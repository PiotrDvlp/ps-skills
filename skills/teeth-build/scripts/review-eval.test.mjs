import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeArgs, parseVerdict } from './review-eval.mjs';
import { tmp } from './test-tmp.mjs';

const script = fileURLToPath(new URL('./review-eval.mjs', import.meta.url));

test('review-eval: parseVerdict reads the first non-empty line only', () => {
  assert.equal(parseVerdict('verdict: clear\nproved:\n- x'), 'clear');
  assert.equal(parseVerdict('verdict: blocking finding\n'), 'blocking finding');
  assert.equal(parseVerdict('\n\nverdict: clear\n'), 'clear');
  assert.equal(parseVerdict('Review below.\nverdict: clear\n'), null);
  assert.equal(parseVerdict('verdict: clear\nverdict: blocking finding'), 'clear');
  assert.equal(parseVerdict('verdict: maybe'), null);
  assert.equal(parseVerdict(''), null);
  assert.equal(parseVerdict('**verdict: clear**'), null);
});

test('review-eval: claudeArgs runs print mode without tools or a saved session', () => {
  assert.deepEqual(claudeArgs('claude-opus-5-5'), ['-p', '--model', 'claude-opus-5-5', '--no-session-persistence', '--tools', '']);
});

function setup() {
  const dir = tmp('review-eval-');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const fake = join(bin, 'claude');
  writeFileSync(fake, '#!/bin/sh\ncat > "$FAKE_STDIN"\nprintf \'%s\\n\' "$FAKE_REPLY"\nexit "${FAKE_EXIT:-0}"\n');
  chmodSync(fake, 0o755);
  const prompt = join(dir, 'prompt.md');
  const packet = join(dir, 'packet.md');
  writeFileSync(prompt, 'PROMPT TEXT');
  writeFileSync(packet, 'PACKET TEXT');
  return { bin, prompt, packet, stdin: join(dir, 'stdin.txt') };
}

function run(s, args, env) {
  const r = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${s.bin}:${process.env.PATH}`, FAKE_STDIN: s.stdin, ...env },
  });
  return { code: r.status, out: r.stdout };
}

test('review-eval: all runs matching the expected verdict exit 0', () => {
  const s = setup();
  const r = run(s, ['--prompt', s.prompt, '--packet', s.packet, '--expect', 'clear', '--runs', '2'], { FAKE_REPLY: 'verdict: clear' });
  assert.equal(r.code, 0);
  assert.match(r.out, /^2\/2 verdict: clear$/m);
});

test('review-eval: a mismatch exits 1 and names the verdict it got', () => {
  const s = setup();
  const r = run(s, ['--prompt', s.prompt, '--packet', s.packet, '--expect', 'blocking finding', '--runs', '2'], { FAKE_REPLY: 'verdict: clear' });
  assert.equal(r.code, 1);
  assert.match(r.out, /^0\/2 verdict: blocking finding$/m);
  assert.match(r.out, /^run 1: got clear$/m);
});

test('review-eval: a reply without a verdict line is reported as such', () => {
  const s = setup();
  const r = run(s, ['--prompt', s.prompt, '--packet', s.packet, '--expect', 'clear', '--runs', '1'], { FAKE_REPLY: 'no schema here' });
  assert.equal(r.code, 1);
  assert.match(r.out, /^run 1: got no verdict line$/m);
});

test('review-eval: a failing claude call exits 3', () => {
  const s = setup();
  const r = run(s, ['--prompt', s.prompt, '--packet', s.packet, '--expect', 'clear', '--runs', '1'], { FAKE_REPLY: 'verdict: clear', FAKE_EXIT: '5' });
  assert.equal(r.code, 3);
});

test('review-eval: a missing --packet exits 3 before any claude call', () => {
  const s = setup();
  const r = run(s, ['--prompt', s.prompt, '--expect', 'clear'], { FAKE_REPLY: 'verdict: clear' });
  assert.equal(r.code, 3);
  assert.equal(existsSync(s.stdin), false);
});

test('review-eval: stdin is the prompt, two newlines, then the packet', () => {
  const s = setup();
  run(s, ['--prompt', s.prompt, '--packet', s.packet, '--expect', 'clear', '--runs', '1'], { FAKE_REPLY: 'verdict: clear' });
  assert.equal(readFileSync(s.stdin, 'utf8'), 'PROMPT TEXT\n\nPACKET TEXT');
});
