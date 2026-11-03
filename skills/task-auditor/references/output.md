# Output — Audit Note, Log Entry and Chat Template

Mechanical scaffolding for Phase 3 of the task-auditor skill: the exact shape of the audit note, the activity-log line and the chat summary. Consulted after Phase 2 completes.

## Filename

`<notes root>/<project>/task-audits/YYYY-MM-DD-<issue-key-lowercase>-<title-slug>.md`, where:

- `YYYY-MM-DD` is today.
- `<issue-key-lowercase>` is the Jira key lowercased (e.g. `proj-123`).
- `<title-slug>` is the issue title slugified: lowercase, ASCII (German umlauts → `a`/`o`/`u`/`ss`), strip non-alphanumeric, hyphenate, truncate to ≤50 chars on a word boundary. Strip a leading bracketed prefix like `[App] ` only if it would push the slug over the limit.
- `<dated-slug>` is that filename without `.md`.

Phase 0f already resolved re-audits: on `overwrite` reuse the existing filename verbatim; on `new-dated` append `-2`/`-3`/… to the slug; on `previous-day` write today's fresh name. Create the directory if it does not exist.

## 3b. Audit-note frontmatter

```yaml
---
title: "<ISSUE_KEY> — <Original Title>"
type: task-audit
project: <project>
aliases: [<ISSUE_KEY>]
date: <YYYY-MM-DD>
verdict: START | BLOCKED
gaps: <count>
decisions: <N>
handoffs: <M>
issue_keys: [<ISSUE_KEY>]
tags: [jira, <project>, <up to 3 canonical tags>]
---
```

**Verdict fields:** `verdict` is `START` or `BLOCKED` from Phase 2's `VERDICT:` block; `decisions` is the count of WARNING + MISSING_ASSETS bullets (each carries a `Default:`); `handoffs` is the count of HANDOFF bullets. Queryable: `grep -l "^verdict: START" "<notes root>"/*/task-audits/*.md` lists every startable audit; sort by `decisions:` for the ticket with the fewest open calls.

**Tag rule:**
- Mechanical (always): `jira` first, `<project>` second.
- Semantic (Phase 2 output): up to 3 lowercase tags describing what the gaps and affected code touch. Content-driven; never project-name-implied.
- Cap at 5 total. If Phase 2 returns more than 3 candidates, keep the 3 most central to the audit's gaps.

## 3c. Audit-note body

Body sections in this order:

1. `## Summary`
2. `## Scope Decision` ← NEW, emitted on every audit (renders Phase 2's `SCOPE_DECISION` field; fast-fail uses the "not assessed" variant)
3. `## Data Sources`
4. `## Codebase Evidence`
5. `## Impact Matrix`
6. `## Gaps` (with `### BLOCKER`, `### WARNING`, `### MISSING_ASSETS`, `### HANDOFF` subsections; numbered bullets inside)
7. `## Verdict`
8. `## Environment Prerequisites`
9. `## Related`

### Scope Decision section

Render the in-scope and excluded module sets from Phase 2's `SCOPE_DECISION` field, with the reasoning verbatim. This section exists to make the audit's most important call — *which module is the work in* — auditable at a glance, and to expose anchoring failures (a sibling module picked over a Jira-cited one).

```markdown
## Scope Decision

**In scope:**
- `<module>` — <reasoning citing Jira text or packet evidence>

**Excluded:**
- `<module>` — <why this candidate was passed over, citing Jira or packet>
```

If `SCOPE_DECISION` is absent (e.g. Phase 1.5 fast-fail fired and skipped Phase 2), render the section with `- _Not assessed (fast-fail before codebase pass)._` under both subsections.

### Codebase Evidence section

Render the six buckets in trust order; this is evidence for gap analysis, not a predicted edit list. Always include the `Module scope` line — it is the lens for the rest. Trust `Module scope`, `Primary locus`, and `Confirmed non-impact`; treat the remaining buckets as leads.

```markdown
## Codebase Evidence

_Evidence for readiness/gap analysis — not predicted edits. Trust the scope note, Primary locus, and Confirmed non-impact; treat the rest as leads._

**Module scope:** <in-scope module/path vs adjacent-but-excluded>
**Primary locus** (read-confirmed): <file(s), or _None confirmed within budget_>
**Confirmed non-impact:** <areas rated None that search covered, or _None_>
**Candidate leads** (conditional, not predicted edits): <files, each citing the gap that makes them conditional, or _None_>
**Adjacent/excluded matches:** <keyword neighbors the scope rules out, or _None_>
**Anticipated new surfaces:** <new capabilities by role, or _None_>
**Search cap reached:** <yes/no>
**Blast radius:** <Low/Medium/High + rationale>
```

### Gaps section

Gap bullets carry per-category numbered IDs; every WARNING and MISSING_ASSETS bullet ends with its `Default:` sentence:

```markdown
## Gaps

### BLOCKER

- **BLOCKER #1:** <prose explanation, evidence-cited from Phase 2>
- **BLOCKER #2:** <as above>

### WARNING

- **WARNING #1:** <prose>

### MISSING_ASSETS

- **MISSING_ASSETS #1:** <prose> Default: <answer>.

### HANDOFF

- **HANDOFF #1:** <what must happen outside this repo> — owner: <name or role>.
```

If a category has no gaps, keep the subsection header and emit a single `- _None._` bullet beneath it. All four subsections are always present; Phase 3 fills in `- _None._` for empty categories. A WARNING or MISSING_ASSETS bullet without a `Default:` sentence is malformed: re-dispatch Phase 2 once, naming the gap IDs that lack it, before writing.

### Verdict section

```markdown
## Verdict

- **Verdict:** START | BLOCKED
- **First move:** <the first commit's content, or `none — blocked by <owner>: <what must exist first>`>
- **Decisions:** <N> (each WARNING and MISSING_ASSETS bullet above carries its default)
- **Handoffs:** <M>
```

### Environment Prerequisites section

Everything the implementer must have before work starts, from Phase 2 `ENV_PREREQUISITES`. One row per entry; `none` with the Phase 2 reason when the field was `none`.

```markdown
## Environment Prerequisites

| Kind | What | Needed for | Status | Evidence |
|---|---|---|---|---|
| env-file | `.env` with `STORYBLOK_TOKEN` | build, browser check | unknown | `nuxt.config.ts:41` |
| test-account | customer login on integ | browser check | missing | PROJ-123 description |
```

Rows with status `missing` or `unknown` are the first thing to ask the user for in the implementation session.

### Related section

Built mechanically:

```markdown
## Related

- [[<sibling-issue-key>]] — auto-detected sibling that has its own audit (zero or more)
- <orphan-issue-key> — referenced in prose, no audit note under the notes root (zero or more)
```

**Sibling auto-detection:** scan the body produced by Phase 2 for any token matching the regex `[A-Z]{2,10}-\d+` that is NOT the audit's own issue key. For each unique match:

1. Check whether a note under the notes root with frontmatter `aliases: [<KEY>]` exists (e.g. via `grep -l "aliases: \[<KEY>\]" "<notes root>"/*/task-audits/*.md`).
2. If yes → emit `- [[<KEY>]] — auto-detected sibling`.
3. If no → emit plain text `- <KEY> — referenced in prose, no audit note under the notes root`.

Never emit a `[[<KEY>]]` wikilink to a key that has no resolving file — that creates a dead wikilink.

## Log entry

Only when a note was written in Phase 3 step 2, the user's CLAUDE.md has an `Activity log: <file>` line and that file exists, and not when re-audit chose overwrite. Prepend immediately after the `<!-- log:entries -->` sentinel:

```markdown
## [<YYYY-MM-DD>] task-audit | <ISSUE_KEY>: <title> (<verdict>, <N> decisions, <M> handoffs) → [[<dated-slug>]]
```

Use `Read` first, then `Edit` with `replace_all: false` on the sentinel line. If the sentinel is missing, say so in one sentence and keep the note; do not append elsewhere.

## Present to user (chat)

Format using:

```
### Technical Task Analysis <ISSUE_KEY>

**Summary**: <summary>

#### Scope Decision
**In scope:** <module(s) with one-line reasoning citing Jira/packet>
**Excluded:** <sibling module(s) with one-line reasoning citing Jira/packet>

#### Data Sources
- Issue description: <Present/Missing>
- Acceptance Criteria: <Present/Missing/Partial>
- Definition of Done: <Present/Missing>
- Comments analyzed: <N comments, key findings>
- Figma/Mockups: <Linked/Missing>

#### Codebase Evidence
<module scope · primary locus (read-confirmed) · confirmed non-impact · candidate leads (conditional) · adjacent/excluded matches · anticipated new surfaces · search-cap · blast radius>

#### Impact Analysis
<matrix table>

#### Gaps
- **BLOCKER**: <list or "None">
- **WARNING**: <list with each `Default:`, or "None">
- **MISSING_ASSETS**: <list with each `Default:`, or "None">
- **HANDOFF**: <list with owners, or "None">

#### Verdict
- **Verdict**: <START / BLOCKED>
- **First move**: <one sentence>
- **Decisions**: <N> · **Handoffs**: <M>

#### Environment prerequisites
Environment prerequisites: <N> item(s), <M> missing or unknown
- <kind>: <what> (<needed for>)

Or, when the field was `none`: `Environment prerequisites: none (<reason>)`

#### Saved to
- `<notes root>/<project>/task-audits/<dated-slug>.md`
```

Omit the "Saved to" block when no notes root is configured; the audit above is the deliverable.

End with:
- If START: "Defaults above apply unless you override; reply `go recommended` or list changes, then I start."
- If BLOCKED: "Blocked by <owner>: <what must exist first>."
