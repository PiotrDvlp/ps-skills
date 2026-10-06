import { test } from 'node:test';
import assert from 'node:assert/strict';
import { farewell } from './greet.js';

test('farewell says goodbye', () => {
  assert.equal(farewell('Sam'), 'Goodbye, Sam!');
});
