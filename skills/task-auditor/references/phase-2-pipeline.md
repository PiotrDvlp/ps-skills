# Phase 2 pipeline (fetch, analysis)

## Phase 1: Jira data fetch

The orchestrator fetches directly through the cs-atlassian MCP wrapper — no subagent. The MCP runs outside the Bash sandbox, which blocks the CLI's egress (Node's `fetch` ignores the sandbox proxy, so the CLI fails with `<no response> fetch failed`).

```
mcp__cs-atlassian__atlassian_jira_get_issue({ idOrUrl: "<ISSUE_KEY>", instance: "<name>" })
```

Pass `instance` explicitly (enumerate with `atlassian_list_instances`) — the default instance returns empty for other projects. Build the Phase 1 markdown from `data.normalized`: key, summary, type, status, assignee, reporter, `descriptionMd`, every entry in `comments`, `attachments`, `issueLinks`, `remoteLinks`. That markdown is `{JIRA_DATA}` and the packet's Jira section downstream.

Fallback only when the MCP server is unavailable: `cs-atlassian jira issue <ISSUE_KEY> --md`, run outside the sandbox or with the Jira host allowed.

### Error handling

| Error | Meaning | User message |
|-------|---------|--------------|
| Auth missing (CLI exit 3) | Not logged in | Run `cs-atlassian login` first |
| Not found (CLI exit 4) | Key missing or no access | Issue key doesn't exist or no access |
| `ALLOWLIST_VIOLATION` (CLI exit 5) | Project outside allowlist | Add the project to `~/.config/cs-atlassian/config.yml` |

## Phase 1.5: Structural-emptiness fast-fail (Jira-only gate)

Before dispatching the analysis codebase pass, the orchestrator inspects the Phase 1 markdown for **structural emptiness**. This is a narrow gate, not a readiness judgment — it fires only when there is nothing to audit, and it exists to skip the ~150s Sonnet pass on tickets that cannot benefit from it.

**Fire only when ALL THREE hold:**
- No issue description (no `Beschreibung`/Description body, or only boilerplate/placeholder text).
- No acceptance criteria (no AC / `Akzeptanzkriterien` section, or it is empty).
- No substantive comments (none, or only noise — "+1", "estimate?", bot/status notices).

**Do NOT fire** when any one of those carries real content. A present description with missing AC is a normal Phase 2 WARNING/BLOCKER — not a fast-fail. Never fire on "missing API / Figma / copy" semantics: those are asset- and codebase-grounded judgments owned by Phase 2's verification-asset and dev-verifiable-downgrade logic, and short-circuiting them here would produce false BLOCKED verdicts.

**On no-fire:** continue to Phase 2 unchanged.

**On fire — emit a COMPLETE synthetic Phase 2 payload** so Phase 3's parser and `output.md` have no special-case holes. Skip Phase 2 (no analysis dispatch), then populate every field Phase 2 would have produced:

- `SUMMARY:` Ticket cannot be audited — Jira content is structurally empty.
- `DATA_SOURCES:` Description Missing; Acceptance Criteria Missing; Definition of Done Missing; Comments None (or "no substantive"); Figma/Mockups Missing; Verification Assets: Asset-grade None; Soft evidence None.
- `CODEBASE_EVIDENCE:` Module scope: not assessed (fast-fail before codebase pass); Primary locus, Confirmed non-impact, Candidate leads, Adjacent/excluded matches, Anticipated new surfaces all `None`; Search cap reached: no; BLAST_RADIUS: not assessed.
- `IMPACT_MATRIX:` every area `Unknown — not assessed (no codebase pass)`.
- `GAPS:` a single `BLOCKER #1: Ticket is structurally empty — no description, no acceptance criteria, no substantive comments; cannot audit for readiness.`
- `VERDICT:` Verdict BLOCKED; First move: none — blocked by the ticket author: a description and acceptance criteria; Decisions: 0; Handoffs: 1.
- `GAPS:` also carries `HANDOFF #1: Add a description, acceptance criteria and implementation context to the ticket — owner: ticket author.`
- `SUGGESTED_TAGS:` none (Phase 3 still applies the mechanical `jira` + `<project>` tags).

Then continue to Phase 3 and write the audit note as normal — a structurally empty ticket is exactly the kind of thing worth a durable, linkable BLOCKED record.

This gate is orchestrator-inline and Jira-only — no subagent dispatch, sub-second cost.

## Phase 1.75: Evidence packet (orchestrator-built, deterministic)

After the Phase 1.5 gate passes (the ticket has substantive content), the orchestrator builds an evidence packet that replaces the analysis agent's interactive search loop. Two things this delivers: **(1)** Phase 2 latency drops because search lives outside the model loop and runs under a real wall-clock timeout — landing the original "hard budget belongs in tooling, not prose" point; **(2)** scope stability — enumerating candidate modules up front with a protected Jira-citation override stops the anchoring failure where Sonnet commits to the first keyword-rich module it hits (e.g. picking `aciPayments` for an Adyen-cited ticket).

### Step A — Derive the keyword plan inline

The orchestrator extracts keywords from the Phase 1 Jira markdown using these rules (moved here from the old analysis Step 1):

- UI component names: "product card" → `ProductCard`, `product-card`
- Page references: "PLP" → `plp`, `ProductList`, `pageModules/plp`
- Feature areas: "cart" → `cart`, `useCart`, `cartStore`
- GraphQL operations mentioned verbatim
- Route patterns: "/checkout" → `checkout`
- CSS class names, event names, store names mentioned

**Caps:** ≤6 primary keywords, ≤2 variants each. Drop generic terms (`product`, `price`, `cart`, `article`) unless paired with a specific modifier — record dropped terms with their reason. Identify modules/providers the Jira **explicitly cites** (e.g. "Adyen" → `adyen`); split them into `include` (Jira affirmatively says this is the path) vs `candidate` (sibling module that also matches keywords but is not what the ticket names) — this is the anti-anchoring signal the script protects.

Emit the plan as a **structured JSON object** that the script consumes and that travels into the packet **verbatim** so the analysis agent can audit the derivation:

```json
{
  "jira_terms": ["Adyen PayPal-Richtlinien"],
  "primary_keywords": ["adyen", "paypal", "applepay"],
  "variants": {
    "adyen": ["AdyenExpress", "adyen"],
    "paypal": ["PayPal", "paypal"]
  },
  "dropped_terms": [{"term": "express", "reason": "generic without provider"}],
  "scope_hints": {
    "include":   [{"module": "adyen", "reason": "comments cite Adyen explicitly"}],
    "candidate": [{"module": "aciPayments", "reason": "sibling payment provider — matches PayPal/ApplePay terms but not the cited provider"}]
  }
}
```

Write the plan to `$TMPDIR/<ISSUE_KEY>-keyword-plan.json`. **Do not** pack it into comma-separated CLI flags — spaces, punctuation, and localized Jira text break that path.

### Step B — Run the deterministic pre-scan

```bash
scripts/prescan.py \
  --stack=<shopin|fallback> \
  --root=<absolute-codebase-root> \
  --input=$TMPDIR/<ISSUE_KEY>-keyword-plan.json \
  --timeout=15
```

The script applies a 15-second wall-clock timeout outside the prompt (deadline-budgeted `subprocess.run` per sub-command). It emits to stdout:

- `REPO_SHAPE` — top-level layout, excluding `node_modules` / `.nuxt` / `.output` / `dist`
- `MODULE_HIT_TABLE` — for each candidate module under `src/pageModules/*` (shopin) or top-level `src/*` (fallback), the keyword-match count; capped per the rule below with cited modules protected
- `FILENAME_HITS` — combined `find -iname` over scope paths
- `CONTENT_HITS` — combined `rg -A2 -B2` matches (context lines, **not** pre-read files — the analysis agent reads selectively via its ≤2 follow-up reads)
- `cap_reached: yes/no`, `elapsed_ms: <int>`

**Module-table cap (anti-anchoring rule):**
1. Include every candidate module with ≥1 keyword hit.
2. Always include modules from `scope_hints.include` and `scope_hints.candidate`, even at zero hit count — this protects the textually-cited module from being drowned out by keyword-rich siblings.
3. If more than `--max-modules` (default 8) remain: keep all cited, then highest-hit-count until the cap.
4. Emit `truncated: yes` plus an omitted summary so the analysis agent sees what was cut.

### Step C — Assemble the packet

Concatenate, in this order, for the Phase 2 prompt's `{EVIDENCE_PACKET}` placeholder:

1. The Phase 1 Jira markdown (unchanged).
2. The verbatim `KEYWORD_PLAN` JSON (emitted in the packet so the analysis agent sees both the semantic derivation and the raw hit table — `SCOPE_DECISION` can cite either).
3. The structured stdout from Step B.
4. The codebase root path (so the analysis agent's ≤2 follow-up reads can use absolute paths).

## Phase 2: Packet-grounded analysis

Read `<analysis-prompt-path>` (from Phase 0b) for the subagent prompt template; the Phase 1.75 packet fills the `{EVIDENCE_PACKET}` placeholder, replacing the old `{JIRA_DATA}` injection plus the in-prompt search-loop budget.

Dispatch the **analysis subagent** on the **session model** — omit the `model` opt so it inherits:

```
Agent({
  description: "Packet-grounded analysis for <ISSUE_KEY>",
  prompt: <contents of analysis prompt with {EVIDENCE_PACKET} filled>
})
```

**Why no `model` pin here (changed 2026-07-27).** This step emits `SCOPE_DECISION`, a verdict and
the first move that gate whether a human starts coding — judgment output, not mechanical
transformation. A cheap tier is permitted only where a deterministic gate verifies the worker's
output; no per-run gate exists here (the retro fixture in `scripts/retro-verdict.mjs` gates prompt
edits, not audits), so the tier is the session model. It was pinned `sonnet` until 2026-07-27.

The analysis agent **may not search**: no `find`, no `rg`, no `grep`, no broad `ls` — the packet is the search, and re-running discovery would duplicate work already done under a wall-clock timeout while undermining the scope-stability the packet provides. It MAY issue **up to 2 targeted `Read` calls**, and only when classifying a specific named gap depends on what that file contains (e.g. a WARNING's severity hinges on whether a config option is shared across payment brands). It must read **only from paths cited in the packet** (FILENAME_HITS, CONTENT_HITS, or KEYWORD_PLAN scope_hints) — it may not invent paths.

The analysis agent returns a structured analysis whose **first required field is `SCOPE_DECISION`** (in-scope modules + excluded modules, each with reasoning citing Jira text or packet evidence). Parse the analysis to extract: scope decision (in_scope, excluded), summary, data sources, codebase evidence (module scope, primary locus, confirmed non-impact, candidate leads, adjacent/excluded, anticipated new surfaces), gaps (incl. HANDOFF), verdict, first move, decisions, handoffs, and suggested canonical tags (0–3).
