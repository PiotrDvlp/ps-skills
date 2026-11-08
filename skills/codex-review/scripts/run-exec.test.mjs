import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildExecArgv, buildExecPrompt, missingHeadings, effortFor } from './run-exec.mjs';
import { assertCodexSandboxUsable, HARD_REFUSE_BYTES } from './code-review-core.mjs';
import { makeFakeCodex } from './test-helpers.mjs';

const base = { model: 'gpt-5.6-sol', outFile: '/tmp/out.md' };
const effortOf = (argv) => (argv.includes('-c') ? argv[argv.indexOf('-c') + 1] : null);

for (const mode of ['design', 'plan', 'duel']) {
  test(`argv/ ${mode}: read-only, isolated from user config, prompt on stdin`, () => {
    const argv = buildExecArgv({ ...base, mode });
    assert.equal(argv[0], 'exec');
    assert.equal(argv[argv.indexOf('-s') + 1], 'read-only');
    assert.equal(argv.filter((a) => a === '-s').length, 1);
    assert.ok(argv.includes('--ignore-user-config'));
    assert.ok(argv.includes('--skip-git-repo-check'));
    assert.equal(argv[argv.indexOf('-o') + 1], '/tmp/out.md');
    assert.equal(argv.at(-1), '-');
  });
}

test('argv/ design and plan pin medium, xhigh with deep, on the requested model', () => {
  for (const mode of ['design', 'plan']) {
    assert.equal(effortOf(buildExecArgv({ ...base, mode })), 'model_reasoning_effort="medium"');
    const deep = buildExecArgv({ ...base, mode, deep: true, model: 'gpt-6.1-sol' });
    assert.equal(effortOf(deep), 'model_reasoning_effort="xhigh"');
    assert.equal(deep[deep.indexOf('-m') + 1], 'gpt-6.1-sol');
  }
});

test('argv/ duel passes no effort flag and rejects deep', () => {
  assert.equal(effortOf(buildExecArgv({ ...base, mode: 'duel' })), null);
  assert.equal(effortFor('duel', false), 'model-default');
  assert.throws(() => buildExecArgv({ ...base, mode: 'duel', deep: true }), (e) => e.code === 'deep_in_duel');
});

test('argv/ -C only when a repo root is given', () => {
  assert.ok(!buildExecArgv({ ...base, mode: 'plan' }).includes('-C'));
  const argv = buildExecArgv({ ...base, mode: 'plan', repoRoot: '/repo' });
  assert.equal(argv[argv.indexOf('-C') + 1], '/repo');
});

test('argv/ refuses models outside the allowlist and unknown modes', () => {
  for (const model of ['gpt-5.6-pro', 'typo-model']) {
    assert.throws(() => buildExecArgv({ ...base, mode: 'plan', model }), (e) => e.code === 'model_not_allowed');
  }
  assert.throws(() => buildExecArgv({ ...base, mode: 'code' }), (e) => e.code === 'usage');
});

test('prompt/ is the rubric, a blank line, then the target', () => {
  assert.equal(buildExecPrompt({ rubric: 'RUBRIC', target: 'TARGET' }), 'RUBRIC\n\nTARGET');
});

test('prompt/ refuses a target at the hard size limit', () => {
  const target = 'x'.repeat(HARD_REFUSE_BYTES);
  assert.throws(() => buildExecPrompt({ rubric: 'r', target }), (e) => e.code === 'too_large');
  assert.doesNotThrow(() => buildExecPrompt({ rubric: 'r', target: target.slice(1) }));
});

test('headings/ design and plan need Verdict and Issues', () => {
  assert.deepEqual(missingHeadings('plan', '## Verdict\nPASS\n\n## Issues\nnone\n'), []);
  assert.deepEqual(missingHeadings('design', '## Verdict\nPASS\n'), ['## Issues']);
  assert.deepEqual(missingHeadings('plan', 'Verdict: PASS, ## Issues inline'), ['## Verdict', '## Issues']);
});

test('headings/ duel needs all five proposal headings', () => {
  const full = '## Approach\n## Design\n## Tradeoffs\n## Risks\n## Open questions\n';
  assert.deepEqual(missingHeadings('duel', full), []);
  assert.deepEqual(missingHeadings('duel', full.replace('## Risks\n', '')), ['## Risks']);
});

const darwinOnly = { skip: process.platform !== 'darwin' };

test('sandbox/ a failing probe refuses with nested_sandbox', darwinOnly, () => {
  assert.throws(() => assertCodexSandboxUsable(() => { throw new Error('denied'); }),
    (e) => e.code === 'nested_sandbox' && /dangerouslyDisableSandbox/.test(e.message));
});

test('sandbox/ a passing probe allows the run', () => {
  assert.doesNotThrow(() => assertCodexSandboxUsable(() => {}));
});

const RUN_EXEC = fileURLToPath(new URL('./run-exec.mjs', import.meta.url));
const GOOD_PLAN = '## Verdict\nPASS\n\n## Issues\nNone.\n';
const GOOD_DUEL = '## Approach\na\n## Design\nd\n## Tradeoffs\nt\n## Risks\nr\n## Open questions\nq\n';

function fakeSandboxExec(exitCode) {
  const dir = mkdtempSync(join(tmpdir(), 'cxr-sbx-'));
  writeFileSync(join(dir, 'sandbox-exec'), `#!/bin/sh\nexit ${exitCode}\n`);
  chmodSync(join(dir, 'sandbox-exec'), 0o755);
  return dir;
}

function cli(args, { behavior = {}, sandboxExit = 0, env = {} } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'cxr-exec-test-'));
  const argvLog = join(work, 'argv.log');
  const stdinCopy = join(work, 'stdin.txt');
  const fake = makeFakeCodex({ json: GOOD_PLAN, argvLog, stdinCopy, ...behavior });
  const sbx = fakeSandboxExec(sandboxExit);
  const target = join(work, 'plan.md');
  writeFileSync(target, '# A plan\n\nTask 1: do it.\n');
  const res = spawnSync(process.execPath, [RUN_EXEC, ...args(target)], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${fake.dir}:${sbx}:${process.env.PATH}`, ...env },
  });
  const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
  const out = { ...res, argv: read(argvLog), stdin: read(stdinCopy), target };
  fake.cleanup();
  rmSync(sbx, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
  return out;
}

test('cli/ a good plan run prints one ok JSON object with the body', () => {
  const res = cli((t) => ['--mode', 'plan', '--target', t]);
  assert.equal(res.status, 0, res.stderr);
  const json = JSON.parse(res.stdout);
  assert.equal(json.ok, true);
  assert.equal(json.reasoning_effort, 'medium');
  assert.equal(json.repo_read, 'ok');
  assert.equal(json.body.trim(), GOOD_PLAN.trim());
  assert.match(res.argv, /-s read-only --ignore-user-config/);
  assert.ok(res.stdin.startsWith(readFileSync(new URL('../references/rubric-plan.md', import.meta.url), 'utf8')));
  assert.ok(res.stdin.endsWith('Task 1: do it.\n'));
});

test('cli/ duel streams the prompt file byte for byte and records model-default', () => {
  const res = cli((t) => ['--mode', 'duel', '--prompt-file', t], { behavior: { json: GOOD_DUEL } });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdin, '# A plan\n\nTask 1: do it.\n');
  assert.equal(JSON.parse(res.stdout).reasoning_effort, 'model-default');
  assert.doesNotMatch(res.argv, /model_reasoning_effort/);
});

test('cli/ a nonzero codex exit fails even when the output has every heading', () => {
  const res = cli((t) => ['--mode', 'plan', '--target', t], { behavior: { exit: 1 } });
  assert.equal(res.status, 1);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /\[codex_failed\]/);
});

test('cli/ a missing heading fails and surfaces the raw output', () => {
  const res = cli((t) => ['--mode', 'plan', '--target', t], { behavior: { json: '## Verdict\nPASS\n' } });
  assert.equal(res.status, 1);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /\[missing_heading\] missing ## Issues/);
});

test('cli/ a model mismatch fails', () => {
  const res = cli((t) => ['--mode', 'plan', '--target', t], { behavior: { model: 'gpt-5.6-terra' } });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /\[model_mismatch\]/);
});

test('cli/ a run past the timeout is killed and fails', () => {
  const res = cli((t) => ['--mode', 'plan', '--target', t],
    { behavior: { mutate: 'sleep 5' }, env: { CXR_EXEC_TIMEOUT_MS: '200' } });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /\[timeout\]/);
});

test('cli/ a failing sandbox probe refuses before any codex call', darwinOnly, () => {
  const res = cli((t) => ['--mode', 'plan', '--target', t], { sandboxExit: 1 });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /\[nested_sandbox\]/);
  assert.equal(res.argv, null, 'codex must not be spawned');
});

test('cli/ usage errors exit 2 without spawning codex', () => {
  for (const args of [
    (t) => ['--mode', 'plan', '--target', t, '--sandbox', 'workspace-write'],
    (t) => ['--mode', 'plan', '--target', t, '--bogus'],
    (t) => ['--mode', 'duel', '--target', t],
    (t) => ['--mode', 'plan', '--target'],
  ]) {
    const res = cli(args);
    assert.equal(res.status, 2, res.stderr);
    assert.equal(res.argv, null);
  }
});

test('cli/ --deep in duel is refused before any codex call', () => {
  const res = cli((t) => ['--mode', 'duel', '--prompt-file', t, '--deep']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /\[deep_in_duel\]/);
  assert.equal(res.argv, null);
});

test('cli/ SIGTERM to the runner also stops the Codex child', async () => {
  const work = mkdtempSync(join(tmpdir(), 'cxr-sig-'));
  const pidFile = join(work, 'codex.pid');
  const fake = makeFakeCodex({ mutate: `echo $$ > ${JSON.stringify(pidFile)}; exec sleep 30` });
  const sbx = fakeSandboxExec(0);
  const target = join(work, 'plan.md');
  writeFileSync(target, '# plan\n');
  const child = spawn(process.execPath, [RUN_EXEC, '--mode', 'plan', '--target', target], {
    env: { ...process.env, PATH: `${fake.dir}:${sbx}:${process.env.PATH}` }, stdio: 'ignore',
  });
  const exited = new Promise((res) => child.on('exit', res));
  const until = async (cond) => {
    for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 50));
    return cond();
  };
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    assert.ok(await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim()), 'fake codex never started');
    const codexPid = Number(readFileSync(pidFile, 'utf8'));
    child.kill('SIGTERM');
    await exited;
    assert.ok(await until(() => !alive(codexPid)), 'the Codex child outlived the runner');
  } finally {
    child.kill('SIGKILL');
    fake.cleanup();
    rmSync(sbx, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});
