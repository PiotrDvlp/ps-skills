import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { withRepoLock, syncWork, toolReady, writeConfig, runStryker } from './stryker.mjs';
import { tmp } from './test-tmp.mjs';

test('lock: a live PID refuses, a dead PID is replaced, the lock is released', async () => {
  const dir = tmp('tb-lk-');
  writeFileSync(join(dir, 'lock'), String(process.pid));
  await assert.rejects(withRepoLock(dir, async () => 0), (e) => e.code === 3 && /another mutants run/.test(e.message));
  writeFileSync(join(dir, 'lock'), '999999');
  assert.equal(await withRepoLock(dir, async () => 7), 7);
  assert.equal(existsSync(join(dir, 'lock')), false);
});

test('lock: a cache root with group/other access is refused', async () => {
  const dir = tmp('tb-unsafe-');
  chmodSync(dir, 0o755);
  await assert.rejects(withRepoLock(dir, async () => 0), (e) => e.code === 3 && /unsafe/.test(e.message));
});

test('work: sync excludes secrets and git, removes stale reports, links node_modules, survives a space', () => {
  const base = tmp('tb-w ');
  const root = join(base, 'my repo');
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, '.env'), 'SECRET=1');
  writeFileSync(join(root, 'a.ts'), 'x');
  const work = join(base, 'work');
  mkdirSync(join(work, 'reports'), { recursive: true, mode: 0o700 });
  writeFileSync(join(work, 'reports', 'mutation.json'), '{}');
  mkdirSync(join(work, '.stryker-tmp'));
  syncWork(root, work);
  assert.equal(readFileSync(join(work, 'a.ts'), 'utf8'), 'x');
  assert.equal(existsSync(join(work, '.env')), false);
  assert.equal(existsSync(join(work, '.git')), false);
  assert.equal(existsSync(join(work, 'reports')), false);
  assert.equal(existsSync(join(work, '.stryker-tmp')), false);
  assert.equal(lstatSync(join(work, 'node_modules')).isSymbolicLink(), true);
});

test('tool: ready only with both pinned packages and the stryker binary', () => {
  const t = tmp('tb-tool-');
  const pkg = (name, version) => { mkdirSync(join(t, 'node_modules', name), { recursive: true }); writeFileSync(join(t, 'node_modules', name, 'package.json'), JSON.stringify({ version })); };
  pkg('@stryker-mutator/core', '10.0.0');
  assert.equal(toolReady(t), false);
  pkg('@stryker-mutator/vitest-runner', '10.0.0');
  assert.equal(toolReady(t), false);
  mkdirSync(join(t, 'node_modules', '.bin'));
  writeFileSync(join(t, 'node_modules', '.bin', 'stryker'), '');
  assert.equal(toolReady(t), true);
  pkg('@stryker-mutator/vitest-runner', '9.0.0');
  assert.equal(toolReady(t), false);
});

test('config: the written config carries the gate settings and the ranges', () => {
  const w = tmp('tb-cfg-');
  writeConfig(w, ['a.ts:2-2', 'b.vue:3-4'], { hasVitestConfig: true });
  const c = JSON.parse(readFileSync(join(w, 'stryker.config.json'), 'utf8'));
  assert.deepEqual(c.mutate, ['a.ts:2-2', 'b.vue:3-4']);
  assert.equal(c.coverageAnalysis, 'perTest');
  assert.equal(c.disableBail, true);
  assert.deepEqual(c.ignorePatterns, ['!.nuxt']);
  assert.deepEqual(c.vitest, { related: true, configFile: 'vitest.config.ts' });
});

test('work: two syncs from a 0o755 repo root leave the work copy owner-only', () => {
  const base = tmp('tb-w2-');
  const root = join(base, 'repo');
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  chmodSync(root, 0o755);
  writeFileSync(join(root, 'a.ts'), 'x');
  const work = join(base, 'work');
  syncWork(root, work);
  syncWork(root, work);
  assert.equal(statSync(work).mode & 0o777, 0o700);
});

test('work: a work directory equal to, inside or above the repo is refused and nothing is deleted', () => {
  const base = tmp('tb-ov-');
  const root = join(base, 'repo');
  mkdirSync(join(root, 'node_modules'), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, 'a.ts'), 'x');
  for (const w of [root, join(root, 'w'), base]) {
    assert.throws(() => syncWork(root, w), (e) => e.code === 3 && /overlaps the repo/.test(e.message));
  }
  assert.equal(readFileSync(join(root, 'a.ts'), 'utf8'), 'x');
  assert.equal(existsSync(join(root, 'node_modules')), true);
  assert.equal(existsSync(join(root, 'w')), false);
});

test('run: a spawn failure throws, and a stale report is not trusted', () => {
  const t = tmp('tb-run-');
  const w = join(t, 'work');
  mkdirSync(join(w, 'reports'), { recursive: true });
  writeFileSync(join(w, 'reports', 'mutation.json'), '{"stale":true}');
  assert.throws(() => runStryker(t, w), (e) => e.code === 3 && /failed to start/.test(e.message));
  assert.equal(existsSync(join(w, 'reports', 'mutation.json')), false);
});

test('work: a failed rsync still leaves the work copy owner-only', () => {
  const base = tmp('tb-rs-');
  const root = join(base, 'repo');
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  chmodSync(root, 0o755);
  writeFileSync(join(root, 'a.ts'), 'x');
  writeFileSync(join(root, 'locked.ts'), 'y');
  chmodSync(join(root, 'locked.ts'), 0o000);
  const work = join(base, 'work');
  try {
    assert.throws(() => syncWork(root, work), (e) => e.code === 3 && /rsync failed/.test(e.message));
  } finally {
    chmodSync(join(root, 'locked.ts'), 0o644);
  }
  assert.equal(statSync(work).mode & 0o777, 0o700);
});

test('work: only top-level reports, .output and .stryker-tmp are excluded', () => {
  const base = tmp('tb-an-');
  const root = join(base, 'repo');
  for (const d of ['node_modules', 'src/reports', 'src/.output', 'reports', '.output']) mkdirSync(join(root, d), { recursive: true });
  for (const f of ['src/reports/a.ts', 'src/.output/b.ts', 'reports/x', '.output/y']) writeFileSync(join(root, f), 'x');
  const work = join(base, 'work');
  syncWork(root, work);
  assert.equal(existsSync(join(work, 'src', 'reports', 'a.ts')), true);
  assert.equal(existsSync(join(work, 'src', '.output', 'b.ts')), true);
  assert.equal(existsSync(join(work, 'reports')), false);
  assert.equal(existsSync(join(work, '.output')), false);
});
