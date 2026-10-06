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

**Asset-grade** (enables downgrade): `integ.*` URL, `staging.*` URL, attached `.json` / `.har` / `.graphql` payload, GraphQL playground link, Postman collection, gist with response payload, sample SKU / ID against a reachable non-production env, documented local fixture or repro path.

**Soft evidence** (does NOT enable downgrade): production URL, screenshots, prose API description, bare `localhost` link without a documented fixture/repro path.

**Downgrade rule.** When a gap is plausibly resolvable by an asset-grade item: `BLOCKER` → `WARNING (dev-verifiable)`; `WARNING` → `WARNING (dev-verifiable)` (lighter score weight); `MISSING_ASSETS` is never used as a downgrade target.

**Marker requirements.** Append ` (dev-verifiable)` to the downgraded gap title and include the literal sentence `Verification asset: <asset>; check <specific behavior>.` in the gap prose.

**Output schema.** Emit `- Verification Assets: Asset-grade: <comma-list or None>; Soft evidence: <comma-list or None>` as a line inside the `DATA_SOURCES:` block.

**Score impact.** When an original BLOCKER is downgraded to `WARNING (dev-verifiable)`, it no longer triggers the BLOCKER override. Do not count an ambiguity against the readiness score if you downgraded it to `(dev-verifiable)`. Items unsatisfied for any other reason (missing DoD, missing design, missing translations, unresolved dependency) still lower the score. Name the credited ambiguity in the readiness prose.

**In-flight downgrade.** A gap may be downgraded `BLOCKER → WARNING (in-flight)` ONLY when its resolution anchor is **visible in the packet** — `FILENAME_HITS` / `CONTENT_HITS` / `KEYWORD_PLAN` / `MODULE_HIT_TABLE` / a generated type / a ≤2 targeted read (bare top-level `REPO_SHAPE` anchors coarse placement only, never a behavioral convention). Eligible: response shape derivable from packet-present types/operations; a documented convention evidenced by a fine-grained packet hit; naming/placement/module structure from the packet layout. Hard floor (stays BLOCKER): no AC/description; undecided product scope; a core contract with no in-repo derivation path; an unresolved cross-team/blocking-ticket dependency; a product/business decision gating the logic. A question to PO/design is NOT an in-flight anchor. Append ` (in-flight)` to the gap title and include `Resolves via: <packet-visible anchor>.` in the prose. Prefer `(dev-verifiable)` when both apply; one marker per gap.

**Deferred-visual downgrade.** Visual treatment undecided: if the visual **is the deliverable** (pure styling/layout/redesign, no separable logic) → stays **BLOCKER**. If separable buildable logic exists → `WARNING (visual-deferred)`; append ` (visual-deferred)` and include `Deferred: <logic buildable now>; pending design: <undecided visual decision>.` in the prose. A `(visual-deferred)` gap is not `(in-flight)`.

**In-flight / deferred-visual score impact.** A code-derivable `(in-flight)` gap stops counting against readiness (it is dev-reachable) — credit at most one mapped checklist-equivalent, **never** the Verification-Assets equivalent. A `(visual-deferred)` gap is override-removed but gets **no** credit (the design asset is still missing). **Band-label rule:** render `NO-GO (BLOCKER)` only when a real BLOCKER gap exists; a low score with no BLOCKER gap is `NO-GO (WARNING)`.

## Step 4: Run the gap analysis

Same output schema as a normal audit:

- SCOPE_DECISION (required first — in_scope_modules + excluded_modules with cited reasoning)
- Summary (one paragraph)
- Data Sources (Description / Acceptance Criteria / Definition of Done / Comments / Figma — Present/Missing each)
- Codebase Evidence — buckets in trust order, not a predicted edit list (use paths from the packet): `Module scope:` (echo SCOPE_DECISION); `Primary locus (read-confirmed):` (file(s) you read via your ≤2 follow-up reads, or "None confirmed — packet evidence only"); `Confirmed non-impact:` (areas Impact Matrix rates None AND the packet covered); `Candidate leads (conditional, NOT predicted edits):` (files from CONTENT_HITS/FILENAME_HITS an open WARNING points at, citing the gap); `Adjacent/excluded matches:` (keyword neighbors SCOPE_DECISION rules out — do-not-inspect); `Anticipated new surfaces:` (new capabilities by role, not invented filenames). Include `Search cap reached: {echo packet's cap_reached}` and a `BLAST_RADIUS: Low/Medium/High estimate + one-line rationale` line. Any file you name in a gap's prose must appear in one of these buckets or in the packet's hits.
- Impact Matrix (areas: UI, API, Types, Stores, Tests, Auth, etc., adapted to the stack you found)
- Gaps (BLOCKER / WARNING / MISSING_ASSETS, evidence-based). Emit numbered IDs per-category, starting at 1: `BLOCKER #1:`, `BLOCKER #2:`, `WARNING #1:`, `MISSING_ASSETS #1:`, etc. These IDs are required by Phase 2.5 (calibration verifier) to cite specific gaps; omit a category entirely if it has no gaps.
- ENV_PREREQUISITES (env files, credentials, test accounts, external hosts, local services the implementer needs before work starts; `none` with a reason when nothing applies — same rules as `analysis-prompt.md`)
- Technical Readiness (score 0–100, verdict GO / NO-GO, recommendation). **Format and band discipline.** Score MUST be rendered as `{N}%` (never `5/10` or `0.52`). Verdict MUST use one of: `GO` (80–100%), `NO-GO (WARNING)` (50–79%, **or** <50% with no real BLOCKER gap), or `NO-GO (BLOCKER)` (only when a real BLOCKER gap exists — the override). Do NOT invent intermediates like `CONDITIONAL GO` or `GO (with conditions)`. If dev-verifiable / in-flight downgrades make the work practically startable, that belongs in the **Recommendation** field, not in the verdict label.
- Suggested tags (0–3 canonical, content-driven)
