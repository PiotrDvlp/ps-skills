import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyMutants } from './classify.mjs';
const fx = () => JSON.parse(readFileSync(new URL('../fixtures/stryker/classify.json', import.meta.url)));
const all = new Map([['src/a.ts', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]]]);
const lines = (rows) => rows.map((r) => r.line);

test('classify: positive assertion evidence passes, everything else is a finding', () => {
  const r = classifyMutants(fx(), all);
  assert.deepEqual(lines(r.passed), [1, 2, 3]);
  assert.deepEqual(lines(r.findings), [4, 5, 6, 7, 10]);
  assert.equal(r.findings.find((f) => f.line === 4).reason, 'no assertion evidence');
  assert.equal(r.findings.find((f) => f.line === 6).reason, 'unattributed');
  assert.equal(r.findings.find((f) => f.line === 10).reason, 'unknown status Ignored');
  assert.deepEqual(lines(r.timedOut), [8]);
  assert.deepEqual(lines(r.invalid), [9]);
});

test('classify: changed lines without a valid mutant are not covered', () => {
  const r = classifyMutants(fx(), all);
  assert.deepEqual(r.notCovered.map((n) => [n.line, n.reason]), [[9, 'no mutant inside the changed lines'], [11, 'no mutant inside the changed lines']]);
});

test('classify: mutants outside the changed lines are ignored', () => {
  const r = classifyMutants(fx(), new Map([['src/a.ts', [1]]]));
  assert.deepEqual(lines(r.passed), [1]);
  assert.equal(r.findings.length, 0);
});
