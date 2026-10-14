import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, cpSync, rmSync, symlinkSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main, stateDir, isGlob, tsRanges } from './relay-gate.mjs';
import { tmp } from './test-tmp.mjs';

const CLI = fileURLToPath(new URL('./relay-gate.mjs', import.meta.url));
const fx = (n) => readFileSync(new URL(`../fixtures/vitest/${n}.json`, import.meta.url), 'utf8');
function repo() {
  const r = tmp('tb-rg-');
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
  assert.equal(await main(args(r, 'baseline'), fakeDeps(r, tmp('tb-s-'), [], 'list-base', null, 0)), 3);
});

test('baseline: a red suite exits 2 and publishes no state that red could use', async () => {
  const r = repo();
  const state = tmp('tb-s-');
  const lines = [];
  assert.equal(await main(args(r, 'baseline'), fakeDeps(r, state, lines, 'list-base', null, 1)), 2);
  assert.equal(existsSync(join(state, 'baseline.json')), false);
  assert.equal(await main(args(r, 'red'), fakeDeps(r, state, lines, 'list-base', null, 1)), 3);
  assert.match(lines.join('\n'), /no baseline; run baseline/);
});

test('baseline: a green suite writes baseline.json with the HEAD sha', async () => {
  const r = repo();
  const state = tmp('tb-s-');
  assert.equal(await main(args(r, 'baseline'), fakeDeps(r, state, [], 'list-base', null, 0)), 0);
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: r, encoding: 'utf8' }).stdout.trim();
  assert.equal(JSON.parse(readFileSync(join(state, 'baseline.json'), 'utf8')).base, head);
});

test('locked: record, a modified test file fails verify, restore brings it back', async () => {
  const r = repo();
  const state = tmp('tb-s-');
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
  const d = { ...fakeDeps(r, tmp('tb-s-'), [], 'list-base', null, 0), run: () => ({ status: null, signal: 'SIGINT', stdout: '', stderr: '' }) };
  assert.equal(await main(args(r, 'baseline'), d), 130);
});

test('baseline: the real run with a relative root and no vitest binary exits 3', async () => {
  const r = repo();
  const lines = [];
  const { run, ...d } = fakeDeps(r, tmp('tb-s-'), lines, 'list-base', null, 0);
  assert.equal(await main(['baseline', '--root', relative(process.cwd(), r), '--task', 't1', '--feature', '.'], d), 3);
  assert.match(lines.join('\n'), /vitest failed to start/);
});

test('task: a path-like --task exits 3', async () => {
  const r = repo();
  const lines = [];
  const a = ['baseline', '--root', r, '--task', '../x', '--feature', '.'];
  assert.equal(await main(a, fakeDeps(r, tmp('tb-s-'), lines, 'list-base', null, 0)), 3);
  assert.match(lines.join('\n'), /invalid --task/);
});

const hashOf = (r) => createHash('sha1').update(r).digest('hex');

test('state: the task state lives under --cache-dir and survives a different TMPDIR', async () => {
  const r = repo();
  const cache = tmp('tb-cache-');
  const { stateDir: _s, ...d } = fakeDeps(r, null, [], 'list-base', null, 0);
  assert.equal(await main([...args(r, 'baseline'), '--cache-dir', cache], d), 0);
  assert.equal(existsSync(join(cache, hashOf(r), 'state', 't1', 'baseline.json')), true);
  const old = process.env.TMPDIR;
  process.env.TMPDIR = tmp('tb-other-');
  try {
    const lines = [];
    const { stateDir: _t, ...d2 } = fakeDeps(r, null, lines, 'list-new', 'red-assert');
    assert.equal(await main([...args(r, 'red'), '--cache-dir', cache], d2), 0, lines.join('\n'));
  } finally {
    process.env.TMPDIR = old;
  }
});

test('state: a group-readable task dir is refused', async () => {
  const r = repo();
  const cache = tmp('tb-cache-');
  chmodSync(stateDir({ cacheRoot: cache, hashDir: join(cache, hashOf(r)) }, 't1'), 0o755);
  const lines = [];
  const { stateDir: _s, ...d } = fakeDeps(r, null, lines, 'list-base', null, 0);
  assert.equal(await main([...args(r, 'baseline'), '--cache-dir', cache], d), 3);
  assert.match(lines.join('\n'), /unsafe state directory/);
});

async function redWith(report, list = 'list-new') {
  const r = repo();
  const state = tmp('tb-state-');
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
  const state = tmp('tb-state-');
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
  const nm = join(root, 'node_modules');
  mkdirSync(nm);
  for (const n of readdirSync(join(VROOT, 'node_modules'))) if (n !== '.vite-temp') symlinkSync(join(VROOT, 'node_modules', n), join(nm, n));
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
  const r = tmp('tb-tpl-');
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
  assert.doesNotMatch(r.out, /defineProps\(\) in <script setup>/);
  assert.doesNotMatch(r.out, /not covered: components\/Badge\.vue:7/);
  assert.equal(/components\/Badge\.vue:7 /.test(r.out) || /[1-9]\d* passed/.test(r.out), true, r.out);
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

const fakeStryker = (report) => ({ vitestMajor: () => 3, toolReady: () => true, linkTool: () => {}, runStryker: () => ({ status: 0, signal: null, report, matched: 1 }) });
async function unitGate(report, extra = {}) {
  const r = repo();
  writeFileSync(join(r, 'sum.ts'), 'export const sum = (a, b) => b + a\n');
  const deps = fakeStryker(report(r));
  const inner = deps.runStryker;
  deps.runStryker = () => ({ ...inner(), ...extra });
  return { r, ...(await gate(r, 'HEAD', deps)) };
}
test('mutants: a report with the file but no mutant on the line passes as not covered', async () => {
  const out = await unitGate(() => ({ files: { 'sum.ts': { mutants: [] } } }));
  assert.equal(out.code, 0, out.out);
  assert.match(out.out, /not covered: sum\.ts:1 no mutant inside the changed lines/);
});
test('mutants: a report with an unknown matched count exits 3', async () => {
  const out = await unitGate(() => ({ files: {} }), { matched: null });
  assert.equal(out.code, 3);
  assert.match(out.out, /Stryker matched an unknown number of 1 changed files/);
});

test('integration: a type-only change has no mutants and passes as not covered', IT, async () => {
  const { root, base } = itRepo();
  writeFileSync(join(root, 'sum.ts'), `${readFileSync(join(root, 'sum.ts'), 'utf8')}export type N = number\n`);
  const r = await gate(root, base);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /not covered: sum\.ts:4 no mutant inside the changed lines/);
});

const noReport = (extra) => ({ vitestMajor: () => 3, toolReady: () => true, linkTool: () => {}, runStryker: () => ({ status: 1, signal: null, report: null, firstError: null, ...extra }) });
async function unitNoReport(extra) {
  const r = repo();
  writeFileSync(join(r, 'sum.ts'), 'export const sum = (a, b) => b + a\n');
  return gate(r, 'HEAD', noReport(extra));
}
test('mutants: no tests plus zero instrumented mutants passes as not covered', async () => {
  const out = await unitNoReport({ noTests: true, instrumented: 0, matched: 1 });
  assert.equal(out.code, 0, out.out);
  assert.match(out.out, /not covered: sum\.ts:1 no mutant inside the changed lines/);
});
test('mutants: no tests with instrumented mutants is a finding', async () => {
  const out = await unitNoReport({ noTests: true, instrumented: 3, matched: 1 });
  assert.equal(out.code, 1, out.out);
  assert.match(out.out, /sum\.ts:1 NoCoverage/);
});
test('mutants: fewer matched files than changed files exits 3', async () => {
  const out = await unitGate(() => ({ files: { 'sum.ts': { mutants: [] } } }), { matched: 0 });
  assert.equal(out.code, 3);
  assert.match(out.out, /Stryker matched 0 of 1 changed files/);
});
test('integration: a glob-character path is skipped as not covered, not rejected', IT, async () => {
  const { root, base } = itRepo();
  mkdirSync(join(root, 'helpers', '__tests__'), { recursive: true });
  writeFileSync(join(root, 'helpers', '[id].ts'), 'export const id = (n: number) => n + 1\n');
  writeFileSync(join(root, 'helpers', '__tests__', 'id.test.ts'), "import { it, expect } from 'vitest'\nimport { id } from '../[id]'\nit('t', () => { id(1); expect(true).toBe(true) })\n");
  const r = await gate(root, base);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /not covered: helpers\/\[id\]\.ts:1 glob characters in path/);
});
test('mutants: no tests, zero mutants and an unknown match count exits 3', async () => {
  const out = await unitNoReport({ noTests: true, instrumented: 0, matched: null });
  assert.equal(out.code, 3);
  assert.match(out.out, /Stryker matched an unknown number of 1 changed files/);
});
test('glob filter: only minimatch magic is excluded', () => {
  for (const f of ['a{b}.ts', 'a@b.ts', 'c++.ts', 'a!b.ts', 'pages/(admin)/x.vue']) assert.equal(isGlob(f), false, f);
  for (const f of ['[id].ts', 'x{a,b}.ts', 'a*.ts', 'foo+(x).ts', 'a?.ts']) assert.equal(isGlob(f), true, f);
});
test('integration: a route-group path with parentheses is mutated', IT, async () => {
  const { root, base } = itRepo();
  mkdirSync(join(root, 'pages', '(g)', '__tests__'), { recursive: true });
  writeFileSync(join(root, 'pages', '(g)', 'x.ts'), 'export const id = (n: number) => n + 1\n');
  writeFileSync(join(root, 'pages', '(g)', '__tests__', 'x.test.ts'), "import { it, expect } from 'vitest'\nimport { id } from '../x'\nit('t', () => { id(1); expect(true).toBe(true) })\n");
  const r = await gate(root, base);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /pages\/\(g\)\/x\.ts:1 /);
});

test('baseline: the real vitest child runs with CI=1 so it writes no snapshots', async () => {
  const r = repo();
  writeFileSync(join(r, '.gitignore'), 'node_modules\nci.txt\n');
  spawnSync('git', ['add', '.'], { cwd: r });
  spawnSync('git', ['commit', '-qm', 'ignore'], { cwd: r });
  mkdirSync(join(r, 'node_modules', '.bin'), { recursive: true });
  const bin = join(r, 'node_modules', '.bin', 'vitest');
  writeFileSync(bin, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(join(r, 'ci.txt'))}, String(process.env.CI))\nif (process.argv[2] === 'list') console.log('[]')\n`);
  chmodSync(bin, 0o755);
  const old = process.env.CI;
  delete process.env.CI;
  try {
    const { run, ...d } = fakeDeps(r, tmp('tb-s-'), [], 'list-base', null, 0);
    assert.equal(await main(args(r, 'baseline'), d), 0);
  } finally {
    if (old !== undefined) process.env.CI = old;
  }
  assert.equal(readFileSync(join(r, 'ci.txt'), 'utf8'), '1');
});

test('ranges: a blank line between changed lines stays inside one Stryker range but is not mutable', () => {
  const r = tsRanges('a\nb\nc(a,\n\nb)\n', [3, 4, 5]);
  assert.deepEqual(r.mutate, [{ start: 3, end: 5 }]);
  assert.deepEqual(r.mutable, [3, 5]);
  assert.deepEqual(tsRanges('a\n\n\nb\n', [2, 3]).mutate, []);
});

test('mutants: a Stryker signal other than SIGINT and SIGTERM exits 2, SIGINT exits 130', async () => {
  const kill = (signal) => ({ vitestMajor: () => 3, toolReady: () => true, linkTool: () => {}, runStryker: () => ({ status: null, signal, report: null }) });
  const run = async (signal) => {
    const r = repo();
    writeFileSync(join(r, 'sum.ts'), 'export const sum = (a, b) => b + a\n');
    return gate(r, 'HEAD', kill(signal));
  };
  const k = await run('SIGKILL');
  assert.equal(k.code, 2);
  assert.match(k.out, /stryker killed by SIGKILL/);
  assert.equal((await run('SIGINT')).code, 130);
  assert.equal((await run('SIGTERM')).code, 130);
});

test('mutants: a relative --cache-dir reaches the work copy and the tool as absolute paths', async () => {
  const r = repo();
  writeFileSync(join(r, 'sum.ts'), 'export const sum = (a, b) => b + a\n');
  const seen = [];
  const deps = { vitestMajor: () => 3, toolReady: (t) => { seen.push(t); return true; }, syncWork: (_r, w) => { seen.push(w); throw new Error('stop'); } };
  const rel = relative(process.cwd(), tmp('tb-rel-'));
  await main(['mutants', '--root', r, '--task', 'it', '--feature', '.', '--base', 'HEAD', '--cache-dir', rel], { log: () => {}, ...deps });
  assert.equal(seen.length, 2);
  for (const p of seen) assert.equal(isAbsolute(p), true, p);
});

test('mutants: the not covered count includes template, macro and glob lines that were printed', async () => {
  const r = tmp('tb-cnt-');
  writeFileSync(join(r, 'a.ts'), 'export const a = 1\n');
  const base = gitRepo(r);
  writeFileSync(join(r, 'a.ts'), 'export const a = 2\n');
  writeFileSync(join(r, '[id].ts'), 'export const id = 1\nexport const j = 2\n');
  const deps = { vitestMajor: () => 3, toolReady: () => true, linkTool: () => {}, runStryker: () => ({ status: 0, signal: null, report: { files: { 'a.ts': { mutants: [] } } }, matched: 1 }) };
  const out = await gate(r, base, deps);
  assert.match(out.out, /0 findings, 0 passed, 0 timed out, 0 invalid, 3 not covered/);
});

test('baseline: a feature with no tests yet passes when vitest is given --passWithNoTests', async () => {
  const r = repo();
  const state = tmp('tb-s-');
  const d = {
    stateDir: () => state,
    vitestMajor: () => 3,
    log: () => {},
    run: (a) => (a[0] === 'list' ? { status: 0, stdout: '[]', stderr: '' } : { status: a.includes('--passWithNoTests') ? 0 : 1, stdout: '', stderr: '' }),
  };
  assert.equal(await main(args(r, 'baseline'), d), 0);
  assert.deepEqual(JSON.parse(readFileSync(join(state, 'baseline.json'), 'utf8')).list, []);
});

test('locked: --feature outside --root exits 3 and --feature . still works', async () => {
  const r = repo();
  const outside = tmp('tb-out-');
  for (const feature of ['../x', outside]) {
    const lines = [];
    const state = tmp('tb-s-');
    const a = ['locked', '--root', r, '--task', 't1', '--feature', feature, '--record'];
    assert.equal(await main(a, fakeDeps(r, state, lines, 'list-base', null, 0)), 3);
    assert.match(lines.join('\n'), /--feature must be inside --root/);
  }
  symlinkSync(outside, join(r, 'link'));
  const lines = [];
  const linkArgs = ['locked', '--root', r, '--task', 't1', '--feature', 'link', '--record'];
  assert.equal(await main(linkArgs, fakeDeps(r, tmp('tb-s-'), lines, 'list-base', null, 0)), 3);
  assert.match(lines.join('\n'), /--feature must be inside --root/);
  const dotLines = [];
  const dotArgs = ['locked', '--root', r, '--task', 't1', '--feature', '.', '--record'];
  assert.equal(await main(dotArgs, fakeDeps(r, tmp('tb-s-'), dotLines, 'list-base', null, 0)), 3);
  assert.match(dotLines.join('\n'), /symlink in feature link/);
  unlinkSync(join(r, 'link'));
  mkdirSync(join(r, '..foo'));
  for (const feature of ['.', '..foo']) {
    const a = ['locked', '--root', r, '--task', 't1', '--feature', feature, '--record'];
    assert.equal(await main(a, fakeDeps(r, tmp('tb-s-'), [], 'list-base', null, 0)), 0);
  }
});
