# Records

The living note is one Markdown file per audited repo. `scripts/check-records.mjs` parses exactly
the syntax below and nothing else; run it after every write.

## What counts as a state machine

State that persists across events, where the order of transitions changes what the user sees or
what the backend receives. A group of refs, store fields, cookies or cache entries can be one
machine; one store can hold several. Describe meaningful states as predicates; do not list every
boolean combination.

## Living-note syntax

````markdown
---
schema: 1
repo_name: demo
repo_root_commit: 0123456789abcdef0123456789abcdef01234567
target_branch: main
---

# State audit: demo

## Machines

### M001: Item loading
- old_id: UI-M9
- coverage: partial
- evidence_revision: f3c24361

Invariants:
- M001-I1 [code contract]: the loading flag is false once the request has settled

(State, States, Transitions, Boundaries: free Markdown, not checked)

## Findings

### F001: Failed item lookup leaves the buy box blocked
- old_id: UI-F3
- machine: M001
- invariant: M001-I1
- lifecycle: open
- disposition: deferred
- severity: P2

#### Locator
#### Trace
#### Dependencies
#### Recipe
#### Observations

| run | revision | assessment | confidence | verification | on_target | note |
| --- | --- | --- | --- | --- | --- | --- |
| R001 | f3c24361 | present | confirmed | code_trace | no | anchors moved |

## Issues

### I001: Release the loading flag on every terminal state
- findings: F001
````

Rules:

- `repo_root_commit` is `git rev-list --max-parents=0 HEAD` (first line). `target_branch` defaults
  to the repo's default branch.
- IDs are `M`, `F` or `I` plus three or more digits, under the matching `##` section. New IDs are
  the next free number. An imported record keeps its earlier ID in `old_id` and is never renumbered.
- `old_id`, `severity` and the `Dependencies` section are optional. A machine built for an imported
  finding, or by an inventory scan, may be partial: ID, title, `coverage`, `evidence_revision` and
  the invariants its findings cite.
- Observation rows are appended, never edited. The last row is the latest. A row's identity is its
  finding ID plus its run ID.
- `absent` needs a note starting `blocker:` that names what stops the old trace (a guard, a writer,
  a changed dependency). Deleted or moved files are never a blocker.
- `unresolved` needs a note starting `reason:`.
- Write a revision before a path as `"${REV}:path"` in recipes. In zsh, `$REV:src/...` is read as
  the history modifier `:s` and breaks the path.
- Finding sections: Locator (purpose, state role, trigger, violation, anchors), Trace
  (preconditions, ordered events, broken invariant; for concurrency, the exact interleaving and why
  the guards allow it), Dependencies (wrappers, client defaults, library versions, consumers, each
  with "changed since the previous observation"), Recipe (read-only commands), Observations.
- Only machines and findings that passed consolidation or an import go into the living note. Leads
  and candidates stay in the run note until promoted.

## Enums

- `lifecycle`: `open`, `closed`
- `disposition`: `proposed`, `selected`, `deferred`, `rejected`, `resolved`, `reopened`
- `assessment`: `present`, `absent`, `unresolved`, `not_checked`
- `confidence`: `confirmed`, `plausible`
- `verification`: `code_trace`, `executed_repro`, `regression_test`
- `on_target`: `yes`, `no`, `unknown`
- `basis`: `code contract`, `product requirement`, `investigator assumption`
- `coverage`: `full`, `partial`, `inventory`
- `severity`: `P1`, `P2`, `P3`

`confirmed` means traced in code, never "reproduced". `on_target` is `yes` when the revision is
contained in `target_branch` (`git merge-base --is-ancestor <rev> <target_branch>`).

## Severity

- `P1`: money, order, auth or session decision, token exposure, or shopper-state corruption.
- `P2`: wrong state that a reload or retry can fix.
- `P3`: minor.

## Lifecycle

| Event | Effect |
| --- | --- |
| New finding | `open`, `proposed` |
| Owner selects / defers / rejects | `selected` / `deferred` / `rejected`; `rejected` closes it |
| Observation `absent` | stays `open`; the index shows "absent at REV, not confirmed" |
| Observation `unresolved` after `absent` | stays `open`; the latest observation decides what the index shows |
| Observation `regression_test` that passes after a fix, on a revision contained in `target_branch` (`git merge-base --is-ancestor`) | `resolved`, `closed` |
| The same, on a revision not yet in `target_branch` | stays `open`; the index shows "fixed on branch X, not on target" |
| Observation `present` on a `closed` finding | `reopened`, `open` |

Allowed pairs: `open` with `proposed`, `selected`, `deferred` or `reopened`; `closed` with
`rejected` or `resolved`.

`resolved` is valid while the finding has a passing regression test row (`regression_test`,
`absent`, `on_target` `yes`) and no `present` row after it; a later `absent` from a plain recheck
keeps it valid. A `present` row after the regression test makes the record invalid until it is
`reopened`. A `rejected` finding may keep `present` as its latest row: the owner decided not to fix
it. If a recheck adds a new `present` row after the rejection, set the finding to `reopened`.

A finding whose invariant has the basis `investigator assumption` cannot be `selected` until the
owner confirms or rewrites the invariant.

## Checks run by `check-records.mjs`

C1 frontmatter present and closed; C2 unique, well-formed IDs, and no record heading outside
`## Machines`, `## Findings` or `## Issues`; C3 machine and invariant exist; C4 required sections,
at least one observation, every row has a revision; C5 enum values; C6 `blocker:` and `reason:`
notes; C7 recipe quoting; C8 lifecycle and disposition pair; C9 `resolved` evidence and no `present`
row after it; C11 `selected` on an investigator assumption; C12 issue references. (C10 was dropped:
whether a `present` row came before or after a rejection is a recheck rule, not a static check.)
