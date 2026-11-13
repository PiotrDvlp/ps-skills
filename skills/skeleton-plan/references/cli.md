# check-plan CLI reference

## Run

macOS and Linux only: `npm` and `npx` are spawned without a shell, and the directory checks need POSIX file ownership. Node 22+ and `git` on the PATH.

```bash
node ${CLAUDE_SKILL_DIR}/scripts/check-plan.mjs --plan <plan.md> --repo <repo root> [--cache-dir <dir>]
node ${CLAUDE_SKILL_DIR}/scripts/check-plan.mjs setup [--cache-dir <dir>]
node ${CLAUDE_SKILL_DIR}/scripts/check-plan.mjs verify --plan <plan.md>
```

- `--plan`: the plan file. The receipt is written next to it: `plan.md` gets `plan.receipt.json`.
- `--repo`: the repo's top-level directory. The gate reads the lockfile and `node_modules` from here.
- `--cache-dir`: the gate's working directory. Default `~/.cache/skeleton-plan`. Give `setup` and every gate run the same value.
- Missing `--plan` or `--repo` prints `blocked: usage: ...` and exits 3.
- `verify` checks a receipt against its plan; see "Check that a receipt matches the plan".
- `setup` installs `typescript@5.9.3` into `<cache>/tool` with `npm install --ignore-scripts --no-audit --no-fund`. It needs network access to the npm registry, so ask the user before you run it. A complete install is kept (`already complete: <dir>`); a partial one is deleted and installed again (`installed typescript@5.9.3 in <dir>`). Exit 0 on success.

## What a run does

1. Parses the plan and runs the format check: labels, files rows, orphan rows, paths, ops, selector syntax, insert fields, duplicate selectors and task signatures (every message is in `format.md`). Any violation: exit 1, one `format: ...` line per violation, before any lock, export or command. Edits that overlap only in the base source are found at the splice (step 9) as `format: overlapping ... (block <id>) ...`.
2. Takes a per-plan lock (`<cache>/runs/locks`) and deletes the plan's earlier receipt. A second run on the same plan while one is running: `blocked: another run on this plan`.
3. Exports the `base:` commit with `git archive` into a new run directory under `<cache>/runs`. Run directories older than 24 hours are deleted first.
4. Copies dependencies. When the base commit has a lockfile (`package-lock.json`, `pnpm-lock.yaml` or `yarn.lock`), the same file in `--repo` must be byte-identical, otherwise `blocked: dependencies differ from base`. Then the checkout's `node_modules` is copied into the scratch copy. Without a lockfile at the base, nothing is copied.
5. No `tsconfig.json` at the root of the base commit: exit 5, `not typechecked: no TypeScript`.
6. Loads TypeScript: the repo's (from the copied `node_modules`), else the one `setup` installed. Neither: `blocked: typescript not found in the repo or the gate install; run: check-plan.mjs setup`.
7. Picks an adapter. `nuxt.config.ts` at the base root: `nuxt`, which runs `npx --no-install nuxi prepare` before each typecheck, and copies the checkout's `generated` path, if present, into the scratch copy. Otherwise `tsc`, with no prepare step. The typecheck command is `npm run typecheck` when `package.json` has a `typecheck` script, else `node <tsc> --noEmit -p tsconfig.json`.
8. Reads the files the base's `tsconfig.json` includes (after the first prepare), then a baseline typecheck of the unchanged base. Any error: `blocked: baseline broken`, followed by the errors.
9. Splices the plan's blocks into the scratch copy and typechecks again.
10. Classifies the result, prints it and, for status 0 or 4, writes the receipt.

Prepare and typecheck each time out after 600 seconds.

**Not a sandbox.** Prepare and typecheck run the repo's own code at the base commit together with the plan's spliced TypeScript: `nuxt.config.ts` and its modules, the `typecheck` package script, and whatever they load. They run as you, with your network and file access, and no isolation. The gate itself only writes under `<cache>` and the receipt, and it never changes the checkout, but the commands it runs can do anything the repo's code does. Run it only on repos and plans you would run `npm run typecheck` on.

## Output and exit codes

The first line is the status. Errors and ungated items follow, one per line, as `<file>:<line>: <message>` and `ungated: <path>`. A passing run ends with `receipt: <plan>.receipt.json` (the `.md` replaced). Write the first line into the plan's header as `Gate: <first line>` after every run.

| Exit | First line | Meaning |
|---|---|---|
| 0 | `passed` | Every block spliced and the typecheck is clean. |
| 1 | `format: ...` or `failed: ...` | The plan is wrong. Fix it and rerun. |
| 3 | `blocked: ...` | The gate cannot judge the plan. Report the reason; do not work around it. |
| 4 | `passed with N ungated items` | Not a plain pass. The TypeScript part is clean, but N items were not typechecked. Each needs a human look. |
| 5 | `not typechecked: no TypeScript` | The base commit has no `tsconfig.json`. No receipt. |

### Status 1

Format errors are listed in `format.md`. Errors after the splice:

- `failed: selector <s>`, `failed: ambiguous <s>`, `failed: exists <path>`, `failed: missing <path>`, `failed: not a directory <path>`, `failed: no export-default object`, `failed: property <name> exists`: a block does not fit the base source.
- `failed: caller broken: <path>`: a `.ts`, `.tsx`, `.mts`, `.cts` or `.vue` file with no row in the files table has a type error. A changed signature broke a caller. Keep the signature compatible, or add the caller to the files table with a block that fixes it.
- `failed: typecheck reported N diagnostics`: errors in files the table lists. Fix the blocks.
- `failed: typecheck exited N without diagnostics`: the typecheck failed but printed no error line the gate can read. There is no receipt on a failure; run the adapter's typecheck command (see "What a run does", step 7) by hand on a branch with the blocks applied to see what it prints.
- `failed: plan changed during the run`: the plan's approval part changed while the gate ran. Rerun.

### Status 3

- `blocked: base <ref> is not a commit`: the `base:` value does not resolve in `--repo`.
- `blocked: baseline broken`: the base commit does not typecheck before any change. The gate cannot tell your errors from existing ones.
- `blocked: dependencies differ from base`: the checkout's lockfile is missing or differs from the base commit's. Install dependencies for the base commit, or move `base:` to the checkout's commit.
- `blocked: prepare failed (<reason>)`: `nuxi prepare` failed; the last 5 lines of its stderr follow.
- `blocked: typecheck could not run`: the typecheck command did not start, was killed or timed out.
- `blocked: no gated block`: every block is `.vue`.
- `blocked: uncovered: <path>`: a block's file is not in the files `tsconfig.json` includes, so the typecheck would not see it. For a `delete-file` block, the base commit's `tsconfig.json` must include the deleted file.
- `blocked: target leaves snapshot <path>`, `blocked: link leaves snapshot: <path>`, `blocked: dependency link leaves snapshot: <path>`: a path resolves, through a symlink, outside the scratch copy.
- `blocked: tsconfig unreadable`: `tsconfig.json` is not valid.
- `blocked: unsafe <label> <path>: <reason>`: a cache directory is a symlink, is not owned by you, or is not owner-only (0700). Fix or delete that directory.
- `blocked: another run on this plan`, `blocked: snapshot export failed: ...`, `blocked: snapshot extract failed: ...`, `blocked: dependency clone failed: ...`.

A sandbox that blocks writes to the cache directory also exits 3, with the operating system's error after `blocked:`. Ask the user to allow the directory, or pass a writable `--cache-dir`.

### Status 4

Two sources of ungated items, each printed as `ungated: <path>`:

- a block whose path ends in `.vue`;
- a `.vue` file with a type error after the splice that has a files row, when every error is in a `.vue` file.

A `.vue` file with a type error and no files row is `failed: caller broken` (status 1): add it to the files table and rerun. Errors in `.vue` files and `.ts` files together are status 1.

## Receipt

`plan.receipt.json` next to `plan.md` (a plan path without `.md` gets `.receipt.json` appended), written only for status 0 and 4, through a temp file and a rename. Every run deletes the old receipt first, so a receipt on disk belongs to the last run. It is written only if the plan's approval part is unchanged since the run started.

| Field | Content |
|---|---|
| `approvalHash` | sha256 over the approval part and every block's fields and code. Text below the marker, the `Gate:` line above `## 1. Files` and block line numbers do not count; trailing whitespace and extra blank lines are normalised away first (see `format.md`, "Header"). |
| `blockHashes` | `{ id, path, hash }` per block; the hash leaves out the line number. |
| `baseCommit` | The full sha `base:` resolved to. |
| `generatedInputs` | Fingerprint of each generated input copied from the checkout (`nuxt` adapter only). |
| `lockfileHash` | sha256 of the base lockfile, or `null`. |
| `nodeVersion` | Node version of the run. |
| `typescript` | `{ version, source }`; source `repo` or `gate`. |
| `adapter` | `tsc` or `nuxt`. |
| `commands` | `{ step, command, exitCode, durationMs }` per step: `prepare`, `baseline typecheck`, `typecheck`. Only the prepare and typecheck commands; `git archive`, `tar` and the dependency copy are not listed. |
| `status` | `passed` or `passed-ungated`. |
| `ungated` | The ungated paths. |

### Check that a receipt matches the plan

```bash
node ${CLAUDE_SKILL_DIR}/scripts/check-plan.mjs verify --plan <plan.md>
```

Prints `receipt matches` and exits 0 only when all three hold:

- the plan still hashes to the receipt's `approvalHash`;
- the receipt's `status` is `passed` or `passed-ungated` (otherwise `receipt stale: the receipt status <status> is not a pass`);
- the plan's `Gate:` line is the line the gate printed for the receipt's status: `Gate: passed`, or `Gate: passed with N ungated items` with N the receipt's number of ungated items.

Otherwise it exits 1 with one of:

- `receipt missing: <path>`: no receipt. Run the gate.
- `receipt stale: the approval part changed`: rerun the gate.
- `receipt stale: the plan says "<line>", the receipt says "<line>"` or `receipt stale: the plan has no Gate line, ...`: write the line the receipt names.

A plan that fails the parse prints its `format: ...` line and exits 1.

## Test-only hooks

Honoured only under `node --test` (when `NODE_TEST_CONTEXT` is set); ignored otherwise.

- `adapterOverride`: an argument of `runGate()` that replaces adapter fields.
- `SKELETON_PLAN_TEST_AFTER_TYPECHECK`: path of a Node script, run as `node <value> <planPath>` after the second typecheck.

The suite: `node --test ${CLAUDE_SKILL_DIR}/scripts/*.test.mjs`.
