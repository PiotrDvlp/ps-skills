# Grader packet

Repo: none attached. Grade from the context blocks and hunks below.

## Plan task

Task 2: clamp and percent helpers

Add `helpers/clamp.ts` with `clamp(n, min, max)`: it returns `n` limited to `min`..`max` and throws `RangeError('min > max')` when `min > max`. Change `percent(part, total)` in `helpers/percent.ts` to return `0` when `total` is `0`, else a whole-number percentage. `shares` clamps each share to `0`..`100`.

Result block:
- proposed equivalents: helpers/clamp.ts:2 EqualityOperator → `min >= max`
- assumptions: implementer: callers pass finite numbers

## q1 (line) helpers/percent.ts:4

Question: `helpers/percent.ts:4` is `if (total === 0) return 0;` (context shown below). What does this line do, and what breaks if it is removed or changed?

Context:

```text
  1  import { clamp } from './clamp';
  2  
  3  export function percent(part: number, total: number): number {
> 4    if (total === 0) return 0;
  5    return Math.round(part / total * 100);
  6  }
  7  
```

Hunk:

```diff
@@ -1,5 +1,8 @@
+import { clamp } from './clamp';
+
 export function percent(part: number, total: number): number {
-  return part / total * 100;
+  if (total === 0) return 0;
+  return Math.round(part / total * 100);
 }
 
 export function formatPercent(value: number): string {
```

Answer:

```text
Stops a divide by zero; without it percent(x, 0) gives NaN or Infinity.
```

## q2 (line) helpers/clamp.ts:3

Question: `helpers/clamp.ts:3` is `return Math.min(Math.max(n, min), max);` (context shown below). What does this line do, and what breaks if it is removed or changed?

Context:

```text
  1  export function clamp(n: number, min: number, max: number): number {
  2    if (min > max) throw new RangeError('min > max');
> 3    return Math.min(Math.max(n, min), max);
  4  }
```

Hunk:

```diff
@@ -0,0 +1,4 @@
+export function clamp(n: number, min: number, max: number): number {
+  if (min > max) throw new RangeError('min > max');
+  return Math.min(Math.max(n, min), max);
+}
```

Answer:

```text
This line clamps n into the range by applying Math.max first and then Math.min. Because Math.min runs last against max, a value of n below min comes back as max, which is how clamp tells callers the input was out of range. If the line were removed, clamp would fall through and return n unchanged, so out-of-range values would leak through to callers.
```

## q3 (line) helpers/percent.ts:5

Question: `helpers/percent.ts:5` is `return Math.round(part / total * 100);` (context shown below). What does this line do, and what breaks if it is removed or changed?

Context:

```text
  2  
  3  export function percent(part: number, total: number): number {
  4    if (total === 0) return 0;
> 5    return Math.round(part / total * 100);
  6  }
  7  
  8  export function formatPercent(value: number): string {
```

Hunk:

```diff
@@ -1,5 +1,8 @@
+import { clamp } from './clamp';
+
 export function percent(part: number, total: number): number {
-  return part / total * 100;
+  if (total === 0) return 0;
+  return Math.round(part / total * 100);
 }
 
 export function formatPercent(value: number): string {
```

Answer:

```text
Rounds to a whole percent; without it percent(1, 3) is 33.33... instead of 33.
```

## q4 (equivalent) helpers/clamp.ts:2

Question: `helpers/clamp.ts:2` is `if (min > max) throw new RangeError('min > max');`. Mutation testing (`EqualityOperator`) replaced part of it with `min >= max` and no test failed. Can any caller see a difference? Explain why or why not.

Context:

```text
  1  export function clamp(n: number, min: number, max: number): number {
> 2    if (min > max) throw new RangeError('min > max');
  3    return Math.min(Math.max(n, min), max);
  4  }
```

Hunk:

```diff
@@ -0,0 +1,4 @@
+export function clamp(n: number, min: number, max: number): number {
+  if (min > max) throw new RangeError('min > max');
+  return Math.min(Math.max(n, min), max);
+}
```

Answer:

```text
No caller can see a difference. The only extra input the new check rejects is min === max, and that range is empty, so there is no value clamp could return for it anyway; for every real range both versions behave the same, which is why no test failed.
```

## q5 (assumption)

Question: The build recorded these assumptions and decisions: implementer: callers pass finite numbers. Which one does this change depend on most, and what breaks if it is wrong?

Answer:

```text
Finite numbers: a NaN input slips past the zero guard and through clamp, so callers get NaN.
```
