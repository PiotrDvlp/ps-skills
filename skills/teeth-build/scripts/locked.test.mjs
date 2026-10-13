import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { record, verify, restore } from './locked.mjs';

function setup() {
  const f = mkdtempSync(join(tmpdir(), 'tb-lock-'));
  mkdirSync(join(f, '__tests__'));
  writeFileSync(join(f, '__tests__', 'a.test.ts'), 'A');
  writeFileSync(join(f, '__tests__', 'b.test.ts'), 'B');
  writeFileSync(join(f, 'a.ts'), 'impl');
  const d = mkdtempSync(join(tmpdir(), 'tb-lockdir-'));
  record(f, d);
  return { f, d };
}
const empty = { modified: [], deleted: [], added: [] };

test('locked: unchanged files verify clean, production edits are ignored', () => {
  const { f, d } = setup();
  writeFileSync(join(f, 'a.ts'), 'changed impl');
  assert.deepEqual(verify(f, d), empty);
});

test('locked: modified, deleted and added test files are named and restored', () => {
  const { f, d } = setup();
  writeFileSync(join(f, '__tests__', 'a.test.ts'), 'A!');
  unlinkSync(join(f, '__tests__', 'b.test.ts'));
  writeFileSync(join(f, '__tests__', 'c.spec.ts'), 'C');
  assert.deepEqual(verify(f, d), { modified: ['__tests__/a.test.ts'], deleted: ['__tests__/b.test.ts'], added: ['__tests__/c.spec.ts'] });
  assert.deepEqual(restore(f, d), empty);
  assert.equal(readFileSync(join(f, '__tests__', 'a.test.ts'), 'utf8'), 'A');
  assert.equal(readFileSync(join(f, '__tests__', 'b.test.ts'), 'utf8'), 'B');
  assert.equal(existsSync(join(f, '__tests__', 'c.spec.ts')), false);
  assert.deepEqual(restore(f, d), empty);
});
