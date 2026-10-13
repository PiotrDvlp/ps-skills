import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main, stateDir } from './relay-gate.mjs';

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

test('task: a path-like --task exits 3', async () => {
  const r = repo();
  const lines = [];
  const a = ['baseline', '--root', r, '--task', '../x', '--feature', '.'];
  assert.equal(await main(a, fakeDeps(r, mkdtempSync(join(tmpdir(), 'tb-s-')), lines, 'list-base', null, 0)), 3);
  assert.match(lines.join('\n'), /invalid --task/);
});

test('state: a group-readable task dir is refused', async () => {
  const r = repo();
  const old = process.env.TMPDIR;
  process.env.TMPDIR = mkdtempSync(join(tmpdir(), 'tb-base-'));
  try {
    chmodSync(stateDir(r, 't1'), 0o755);
    const lines = [];
    const { stateDir: _s, ...d } = fakeDeps(r, null, lines, 'list-base', null, 0);
    assert.equal(await main(args(r, 'baseline'), d), 3);
    assert.match(lines.join('\n'), /unsafe state directory/);
  } finally {
    process.env.TMPDIR = old;
  }
});

async function redWith(report, list = 'list-new') {
  const r = repo();
  const state = mkdtempSync(join(tmpdir(), 'tb-state-'));
  const lines = [];
  assert.equal(await main(args(r, 'baseline'), fakeDeps(r, state, lines, 'list-base', null, 0)), 0);
  const code = await main(args(r, 'red'), fakeDeps(r, state, lines, list, report));
  return { code, out: lines.join('\n') };
}

test('red: an assertion failure on every new case passes', async () => {
  assert.equal((await redWith('red-assert')).code, 0);
});
test('red: a TypeError is a finding naming the case', async () => {
  const r = await redWith('red-typeerror');
  assert.equal(r.code, 1);
  assert.match(r.out, /sum\.test\.ts > sum > doubles: crashed \(TypeError/);
});
test('red: an import error, a skip and an already-passing case are findings', async () => {
  assert.match((await redWith('red-import')).out, /sum > doubles: import error/);
  assert.match((await redWith('red-skipped')).out, /sum > doubles: skipped/);
  assert.match((await redWith('red-passing')).out, /sum > doubles: already passing/);
});
test('red: a renamed spec makes its old cases new, and they are already passing', async () => {
  const r = await redWith('red-renamed', 'list-renamed');
  assert.equal(r.code, 1);
  assert.match(r.out, /sum-renamed\.test\.ts > sum > adds: already passing/);
});
