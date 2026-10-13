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

test('red: a stale red.json is not accepted when vitest writes no report', async () => {
  const r = repo();
  const state = mkdtempSync(join(tmpdir(), 'tb-state-'));
  const lines = [];
  assert.equal(await main(args(r, 'baseline'), fakeDeps(r, state, lines, 'list-base', null, 0)), 0);
  assert.equal(await main(args(r, 'red'), fakeDeps(r, state, lines, 'list-new', 'red-assert')), 0);
  const silent = { ...fakeDeps(r, state, lines, 'list-new', 'red-assert') };
  const listRun = silent.run;
  silent.run = (a) => (a[0] === 'list' ? listRun(a) : { status: 1, stdout: '', stderr: '' });
  assert.equal(await main(args(r, 'red'), silent), 3);
  assert.match(lines.join('\n'), /vitest wrote no report/);
});
test('red: an import error in one spec does not taint another spec', async () => {
  const r = await redWith('red-two-spec', 'list-two');
  assert.equal(r.code, 1);
  assert.match(r.out, /other\.test\.ts > other > works: import error/);
  assert.doesNotMatch(r.out, /sum > doubles/);
});

import { cpSync, rmSync, symlinkSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
const VROOT = process.env.TEETH_BUILD_VITEST_ROOT;
const CACHE = process.env.TEETH_BUILD_CACHE;
const NEEDS_ROOT = VROOT ? {} : { skip: 'set TEETH_BUILD_VITEST_ROOT' };
const IT = VROOT && CACHE ? {} : { skip: 'set TEETH_BUILD_VITEST_ROOT and TEETH_BUILD_CACHE' };
const sh = (cwd, cmd, ...a) => spawnSync(cmd, a, { cwd, encoding: 'utf8' });

function gitRepo(root) {
  writeFileSync(join(root, '.gitignore'), 'node_modules\n');
  for (const a of [['init', '-q'], ['config', 'user.email', 't@t'], ['config', 'user.name', 't'], ['add', '.'], ['commit', '-qm', 'b']]) sh(root, 'git', ...a);
  return sh(root, 'git', 'rev-parse', 'HEAD').stdout.trim();
}
function itRepo() {
  const root = join(CACHE, 'it repo');
  rmSync(root, { recursive: true, force: true });
  cpSync(new URL('../fixtures/mini', import.meta.url), root, { recursive: true });
  symlinkSync(join(VROOT, 'node_modules'), join(root, 'node_modules'));
  return { root, base: gitRepo(root) };
}
async function gate(root, base, deps = {}) {
  const lines = [];
  const code = await main(['mutants', '--root', root, '--task', 'it', '--feature', '.', '--base', base, '--cache-dir', join(CACHE ?? tmpdir(), 'cache')], { log: (s) => lines.push(s), ...deps });
  return { code, out: lines.join('\n') };
}
function snapshot(root) {
  const out = {};
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (n === 'node_modules') continue; if (statSync(p).isDirectory()) walk(p); else out[p] = createHash('sha256').update(readFileSync(p)).digest('hex'); } };
  walk(root);
  return out;
}
const TAUT = "import { it, expect } from 'vitest'\nit('t', () => { expect(true).toBe(true) })\n";
const SUM2 = 'export function sum(a: number, b: number): number {\n  return b + a\n}\n';

test('mutants: deletions only skip Stryker and exit 0', async () => {
  const r = repo();
  writeFileSync(join(r, 'sum.ts'), '');
  const out = await gate(r, 'HEAD', { vitestMajor: () => 3, runStryker: () => { throw new Error('must not run'); } });
  assert.equal(out.code, 0);
  assert.match(out.out, /no changed mutable lines/);
});

test('mutants: a template-only change lists every changed line and exits 0', NEEDS_ROOT, async () => {
  const r = mkdtempSync(join(tmpdir(), 'tb-tpl-'));
  symlinkSync(join(VROOT, 'node_modules'), join(r, 'node_modules'));
  writeFileSync(join(r, 'T.vue'), '<template>\n  <p>a</p>\n</template>\n');
  const base = gitRepo(r);
  writeFileSync(join(r, 'T.vue'), '<template>\n  <p>b</p>\n</template>\n');
  const out = await gate(r, base, { vitestMajor: () => 3 });
  assert.equal(out.code, 0);
  assert.match(out.out, /not covered: T\.vue:2 template/);
});

test('integration: a real assertion test passes the gate', IT, async () => {
  const { root, base } = itRepo();
  writeFileSync(join(root, 'sum.ts'), SUM2);
  const r = await gate(root, base);
  assert.equal(r.code, 0, r.out);
});

test('integration: a tautology-only test fails the gate naming the survivor', IT, async () => {
  const { root, base } = itRepo();
  writeFileSync(join(root, '__tests__', 'sum.test.ts'), TAUT);
  writeFileSync(join(root, 'sum.ts'), SUM2);
  const r = await gate(root, base);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /sum\.ts:2 /);
});

test('integration: a new untracked helper with a tautology test fails the gate', IT, async () => {
  const { root, base } = itRepo();
  mkdirSync(join(root, 'helpers', '__tests__'), { recursive: true });
  writeFileSync(join(root, 'helpers', 'double.ts'), 'export const double = (n: number) => n * 2\n');
  writeFileSync(join(root, 'helpers', '__tests__', 'double.test.ts'), "import { it, expect } from 'vitest'\nimport { double } from '../double'\nit('t', () => { double(1); expect(true).toBe(true) })\n");
  const r = await gate(root, base);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /helpers\/double\.ts:1 /);
});

test('integration: the template-first withDefaults component compiles under Stryker', IT, async () => {
  const { root, base } = itRepo();
  const p = join(root, 'components', 'Badge.vue');
  writeFileSync(p, readFileSync(p, 'utf8').replace('props.count > 9', '9 < props.count'));
  const r = await gate(root, base);
  assert.equal([0, 1].includes(r.code), true, r.out);
  assert.doesNotMatch(r.out, /defineProps\(\) in <script setup>/);
});

test('integration: two runs give the same findings and change no file outside node_modules', IT, async () => {
  const { root, base } = itRepo();
  writeFileSync(join(root, '__tests__', 'sum.test.ts'), TAUT);
  writeFileSync(join(root, 'sum.ts'), SUM2);
  const before = snapshot(root);
  const findings = (o) => o.split('\n').filter((l) => l.includes(' → ')).join('\n');
  const a = await gate(root, base);
  const b = await gate(root, base);
  assert.equal(a.code, 1, a.out);
  assert.equal(b.code, 1, b.out);
  assert.equal(findings(a.out), findings(b.out));
  assert.deepEqual(snapshot(root), before);
});
