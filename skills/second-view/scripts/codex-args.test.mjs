import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCodexArgs, assertSafeArgs, assertCodexSandboxUsable } from './codex-args.mjs';

const base = { model: 'gpt-5.6-sol', outFile: '/tmp/out.md' };

// Adjacency, not membership. `-s` and `read-only` both present somewhere in argv
// does not prove a read-only invocation — they must be consecutive tokens.
test('emits -s immediately followed by read-only', () => {
  const argv = buildCodexArgs(base);
  const i = argv.indexOf('-s');
  assert.notEqual(i, -1, '-s missing entirely');
  assert.equal(argv[i + 1], 'read-only');
});

test('emits exactly one -s, so nothing later can override it', () => {
  const argv = buildCodexArgs(base);
  assert.equal(argv.filter((a) => a === '-s').length, 1);
});

test('reads the prompt from stdin', () => {
  assert.equal(buildCodexArgs(base).at(-1), '-');
});

test('passes --skip-git-repo-check so vault artifacts outside a repo work', () => {
  assert.ok(buildCodexArgs(base).includes('--skip-git-repo-check'));
});

test('deep raises reasoning effort on the resolved model without switching models', () => {
  const argv = buildCodexArgs({ ...base, deep: true });
  const i = argv.indexOf('-c');
  assert.equal(argv[i + 1], 'model_reasoning_effort="xhigh"');
  assert.equal(argv[argv.indexOf('-m') + 1], 'gpt-5.6-sol');
});

test('omits the reasoning-effort flag when deep is not set', () => {
  assert.ok(!buildCodexArgs(base).includes('-c'));
});

test('includes -C only when repoRoot is given', () => {
  assert.ok(!buildCodexArgs(base).includes('-C'));
  const argv = buildCodexArgs({ ...base, repoRoot: '/repo' });
  assert.equal(argv[argv.indexOf('-C') + 1], '/repo');
});

test('rejects gpt-5.6-pro, which 400s on a ChatGPT account', () => {
  assert.throws(() => buildCodexArgs({ ...base, model: 'gpt-5.6-pro' }), /gpt-5\.6-pro/);
});

test('accepts gpt-6-astra and rejects slugs outside the allowlist', () => {
  const argv = buildCodexArgs({ ...base, model: 'gpt-6-astra' });
  assert.equal(argv[argv.indexOf('-m') + 1], 'gpt-6-astra');
  for (const bad of ['gpt-5.6-codex', 'gpt-5.5-codex', 'gpt-5.5', 'typo-model']) {
    assert.throws(() => buildCodexArgs({ ...base, model: bad }), /not allowed/);
  }
});

const darwinOnly = { skip: process.platform !== 'darwin' };

test('assertCodexSandboxUsable refuses a nested sandbox with the remedy', darwinOnly, () => {
  assert.throws(
    () => assertCodexSandboxUsable(() => { throw new Error('sandbox_apply: Operation not permitted'); }),
    /nested sandbox[\s\S]*dangerouslyDisableSandbox/,
  );
});

test('assertCodexSandboxUsable passes when the probe succeeds', () => {
  assert.doesNotThrow(() => assertCodexSandboxUsable(() => {}));
});

test('requires model and outFile', () => {
  assert.throws(() => buildCodexArgs({ outFile: '/tmp/o' }), /required/);
  assert.throws(() => buildCodexArgs({ model: 'gpt-5.6-sol' }), /required/);
});

test('assertSafeArgs rejects a sandbox override', () => {
  assert.throws(() => assertSafeArgs(['--sandbox', 'workspace-write']), /sandbox/i);
});

test('assertSafeArgs rejects full-access and bypass flags', () => {
  assert.throws(() => assertSafeArgs(['--dangerously-bypass-approvals-and-sandbox']), /forbidden/);
  assert.throws(() => assertSafeArgs(['-s', 'danger-full-access']), /forbidden/);
});

// A string makes every check vacuous: `for (const a of '--sandbox')` iterates
// CHARACTERS, so each includes() test runs against one character and returns
// false. A sibling skill shipped exactly this bug once.
test('assertSafeArgs rejects a string instead of an array', () => {
  for (const bad of ['--sandbox workspace-write', '-s danger-full-access', '']) {
    assert.throws(() => assertSafeArgs(bad), /must be an array/);
  }
});

test('assertSafeArgs accepts an empty array and safe flags', () => {
  assert.doesNotThrow(() => assertSafeArgs([]));
  assert.doesNotThrow(() => assertSafeArgs(['--skip-git-repo-check']));
});
