---
name: teeth-build
description: Use when a plan's tasks should be built with tests that have teeth — a Stryker gate on changed lines, red-first tests, locked test files. Phase 1 ships the relay-gate CLI only.
---

# teeth-build

Phase 1 is the `relay-gate.mjs` CLI. It checks one task's work in a vitest 3 repo: the new tests fail first, the test files stay locked, and a Stryker run on the changed lines finds mutants the tests do not kill. The controller loop that drives it arrives in phase 2. The report is evidence for a developer, not an instruction to change code.

## Run

This skill runs on macOS and Linux only. Node 22+ is required.

```bash
node ${CLAUDE_SKILL_DIR}/scripts/relay-gate.mjs <command> --root /path/to/your/repo --task T1 --feature src/features/cart
```

Commands:

- `setup --root R [--cache-dir D]`: install Stryker 10.0.0 once per repo into `<cache>/<sha1 of root>/tool`. A complete install is kept; a partial one is deleted and reinstalled. `--cache-dir` overrides `~/.cache/teeth-build`. Needs network access to the npm registry and write access to the cache directory. Run it only after the user approves the install. `--task` and `--feature` are not needed.
- `baseline`: needs a clean working tree. Runs the feature suite, and writes `baseline.json` (HEAD sha and test list) only when the suite is green.
- `red`: lists the tests now, compares with the baseline, and checks that every new test fails with an assertion.
- `locked --record | --verify | --restore`: records the feature's test files (`*.test.*` and `*.spec.*` with a `js`, `ts`, `jsx`, `tsx`, `mjs`, `cjs`, `mts` or `cts` extension) and every file under a `__snapshots__` directory, reports changes to them, or rewrites them to the recorded bytes. `--restore` is the only command that writes to the target repo's working tree: it overwrites modified and deleted test files and deletes added ones.
- `mutants [--base SHA] [--cache-dir D]`: copies the repo to a work directory, runs Stryker on the changed lines of `.ts` and `.vue` files under `--feature`, and prints one line per finding. `--base` defaults to the sha stored by `baseline`.

Required for every command except `setup`: `--root`, `--task` (letters, digits, `_`, `.`, `-`; names the state directory), `--feature` (repo-relative path). The state directory is `<os temp>/teeth-build/<sha1 of root>/<task>`.

Exit codes:

- `0`: pass.
- `1`: findings.
- `2`: the code under test is not green (vitest failed, or Stryker wrote no report).
- `3`: usage or setup problem. Messages include `--root, --task and --feature are required`, `invalid --task`, `no baseline; run baseline` (from `red`), `no baseline; run baseline or pass --base` (from `mutants`), `vitest wrote no report`, `working tree not clean`, `vitest <version> not verified`, `root must be the git top-level`, `run: relay-gate.mjs setup --root <root>`, `run npx nuxi prepare`, `Stryker matched <n> of <m> changed files` (or `an unknown number of`), `unsafe inventory path`, `work directory overlaps the repo`, `another mutants run on this repo`, and `base <sha> is not an ancestor of HEAD; rerun baseline`.
- `130`: SIGINT or SIGTERM interrupted vitest or Stryker. Any other signal that kills Stryker exits 2 with `stryker killed by <signal>`.

`setup` exits 3 when the install is incomplete after `npm` ran. `unsafe ... directory` also exits 3. The state, cache, tool and work directories must be owned by you and set to owner-only 0700, and must not be symlinks. Delete the directory the message names, or `chmod 700` it if only the permissions are wrong, then rerun.

## Read the output

`red` prints one line per problem: `<spec> > <test name>: <reason>`.

- `no new tests`: the feature has no test that was absent from the baseline. Exit 1.
- `already passing`: the new test passes, so it was not written red-first.
- `crashed (<first line>)`: the new test failed without an assertion error.
- `skipped`: the new test is skipped, pending, or todo.
- `import error`: the spec file failed to load, so none of its tests ran.
- `not reported`: vitest listed the test but its report omitted it.
- `duplicate identity`: two tests share a spec and name.

`locked --verify` prints `modified: <path>`, `deleted: <path>` and `added: <path>`; exit 1 when any line prints. `--restore` prints only the differences that remain after restoring; normally nothing, exit 0.

`mutants` prints findings as `<file>:<line> <mutator> → <replacement> (<reason>)`, then the other lists, then a summary: `N findings, N passed, N timed out, N invalid, N not covered`.

Finding reasons:

- `Survived`: no test failed when the line changed.
- `NoCoverage`: no test covers the mutant. When no test reaches the file at all, the replacement reads `no test reaches this file`.
- `no assertion evidence`: a test failed, but not with an assertion error (a crash does not prove the test checks anything).
- `unattributed`: Stryker marked the mutant killed without naming a killing test.
- `unknown status <status>`: Stryker returned a status this gate does not know.

Other lines:

- `not covered: <file>:<line> <reason>`: the line was not mutated. This does not fail the gate. Reasons:
  - `template`: a `.vue` template line; Stryker mutates `<script>` only.
  - `macro`: a `defineProps`, `defineEmits`, `defineModel`, `defineOptions`, or `withDefaults` call.
  - `unparsed`: the script block did not parse.
  - `two script blocks`: the `.vue` file has both `<script>` and `<script setup>`.
  - `glob characters in path`: the file path contains minimatch magic (for example Nuxt `pages/[id].vue`), so it is not mutated.
  - `no mutant inside the changed lines`: Stryker made no mutant for the line. A comment-only or type-only change passes this way, with its lines listed here. The `not covered` count in the summary includes every `not covered` line printed.
- `timed out: <file>:<line> <mutator>`: the mutant ran past its timeout. It is listed as `timed out`; it is not a finding and does not fail the gate.
- `invalid: <file>:<line> <mutator>`: the mutant did not compile or crashed at start-up. It is not evidence either way.
- `no changed mutable lines`: nothing to mutate; exit 0.

## Prerequisites

1. `npm` (used by `setup`) and `rsync` (used by `mutants`) must be on the PATH.
2. Run `setup` once per repo, after the user approves the install.
3. In a Nuxt repo, run `npx nuxi prepare` first. `mutants` exits 3 with `run npx nuxi prepare` when `tsconfig.json` extends `.nuxt/` and that directory is missing.
4. The repo must have vitest 3 in `node_modules`. Any other major version exits 3. `.vue` files also need `@vue/compiler-sfc` and `@babel/parser` there.
5. `--root` must be the git top-level, and `--base` (or the baseline sha) must be an ancestor of HEAD.
6. Vite writes `.vite-temp` into the repo's `node_modules` during `mutants`. A sandbox that makes that `node_modules` read-only blocks the gate.

Do not edit files under `--feature` while a command runs. Stop `nuxt dev` and vitest watchers first. Run one `mutants` at a time per repo; a lock left by a killed run is replaced on the next run.

`baseline` and `red` run vitest with `CI=1`, so it writes no snapshots; vitest still writes `node_modules/.vite-temp`. `locked --record` and `locked --verify` write nothing to the repo. `mutants` writes only to the cache work directory, never to the repo, apart from the `.vite-temp` file above. The work copy leaves out `.git`, `node_modules`, `.env*`, and the top-level `reports`, `.output` and `.stryker-tmp`, so a suite that needs values from `.env` fails under Stryker (exit 2).

## Limits

- Template lines are not mutated; a test that pins template output can still be toothless.
- Files with two script blocks are not covered.
- Vitest 4 is refused (`vitest 4.x not verified`).
- Only `.ts` and `.vue` files that are not test files (`*.test.*`, `*.spec.*`) are checked.
- A mutant is created only when its whole node lies inside the changed lines. A mutant whose node starts or ends on an unchanged line is not generated (for example a change inside a multi-line chain), and its line shows `no mutant inside the changed lines`. Whole-file mutation is a phase-2 decision.
- For `mutants`, a test that fails with a message starting `expected ` (for example a thrown plain `expected 1` error) counts as assertion evidence, the same as `AssertionError`.
- Only test files under `--feature` are locked. Tests outside it and shared test shims are not; phase 2 closes this because the controller will reject any changed path outside the task's planned files.
- Phase 2 (the controller loop) is not built.

## Developing this skill

From the skill directory, run `node --test scripts/*.test.mjs`. Set `TEETH_BUILD_VITEST_ROOT` to a repo with vitest 3 installed, and optionally `TEETH_BUILD_CACHE`, to run the integration tests.
