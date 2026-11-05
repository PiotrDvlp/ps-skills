import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp } from './test-tmp.mjs';

const script = fileURLToPath(new URL('./grade-eval.mjs', import.meta.url));

const REPLY = [
  'score: 1/2',
  'q1: pass',
  'reason: names the behaviour and the effect',
  'full answer: correct.',
  'q2: fail',
  'reason: restates the code',
  'full answer: says what the call is, not what it does.',
].join('\n');

function setup() {
  const dir = tmp('grade-eval-');
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

test('grade-eval: every run matching the expected grades exits 0', () => {
  const s = setup();
  const r = run(s, ['--prompt', s.prompt, '--packet', s.packet, '--expect', 'pass,fail', '--runs', '2'], { FAKE_REPLY: REPLY });
  assert.equal(r.code, 0);
  assert.match(r.out, /^2\/2 grades match$/m);
});

test('grade-eval: a run with other grades is a miss and names what it got', () => {
  const s = setup();
  const r = run(s, ['--prompt', s.prompt, '--packet', s.packet, '--expect', 'pass,pass', '--runs', '2'], { FAKE_REPLY: REPLY });
  assert.equal(r.code, 1);
  assert.match(r.out, /^0\/2 grades match$/m);
  assert.match(r.out, /^run 1: got pass,fail$/m);
  assert.match(r.out, /^run 2: got pass,fail$/m);
});

test('grade-eval: a reply outside the schema is a miss', () => {
  const s = setup();
  const r = run(s, ['--prompt', s.prompt, '--packet', s.packet, '--expect', 'pass,fail', '--runs', '1'], { FAKE_REPLY: 'no schema' });
  assert.equal(r.code, 1);
  assert.match(r.out, /^0\/1 grades match$/m);
  assert.match(r.out, /^run 1: got no valid reply$/m);
});

test('grade-eval: claude exiting non-zero exits 3', () => {
  const s = setup();
  const r = run(s, ['--prompt', s.prompt, '--packet', s.packet, '--expect', 'pass,fail', '--runs', '1'], { FAKE_REPLY: REPLY, FAKE_EXIT: '5' });
  assert.equal(r.code, 3);
});

test('grade-eval: usage errors exit 3 without calling claude', () => {
  const s = setup();
  for (const args of [
    ['--prompt', s.prompt, '--expect', 'pass,fail'],
    ['--prompt', s.prompt, '--packet', s.packet],
    ['--prompt', s.prompt, '--packet', s.packet, '--expect', 'pass,maybe'],
    ['--prompt', s.prompt, '--packet', s.packet, '--expect', 'pass', '--runs', '0'],
  ]) {
    const r = run(s, args, { FAKE_REPLY: REPLY });
    assert.equal(r.code, 3, args.join(' '));
    assert.equal(existsSync(s.stdin), false, args.join(' '));
  }
});

test('grade-eval: claude gets the prompt, two newlines, then the packet', () => {
  const s = setup();
  run(s, ['--prompt', s.prompt, '--packet', s.packet, '--expect', 'pass,fail', '--runs', '1'], { FAKE_REPLY: REPLY });
  assert.equal(readFileSync(s.stdin, 'utf8'), 'PROMPT TEXT\n\nPACKET TEXT');
});
