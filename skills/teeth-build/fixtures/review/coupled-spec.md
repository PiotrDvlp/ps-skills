## Contract

Task T1: cart total

Files:
- Create: `cart/createCart.ts`

`export function createCart(): { add(price: number, qty: number): void; total(): number }` returns an empty cart. `add(price, qty)` puts a line in the cart. `total()` returns the sum of `price * qty` over all lines, in cents. An empty cart totals 0.

## Diff

```diff
diff --git a/cart/createCart.ts b/cart/createCart.ts
new file mode 100644
--- /dev/null
+++ b/cart/createCart.ts
@@ -0,0 +1,16 @@
+interface Line {
+  price: number
+  qty: number
+}
+
+export function createCart() {
+  return {
+    _lines: [] as Line[],
+    add(price: number, qty: number): void {
+      this._lines.push({ price, qty })
+    },
+    total(): number {
+      return this._lines.reduce((sum, line) => sum + line.price * line.qty, 0)
+    },
+  }
+}
diff --git a/cart/__tests__/createCart.test.ts b/cart/__tests__/createCart.test.ts
new file mode 100644
--- /dev/null
+++ b/cart/__tests__/createCart.test.ts
@@ -0,0 +1,18 @@
+import { describe, expect, it } from 'vitest'
+import { createCart } from '../createCart'
+
+describe('createCart', () => {
+  it('totals price times quantity over all lines', () => {
+    const cart = createCart()
+    cart.add(250, 2)
+    cart.add(100, 1)
+    expect(cart.total()).toBe(600)
+  })
+
+  it('keeps one line per add call', () => {
+    const cart = createCart()
+    cart.add(250, 2)
+    cart.add(100, 1)
+    expect((cart as any)._lines).toHaveLength(2)
+  })
+})
```

## Checks

baseline 0; suite 0; scope 0; cases 0; mutants 0

## Decisions and assumptions

Decisions:
- route inferred as gate (cart/)
- feature is the repo root (cart/ did not exist)

Assumptions: none

## Mutants output

```
0 findings, 6 passed, 0 timed out, 0 invalid, 0 not covered
```
