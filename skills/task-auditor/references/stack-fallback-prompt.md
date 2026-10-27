# Stack-fallback analysis prompt

Used by `task-auditor` when the orchestrator's stack detection (Phase 0) does not match a known profile (SHOPin/Nuxt). The output schema is identical to `analysis-prompt.md`; the difference is that the evidence packet was produced with `--stack=fallback`, so `REPO_SHAPE` and `MODULE_HIT_TABLE` reflect the project's actual top-level layout rather than SHOPin conventions.

## Inputs

The orchestrator fills `{ISSUE_KEY}` and `{EVIDENCE_PACKET}` (Jira markdown + KEYWORD_PLAN + REPO_SHAPE + MODULE_HIT_TABLE + FILENAME_HITS + CONTENT_HITS + codebase root, produced by Phase 1.75 with `--stack=fallback`).

## Instructions

You are auditing Jira issue `{ISSUE_KEY}` in a codebase whose stack the orchestrator could not auto-recognize.

You receive a pre-built evidence packet. **You do not search the codebase yourself** — the deterministic pre-scan in Phase 1.75 has already gathered the evidence under a wall-clock timeout, including REPO_SHAPE so you can see the layout without re-discovering it. The packet contains:

- The full Jira issue markdown.
- `KEYWORD_PLAN` — the orchestrator's semantic mapping from Jira text to codebase identifiers, plus dropped terms and Jira-cited scope hints (`include` vs `candidate`).
- `REPO_SHAPE` — the actual top-level project layout (replaces the previous "read root manifest + tree" step).
- `MODULE_HIT_TABLE` — every candidate top-level source directory with its keyword-match count. **Jira-cited modules are protected and may appear with zero hits**; weigh by Jira citation, not just count. Capped (default 8) with a `truncated`/`omitted` summary.
- `FILENAME_HITS` — combined filename matches across the scope.
- `CONTENT_HITS` — combined `rg -A2 -B2` matches with context lines.
- `cap_reached` — whether the pre-scan hit its time budget.

{EVIDENCE_PACKET}

## You may not search

The packet is the search. **Do NOT run `find`, `rg`, `grep`, broad `ls`, or any other discovery command** — those would duplicate work the pre-scan already did under a wall-clock timeout, re-introduce the latency this design exists to remove, and undermine the scope-stability the packet provides.

You **MAY** issue **up to 2 targeted `Read` calls**, and only when classifying a specific named gap depends on what that file contains. **Read only from paths cited in the packet** (FILENAME_HITS, CONTENT_HITS, or KEYWORD_PLAN scope_hints) — do not invent paths.

## Step 1: Decide scope (SCOPE_DECISION — required first output)

Before any other output, emit `SCOPE_DECISION`. The `MODULE_HIT_TABLE` may show several keyword-matching top-level directories; `KEYWORD_PLAN.scope_hints` distinguishes Jira-cited modules from sibling matches. Pick the in-scope module(s) and exclude the rest **with reasoning that cites Jira text or packet evidence**.

- A high hit count is **not** by itself a reason to include — sibling directories can be keyword-rich without being what the ticket names.
- A Jira citation is **decisive** even at a low hit count.
- For every candidate in `MODULE_HIT_TABLE`, you must either include it (with reasoning) or exclude it (with reasoning). Silence is not an excluded decision.
- **The schema is binary.** Primary/in-scope modules go in `in_scope_modules`; adjacent, monitor-only, sibling, or otherwise-passed-over candidates go in `excluded_modules` with the reasoning naming their status. Do NOT place a module in `in_scope_modules` with an "adjacent-only" or "monitor-only" qualifier — that drifts the contract and re-introduces the failure the binary structure exists to prevent.

## Step 2: Read the canonical tag vocabulary

Suggest 0–3 lowercase tags that describe what THIS audit's gaps and affected code actually touch. Rules:

- Do NOT add a tag because the project name implies it.
- Do NOT add stack-name tags (`nuxt`, `next`, `spring`, `react`) unless the audit's analysis specifically discusses framework-level concerns.
- Never invent non-canonical tags. If nothing fits, suggest none — the project anchor tag (added mechanically by Phase 3) carries the load.

## Step 3: Verification-Asset Inventory

**Asset-grade** (enables the `(dev-verifiable)` marker): `integ.*` URL, `staging.*` URL, attached `.json` / `.har` / `.graphql` payload, GraphQL playground link, Postman collection, gist with response payload, sample SKU / ID against a reachable non-production env, documented local fixture or repro path.

**Soft evidence** (does NOT enable the marker): production URL, screenshots, prose API description, bare `localhost` link without a documented fixture/repro path.

**Gap categories.** `BLOCKER` stops the first commit in this repo (no commit can advance any AC without inventing a product decision or an API/data contract with no in-repo derivation path). `WARNING` is an ambiguity the developer resolves by a stated default. `MISSING_ASSETS` is an external deliverable not needed for the first commit. `HANDOFF` is work outside this repo someone else must do before the ticket can close; it never blocks the first commit and carries an owner: `HANDOFF #N: <what> — owner: <name or role>.`

**Hard floor (stays BLOCKER).** No AC and no description; undecided product scope where no AC can advance without the answer; a core contract with no in-repo derivation path that the first commit must consume; a blocking ticket whose output the first commit needs; a deliverable that is content, data or an asset this repo cannot produce when no AC is met without it. A cross-team dependency that blocks only closing is a HANDOFF.

**PO/design questions.** WARNING with a default when at least one AC can advance under it; BLOCKER only when none can.

**`Default:` sentence (required).** Every WARNING and MISSING_ASSETS bullet ends with `Default: <the answer the auditor would take, and what it changes in the work>.`

**Dev-verifiable marker.** A gap an asset-grade item answers today: append ` (dev-verifiable)` and include `Verification asset: <asset>; check <specific behavior>.` A would-be BLOCKER becomes WARNING (dev-verifiable) only when the asset answers it today; not when the backend side of the contract is unconfirmed (merged-not-deployed, future response shape, asset status `unknown`).

**In-flight marker.** Anchor **visible in the packet** (`FILENAME_HITS` / `CONTENT_HITS` / `KEYWORD_PLAN` / `MODULE_HIT_TABLE` / a generated type / a ≤2 targeted read; bare `REPO_SHAPE` anchors coarse placement only): append ` (in-flight)` and include `Resolves via: <packet-visible anchor>.` Prefer `(dev-verifiable)` when both apply; one marker per gap.

**Deferred-visual marker.** Visual undecided and the visual **is** the deliverable → BLOCKER. Separable buildable logic exists → WARNING (visual-deferred) with `Deferred: <logic buildable now>; pending design: <undecided visual decision>.`

## Step 4: Run the gap analysis

Same output schema as a normal audit:

- SCOPE_DECISION (required first — in_scope_modules + excluded_modules with cited reasoning)
- Summary (one paragraph)
- Data Sources (Description / Acceptance Criteria / Definition of Done / Comments / Figma — Present/Missing each)
- Codebase Evidence — buckets in trust order, not a predicted edit list (use paths from the packet): `Module scope:` (echo SCOPE_DECISION); `Primary locus (read-confirmed):` (file(s) you read via your ≤2 follow-up reads, or "None confirmed — packet evidence only"); `Confirmed non-impact:` (areas Impact Matrix rates None AND the packet covered); `Candidate leads (conditional, NOT predicted edits):` (files from CONTENT_HITS/FILENAME_HITS an open WARNING points at, citing the gap); `Adjacent/excluded matches:` (keyword neighbors SCOPE_DECISION rules out — do-not-inspect); `Anticipated new surfaces:` (new capabilities by role, not invented filenames). Include `Search cap reached: {echo packet's cap_reached}` and a `BLAST_RADIUS: Low/Medium/High estimate + one-line rationale` line. Any file you name in a gap's prose must appear in one of these buckets or in the packet's hits.
- Impact Matrix (areas: UI, API, Types, Stores, Tests, Auth, etc., adapted to the stack you found)
- Gaps (BLOCKER / WARNING / MISSING_ASSETS / HANDOFF, evidence-based). Emit numbered IDs per-category, starting at 1: `BLOCKER #1:`, `WARNING #1:`, `MISSING_ASSETS #1:`, `HANDOFF #1:`; omit a category entirely if it has no gaps. Every WARNING and MISSING_ASSETS bullet ends with its `Default:` sentence.
- ENV_PREREQUISITES (env files, credentials, test accounts, external hosts, local services the implementer needs before work starts; `none` with a reason when nothing applies — same rules as `analysis-prompt.md`)
- VERDICT block: `Verdict: START | BLOCKED` (BLOCKED only with a hard-floor BLOCKER gap; no percentage, no intermediate label), `First move:` (the first commit's content, or `none — blocked by <owner>: <what must exist first>`), `Decisions:` (count of WARNING + MISSING_ASSETS bullets), `Handoffs:` (count of HANDOFF bullets).
- Suggested tags (0–3 canonical, content-driven)
