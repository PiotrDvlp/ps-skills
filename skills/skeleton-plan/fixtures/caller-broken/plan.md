---
title: Greeting fixture
base: HEAD
---

# Greeting

## 1. Files

| Action | File | Change |
|---|---|---|
| Modify | `src/greet.ts` | add punctuation |

## 2. Interfaces

**Replace in `src/greet.ts` — `greet`**
<!-- skeleton {"id":"t1-greet","path":"src/greet.ts","op":"replace","selector":"function:greet"} -->
```ts
export function greet(name: string, punctuation: string): string {
  return `hi ${name}${punctuation}`;
}
```

*Below this line: for the implementer, the gates and the reviewer.*

### Task 1: Greeting

**Files:** Modify `src/greet.ts`.
**Interfaces:** Produces `t1-greet`.
