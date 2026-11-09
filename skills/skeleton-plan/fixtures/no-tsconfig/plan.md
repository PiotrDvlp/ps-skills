---
title: Greeting fixture
base: HEAD
---

# Greeting

## 1. Files

| Action | File | Change |
|---|---|---|
| Create | `src/greet.ts` | the helper |

## 2. Interfaces

**Create `src/greet.ts`**
<!-- skeleton {"id":"t1-greet","path":"src/greet.ts","op":"create"} -->
```ts
export const greet = (name: string): string => `hi ${name}`;
```

*Below this line: for the implementer, the gates and the reviewer.*

### Task 1: Greeting

**Files:** Create `src/greet.ts`.
**Interfaces:** Produces `t1-greet`.
