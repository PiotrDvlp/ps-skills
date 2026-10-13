import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main } from './relay-gate.mjs';

const CLI = fileURLToPath(new URL('./relay-gate.mjs', import.meta.url));
const fx = (n) => readFileSync(new URL(`../fixtures/vitest/${n}.json`, import.meta.url), 'utf8');
function repo() {
  const r = mkdtempSync(join(tmpdir(), 'tb-rg-'));
  mkdirSync(join(r, '__tests__'));
  writeFileSync(join(r, 'sum.ts'), 'export const sum = (a, b) => a + b\n');
  writeFileSync(join(r, '__tests__', 'sum.test.ts'), 'x\n');
  for (const a of [['init', '-q'], ['config', 'user.email', 't@t'], ['config', 'user.name', 't'], ['add', '.'], ['commit', '-qm', 'b']]) spawnSync('git', a, { cwd: r });
  return r;
}
function fakeDeps(r, state, lines, list, report, runStatus = 1) {
  return {
    stateDir: () => state,
    vitestMajor: () => 3,
    log: (s) => lines.push(s),
    run: (args) => {
      if (args[0] === 'list') return { status: 0, stdout: fx(list).replaceAll('/repo', r), stderr: '' };
      const o = args.find((a) => a.startsWith('--outputFile='));
      if (!o) return { status: runStatus, stdout: '', stderr: '' };
      writeFileSync(o.slice('--outputFile='.length), fx(report).replaceAll('/repo', r));
      return { status: 1, stdout: '', stderr: '' };
    },
  };
}
const args = (r, cmd, ...more) => [cmd, '--root', r, '--task', 't1', '--feature', '.', ...more];

test('cli: no subcommand and a flag without a value exit 3', () => {
  assert.equal(spawnSync(process.execPath, [CLI]).status, 3);
  assert.equal(spawnSync(process.execPath, [CLI, 'baseline', '--root']).status, 3);
});

test('baseline: a dirty tree exits 3', async () => {
  const r = repo();
  writeFileSync(join(r, 'sum.ts'), 'changed\n');
  assert.equal(await main(args(r, 'baseline'), fakeDeps(r, mkdtempSync(join(tmpdir(), 'tb-s-')), [], 'list-base', null, 0)), 3);
});

test('baseline: a red suite exits 2 and publishes no state that red could use', async () => {
  const r = repo();
  const state = mkdtempSync(join(tmpdir(), 'tb-s-'));
  const lines = [];
  assert.equal(await main(args(r, 'baseline'), fakeDeps(r, state, lines, 'list-base', null, 1)), 2);
  assert.equal(existsSync(join(state, 'baseline.json')), false);
  assert.equal(await main(args(r, 'red'), fakeDeps(r, state, lines, 'list-base', null, 1)), 3);
  assert.match(lines.join('\n'), /no baseline; run baseline/);
});

test('baseline: a green suite writes baseline.json with the HEAD sha', async () => {
  const r = repo();
  const state = mkdtempSync(join(tmpdir(), 'tb-s-'));
  assert.equal(await main(args(r, 'baseline'), fakeDeps(r, state, [], 'list-base', null, 0)), 0);
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: r, encoding: 'utf8' }).stdout.trim();
  assert.equal(JSON.parse(readFileSync(join(state, 'baseline.json'), 'utf8')).base, head);
});

test('locked: record, a modified test file fails verify, restore brings it back', async () => {
  const r = repo();
  const state = mkdtempSync(join(tmpdir(), 'tb-s-'));
  const lines = [];
  const d = fakeDeps(r, state, lines, 'list-base', null, 0);
  assert.equal(await main(args(r, 'locked', '--record'), d), 0);
  writeFileSync(join(r, '__tests__', 'sum.test.ts'), 'weakened\n');
  assert.equal(await main(args(r, 'locked', '--verify'), d), 1);
  assert.match(lines.join('\n'), /modified: __tests__\/sum\.test\.ts/);
  assert.equal(await main(args(r, 'locked', '--restore'), d), 0);
  assert.equal(readFileSync(join(r, '__tests__', 'sum.test.ts'), 'utf8'), 'x\n');
});

test('signals: an interrupted vitest child returns 130', async () => {
  const r = repo();
  const d = { ...fakeDeps(r, mkdtempSync(join(tmpdir(), 'tb-s-')), [], 'list-base', null, 0), run: () => ({ status: null, signal: 'SIGINT', stdout: '', stderr: '' }) };
  assert.equal(await main(args(r, 'baseline'), d), 130);
});

test('baseline: the real run with a relative root and no vitest binary exits 3', async () => {
  const r = repo();
  const lines = [];
  const { run, ...d } = fakeDeps(r, mkdtempSync(join(tmpdir(), 'tb-s-')), lines, 'list-base', null, 0);
  assert.equal(await main(['baseline', '--root', relative(process.cwd(), r), '--task', 't1', '--feature', '.'], d), 3);
  assert.match(lines.join('\n'), /vitest failed to start/);
});
