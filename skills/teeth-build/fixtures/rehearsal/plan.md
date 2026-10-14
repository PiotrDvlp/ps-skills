# Rehearsal plan for teeth-build

Three tasks on a copy of `fixtures/mini`. Task 1 routes to relay by folder, Task 2 to gate, Task 3 to refactor by its Route line.

### Task 1: clamp helper

**Files:**
- Create: `helpers/clamp.ts`

`export function clamp(n: number, min: number, max: number): number` returns `n` limited to `min`..`max`, both ends included. It throws `RangeError('min > max')` when `min` is greater than `max`.

### Task 2: Badge caps at 99

**Files:**
- Modify: `components/Badge.vue`
- Modify: `components/__tests__/Badge.test.ts`

The label shows `99+` for counts above 99 and the count itself otherwise. The existing case `shows 9+ above nine` is replaced.

### Task 3: sum through reduce

**Route:** refactor

**Files:**
- Modify: `sum.ts`

`sum` returns `[a, b].reduce((x, y) => x + y, 0)`. Behaviour does not change.
