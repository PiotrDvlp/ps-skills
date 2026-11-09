import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getCartTotals } from '../src/cart/totals.js';

test('totals are returned in euros with 19% VAT', () => {
  const totals = getCartTotals([{ unitPriceCents: 1000, quantity: 2 }]);
  assert.deepEqual(totals, { net: 20, vat: 3.8, gross: 23.8 });
});
