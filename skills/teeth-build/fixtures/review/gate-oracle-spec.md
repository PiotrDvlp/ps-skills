## Contract

Task T1: VAT amount

Files:
- Create: `helpers/vat.ts`
- Create: `helpers/__tests__/vat.test.ts`

`export function vatAmount(netCents: number): number` takes `netCents >= 0` and returns 19 % of it, rounded half up to whole cents. Example: `vatAmount(1000)` is `190`.

## Implementer's report

Round 1:
- files: helpers/vat.ts, helpers/__tests__/vat.test.ts; suite: pass
- `helpers/__tests__/vat.test.ts` › `takes 19 percent of the net amount`: catches a wrong rate. oracle: contract example.
- `helpers/__tests__/vat.test.ts` › `rounds a half cent up`: catches truncation or half-down rounding. oracle: roundCents(1050 * 0.19) from helpers/money.ts, run in a scratch script.

assumptions: none

## Diff

```diff
diff --git a/helpers/vat.ts b/helpers/vat.ts
new file mode 100644
--- /dev/null
+++ b/helpers/vat.ts
@@ -0,0 +1,3 @@
+export function vatAmount(netCents: number): number {
+  return Math.round(netCents * 0.19)
+}
diff --git a/helpers/__tests__/vat.test.ts b/helpers/__tests__/vat.test.ts
new file mode 100644
--- /dev/null
+++ b/helpers/__tests__/vat.test.ts
@@ -0,0 +1,12 @@
+import { describe, expect, it } from 'vitest'
+import { vatAmount } from '../vat'
+
+describe('vatAmount', () => {
+  it('takes 19 percent of the net amount', () => {
+    expect(vatAmount(1000)).toBe(190)
+  })
+
+  it('rounds a half cent up', () => {
+    expect(vatAmount(1050)).toBe(200)
+  })
+})
```

## Checks

baseline 0; suite 0; scope 0; cases 0; mutants 0

## Decisions and assumptions

Decisions:
- route read from the plan task (gate)
- feature is `helpers/`

Assumptions: none

## Mutants output

```
0 findings, 5 passed, 0 timed out, 0 invalid, 0 not covered
```
