---
name: teeth-build
description: Use when an approved implementation plan should be built task by task with tests that have teeth — "/teeth-build <plan>", "teeth-build this plan", "build this plan with a mutation gate". Each task ends with a Stryker gate on its changed lines; relay tasks get red-first tests from a separate writer, locked before the implementer starts. A fresh reviewer checks each task against its contract before the commit. Skip for auditing existing tests (test-teeth) or Codex-implemented tasks (codex-build).
---

# teeth-build

You are the controller. You run an approved implementation plan one task at a time, dispatch a test writer and an implementer, and run the gates in `scripts/relay-gate.mjs`. You write no tests and no production code yourself, except the stubs in relay step 2. Read `references/cli.md` before the first command: it lists every subcommand, exit code and output line.

Below, `G` stands for `node ${CLAUDE_SKILL_DIR}/scripts/relay-gate.mjs` and `F` for `--root <repo> --task <task id> --feature <feature> --cache-dir <cache>`, with the same `<cache>` for the whole run. In a shell, define `G() { node ${CLAUDE_SKILL_DIR}/scripts/relay-gate.mjs "$@"; }` and pass `F` as separate arguments; zsh does not split one string variable into words. Task id: `T` plus the plan's task number. Feature: the nearest existing directory, relative to the repo root, that contains every file the task lists. When a task creates a new directory, that is often the repo root; `locked` and the feature suite then cover the whole repo, which is correct but slower.

## Before the first task

1. The user approved the plan. A `/teeth-build <plan>` invocation counts as approval; if the plan reached you another way and you cannot tell, ask.
2. The repo has vitest 3 in `node_modules`; Node 22+; `npm` and `rsync` are on the PATH.
3. `git branch --show-current` is not `main`, `master` or `develop`. Otherwise stop and ask for a branch.
4. The working tree is clean, unless the plan's last result block has status `blocked, review finding`; then go to step 7 with the tree as it is. Otherwise stop and ask the user to commit, stash or stop.
5. Cache: `~/.cache/teeth-build` unless the user names another directory. If the sandbox blocks writes there, every command exits 3; ask the user to allow the directory or name a writable one.
6. In a Nuxt repo, `.nuxt/` exists. Otherwise ask the user to run `npx nuxi prepare`.
7. Resume: read the plan. Skip a task whose `teeth-build result` block says `done`, `done, waiver pending`, `done, not mutation-checked` or `done, review overridden`. For a `blocked` task, ask the user whether to retry it. For `blocked, review finding`, show its `review:` line and `git status --short`, and ask override, retry or stop as in Review step 5. A task with no result block and a dirty working tree: show `git status --short` and ask the user to discard those edits or stop.

## Per task

### 1. Route

- The task has a line `**Route:** relay`, `gate` or `refactor`: use it.
- Otherwise `relay` when every production file the task creates or modifies is under a `helpers/` directory, or under a `mappers/` directory whose spec files contain neither `vi.stubGlobal` nor `vi.mock` (`rg -l 'vi\.(stubGlobal|mock)' <that mappers dir>` prints nothing).
- Otherwise `gate`.

### 2. Baseline

Run `G baseline F`. Exit 2: the feature suite was red before the task; stop and report. Exit 3: stop and show the message.

### 3a. Relay path

1. Contract: copy from the plan task its files, exported names with full signatures, behaviour, and acceptance criteria. If an export the tests will call has no signature, stop and ask.
2. Stubs: write every new export with the planned signature and a body that returns without throwing (`return undefined as never` for a value, an empty body for `void`). Leave existing exports alone.
3. Dispatch the writer (see Agents) in write mode with the contract, the stub paths and the feature path.
4. `G red F`. Exit 1, or exit 2 (a spec does not load): send the output to the writer. This is a red round.
5. `G locked --record F`.
6. Dispatch the implementer in relay mode with the contract and the locked test paths.
7. Green checks, in this order. A failure goes back to the implementer as a green round:
   - `G locked --verify F`. On exit 1, run `G locked --restore F` first, then send the printed paths.
   - `(cd <repo> && CI=1 node_modules/.bin/vitest run <feature> --no-cache)` exits 0.
   - `G scope F --allow <list>`. The list, comma-separated and repo-relative: every file the plan task names (production and test), plus, on the relay and refactor paths, the test files the writer reported. On exit 1 the implementer reverts the printed paths.
   - `G cases F`. On exit 1, send the removed cases, unless the plan task names that removal.
8. `G mutants F`.
   - Exit 0: go to Review.
   - Exit 1: send the findings to the writer in repair mode (a mutants round). For `no assertion evidence`, tell the writer that the gate reads only the first failing test of each mutant, so the repair case must come before any test that crashes on that mutant. Run the feature suite; a failing repair test goes back to the writer once, and if the writer reports that the implementation is wrong, the task is `blocked`. Then rerun `G scope F --allow <list>` (the list from step 7 plus the repair test files) and `G cases F`; a failure goes back to the writer as a mutants round. Then `G locked --record F` and `G mutants F` again; the targeted mutants must be gone from the findings.
   - Exit 2: send the output to the implementer (a green round).
   - Exit 3 with `run: relay-gate.mjs setup`: see Setup. Any other exit 3: stop and show the message.

### 3b. Gate path

Dispatch the implementer in gate mode; it writes tests and code. Run the green checks of 3a step 7 without the `locked` line, then `G mutants F`. Findings go back to the implementer (a mutants round); after its fix, run the green checks again before the next `G mutants F`. Exit 0: go to Review.

### 3c. Refactor path

Run `G locked --record F` right after the baseline. Dispatch the implementer in refactor mode. Run the green checks of 3a step 7; `G cases F` must exit 0 with no exception. Then `G mutants F`; findings go to the writer in repair mode as in 3a step 8, because new tests on a refactor pin existing behaviour. Exit 0: go to Review.

### Setup

The first `mutants` in a repo without the Stryker install exits 3 with `run: relay-gate.mjs setup --root <repo>`. `setup` installs two npm packages into the cache directory, not into the repo. Ask the user to approve it, then run `G setup --root <repo> --cache-dir <cache>` (needs network access to `registry.npmjs.org`) and run `mutants` again.

### Repair cap

A round is one return of work to an agent. Each loop (red, green, mutants) gets two rounds per task. A third failure in the same loop makes the task `blocked`: commit nothing, write the result block with the last gate output, stop the run and tell the user.

### Equivalent mutants

You may propose a surviving mutant as `equivalent` when its replacement cannot change behaviour any caller can observe, with a one-line reason. You never approve your own proposal. A task whose only remaining findings are proposed equivalents goes to Review, and on `clear` is committed with status `done, waiver pending`.

### Decisions and assumptions

Keep two lists for the task while it runs. One line per entry.

Decisions: add one when
- the route was inferred, not read from a `**Route:**` line;
- the feature is the repo root because no deeper existing directory holds every file;
- you chose a value the plan task does not state;
- the writer or implementer reported that the contract or a test is wrong, with how it was resolved;
- two lines of the plan task clash, with the line the work followed. Do not resolve a clash silently: the reviewer gets it and the user decides.

Assumptions: copy each assumption from the writer's and implementer's reports, prefixed with `writer:` or `implementer:`.

An empty list is written `none`.

### Review

Once per task diff, before Done: after `mutants` exits 0, or exits 1 when every remaining finding is a proposed equivalent (§ Equivalent mutants).

1. Evidence first: print the command of the last run of each gate with its exit code and decisive line (the summary line for `mutants`, the last line for the suite). Show raw output only when the user asks.
2. Packet, in this order:
   - the contract (3a step 1; on the gate and refactor paths, the same fields copied from the plan task);
   - the diff: `git -C <repo> diff HEAD`, then `git -C <repo> diff --no-index -- /dev/null <path>` for each path that `git -C <repo> ls-files --others --exclude-standard` prints;
   - the task's `checks`, decisions and assumptions (see Done), and its proposed equivalents, if any;
   - the last `mutants` output, verbatim.
   If you cut anything for length, add a line `truncated: <what>`.
3. Dispatch the reviewer (see Agents) with `references/reviewer.md` and the packet. Never dispatch a second reviewer on the same diff. If the reply's first non-empty line is not a `verdict:` line, send one message to the same reviewer agent asking for the report form; that is a format repair of the same review, not a second review. A second reply without one counts as `verdict: blocking finding` with `finding: reviewer returned no verdict`.
4. `verdict: clear`: go to Done. Copy the `not proved` items into the `review:` line.
5. `verdict: blocking finding`: write the result block with status `blocked, review finding` and the reviewer's `finding` lines on the `review:` line. Commit nothing. Show the findings and ask the user to choose:
   - override: the user gives a reason. Change the status to `done, review overridden`, add the reason to the `review:` line, and commit as in Done.
   - retry: the user corrects the plan task. Show `git status --short` and ask the user to discard the task's edits. Then run the task again from Route; its new diff gets its own review.
   - stop: the run ends and the working tree stays as it is.

### Done

1. Append under the task's heading in the plan file:

   ```markdown
   **teeth-build result (T3):** done
   - base: 1a2b3c4, route: relay
   - tests: 4 red-proven, 1 mutation-proven repair
   - planned removals: none
   - mutants: 23 killed of 25; timed out: none; invalid: none
   - not covered: src/x/Badge.vue:3 template
   - proposed equivalents: src/x/clamp.ts:4 EqualityOperator → `n <= max` (n equal to max returns max either way)
   - rounds: red 0, green 1, mutants 1
   - checks: baseline 0; red 1, 0; locked --verify 0; suite 0; scope 0; cases 0; mutants 1, 0
   - review: clear; not proved: src/x/Badge.vue:3 template output
   - decisions: route inferred as relay (helpers/)
   - assumptions: implementer: callers pass finite numbers
   ```

   The `tests` line depends on the path: relay `N red-proven, M mutation-proven repair`; gate `N written by implementer, M mutation-proven repair`; refactor `N new, M mutation-proven repair`. `planned removals` lists each `cases` line the plan task names, or `none`. The status is `done`, `done, waiver pending`, `done, not mutation-checked` or `blocked`. Use `done, not mutation-checked` when N in `killed of N` is 0 and the block lists at least one `not covered` line: the gate tested none of the task's changes, for example a template-only change. `killed of N` counts `passed` against `passed` plus findings plus `timed out` from the last `mutants` summary. `checks` lists each gate in run order with every exit code it returned, the last one decisive; a gate the path does not run is left out. The status list adds `done, review overridden` and `blocked, review finding`.
2. Commit the task's files through the `commit` skill; when the plan file lives inside the repo, commit it in the same commit, so the next `baseline` finds a clean tree. Never push. A `blocked` task writes its result block and commits nothing; the run stops there.

## After the last task: waiver review

List every proposed equivalent from all result blocks (task, `file:line mutator → replacement`, reason) and ask the user to approve or reject each one. Mark an approved one `approved` in its result block. For a rejected one, reopen its task: the writer (relay, refactor) or the implementer (gate) gets the mutant. Run the feature suite, then `G mutants F --base <base from that task's result block>`. A fresh baseline would see no changed lines, because the task's code is already committed. The rejected mutant must no longer be a finding; findings on lines from later tasks belong to those tasks. Commit the follow-up as a new commit and update the result block.

Then list every task with status `done, not mutation-checked` and its `not covered` lines, and ask the user to accept each one. Append `, accepted` to an accepted status. For a rejected one, tell the user that no gate checks those lines and leave the follow-up to them. The run is done when no waiver is pending and the user has answered for every `done, not mutation-checked` task.

## Agents

Dispatch all three with the Agent tool, `subagent_type: "general-purpose"`, and paste the prompt file's content into the dispatch.

| Role | Prompt | Model | Effort |
|---|---|---|---|
| Writer | `references/writer.md`, the mode, the contract | not set (session model) | not set |
| Implementer | `references/implementer.md`, the mode, the contract | `sonnet` | `medium` |
| Reviewer | `references/reviewer.md`, the packet | not set (session model) | not set |

If the Agent tool in this harness has no `effort` parameter, pin `model` only and say so in the first result block. The writer decides which defects matter, and no gate sees all of that, so it stays on the session model. The implementer works behind the `red`, `locked`, `scope`, `cases`, suite and `mutants` gates. The reviewer judges whether tests and code fit the contract, which no gate sees, so it stays on the session model. Dispatch it as a new agent, never a fork: a fork inherits this conversation.

## Limits

- The writer is told not to read the implementation; nothing enforces it. For new exports there is only the stub to read.
- Gate limits (templates, macros, unsupported extensions, line ranges): `references/cli.md` § Limits.
- Relay on composables and components is unproven: their specs stub auto-imported names, which the writer must guess. Use `**Route:** relay` there only as a pilot.
- The reviewer's verdict is a judgment, not a gate. `scripts/review-eval.mjs` measures it on two fixture packets only, and its 300 s timeout path has no test. The reviewer can read any repo file; its fresh context is the Agent tool's, not enforced here.
