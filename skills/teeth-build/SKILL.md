---
name: teeth-build
description: Use when an approved implementation plan should be built task by task with tests that have teeth — "/teeth-build <plan>", "teeth-build this plan", "build this plan with a mutation gate". Each task ends with a Stryker gate on its changed lines; relay tasks get red-first tests from a separate writer, locked before the implementer starts. Skip for auditing existing tests (test-teeth) or Codex-implemented tasks (codex-build).
---

# teeth-build

You are the controller. You run an approved implementation plan one task at a time, dispatch a test writer and an implementer, and run the gates in `scripts/relay-gate.mjs`. You write no tests and no production code yourself, except the stubs in relay step 2. Read `references/cli.md` before the first command: it lists every subcommand, exit code and output line.

Below, `G` stands for `node ${CLAUDE_SKILL_DIR}/scripts/relay-gate.mjs` and `F` for `--root <repo> --task <task id> --feature <feature> --cache-dir <cache>`, with the same `<cache>` for the whole run. In a shell, define `G() { node ${CLAUDE_SKILL_DIR}/scripts/relay-gate.mjs "$@"; }` and pass `F` as separate arguments; zsh does not split one string variable into words. Task id: `T` plus the plan's task number. Feature: the nearest existing directory, relative to the repo root, that contains every file the task lists. When a task creates a new directory, that is often the repo root; `locked` and the feature suite then cover the whole repo, which is correct but slower.

## Before the first task

1. The user approved the plan. A `/teeth-build <plan>` invocation counts as approval; if the plan reached you another way and you cannot tell, ask.
2. The repo has vitest 3 in `node_modules`; Node 22+; `npm` and `rsync` are on the PATH.
3. `git branch --show-current` is not `main`, `master` or `develop`. Otherwise stop and ask for a branch.
4. The working tree is clean. Otherwise stop and ask the user to commit, stash or stop.
5. Cache: `~/.cache/teeth-build` unless the user names another directory. If the sandbox blocks writes there, every command exits 3; ask the user to allow the directory or name a writable one.
6. In a Nuxt repo, `.nuxt/` exists. Otherwise ask the user to run `npx nuxi prepare`.
7. Resume: read the plan. Skip a task whose `teeth-build result` block says `done` or `done, waiver pending`. For a `blocked` task, ask the user whether to retry it. A task with no result block and a dirty working tree: show `git status --short` and ask the user to discard those edits or stop.

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
   - Exit 0: go to Done.
   - Exit 1: send the findings to the writer in repair mode (a mutants round). For `no assertion evidence`, tell the writer that the gate reads only the first failing test of each mutant, so the repair case must come before any test that crashes on that mutant. Run the feature suite; a failing repair test goes back to the writer once, and if the writer reports that the implementation is wrong, the task is `blocked`. Then rerun `G scope F --allow <list>` (the list from step 7 plus the repair test files) and `G cases F`; a failure goes back to the writer as a mutants round. Then `G locked --record F` and `G mutants F` again; the targeted mutants must be gone from the findings.
   - Exit 2: send the output to the implementer (a green round).
   - Exit 3 with `run: relay-gate.mjs setup`: see Setup. Any other exit 3: stop and show the message.

### 3b. Gate path

Dispatch the implementer in gate mode; it writes tests and code. Run the green checks of 3a step 7 without the `locked` line, then `G mutants F`. Findings go back to the implementer (a mutants round); after its fix, run the green checks again before the next `G mutants F`.

### 3c. Refactor path

Run `G locked --record F` right after the baseline. Dispatch the implementer in refactor mode. Run the green checks of 3a step 7; `G cases F` must exit 0 with no exception. Then `G mutants F`; findings go to the writer in repair mode as in 3a step 8, because new tests on a refactor pin existing behaviour.

### Setup

The first `mutants` in a repo without the Stryker install exits 3 with `run: relay-gate.mjs setup --root <repo>`. `setup` installs two npm packages into the cache directory, not into the repo. Ask the user to approve it, then run `G setup --root <repo> --cache-dir <cache>` (needs network access to `registry.npmjs.org`) and run `mutants` again.

### Repair cap

A round is one return of work to an agent. Each loop (red, green, mutants) gets two rounds per task. A third failure in the same loop makes the task `blocked`: commit nothing, write the result block with the last gate output, stop the run and tell the user.

### Equivalent mutants

You may propose a surviving mutant as `equivalent` when its replacement cannot change behaviour any caller can observe, with a one-line reason. You never approve your own proposal. A task whose only remaining findings are proposed equivalents is committed with status `done, waiver pending`.

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
   ```

   The `tests` line depends on the path: relay `N red-proven, M mutation-proven repair`; gate `N written by implementer, M mutation-proven repair`; refactor `N new, M mutation-proven repair`. `planned removals` lists each `cases` line the plan task names, or `none`. The status is `done`, `done, waiver pending` or `blocked`. `killed of N` counts `passed` against `passed` plus findings plus `timed out` from the last `mutants` summary.
2. Commit the task's files through the `commit` skill; when the plan file lives inside the repo, commit it in the same commit, so the next `baseline` finds a clean tree. Never push. A `blocked` task writes its result block and commits nothing; the run stops there.

## After the last task: waiver review

List every proposed equivalent from all result blocks (task, `file:line mutator → replacement`, reason) and ask the user to approve or reject each one. Mark an approved one `approved` in its result block. For a rejected one, reopen its task: the writer (relay, refactor) or the implementer (gate) gets the mutant. Run the feature suite, then `G mutants F --base <base from that task's result block>`. A fresh baseline would see no changed lines, because the task's code is already committed. The rejected mutant must no longer be a finding; findings on lines from later tasks belong to those tasks. Commit the follow-up as a new commit and update the result block. The run is done when no waiver is pending.

## Agents

Dispatch both with the Agent tool, `subagent_type: "general-purpose"`, and paste the prompt file's content into the dispatch.

| Role | Prompt | Model | Effort |
|---|---|---|---|
| Writer | `references/writer.md`, the mode, the contract | not set (session model) | not set |
| Implementer | `references/implementer.md`, the mode, the contract | `sonnet` | `medium` |

If the Agent tool in this harness has no `effort` parameter, pin `model` only and say so in the first result block. The writer decides which defects matter, and no gate sees all of that, so it stays on the session model. The implementer works behind the `red`, `locked`, `scope`, `cases`, suite and `mutants` gates.

## Limits

- The writer is told not to read the implementation; nothing enforces it. For new exports there is only the stub to read.
- Gate limits (templates, macros, unsupported extensions, line ranges): `references/cli.md` § Limits.
- Relay on composables and components is unproven: their specs stub auto-imported names, which the writer must guess. Use `**Route:** relay` there only as a pilot.
