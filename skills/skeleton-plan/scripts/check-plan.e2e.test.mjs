import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { tmp } from './test-tmp.mjs';
import { runGate } from './check-plan.mjs';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
const CLI = join(import.meta.dirname, 'check-plan.mjs');
const GATE_TOOL = join(homedir(), '.cache', 'skeleton-plan', 'tool');
const WITHOUT_LOCAL_TYPESCRIPT = new Set(['no-local-typescript']);
const RECEIPT_FIELDS = ['approvalHash', 'blockHashes', 'baseCommit', 'generatedInputs', 'lockfileHash', 'nodeVersion', 'typescript', 'adapter', 'commands', 'status', 'ungated'];

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8' });

function fixture(name) {
  const root = tmp(`sk-e2e-${name}-`);
  const repo = join(root, 'repo');
  const source = join(FIXTURES, name, 'repo');
  if (existsSync(source)) {
    cpSync(source, repo, { recursive: true });
    if (!WITHOUT_LOCAL_TYPESCRIPT.has(name)) {
      cpSync(join(GATE_TOOL, 'node_modules'), join(repo, 'node_modules'), { recursive: true, verbatimSymlinks: true });
      copyFileSync(join(GATE_TOOL, 'package-lock.json'), join(repo, 'package-lock.json'));
    }
  } else {
    mkdirSync(repo);
  }
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD').trim();
  const plan = join(root, 'plan.md');
  writeFileSync(plan, readFileSync(join(FIXTURES, name, 'plan.md'), 'utf8').replace(/^base:.*$/m, `base: ${base}`));
  const cache = tmp('sk-e2e-cache-');
  symlinkSync(GATE_TOOL, join(cache, 'tool'));
  return { root, repo, plan, base, cache, receipt: `${plan}.receipt.json` };
}

function gate(f, env = {}) {
  const r = spawnSync(process.execPath, [CLI, '--plan', f.plan, '--repo', f.repo, '--cache-dir', f.cache], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, first: r.stdout.split('\n')[0], out: `${r.stdout}\n${r.stderr}` };
}

const receiptOf = (f) => JSON.parse(readFileSync(f.receipt, 'utf8'));
const runDirs = (f) => readdirSync(join(f.cache, 'runs')).filter((n) => n !== 'locks');

test('good: exit 0, passed, receipt has every listed field', () => {
  const f = fixture('good');
  const r = gate(f);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.first, 'passed');
  const receipt = receiptOf(f);
  for (const field of RECEIPT_FIELDS) assert.ok(Object.hasOwn(receipt, field), `missing ${field}`);
  assert.equal(receipt.baseCommit, f.base);
  assert.equal(receipt.status, 'passed');
  assert.deepEqual(receipt.typescript, { version: '5.9.3', source: 'repo' });
  assert.equal(receipt.adapter, 'tsc');
  assert.match(receipt.lockfileHash, /^[0-9a-f]{64}$/);
  assert.equal(receipt.blockHashes.length, 2);
  assert.deepEqual(receipt.commands.map((c) => c.step), ['baseline typecheck', 'typecheck']);
  for (const c of receipt.commands) {
    assert.equal(c.exitCode, 0);
    assert.equal(typeof c.durationMs, 'number');
  }
});

test('vue-caller: exit 4, passed with 1 ungated items', () => {
  const f = fixture('vue-caller');
  const r = gate(f);
  assert.equal(r.code, 4, r.out);
  assert.equal(r.first, 'passed with 1 ungated items');
  assert.match(r.out, /ungated: src\/components\/Card\.vue/);
  assert.deepEqual(receiptOf(f).ungated, ['src/components/Card.vue']);
});

test('unknown-type: exit 1, failed:', () => {
  const f = fixture('unknown-type');
  const r = gate(f);
  assert.equal(r.code, 1, r.out);
  assert.match(r.first, /^failed: /);
  assert.match(r.out, /src\/greet\.ts:1: .*Widget/);
  assert.equal(existsSync(f.receipt), false);
});

test('caller-broken: exit 1, caller broken: src/caller.ts', () => {
  const f = fixture('caller-broken');
  const r = gate(f);
  assert.equal(r.code, 1, r.out);
  assert.equal(r.first, 'failed: caller broken: src/caller.ts');
});

test('label-mismatch: exit 1, format:, no run directory created', () => {
  const f = fixture('label-mismatch');
  const r = gate(f);
  assert.equal(r.code, 1, r.out);
  assert.match(r.first, /^format: label /);
  assert.equal(existsSync(join(f.cache, 'runs')), false);
});

test('overlap: exit 1, format: overlapping', () => {
  const f = fixture('overlap');
  const r = gate(f);
  assert.equal(r.code, 1, r.out);
  assert.match(r.first, /^format: overlapping /);
});

test('excluded-file: exit 3, blocked: uncovered:', () => {
  const f = fixture('excluded-file');
  const r = gate(f);
  assert.equal(r.code, 3, r.out);
  assert.equal(r.first, 'blocked: uncovered: tools/build.ts');
});

test('broken-baseline: exit 3, blocked: baseline broken', () => {
  const f = fixture('broken-baseline');
  const r = gate(f);
  assert.equal(r.code, 3, r.out);
  assert.equal(r.first, 'blocked: baseline broken');
  assert.match(r.out, /src\/app\.ts:1: /);
});

test('no-gated-block: exit 3, blocked: no gated block', () => {
  const f = fixture('no-gated-block');
  const r = gate(f);
  assert.equal(r.code, 3, r.out);
  assert.equal(r.first, 'blocked: no gated block');
});

test('no-tsconfig: exit 5, not typechecked', () => {
  const f = fixture('no-tsconfig');
  const r = gate(f);
  assert.equal(r.code, 5, r.out);
  assert.equal(r.first, 'not typechecked: no TypeScript');
  assert.equal(existsSync(f.receipt), false);
});

test('edited-during-run: exit 1, plan changed during the run, no receipt', () => {
  const f = fixture('edited-during-run');
  const hook = join(FIXTURES, 'edited-during-run', 'edit-plan.mjs');
  const r = gate(f, { NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT ?? 'child', SKELETON_PLAN_TEST_AFTER_TYPECHECK: hook });
  assert.equal(r.code, 1, r.out);
  assert.equal(r.first, 'failed: plan changed during the run');
  assert.match(readFileSync(f.plan, 'utf8'), /^# Greeting, edited$/m);
  assert.equal(existsSync(f.receipt), false);
});

test('typecheck-crash: exit 1, typecheck exited without diagnostics', () => {
  const f = fixture('typecheck-crash');
  const r = gate(f);
  assert.equal(r.code, 1, r.out);
  assert.match(r.first, /^failed: typecheck exited \d+ without diagnostics$/);
});

test("no-local-typescript: exit 0, receipt names the gate's TypeScript 5.9.3", () => {
  const f = fixture('no-local-typescript');
  assert.equal(existsSync(join(f.repo, 'node_modules')), false);
  const r = gate(f);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.first, 'passed');
  const receipt = receiptOf(f);
  assert.deepEqual(receipt.typescript, { version: '5.9.3', source: 'gate' });
  assert.equal(receipt.lockfileHash, null);
});

test('a failing rerun after a pass leaves no receipt', () => {
  const f = fixture('good');
  assert.equal(gate(f).code, 0);
  assert.equal(existsSync(f.receipt), true);
  writeFileSync(f.plan, readFileSync(f.plan, 'utf8').replace('(name: string): string', '(name: Missing): string'));
  const r = gate(f);
  assert.equal(r.code, 1, r.out);
  assert.match(r.first, /^failed: /);
  assert.equal(existsSync(f.receipt), false);
  assert.equal(runDirs(f).length, 2);
});

const logger = (log, label, extra = '') => ['node', '-e', `require('fs').appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(label)}${extra} + '\\n')`];

test('prepare-order: prepare runs before the baseline and again after the splice', async () => {
  const f = fixture('prepare-order');
  const log = join(f.root, 'order.log');
  const adapterOverride = {
    prepare: logger(log, 'prepare ', " + require('fs').existsSync('src/greet.ts')"),
    typecheck: logger(log, 'typecheck'),
  };
  const r = await runGate({ planPath: f.plan, repoRoot: f.repo, cacheDir: f.cache, adapterOverride });
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['prepare false', 'typecheck', 'prepare true', 'typecheck']);
  assert.deepEqual(receiptOf(f).commands.map((c) => c.step), ['prepare', 'baseline typecheck', 'prepare', 'typecheck']);
});

test('prepare-order with a failing prepare: exit 3, blocked: prepare failed', async () => {
  const f = fixture('prepare-order');
  const adapterOverride = { prepare: ['node', '-e', 'process.exit(1)'] };
  const r = await runGate({ planPath: f.plan, repoRoot: f.repo, cacheDir: f.cache, adapterOverride });
  assert.equal(r.code, 3, r.lines.join('\n'));
  assert.match(r.lines[0], /^blocked: prepare failed/);
  assert.equal(existsSync(f.receipt), false);
});

test('the checkout is unchanged after a run', () => {
  const f = fixture('good');
  const before = git(f.repo, 'status', '--porcelain', '--ignored');
  assert.equal(gate(f).code, 0);
  assert.equal(git(f.repo, 'status', '--porcelain', '--ignored'), before);
});
