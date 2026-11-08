import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_MODEL } from './codex-args.mjs';

const RUNNER = fileURLToPath(new URL('./run-second-view.mjs', import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`../references/fixtures/${name}`, import.meta.url));
const GOOD = '## Approach\na\n\n## Design\nd\n\n## Tradeoffs\nt\n\n## Risks\nr\n\n## Open questions\nq\n';

function makeBin(dir, name, body) {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
}

function run(args, { proposal = GOOD, exit = 0, sleep = 0, sandboxExit = 0, env = {}, header = `model: ${DEFAULT_MODEL}` } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'sv-test-'));
  const bin = join(work, 'bin');
  spawnSync('mkdir', [bin]);
  const argvLog = join(work, 'argv.log');
  const stdinCopy = join(work, 'stdin.txt');
  writeFileSync(join(work, 'proposal.md'), proposal);
  makeBin(bin, 'codex', [
    `printf '%s\\n' "$*" >> '${argvLog}'`,
    'OUT=""',
    'while [ $# -gt 0 ]; do case "$1" in -o) OUT="$2"; shift 2 ;; *) shift ;; esac; done',
    `cat > '${stdinCopy}'`,
    sleep ? `sleep ${sleep}` : '',
    `printf '%s\\n' '${header}' >&2`,
    `[ -n "$OUT" ] && cp '${join(work, 'proposal.md')}' "$OUT"`,
    `exit ${exit}`,
  ].join('\n'));
  makeBin(bin, 'sandbox-exec', `exit ${sandboxExit}`);
  const res = spawnSync(process.execPath, [RUNNER, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
  });
  const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
  const out = { ...res, argv: read(argvLog), stdin: read(stdinCopy) };
  rmSync(work, { recursive: true, force: true });
  return out;
}

test('a good run prints one ok JSON object with the proposal', () => {
  const res = run(['--brief', fixture('brief-plain.md')]);
  assert.equal(res.status, 0, res.stderr);
  const json = JSON.parse(res.stdout);
  assert.equal(json.ok, true);
  assert.equal(json.model, DEFAULT_MODEL);
  assert.equal(json.reasoning_effort, 'medium');
  assert.equal(json.proposal, GOOD);
});

test('the withheld half never reaches Codex', () => {
  const res = run(['--brief', fixture('brief-with-canary-in-withheld-half.md')]);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdin.includes('Problem statement'), 'the sent half must reach Codex');
  assert.ok(!res.stdin.includes('WITHHELD_CANARY_7f3a'), 'the withheld canary leaked to Codex');
  assert.ok(!res.stdin.includes('Current direction'));
});

test('argv is read-only, isolated from the user config, and xhigh with --deep', () => {
  const res = run(['--brief', fixture('brief-plain.md'), '--deep', '--model', 'gpt-6.1-sol'],
    { header: 'model: gpt-6.1-sol' });
  assert.equal(res.status, 0, res.stderr.slice(0, 500));
  assert.match(res.argv, /-m gpt-6\.1-sol -s read-only --ignore-user-config/);
  assert.match(res.argv, /model_reasoning_effort="xhigh"/);
});

test('a sandbox override is refused before any spawn', () => {
  for (const extra of [['--sandbox', 'workspace-write'], ['--dangerously-bypass-approvals-and-sandbox']]) {
    const res = run(['--brief', fixture('brief-plain.md'), ...extra]);
    assert.equal(res.status, 2, res.stderr);
    assert.match(res.stderr, /forbidden/);
    assert.equal(res.argv, null, 'codex must not be spawned');
  }
});

test('unknown flags and a missing brief exit 2 without spawning', () => {
  for (const args of [['--brief', fixture('brief-plain.md'), '--bogus'], ['--deep'], ['--brief']]) {
    const res = run(args);
    assert.equal(res.status, 2, res.stderr);
    assert.equal(res.argv, null);
  }
});

const darwinOnly = { skip: process.platform !== 'darwin' };

test('a failing sandbox probe refuses before any spawn', darwinOnly, () => {
  const res = run(['--brief', fixture('brief-plain.md')], { sandboxExit: 1 });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /\[nested_sandbox\]/);
  assert.equal(res.argv, null);
});

test('a nonzero codex exit fails even when the proposal has every heading', () => {
  const res = run(['--brief', fixture('brief-plain.md')], { exit: 1 });
  assert.equal(res.status, 1);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /\[codex_failed\]/);
});

test('a proposal missing a heading fails and surfaces the raw output', () => {
  const res = run(['--brief', fixture('brief-plain.md')], { proposal: GOOD.replace('## Risks\nr\n\n', '') });
  assert.equal(res.status, 1);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /\[missing_heading\] missing ## Risks/);
});

test('an empty proposal fails', () => {
  const res = run(['--brief', fixture('brief-plain.md')], { proposal: '\n' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /\[empty_output\]/);
});

test('a run past the timeout is killed and fails', () => {
  const res = run(['--brief', fixture('brief-plain.md')], { sleep: 5, env: { SV_TIMEOUT_MS: '200' } });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /\[timeout\]/);
});

test('a brief without the SENT marker is refused before any spawn', () => {
  const work = mkdtempSync(join(tmpdir(), 'sv-brief-'));
  const brief = join(work, 'brief.md');
  writeFileSync(brief, 'Problem statement\nno markers here\n');
  const res = run(['--brief', brief]);
  rmSync(work, { recursive: true, force: true });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /\[bad_brief\]/);
  assert.equal(res.argv, null);
});

test('a model other than the requested one fails', () => {
  const res = run(['--brief', fixture('brief-plain.md')], { header: 'model: gpt-5.6-luna' });
  assert.equal(res.status, 1);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /\[model_mismatch\]/);
});

test('a fallback warning from Codex fails', () => {
  const res = run(['--brief', fixture('brief-plain.md')],
    { header: `model: ${DEFAULT_MODEL}\nwarning: Model metadata for \`x\` not found. Defaulting to fallback metadata` });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /\[model_fallback\]/);
});

test('a missing model header fails', () => {
  const res = run(['--brief', fixture('brief-plain.md')], { header: 'no header here' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /\[model_unresolved\]/);
});

test('SIGTERM to the runner also stops the Codex child', async () => {
  const work = mkdtempSync(join(tmpdir(), 'sv-sig-'));
  const bin = join(work, 'bin');
  spawnSync('mkdir', [bin]);
  const pidFile = join(work, 'codex.pid');
  makeBin(bin, 'codex', `cat > /dev/null\necho $$ > '${pidFile}'\nexec sleep 30`);
  makeBin(bin, 'sandbox-exec', 'exit 0');
  const child = spawn(process.execPath, [RUNNER, '--brief', fixture('brief-plain.md')], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: 'ignore',
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
    rmSync(work, { recursive: true, force: true });
  }
});
