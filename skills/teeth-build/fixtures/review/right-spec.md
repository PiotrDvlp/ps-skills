## Contract

Task T1: clamp helper

Files:
- Create: `helpers/clamp.ts`

`export function clamp(n: number, min: number, max: number): number` returns `n` limited to `min`..`max`, both ends included. It throws `RangeError('min > max')` when `min` is greater than `max`.

## Diff

```diff
diff --git a/helpers/clamp.ts b/helpers/clamp.ts
new file mode 100644
--- /dev/null
+++ b/helpers/clamp.ts
@@ -0,0 +1,4 @@
+export function clamp(n: number, min: number, max: number): number {
+  if (min > max) throw new RangeError('min > max')
+  return Math.min(Math.max(n, min), max)
+}
diff --git a/helpers/__tests__/clamp.test.ts b/helpers/__tests__/clamp.test.ts
new file mode 100644
--- /dev/null
+++ b/helpers/__tests__/clamp.test.ts
@@ -0,0 +1,24 @@
+import { describe, expect, it } from 'vitest'
+import { clamp } from '../clamp'
+
+describe('clamp', () => {
+  it('returns max for a value above the range', () => {
+    expect(clamp(5, 0, 3)).toBe(3)
+  })
+
+  it('returns min for a value below the range', () => {
+    expect(clamp(-1, 0, 3)).toBe(0)
+  })
+
+  it('returns a value inside the range unchanged', () => {
+    expect(clamp(2, 0, 3)).toBe(2)
+  })
+
+  it('returns the bound when min equals max', () => {
+    expect(clamp(1, 3, 3)).toBe(3)
+  })
+
+  it('throws when min is greater than max', () => {
+    expect(() => clamp(1, 4, 3)).toThrow(RangeError)
+  })
+})
```

## Checks

baseline 0; red 1, 0; locked --verify 0; suite 0; scope 0; cases 0; mutants 0

## Decisions and assumptions

Decisions:
- route inferred as relay (helpers/)
- feature is the repo root (helpers/ did not exist)

Assumptions: none

## Mutants output

```
0 findings, 8 passed, 0 timed out, 0 invalid, 0 not covered
```
