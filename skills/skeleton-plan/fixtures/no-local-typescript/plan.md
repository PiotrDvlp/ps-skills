---
title: Greeting fixture
base: HEAD
---

# Greeting

## 1. Files

| Action | File | Change |
|---|---|---|
| Create | `src/greet.ts` | the helper |
| Modify | `src/app.ts` | use the helper |

## 2. Interfaces

**Create `src/greet.ts`**
<!-- skeleton {"id":"t1-greet","path":"src/greet.ts","op":"create"} -->
```ts
export const greet = (name: string): string => `hi ${name}`;
```

**Replace in `src/app.ts` — `run`**
<!-- skeleton {"id":"t2-run","path":"src/app.ts","op":"replace","selector":"function:run"} -->
```ts
import { greet } from './greet';

export function run(): string {
  return greet('world');
}
```

*Below this line: for the implementer, the gates and the reviewer.*

### Task 1: Greeting

**Files:** Create `src/greet.ts`, modify `src/app.ts`.
**Interfaces:** Produces `t1-greet`, `t2-run`.
