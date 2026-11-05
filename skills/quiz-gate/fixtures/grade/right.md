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
When total is 0 the function returns 0 before it divides. Without it, percent(0, 0) is 0/0 = NaN and percent(3, 0) is Infinity, so a caller with an empty total gets NaN or Infinity instead of 0.
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
It keeps n inside the range: a value below min comes back as min, a value above max comes back as max, anything in between comes back unchanged. If the line is removed, clamp returns undefined for every input, so callers get undefined instead of a number.
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
It turns the share into a whole-number percentage, rounded to the nearest integer, so percent(1, 3) is 33. Without Math.round it returns 33.33333333333333, and formatPercent would print the long decimal.
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
Yes. When min equals max, for example clamp(5, 3, 3), the original returns 3, but with min >= max it throws RangeError. So the change is not equivalent; a test with min === max would catch it.
```

## q5 (assumption)

Question: The build recorded these assumptions and decisions: implementer: callers pass finite numbers. Which one does this change depend on most, and what breaks if it is wrong?

Answer:

```text
It depends on callers passing finite numbers. The guard only catches total === 0, so if a caller passes NaN, say a total parsed from an empty string, percent returns NaN: Math.round(NaN) is NaN, and clamp(NaN, 0, 100) is NaN as well because Math.max and Math.min pass NaN through. The caller then shows NaN instead of a percentage.
```
