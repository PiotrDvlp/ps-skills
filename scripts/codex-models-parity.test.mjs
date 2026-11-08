import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as review from '../skills/codex-review/scripts/code-review-core.mjs';
import * as secondView from '../skills/second-view/scripts/codex-args.mjs';

test('codex-review and second-view allow the same Codex models', () => {
  assert.deepEqual(secondView.ALLOWED_MODELS, review.ALLOWED_MODELS);
});

test('codex-review and second-view share one default model, and it is allowed', () => {
  assert.equal(secondView.DEFAULT_MODEL, review.DEFAULT_MODEL);
  assert.ok(review.ALLOWED_MODELS.includes(review.DEFAULT_MODEL));
});
