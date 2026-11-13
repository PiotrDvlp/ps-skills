---
title: Example fixture
base: abc1234
---

# Example fixture

## 1. Files

| Action | File | Change |
|---|---|---|
| Create | `src/greet.ts` | the helper |
| Modify | `src/app.ts` | use the helper |

## 2. Interfaces

**Replace in `src/app.ts` — `run`**
<!-- skeleton {"id":"t1-run","path":"src/app.ts","op":"replace","selector":"function:run"} -->
```ts
export function run(): void {}
```

**Replace in `src/app.ts` — `run`**
<!-- skeleton {"id":"t2-run","path":"src/app.ts","op":"replace","selector":"function:run"} -->
```ts
export function run(): void {}
```

*Below this line: for the implementer, the gates and the reviewer.*

### Task 1: Helper

**Files:** Create `src/greet.ts`. Modify `src/app.ts`.
**Interfaces:** Produces `t1-run`.
