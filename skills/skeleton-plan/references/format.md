# skeleton-plan format

A plan is one Markdown file in two parts. The part above the marker line is what the user approves: files, interfaces as code, test cases. The part below it is for the implementer, the gates and the reviewer. The gate reads only the approval part, except the `**Interfaces:**` lines of each task.

## Whole example

The names are neutral examples. Copy the shape, not the names.

````markdown
---
title: Cart quantity limit
base: 1a2b3c4
---

# Cart quantity limit

Goal: a cart line never holds more than 20 of one product.
Base `1a2b3c4`. Design: `docs/designs/2026-11-01-cart-limit.md`.
Gate: passed

## 1. Files

| Action | File | Change |
|---|---|---|
| Create | `src/cart/limits.ts` | the limit and the clamp |
| Create | `src/cart/limits.test.ts` | clamp cases |
| Modify | `src/cart/cart.ts` | `addItem` clamps; deletes `MAX_ITEMS` |

## 2. Interfaces

**Create `src/cart/limits.ts`**
<!-- skeleton {"id":"t1-limits","path":"src/cart/limits.ts","op":"create"} -->
```ts
/** Largest quantity one cart line may hold. */
export const MAX_QUANTITY = 20;
/** The quantity clamped to 1..MAX_QUANTITY; throws RangeError for a non-integer. */
export function clampQuantity(quantity: number): number {
  return undefined as never;
}
```

**Replace in `src/cart/cart.ts` — `addItem`; adds one import**
<!-- skeleton {"id":"t1-additem","path":"src/cart/cart.ts","op":"replace","selector":"function:addItem"} -->
```ts
import { clampQuantity } from './limits';
/** Adds the product or raises its line's quantity, clamped to MAX_QUANTITY. */
export function addItem(cart: Cart, productId: string, quantity: number): Cart {
  return undefined as never;
}
```

**Delete in `src/cart/cart.ts` — `MAX_ITEMS`**
<!-- skeleton {"id":"t1-maxitems","path":"src/cart/cart.ts","op":"delete-declaration","selector":"const:MAX_ITEMS"} -->
```ts
```

**Signature unchanged, behaviour changed**
- `mergeCarts` (`src/cart/cart.ts`): clamps each merged line.

## 3. Test cases

**`src/cart/limits.test.ts` (new)**
- `clampQuantity caps a quantity above the limit`
  Given 25; then 20.
- `clampQuantity rejects a fractional quantity`
  Given 1.5; then it throws RangeError.

**`src/cart/cart.test.ts`**
- `addItem clamps the line quantity`
  Given a line with 18 and an add of 5; then the line holds 20. Red today: the line holds 23.

**No dedicated cases:** `mergeCarts` clamping.

---

*Below this line: for the implementer, the gates and the reviewer.*

## Decisions

| Decision | Choice | Rejected option and why | Source |
|---|---|---|---|
| Where the limit lives | `limits.ts` | In `cart.ts`: the checkout also needs it | design, section 2 |

### Task 1: Quantity limit

**Files:** Create `src/cart/limits.ts`, `src/cart/limits.test.ts`; modify `src/cart/cart.ts`.
**Interfaces:** Produces `t1-limits`: `clampQuantity(quantity: number): number`, `t1-additem`: `addItem(cart: Cart, productId: string, quantity: number): Cart`, `t1-maxitems`. Consumes `Cart` (`src/cart/types.ts:3`).
**Route:** relay
Needs: none.
Decided here: `clampQuantity(0)` returns 1.

Verify: `npx vitest run src/cart`
Expected: exit 0, 3 tests passed.

## Acceptance

`npx vitest run` exits 0.

## Rollback

Revert the task's commit.
````

## Above the line

### Front matter

YAML front matter with a `base:` line. The value is any commit the repo's git can resolve (a sha, a branch, a tag). Use a short sha: `HEAD` and branch names move. The gate builds its scratch copy from this commit, so uncommitted changes in the checkout are not part of it. With no `base:` line the gate exits 3 with `blocked: base  is not a commit`.

### Header

One goal line, the base commit, a link to the design document if one exists, and the gate status on its own line:

```text
Gate: <the first line the gate printed>
```

The line starts with exactly `Gate: ` and sits above `## 1. Files`. The first such line is left out of the approval hash, so writing it after a run keeps the receipt valid. Everything else in the header is part of the hash: edit it after a gate run and the receipt no longer matches, so you rerun the gate. After every run, write the line the gate printed, also for a failure or a block (`Gate: blocked: baseline broken`). `check-plan.mjs verify` compares this line with the receipt (see `cli.md`).

### 1. Files

The heading must start with `## 1. Files`. One table row per file: action (`Create`, `Modify`, `Delete`), path in backticks, change in a few words. The table ends at the next `## ` heading.

- Every block's path must have a row; otherwise `format: not in files table <path> in <id> (line N)`.
- The row's action must fit the block's op: `create` needs `Create`, `delete-file` needs `Delete`, `replace`, `insert` and `delete-declaration` need `Modify`. Otherwise `format: row <Action> for <path> does not fit op <op> in <id>`.
- Name deleted declarations in their row.
- List files the plan changes with no block (test files, docs, `.vue` callers the gate reported). A `.ts` or `.vue` file with a type error that has no row fails the gate as `caller broken`; see "Status 1" in `cli.md`.

### 2. Interfaces

One block per splice operation, in this shape and with nothing between the three parts:

```text
**<verb> `<path>` — <what>**
<!-- skeleton {"id":"...","path":"...","op":"..."} -->
```ts
...
```
```

- **Label:** a bold line directly above the splice comment. It must name everything the block touches:
  - the verb for the operation: `create` is `Create`, `insert` is `Insert into`, `replace` is `Replace in`, `delete-declaration` and `delete-file` are `Delete in`;
  - the path as one backticked token that is the whole path or its last two or more segments (for `src/cart/cart.ts`: `` `src/cart/cart.ts` `` or `` `cart/cart.ts` ``; for a top-level file: the file name). `` `cart.ts` `` alone, `` `src/cart/cart.tsx` `` or an unquoted path does not count;
  - for `replace` and `delete-declaration`, every selector's name in backticks (`function:addItem` needs `` `addItem` ``);
  - for `insert` into `export-default`, the property name in backticks.

  Each missing item is `format: label "<label>" does not name <what> in <id> (line N)`, where `<what>` is `verb "<verb>"`, ``path `<tail>` ``, ``selector `<name>` `` or ``property `<name>` ``. Say after the names if the block adds imports.
- **Splice comment:** one line, exactly `<!-- skeleton {JSON} -->`. Any HTML comment whose text starts with `skeleton` is read as a splice comment; do not write other `<!-- skeleton... -->` comments in a plan. Bad JSON, a missing or non-string `id`, `path` or `op`, or a field below with the wrong type is `format: bad splice comment at line N`.
- **Code block:** the fence must be on the next line. Its language tag does not matter. A `delete-declaration` or `delete-file` block is an empty fence.

Contracts are one-line JSDoc on exported symbols. Every stubbed export has an explicit return type, and its body is `return undefined as never;` (or `=> undefined as never`). Keep framework wrappers such as a store factory: replace the whole declaration, not its inner functions.

After the blocks, a bold line `**Signature unchanged, behaviour changed**` followed by a bullet list: one line per declaration whose signature stays and whose behaviour changes. The gate does not check this list.

#### Splice comment fields

| Field | Values |
|---|---|
| `id` | Your name for the block, for example `t1-limits`. Tasks refer to it. |
| `path` | Repo-relative, `/` separators, normalised: no leading `/`, no `./`, no `..`, no trailing `/`. Ends in `.ts`, `.tsx`, `.mts`, `.cts` or `.vue` (any case). |
| `op` | `create`, `insert`, `replace`, `delete-declaration`, `delete-file` |
| `selector` or `selectors` | One string, or an array of strings. Never both: `format: selector and selectors both set`. |
| `after` | `"imports"` (with `insert`) |
| `into`, `property` | `"export-default"` and the new property's name (with `insert`) |

#### Operations

- `create`: the block is the whole new file. Fails with `failed: exists <path>` when the file exists at the base. Imports stay where you wrote them.
- `insert` with `"after":"imports"`: the code goes after the file's last import, after a blank line. A file with no imports gets it below the shebang, `///` and `// @ts-` pragma lines and the `'use ...'` prologue.
- `insert` with `"into":"export-default","property":"<name>"`: adds one property to the default export. The export must be an object literal or a call whose first argument is one (`export default defineConfig({ ... })`); otherwise `failed: no export-default object`. A property that already exists is `failed: property <name> exists`. Write the property as `name: value`; a trailing comma is removed.
- `replace`: the code takes the place of the selected declarations. With several selectors, the code goes where the earliest selected declaration was and the others are removed. Declarations between them stay.
- `delete-declaration`: removes each selected declaration.
- `delete-file`: removes the file. Fails with `failed: missing <path>` when it does not exist, and blocks with `blocked: uncovered: <path>` when the base commit's `tsconfig.json` does not include it (the typecheck could not see what the deletion breaks).

`create` and `delete-file` must be the only block for their path: `format: <op> must be the only block for <path>`. `replace`, `insert` and `delete-declaration` need the file to exist: `failed: missing <path>`.

#### Selectors

`kind:name`, where kind is `const`, `function`, `type`, `interface`, `class` or `enum`, and name is an identifier.

- Top-level statements only. Nested functions and object members cannot be selected.
- `const:x` selects the whole variable statement and also matches `let` and `var`. Destructured names cannot be selected.
- Consecutive `function` overloads of one name are one declaration.
- The selected range starts at the declaration's own `/**` JSDoc (the last one directly above it), else at the declaration. Plain comments, file headers, `///` directives and `// @ts-` pragmas stay. A replacement that should keep the JSDoc must include it. The `export` keyword is part of the declaration, so write it in the replacement.
- Selectors resolve against the base source, never against a file another block already changed.

Errors: unknown kind is `format: unknown selector kind <kind>`; a malformed selector is `format: bad selector <s>`; no match is `failed: selector <s>`; two separate matches is `failed: ambiguous <s>`.

Two blocks that select the same declaration, or whose edits overlap in one file, fail with `format: overlapping ...`.

#### Imports in a block

Leading `import` lines of a `replace` or `insert` block move to the file's import section. A line identical to an existing import is dropped; whitespace, a trailing `;` and spaces inside braces are ignored in the comparison. Imports that differ in any other way are added as separate lines, even from the same module.

#### `.vue` files

A block whose path ends in `.vue` (any case) is not spliced or typechecked. It still needs its files row and label. The gate lists it as ungated, so the best result is status 4. A plan whose blocks are all `.vue` is `blocked: no gated block`. A `.vue` file with a type error after the splice must have a files row: with the row it is ungated (status 4), without it the gate fails with `caller broken`.

### 3. Test cases

Grouped by test file, with the file path as a bold line. Each case is the exact test title, then one line `Given ...; then ...`. A regression test that is red today states the required behaviour and today's failure. End with `**No dedicated cases:**` and the behaviours no case covers. The gate does not read this section; the reviewer does.

### The marker

The approval part ends at a line that is exactly:

```text
*Below this line: for the implementer, the gates and the reviewer.*
```

Without it the gate exits 1 with `format: no approval marker`. Text below the marker does not count toward the approval hash, so you can edit tasks without rerunning the gate, as long as the `**Interfaces:**` lines still pass the format check.

### Every format message

The format check runs on the plan alone, before the gate exports any commit, so these exit 1 with nothing built. The splice repeats the selector, path, op and insert checks with the same messages.

| Message | Cause |
|---|---|
| `format: no approval marker` | No marker line. |
| `format: bad splice comment at line N` | A `<!-- skeleton` comment that is not exactly `<!-- skeleton {JSON} -->`, has bad JSON, or a missing or wrongly typed field. |
| `format: no code block after line N` | The line after a splice comment is not a fence. |
| `format: unclosed code block at line N` | The block's fence never closes. |
| `format: label "<label>" does not name <what> in <id> (line N)` | The label misses the verb, the path, a selector name or the property. |
| `format: not in files table <path> in <id> (line N)` | The block's path has no row. |
| `format: row <Action> for <path> does not fit op <op> in <id>` | The row's action does not fit the op. |
| `format: path <path> leaves the repo in <id> (line N)` | An absolute path or one with `..`. |
| `format: path <path> is not normalised` | Empty, `./`, `//`, a trailing `/`, or another form `posix.normalize` changes. |
| `format: path <path> is not a TypeScript or Vue file in <id>` | Not `.ts`, `.tsx`, `.mts`, `.cts` or `.vue`. |
| `format: unsupported op <op> in block <id>` | An op outside the five. |
| `format: <op> must be the only block for <path>` | `create` or `delete-file` shares its path with another block. |
| `format: insert needs after or into in block <id>` | `insert` with neither `"after":"imports"` nor `"into":"export-default"`. |
| `format: insert into export-default needs property in block <id>` | No `property`. |
| `format: bad selector <s>` | Not `kind:name`. |
| `format: unknown selector kind <kind>` | A kind outside the six. |
| `format: selector and selectors both set in <id> (line N)` | Both fields in one comment. |
| `format: overlapping <selector> in <path>: <id> and <id>` | Two blocks select the same declaration. The splice reports other overlapping edits as `format: overlapping <selector> (block <id>) and <selector> (block <id>) in <path>`. |
| ``format: signature `<s>` in Task N not found in <id>`` | A `Produces` value below the line that no block contains. |

## Below the line

- A decisions table: decision, choice, rejected option and why, source.
- One `### Task N: <name>` per task, each with:
  - `**Files:**` the task's files.
  - `**Interfaces:**` `Produces` then, for each block the task makes, the block id in backticks, then the full signatures in backticks: ``Produces `t1-limits`: `clampQuantity(quantity: number): number` ``. Then `Consumes` and what the task uses from other tasks or the repo.
  - `**Route:**` for a build skill that reads one (for example `relay`, `gate` or `refactor` in teeth-build).
  - `Needs:` the tasks that must be done first.
  - `Decided here:` what the blocks and the test titles leave open: exact copy the spec fixes, an algorithm, a constant.
  - One verification command and its expected output; `Negative proof:` where a check could pass without the change.
- Acceptance and Rollback sections.

### What the gate checks below the line

Only the `Produces` part of each `**Interfaces:**` line. After a block id, every backticked value up to the next block id must appear word for word in that block's code; a value before any id must appear in some block. A miss is ``format: signature `<s>` in Task N not found in <id>``. So copy signatures from the blocks: `clampQuantity(quantity: number): number` matches `export function clampQuantity(quantity: number): number {`, but `greet(name: string): string` does not match `export const greet = (name: string): string =>`. `Consumes` is not checked.

The Interfaces lines run until an empty line, a heading, a line that starts with `**`, or `Decided here`.
