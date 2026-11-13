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

**Create `src/other.ts`**
<!-- skeleton {"id":"t1-greet","path":"src/greet.ts","op":"create"} -->
```ts
export const greet = (name: string): string => `hi ${name}`
```

*Below this line: for the implementer, the gates and the reviewer.*

### Task 1: Helper

**Files:** Create `src/greet.ts`. Modify `src/app.ts`.
**Interfaces:** Produces `t1-greet`.
