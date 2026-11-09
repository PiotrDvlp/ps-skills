import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getCartTotals } from '../src/cart/totals.js';

test('totals are computed in cents with 19% VAT', () => {
  const totals = getCartTotals([{ unitPriceCents: 1000, quantity: 2 }]);
  assert.deepEqual(totals, { net: 2000, vat: 380, gross: 2380 });
});
