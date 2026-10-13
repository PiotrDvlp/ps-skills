import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, unlinkSync, existsSync, rmSync, symlinkSync } from 'node:fs';
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

test('locked: an inventory path that escapes the feature makes restore throw code 3', () => {
  const { f, d } = setup();
  rmSync(join(f, '..', 'evil.test.ts'), { force: true });
  const inv = JSON.parse(readFileSync(join(d, 'inventory.json'), 'utf8'));
  inv.push({ path: '../evil.test.ts', sha256: 'x' });
  writeFileSync(join(d, 'inventory.json'), JSON.stringify(inv));
  writeFileSync(join(d, 'evil.test.ts'), 'EVIL');
  assert.throws(() => restore(f, d), (e) => e.code === 3 && /unsafe inventory path/.test(e.message));
  assert.equal(existsSync(join(f, '..', 'evil.test.ts')), false);
});

test('locked: vitest-default test names and snapshot files are locked', () => {
  const { f, d } = setup();
  mkdirSync(join(f, '__snapshots__'));
  writeFileSync(join(f, '__snapshots__', 'a.test.ts.snap'), 'S');
  record(f, d);
  assert.deepEqual(verify(f, d), empty);
  writeFileSync(join(f, 'x.test.js'), '1');
  writeFileSync(join(f, 'y.spec.tsx'), '1');
  writeFileSync(join(f, '__snapshots__', 'a.test.ts.snap'), 'S2');
  assert.deepEqual(verify(f, d), { modified: ['__snapshots__/a.test.ts.snap'], deleted: [], added: ['x.test.js', 'y.spec.tsx'] });
});

test('locked: dangling symlinks, symlinks to the feature root and .git are skipped', () => {
  const { f, d } = setup();
  symlinkSync(join(f, 'nope'), join(f, 'dangling'));
  symlinkSync(f, join(f, '__tests__', 'loop'));
  mkdirSync(join(f, '.git'));
  writeFileSync(join(f, '.git', 'x.test.ts'), 'G');
  record(f, d);
  const inv = JSON.parse(readFileSync(join(d, 'inventory.json'), 'utf8')).map((e) => e.path);
  assert.deepEqual(inv, ['__tests__/a.test.ts', '__tests__/b.test.ts']);
  assert.deepEqual(verify(f, d), empty);
});

test('locked: a symlinked test file makes record throw code 3', () => {
  const { f, d } = setup();
  const target = join(mkdtempSync(join(tmpdir(), 'tb-tgt-')), 't.ts');
  writeFileSync(target, 'T');
  symlinkSync(target, join(f, 'y.test.ts'));
  assert.throws(() => record(f, d), (e) => e.code === 3 && /symlinked test file y\.test\.ts/.test(e.message));
});
