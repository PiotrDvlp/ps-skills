import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEligible } from './util.js';

test('isEligible returns a boolean', () => {
  const user = { vip: true, age: 10, active: true };
  assert.equal(typeof isEligible(user), 'boolean');
});
