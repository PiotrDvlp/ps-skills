---
name: skeleton-plan
description: Use when an implementation plan should be written — "write the plan", "plan this", or right after a design was approved. The plan is short: a files table, interfaces as code blocks, and test cases as titles with one given/then line, above a line the user approves; tasks for the implementer go below it. A gate splices the code blocks into a scratch copy of the repo at the plan's base commit and typechecks it before the user sees the plan. Skip for building an existing plan (teeth-build, codex-build) or for a one-file change that needs no plan.
---

# skeleton-plan

You write an implementation plan whose approval part is code the gate can check. The user approves files, interfaces and test cases, not prose. Read `references/format.md` before you write the first plan: it has a whole example and every rule the gate enforces. `references/cli.md` lists every command, output line, exit code and receipt field.

Below, `C` stands for `node ${CLAUDE_SKILL_DIR}/scripts/check-plan.mjs`.

## 1. Start

Start after a design is approved, or when the user asks for a plan. If there is no design and the work is not obvious, ask whether to design first.

Where the plan goes: the path the user names. Otherwise, if the user's CLAUDE.md has a `Notes root: <dir>` line, `<dir>/<project>/plans/YYYY-MM-DD-<feature>.md`; else `docs/plans/YYYY-MM-DD-<feature>.md` in the repo. The gate writes `<plan>.receipt.json` next to the plan (`plan.md` gets `plan.receipt.json`); inside the repo, commit both or neither.

To have brainstorming hand over to this skill, a user can add one line to their CLAUDE.md:

```
After a design is approved, write the implementation plan with the skeleton-plan skill.
```

## 2. Scope and file structure

- **Scope check.** If the design covers several independent subsystems, propose one plan per subsystem. Each plan must produce working, testable software on its own.
- **File structure.** Before any block, decide which files are created, modified or deleted, and what each one is responsible for. One clear responsibility per file; files that change together live together; in an existing codebase, follow its patterns.
- **Base.** Pick the commit the implementer will start from: `git rev-parse --short HEAD` on a clean tree. It goes in the plan's YAML front matter as `base: <sha>`; the gate reads only that line and ignores uncommitted changes.

## 3. Write the plan

Format: `references/format.md`. Above the marker line:

1. Front matter with `base: <sha>`. Header: goal (one line), base commit, design link, and a `Gate:` line on its own (`Gate: pending` before the first run).
2. `## 1. Files`: one row per file, including test files and docs the plan changes.
3. `## 2. Interfaces`: one labelled block per splice operation. New exports are stubs with an explicit return type, a one-line JSDoc contract and a `return undefined as never` body. Then the "Signature unchanged, behaviour changed" list.
4. `## 3. Test cases`: exact test titles, each with one `Given ...; then ...` line, grouped by test file; a final `**No dedicated cases:**` line.

Below the marker: decisions table, then one `### Task N:` per task, then Acceptance and Rollback.

- **Task size.** A task is the smallest unit that carries its own test cycle and is worth a reviewer's gate. Fold setup, configuration and docs into the task whose deliverable needs them. Split only where a reviewer could reject one task and approve its neighbour.
- **What a task line contains.** Each line lets the implementer write exactly one reasonable thing. A code item is its signature and the values the spec fixes; the implementer writes the body. A body appears in `Decided here:` only for an algorithm or exact copy the signature and the tests do not decide. A verification line is a command and the output that means it passed.

### Self-review

Before the gate, check the plan against the design:

1. **Spec coverage.** Every requirement in the design has a block, a test case or a task line. Add what is missing.
2. **No empty lines.** No line that decides nothing: "TBD", "handle edge cases", "add validation", a type no block defines.
3. **No transcripts.** No body that the signature and the test cases already decide.
4. **Proportion.** The approval part is short against the design. If code blocks are most of the plan, replace bodies with stubs.

## 4. Run the gate

Run the gate only on a plan that you or your own session wrote. Prepare and typecheck run the plan's spliced code, for example a changed `nuxt.config.ts`, with your file and network access (`references/cli.md`, "Not a sandbox").

```bash
C --plan <plan.md> --repo <repo root>
```

Add `--cache-dir <dir>` when the default `~/.cache/skeleton-plan` is not writable. The status is the first output line and the exit code:

- **0 `passed`:** go on.
- **1 `format: ...` or `failed: ...`:** the plan is wrong. Fix it and rerun. A `caller broken` line names a file your signature change breaks: keep the signature compatible, or add the file with a block (TypeScript) or a files row (`.vue`).
- **3 `blocked: ...`:** the gate cannot judge the plan. Stop and report the reason to the user. Never work around it (do not change `base:` to dodge a broken baseline, do not drop blocks). `typescript not found ... run: check-plan.mjs setup`: ask the user to approve `C setup` (an npm install with network access), run it, then rerun the gate.
- **4 `passed with N ungated items`:** not a plain pass. Each `ungated:` line is a `.vue` block or a listed `.vue` caller that no typecheck saw. Name every item to the user.
- **5 `not typechecked: no TypeScript`:** the base has no `tsconfig.json`. There is no receipt.

After every run, whatever the status (also 1 and 3), set the header's `Gate:` line to `Gate: ` followed by the first line the gate printed, for example `Gate: passed with 2 ungated items` or `Gate: blocked: baseline broken`. That one line is not part of the approval hash, so writing it does not need another run.

## 5. Second review

If the `codex-review` skill is available, run `codex-review plan <plan.md>` before you show the plan. Fix what it finds. If a fix changes anything above the marker, rerun the gate.

## 6. Hand off

Show the plan only when its receipt matches it (status 0 or 4): run `C verify --plan <plan.md>` and expect `receipt matches`. It also checks that the `Gate:` line is the one the gate printed. For status 5, there is no receipt; say so.

Then give the user:

- the plan path and its gate status line, with every ungated item;
- what the second review found, in one line, or that it did not run;
- the build options that are installed (`teeth-build`, `codex-build`, or subagent-driven development) with a one-sentence recommendation from the plan: how many tasks, how much they depend on each other's interfaces, what a shipped mistake would cost.

Wait for the user's approval before anyone builds.

## Gotchas

- **The label is checked.** The bold line above each splice comment must contain the operation's verb, the path (or at least its last two segments) as one backticked token, and every selector name or inserted property in backticks: ``**Replace in `cart/cart.ts` — `addItem`**`` passes for `src/cart/cart.ts` with selector `function:addItem`; ``**Replace in `cart.ts` — `addItem`**`` and ``**Replace in `cart/cart.ts` — addItem**`` fail.
- **The files row must fit the op.** `create` needs a `Create` row, `delete-file` a `Delete` row, every other op a `Modify` row.
- **Produces signatures are matched word for word.** ``Produces `t1-greet`: `greet(name: string): string` `` fails when the block says `const greet = (name: string): string =>`. Copy the text from the block.
- **A replace removes the JSDoc above the declaration.** Include the JSDoc in the block when the declaration should keep one.
- **Stubs meet the repo's own compiler flags.** Under `noUnusedParameters` or `noUnusedLocals`, a stub that ignores its parameters, or an import only the future body will use, fails the typecheck. Reference the parameter (`void quantity;`) or leave the import to the task.
- **Do not write other `<!-- skeleton ... -->` comments.** The parser reads every HTML comment that starts with `skeleton` as a splice comment.
- **Edits below the marker do not touch the receipt,** except that each task's `Produces` signatures must still match the blocks.
- **The gate reads `base:`, not your working tree.** A file you created but did not commit does not exist for the gate.
