---
name: state-audit
description: "Use when an app's explicit and implicit state machines should be audited for reachable invalid states (retries and concurrency included), when findings from an earlier state audit should be rechecked after code changes, or when owner-selected findings should become a fix packet and plan — \"audit the state machines\", \"find the implicit state machines\", \"recheck F003\", \"prepare a fix for F001\". Skip for reviewing one diff (use a code review) or for structural refactoring."
---

# state-audit

You find the state machines in an application, record each machine and each reachable invalid
state as a stable record in a living note, and later recheck those records against changed code.
You stop at a fix packet the owner selected. You never change the audited application.

`${CLAUDE_SKILL_DIR}` is the directory holding this file. Read `references/records.md` before
writing any record.

## Hard rules

1. The audited repo is read-only. Read code at a pinned revision with `git show "${REV}:path"`
   and `git grep ... "${REV}"`. Never edit, stage, commit, install or run its build.
2. No fix is applied and no plan is handed to a builder until the owner has chosen the findings.
3. Never write or imply "all state machines found". Report what the ledger says was covered.
4. A recheck never reports `absent` because files were deleted or moved.
5. `confirmed` means traced in code, never "reproduced".

## Invocation

```text
/state-audit scan [area ...] [--depth inventory|full] [--out DIR]
/state-audit recheck [F### ... | --changed] [--rev REV] [--import REPORT OLD-ID] [--out DIR]
/state-audit prepare-fix F### [F### ...] [--rev REV] [--out DIR]
```

A bare `/state-audit` reads the living note for this repo. If one exists, print the open findings
and the last run revision and propose `recheck --changed`. If none exists, propose a scoped `scan`
and show its scope and budget. Either way, wait for the user before dispatching anything.

## Output location

First match wins:

1. `--out DIR`.
2. A `state-audit extension: FILE` line in the user's `CLAUDE.md`: read that file; it decides the
   directory and may add an activity-log step. If it is missing or a step fails, say so in one
   sentence and fall through.
3. A `Notes root: DIR` line: `DIR/state-audit/<repo-name>/`.
4. Default: `~/.state-audit/<repo-name>/`.

`<repo-name>` is the basename of the parent of
`git rev-parse --path-format=absolute --git-common-dir`, so every worktree of a repo shares one
folder. When that common dir is not named `.git` (a submodule or a bare clone), stop and ask for
`--out`.

Steps 2-4 refuse a folder inside the audited working tree or inside any other worktree of the
repo (`git worktree list`). Compare resolved real paths, so a symlink cannot slip through. Only an
explicit `--out` may point there.

Folder layout:

```text
<repo-name>.md                  living note (format: references/records.md)
runs/YYYY-MM-DD-<mode>-<n>.md   one note per run, never edited after it is complete
.lock/                          present only while a run is writing
```

**Repo identity.** The living note's frontmatter records `repo_root_commit`
(`git rev-list --max-parents=0 HEAD`, first line). On every run, compare it with the audited repo.
On a mismatch, two unrelated repos share a folder name: refuse and ask for `--out`.

With an `Activity log: FILE` line in `CLAUDE.md`, a completed run whose folder came from step 3
(`Notes root:`) prepends `## [YYYY-MM-DD] state-audit | <title> → [[<run note slug>]]` right after
the `<!-- log:entries -->` line of that file; with step 2, the extension file decides. A run saved
with `--out` or to the default folder never logs: its note is outside the notes, so the link would
point nowhere. No `Activity log:` line: skip it.

## Writing a run

Every mode that writes follows these steps:

Quote every path: a notes root may contain spaces.

1. `mkdir -p "<out>"` (the folder may not exist on a first run), then `mkdir "<out>/.lock"`. The
   second command fails when the lock exists; that is the point (atomic). A failure of the first
   command is a path problem, not a lock: report it.
2. Write `"<out>/.lock/owner.txt"` with the start time and the path of this run's note.
3. Write the run note with `status: incomplete`, its run ID (`R` plus the next free number across
   `runs/`), mode, target revision, scope, budget, every record the run produced, and the field
   changes it makes to existing records (for example `F003 disposition: proposed -> selected`).
4. Update the living note: new records under their IDs, new observation rows appended, the field
   changes applied.
5. Run `node "${CLAUDE_SKILL_DIR}/scripts/check-records.mjs" "<out>/<repo-name>.md"`. Anything other
   than `0 problems`: fix the living note now, while the lock is held, and run it again.
6. Set the run note's status to `status: complete`.
7. Remove `"<out>/.lock"`. Report the validator's last line with the run.

**Existing lock.** Refuse and print `owner.txt`. If the run note it names is still
`status: incomplete`, call it an abandoned run, and tell the user how to tell it from an active
one: no other session is working on this repo now. Only after the user confirms, remove `.lock/`,
take a new lock, and ask whether to re-apply or discard the abandoned run. Re-apply is the
default. Offer discard when the run note looks wrong (a run ID that is not the next free number,
rows that duplicate an earlier run, a scope the user did not ask for) or the user does not trust it.

- Re-apply: follow the re-apply rule below, then finish from step 5 for that run.
- Discard: undo what reached the living note before the crash. Remove the rows carrying this
  run ID, remove records the run note lists as new under their IDs, and set each listed field
  change back to its old value when the field still holds the new one. Then run step 5 for the
  living note, set the run note to `status: discarded` with a `discard_reason:` line, and remove
  the lock. A discarded run keeps its file and its run ID; the ID is never reused.

**Re-apply rule.** An observation's identity is its finding ID plus its run ID. Re-applying a run
adds only rows whose run ID is not yet in that finding's table, so replaying the same run twice
adds nothing, while a new run at the same revision still adds its row. Records missing from the
living note are added under their IDs from the run note. The run note's field changes are applied
again; a field that already holds the new value stays as it is. Nothing else in an existing record
is rewritten.

## Owner decisions

When the owner selects, defers or rejects findings ("defer F002", "reject F005"), record it as a
small run (mode `decision`): set `disposition`, and for a rejection also `lifecycle: closed`, list
the field changes in the run note, and write it as above. A rejection keeps the finding's
observations; a later recheck that finds it `present` again reopens it.

At the start of every invocation, list run notes still `status: incomplete` first. Skip `status: discarded` ones. With no lock present, the same choice applies: take the lock, then offer re-apply or discard as under "Existing lock", before any new work.

## recheck

Follow `references/recheck.md`. A recheck re-traces existing findings at a revision and appends
one observation per finding. It prints one summary line per rechecked finding:
`<ID> <assessment> <rev as given>`, for example `F001 present v2-moved`.

## scan

A scan finds machines and the invalid states the code can reach, with evidence.

1. **Scope and budget.** Show the areas (workflow areas such as auth and session, cart, checkout,
   account, global UI; or the ones the user named), the target revision, the investigator count
   and the output limits. Wait for the user.
2. **Ownership map (main session).** Search for state holders and their writers: stores,
   composables or modules with module-level state, cookies, shared request state, global flags,
   retry and error middleware. Use `references/cues.md`. When `package.json` lists `vue` or
   `nuxt`, also use `references/cues-vue-nuxt.md`.
3. **Investigators.** Dispatch one packet per workflow area, at most 4, plus one cross-area packet
   for the seams between areas (for example login and cart merge, cart swap during order submit,
   route change and overlay cleanup). Each packet follows `references/investigator.md`: entry
   points, the shared code it may read, its exclusions, the required scenarios, and an output limit
   of 8 detailed candidates plus a list of leads. Each machine gets one reporting owner. No nested
   delegation. Investigators run on the session model, never a cheaper tier: their output is
   judgment, and no gate checks it.
4. **Consolidate (main session).** Deduplicate by invariant and trace. Re-read the code for every
   finding offered as actionable before it gets `confirmed`; the rest stay `plausible` and say what
   was not checked. Group into issues only when one behaviour change and one regression strategy
   cover every finding in the group; a shared cause label is not enough.
5. **Ledger.** In the run note, mark each area and each required scenario `traced`, `partial`,
   `not_started` or `blocked`, with a reason. Counts describe the work done, never the whole app.
6. **Write** the run as in "Writing a run". Only consolidated machines and findings go into the
   living note; leads and unverified candidates stay in the run note.

These budgets are starting values from two manual runs, not measured optima.

`--depth inventory` (a short list of machines only) tells investigators to report machines, not
defects. Steps 4-6 still run: machines are consolidated, the ledger records what was inventoried,
and the run is saved. Inventory machines use the partial shape (ID, title, `coverage: inventory`,
`evidence_revision`, key files and a one-line description in the body). A later full scan of the
same area fills in the rest under the same IDs.

Report the scan as: one line per machine and finding (ID, title, most important files),
the coverage ledger, and the path of the run note for details.

## prepare-fix

Turns findings the owner selected into a fix packet and an implementation plan, then stops.

1. The user names the findings. Selection allows preparation only; it does not approve a fix. A
   finding whose invariant has the basis `investigator assumption` needs the owner to confirm or
   rewrite the invariant first.
2. Recheck the selected findings at `--rev` (default `HEAD`) as in `references/recheck.md`. Only
   findings whose new observation is `present` go further. List an `absent` one as "nothing to fix
   at REV" (the owner may close it) and an `unresolved` one with what could not be found (the owner
   decides after looking).
3. Group into issues only when one behaviour change and one regression strategy cover every
   finding in the group. Findings that need an owner or backend answer first (for example whether
   a mutation is idempotent) are listed with the question, not packed.
4. Write one fix packet per issue to `<out>/fixes/I###.md`: states and invariants involved, the
   current traces, evidence (`file:line` at the pinned revision, short excerpts), the proposed
   change, regression scenarios (each with the event order a test must force), and open
   assumptions. Measure it with `wc -c`. Above 40 KiB, replace the excerpts with `file:line`
   references (a reviewer can read the repo itself) and measure again. Still above 40 KiB: the
   issue is too large to review as one unit; stop and ask the owner to narrow the selection.
5. If a `codex-review` skill is installed, offer `/codex-review design <packet>`. Without it, say
   in the packet and in your report that it was not independently reviewed.
6. Draft the implementation plan next to the packet (`<out>/fixes/I###-plan.md`). Every task that
   fixes a finding starts with the regression test that must fail before the fix, named with the
   finding ID. When the plan is meant for a `teeth-build` skill, give each such task the line
   `**Route:** relay`, so a separate writer produces the red test before the implementer starts;
   its `gate` route lets the implementer write tests and code together. Without `teeth-build`, the
   plan is for the user's own workflow.
7. Record the issue in the living note (`## Issues`), set the packed findings to `selected`, and
   write the run as in "Writing a run".
8. Stop. Report the packet and plan paths. The owner approves the plan and starts the build.

After a build, `recheck F###` records the fix revision and the regression evidence
(`verification: regression_test`). `resolved` needs both, on a revision contained in
`target_branch`. "Fixed on a branch" and "verified on the target branch" are separate
observations.
