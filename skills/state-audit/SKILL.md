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

With an `Activity log: FILE` line in `CLAUDE.md`, a completed run prepends
`## [YYYY-MM-DD] state-audit | <title> → [[<run note slug>]]` right after the
`<!-- log:entries -->` line of that file. No such line: skip it.

## Writing a run

Every mode that writes follows these steps:

1. `mkdir <out>/.lock`. It fails when the directory exists; that is the point (atomic).
2. Write `<out>/.lock/owner.txt` with the start time and the path of this run's note.
3. Write the run note with `status: incomplete`, its run ID (`R` plus the next free number across
   `runs/`), mode, target revision, scope, budget, and every record the run produced.
4. Update the living note: new records under their IDs, new observation rows appended.
5. Set the run note's status to `status: complete`.
6. Remove `<out>/.lock`.
7. Run `node ${CLAUDE_SKILL_DIR}/scripts/check-records.mjs <out>/<repo-name>.md` and report its
   last line. Anything other than `0 problems`: fix the living note before you report the run done.

**Existing lock.** Refuse and print `owner.txt`. If the run note it names is still
`status: incomplete`, call it an abandoned run, and tell the user how to tell it from an active
one: no other session is working on this repo now. Only after the user confirms: remove `.lock/`,
take a new lock, re-apply the abandoned run, then finish from step 5 for that run.

**Re-apply rule.** An observation's identity is its finding ID plus its run ID. Re-applying a run
adds only rows whose run ID is not yet in that finding's table, so replaying the same run twice
adds nothing, while a new run at the same revision still adds its row. Records missing from the
living note are added under their IDs from the run note; existing records are not rewritten.

At the start of every invocation, list run notes still `status: incomplete` first.

## recheck

Follow `references/recheck.md`. A recheck re-traces existing findings at a revision and appends
one observation per finding. It prints one summary line per rechecked finding:
`<ID> <assessment> <rev as given>`, for example `F001 present v2-moved`.

## scan

Filled in by the scan task of the build plan.

## prepare-fix

Filled in by the prepare-fix task of the build plan.
