import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { classify, startRun, writeReceipt } from './receipt.mjs';
import { parsePlan, planHash } from './plan-format.mjs';
import { tmp } from './test-tmp.mjs';

const block = (path) => ({ id: 'b', path, op: 'create', selectors: [], label: 'x', code: '', line: 1 });
const row = (path) => ({ action: 'modify', path, change: 'x' });
const plan = (blocks = [block('src/a.ts')], files = [row('src/a.ts')]) => ({ base: 'x', approval: '', files, blocks, unchanged: [], taskSignatures: new Map() });
const run = (over = {}) => ({ exitCode: 0, signal: null, spawnError: null, diagnostics: [], ...over });
const diag = (file) => ({ file, line: 1, message: 'TS2322: bad' });
const covered = new Set(['src/a.ts']);
const spliced = { gated: 1, ungated: [] };

test('exit 0 with no diagnostics passes', () => {
  const r = classify(run(), plan(), covered, spliced);
  assert.equal(r.status, 'passed');
  assert.equal(r.code, 0);
});

test('a nonzero exit without diagnostics fails', () => {
  const r = classify(run({ exitCode: 2 }), plan(), covered, spliced);
  assert.equal(r.status, 'failed');
  assert.equal(r.code, 1);
  assert.equal(r.reason, 'typecheck exited 2 without diagnostics');
});

test('a spawn error or signal blocks', () => {
  for (const over of [{ spawnError: 'ENOENT', exitCode: null }, { signal: 'SIGKILL', exitCode: null }]) {
    const r = classify(run(over), plan(), covered, spliced);
    assert.equal(r.status, 'blocked');
    assert.equal(r.code, 3);
    assert.equal(r.reason, 'typecheck could not run');
  }
});

test('only .vue diagnostics with a gated block give status 4', () => {
  const r = classify(run({ exitCode: 1, diagnostics: [diag('src/v.vue')] }), plan(), covered, spliced);
  assert.equal(r.status, 'passed-ungated');
  assert.equal(r.code, 4);
  assert.equal(r.reason, 'passed with 1 ungated items');
  assert.deepEqual(r.ungated, ['src/v.vue']);
});

test('a skipped sfc block with a clean run gives status 4, not a plain pass', () => {
  const r = classify(run(), plan(), covered, { gated: 1, ungated: ['src/v.vue'] });
  assert.equal(r.status, 'passed-ungated');
  assert.equal(r.code, 4);
  assert.equal(r.reason, 'passed with 1 ungated items');
  assert.deepEqual(r.ungated, ['src/v.vue']);
});

test('a diagnostic in an unlisted .ts file is a broken caller', () => {
  const r = classify(run({ exitCode: 1, diagnostics: [diag('src/caller.ts')] }), plan(), covered, spliced);
  assert.equal(r.status, 'failed');
  assert.equal(r.code, 1);
  assert.equal(r.reason, 'caller broken: src/caller.ts');
});

test('a diagnostic in a listed ts file is a plain failure', () => {
  const r = classify(run({ exitCode: 1, diagnostics: [diag('src/a.ts')] }), plan(), covered, spliced);
  assert.equal(r.status, 'failed');
  assert.ok(!r.reason.startsWith('caller broken'));
});

test('a file-deleting block needs no coverage', () => {
  const blocks = [block('src/a.ts'), { ...block('src/old.ts'), op: 'delete-file' }];
  const r = classify(run(), plan(blocks, [row('src/a.ts'), row('src/old.ts')]), covered, spliced);
  assert.equal(r.status, 'passed');
  assert.equal(r.code, 0);
});

test('a mix of sfc and ts diagnostics in listed files is a plain failure', () => {
  const r = classify(run({ exitCode: 1, diagnostics: [diag('src/v.vue'), diag('src/a.ts')] }), plan(), covered, spliced);
  assert.equal(r.status, 'failed');
  assert.equal(r.code, 1);
});

test('zero gated blocks block', () => {
  const r = classify(run(), plan(), covered, { gated: 0, ungated: ['src/v.vue'] });
  assert.equal(r.status, 'blocked');
  assert.equal(r.code, 3);
  assert.equal(r.reason, 'no gated block');
});

test('a block in an uncovered file blocks', () => {
  const r = classify(run(), plan([block('src/x.ts')], [row('src/x.ts')]), covered, spliced);
  assert.equal(r.status, 'blocked');
  assert.equal(r.code, 3);
  assert.equal(r.reason, 'uncovered: src/x.ts');
});

const MARK = '*Below this line: for the implementer, the gates and the reviewer.*';
const setup = () => {
  const dir = tmp('receipt-');
  const planPath = join(dir, 'plan.md');
  writeFileSync(planPath, `# Plan\n\nBase: abc\n\n${MARK}\n`);
  const runRoot = join(dir, 'runs');
  return { dir, planPath, runRoot, hash: planHash(parsePlan(readFileSync(planPath, 'utf8'))) };
};
const lockPath = (runRoot, planPath) =>
  join(runRoot, 'locks', `${createHash('sha256').update(realpathSync(planPath)).digest('hex')}.lock`);

test('writeReceipt renames only when the hash still matches', () => {
  const { planPath, hash } = setup();
  assert.equal(writeReceipt(planPath, hash, { status: 'passed' }), true);
  const written = JSON.parse(readFileSync(`${planPath}.receipt.json`, 'utf8'));
  assert.equal(written.status, 'passed');
  assert.equal(written.approvalHash, hash);
  rmSync(`${planPath}.receipt.json`);
  writeFileSync(planPath, `# Plan edited\n\n${MARK}\n`);
  assert.equal(writeReceipt(planPath, hash, { status: 'passed' }), false);
  assert.equal(existsSync(`${planPath}.receipt.json`), false);
  assert.deepEqual(readdirSync(dirname(planPath)).filter((n) => n.includes('tmp-')), []);
  writeFileSync(planPath, 'no marker here');
  assert.equal(writeReceipt(planPath, hash, {}), false);
  assert.equal(existsSync(`${planPath}.receipt.json`), false);
});

test('startRun deletes an earlier receipt', () => {
  const { planPath, runRoot, hash } = setup();
  writeReceipt(planPath, hash, { status: 'passed' });
  assert.equal(existsSync(`${planPath}.receipt.json`), true);
  const run = startRun(planPath, runRoot);
  assert.equal(existsSync(`${planPath}.receipt.json`), false);
  run.release();
});

test('a second run on the same plan is blocked', () => {
  const { planPath, runRoot } = setup();
  mkdirSync(join(runRoot, 'locks'), { recursive: true, mode: 0o700 });
  writeFileSync(lockPath(runRoot, planPath), String(process.pid));
  assert.throws(() => startRun(planPath, runRoot), (e) => e.code === 3 && e.message === 'blocked: another run on this plan');
  rmSync(lockPath(runRoot, planPath));
  const child = spawnSync(process.execPath, ['-e', '']);
  writeFileSync(lockPath(runRoot, planPath), String(child.pid));
  const run = startRun(planPath, runRoot);
  assert.equal(readFileSync(lockPath(runRoot, planPath), 'utf8'), String(process.pid));
  run.release();
  assert.equal(existsSync(lockPath(runRoot, planPath)), false);
});
