# Recheck

A recheck finds existing findings again at a new revision and records, per finding, whether the
invalid state is still reachable. It never widens into a scan.

## Selecting findings

- `recheck F001 F004`: the named findings, closed ones included (the user named them).
- `recheck --changed`: every open finding whose own last observed revision differs from the target
  in a way that touches it. For each open finding, run
  `git diff --name-only <its last observed revision> "${REV}"` and select it when the diff touches
  its anchors, its dependencies, or its machine's other writers and consumers. Do not use one
  global "last run revision": a scoped run leaves other findings behind, and runs on different
  branches have no single base.
- `recheck --import REPORT OLD-ID`: copy one finding from an older free-form report into a new
  record (old ID in `old_id`, a link to the report in the Locator), build a partial machine for it
  if none exists (see `records.md`), then recheck it like any other finding.
- `--rev REV`: the target revision; default `HEAD`.

## Rules

1. Pin the target revision. Read through `git show "${REV}:path"` and `git grep ... "${REV}"`, so
   the working tree does not matter. If the user asks for the working tree instead, record the
   dirty file list and their hashes in the run note.
2. Check every dependency first. A changed wrapper can remove or create a defect in code that did
   not change.
3. Follow the locator, not the paths. Search for the writers of the state role, the trigger and
   the consumer. Use git rename detection as a hint only.
4. Re-trace the current entry point, writers, error path and guards.
5. Write one new observation per finding:
   - `present`: the same invariant breaks by the same mechanism. Same ID; refresh the anchors and
     the recipe.
   - `absent`: name the concrete blocker of the old trace (a guard, a writer, a changed
     dependency) in a note starting `blocker:`. Deleted or moved files are never a blocker.
   - `unresolved`: the anchors cannot be found again, or a dependency cannot be read (for example
     its source is not installed). Note starting `reason:`. Install nothing.
6. The same symptom by a new mechanism is a new finding. The same mechanism coming back on a
   closed finding reopens it (`reopened`, `open`).
7. At the end, print one summary line per rechecked finding, `<ID> <assessment> <rev as given>`
   (for example `F001 present v2-moved`), so a caller or a gate can read the result without
   parsing the note.
8. Findings outside the recheck scope get no new observation; the status list shows their latest
   revision, which reads as "not rechecked since".
9. New defects met during a recheck are recorded as `proposed` candidates in the run note and
   listed there. They enter the living note only when the main session promotes them with every
   required field. The recheck does not widen into a scan.

## Filling the row

| Column | Value |
| --- | --- |
| run | this run's ID |
| revision | the full commit the tag or branch resolved to (`git rev-parse "${REV}"`), never the tag or branch name; only a row imported from an older report may keep the short commit that report gave |
| assessment | from rule 5 |
| confidence | `confirmed` when every step was traced; `plausible` when a step depends on unchecked runtime or backend behaviour |
| verification | `code_trace`, unless an executed reproduction or a regression test result is recorded. The skill never runs tests or the build: `regression_test` needs a passing result the owner or a CI run produced, and the note names the test and where its output is (a CI job link or a log path) |
| on_target | `yes` when `git merge-base --is-ancestor "${REV}" "${TARGET}"` exits 0, `no` when it exits 1, `unknown` otherwise (see below) |
| note | `blocker:` or `reason:` where rule 5 requires it; otherwise what changed |

`TARGET` is the upstream of the target branch, `<target_branch>@{upstream}`, when
`git rev-parse --verify -q "<target_branch>@{upstream}"` resolves; otherwise the local
`<target_branch>`. A local branch is often behind its remote. The skill never fetches: write the ref
used and its commit in the run note, so a stale answer can be seen. The user fetches first when
they want a fresh one.

Refresh the recipe when anchors moved. Write a revision before a path as `"${REV}:path"`; in zsh,
`$REV:src/...` is read as the history modifier `:s` and breaks.

Lifecycle effects follow the table in `records.md`: an `absent` row alone never closes a finding.
