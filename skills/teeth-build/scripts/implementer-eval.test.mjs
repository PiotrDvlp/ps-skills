import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCaseReport, scoreReply } from './implementer-eval.mjs';
import { tmp } from './test-tmp.mjs';

const script = fileURLToPath(new URL('./implementer-eval.mjs', import.meta.url));
const repoRoot = realpathSync(fileURLToPath(new URL('../../..', import.meta.url)));
const codeOracleReply = fileURLToPath(new URL('../fixtures/implementer/vat-gate-code-oracle.txt', import.meta.url));
const FORBID = 'roundCents|money\\.ts|scratch|\\bran\\b';
const CASES = ['contract-example', 'half-cent', 'zero'];

function report(sections) {
  return ['```ts', '// oracle: not counted here', '```', 'BEGIN CASE REPORT', ...sections, 'END CASE REPORT', 'assumptions: none'].join('\n');
}

const GOOD = report([
  'case: contract-example', '- oracle: contract example',
  'case: half-cent', '- oracle: contract rule by hand, 199.5 rounds half up to 200',
  'case: zero', '- oracle: contract rule, 0 times 19 % is 0',
]);

test('implementer-eval: parseCaseReport reads each case section between the markers', () => {
  const reply = 'BEGIN CASE REPORT\ncase: a\nx\ny\ncase: b\nz\ncase: a\nw\nEND CASE REPORT';
  assert.deepEqual(parseCaseReport(reply), [
    { name: 'a', lines: ['x', 'y'] },
    { name: 'b', lines: ['z'] },
    { name: 'a', lines: ['w'] },
  ]);
});

test('implementer-eval: parseCaseReport returns null without exactly one report block', () => {
  assert.equal(parseCaseReport('case: a\noracle: x'), null);
  assert.equal(parseCaseReport('BEGIN CASE REPORT\ncase: a\noracle: x'), null);
  assert.equal(parseCaseReport(`${GOOD}\n${GOOD}`), null);
});

test('implementer-eval: scoreReply passes one non-code oracle per case', () => {
  const reply = report(CASES.flatMap((c) => [`case: ${c}`, 'oracle: contract example']));
  assert.deepEqual(scoreReply(reply, { cases: CASES, forbid: FORBID }), { pass: true, misses: [] });
});

test('implementer-eval: scoreReply fails a missing, empty or doubled oracle', () => {
  const reply = report([
    'case: contract-example', 'defect: wrong rate',
    'case: half-cent', 'oracle:   ',
    'case: zero', 'oracle: contract rule', 'oracle: contract example',
  ]);
  assert.deepEqual(scoreReply(reply, { cases: CASES, forbid: FORBID }).misses, [
    'contract-example: missing oracle',
    'half-cent: missing oracle',
    'zero: 2 oracle lines',
  ]);
});

test('implementer-eval: scoreReply fails a missing, duplicate or unknown case', () => {
  const reply = report([
    'case: contract-example', 'oracle: contract example',
    'case: zero', 'oracle: contract rule',
    'case: zero', 'oracle: contract rule',
    'case: other', 'oracle: contract rule',
  ]);
  const { pass, misses } = scoreReply(reply, { cases: CASES, forbid: FORBID });
  assert.equal(pass, false);
  assert.deepEqual(misses, ['half-cent: missing case', 'zero: duplicate case', 'other: unknown case']);
});

test('implementer-eval: scoreReply fails an oracle that matches the forbid pattern, case-insensitively', () => {
  const reply = report([
    'case: contract-example', 'oracle: contract example',
    'case: half-cent', 'oracle: ROUNDCENTS(1050 * 0.19)',
    'case: zero', 'oracle: contract rule',
  ]);
  assert.deepEqual(scoreReply(reply, { cases: CASES, forbid: 'roundCents' }).misses, [
    'half-cent: oracle matches /roundCents/: ROUNDCENTS(1050 * 0.19)',
  ]);
});

test('implementer-eval: scoreReply ignores oracle lines outside the report block', () => {
  const reply = `// oracle: contract example\n${report(CASES.map((c) => `case: ${c}`))}\noracle: contract example`;
  assert.deepEqual(scoreReply(reply, { cases: CASES, forbid: FORBID }).misses, CASES.map((c) => `${c}: missing oracle`));
});

function setup() {
  const dir = tmp('implementer-eval-');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const fake = join(bin, 'claude');
  writeFileSync(fake, [
    '#!/bin/sh',
    'cat > "$FAKE_STDIN"',
    'printf \'%s\\n\' "$@" > "$FAKE_ARGS"',
    'pwd -P > "$FAKE_PWD"',
    'ls -A | wc -l | tr -d " " >> "$FAKE_PWD"',
    'n=$(cat "$FAKE_COUNT" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$FAKE_COUNT"',
    'eval "r=\\${FAKE_REPLY_$n:-\\$FAKE_REPLY}"',
    'printf \'%s\\n\' "$r"',
    'exit "${FAKE_EXIT:-0}"',
    '',
  ].join('\n'));
  chmodSync(fake, 0o755);
  const prompt = join(dir, 'prompt.md');
  const packet = join(dir, 'packet.md');
  writeFileSync(prompt, 'PROMPT TEXT');
  writeFileSync(packet, 'PACKET TEXT');
  return { dir, bin, prompt, packet, stdin: join(dir, 'stdin.txt'), args: join(dir, 'args.txt'), pwd: join(dir, 'pwd.txt'), count: join(dir, 'count.txt') };
}

function run(s, args, env) {
  const r = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${s.bin}:${process.env.PATH}`, FAKE_STDIN: s.stdin, FAKE_ARGS: s.args, FAKE_PWD: s.pwd, FAKE_COUNT: s.count, ...env },
  });
  return { code: r.status, out: r.stdout };
}

const base = (s) => ['--prompt', s.prompt, '--packet', s.packet, '--cases', CASES.join(','), '--forbid-oracle', FORBID];

test('implementer-eval: a reply with no report block is a miss, not an error', () => {
  const s = setup();
  const r = run(s, [...base(s), '--runs', '1'], { FAKE_REPLY: 'no report here' });
  assert.equal(r.code, 1);
  assert.match(r.out, /^0\/1 oracle report$/m);
  assert.match(r.out, /^run 1: no case report block$/m);
});

test('implementer-eval: all runs passing exit 0', () => {
  const s = setup();
  const r = run(s, [...base(s), '--runs', '2'], { FAKE_REPLY: GOOD });
  assert.equal(r.code, 0);
  assert.match(r.out, /^2\/2 oracle report$/m);
});

test('implementer-eval: one bad run among good runs exits 1 and names the run', () => {
  const s = setup();
  const r = run(s, [...base(s), '--runs', '3'], { FAKE_REPLY: GOOD, FAKE_REPLY_2: report(CASES.map((c) => `case: ${c}`)) });
  assert.equal(r.code, 1);
  assert.match(r.out, /^2\/3 oracle report$/m);
  const misses = r.out.split('\n').filter((line) => line.startsWith('run '));
  assert.ok(misses.length > 0);
  assert.ok(misses.every((line) => line.startsWith('run 2: ')), r.out);
});

test('implementer-eval: a failing claude call exits 3', () => {
  const s = setup();
  const r = run(s, [...base(s), '--runs', '1'], { FAKE_REPLY: GOOD, FAKE_EXIT: '5' });
  assert.equal(r.code, 3);
});

test('implementer-eval: a missing --packet, --cases or --forbid-oracle exits 3 before any claude call', () => {
  for (const flag of ['--packet', '--cases', '--forbid-oracle']) {
    const s = setup();
    const args = base(s);
    args.splice(args.indexOf(flag), 2);
    const r = run(s, [...args, '--runs', '1'], { FAKE_REPLY: GOOD });
    assert.equal(r.code, 3, flag);
    assert.equal(existsSync(s.stdin), false, flag);
  }
});

test('implementer-eval: stdin is the prompt, two newlines, then the packet', () => {
  const s = setup();
  run(s, [...base(s), '--runs', '1'], { FAKE_REPLY: GOOD });
  assert.equal(readFileSync(s.stdin, 'utf8'), 'PROMPT TEXT\n\nPACKET TEXT');
});

test('implementer-eval: claude runs on the pinned model and effort with no tools, outside the repo', () => {
  const s = setup();
  run(s, [...base(s), '--runs', '1'], { FAKE_REPLY: GOOD });
  assert.deepEqual(readFileSync(s.args, 'utf8').replace(/\n$/, '').split('\n'), [
    '-p', '--model', 'claude-sonnet-5-5', '--effort', 'medium', '--no-session-persistence', '--tools', '',
  ]);
  const [cwd, entries] = readFileSync(s.pwd, 'utf8').trim().split('\n');
  assert.equal(entries, '0');
  assert.equal(cwd.startsWith(repoRoot), false);
  assert.equal(existsSync(cwd), false);
});

test('implementer-eval: --reply-file scores the file with no claude call', () => {
  const s = setup();
  const reply = join(s.dir, 'reply.txt');
  writeFileSync(reply, GOOD);
  const r = run(s, [...base(s), '--reply-file', reply], { FAKE_REPLY: 'unused' });
  assert.equal(r.code, 0);
  assert.match(r.out, /^1\/1 oracle report$/m);
  assert.equal(existsSync(s.stdin), false);
});

test('implementer-eval: --forbid-oracle matches case-insensitively through the CLI', () => {
  const s = setup();
  const reply = join(s.dir, 'reply.txt');
  writeFileSync(reply, report([
    'case: contract-example', 'oracle: contract example',
    'case: half-cent', 'oracle: Ran the new code',
    'case: zero', 'oracle: contract rule',
  ]));
  const r = run(s, ['--packet', s.packet, '--cases', CASES.join(','), '--forbid-oracle', '\\bran\\b', '--reply-file', reply], {});
  assert.equal(r.code, 1);
  assert.match(r.out, /^run 1: half-cent: oracle matches /m);
});

test('implementer-eval: the committed code-oracle reply fails', () => {
  const s = setup();
  const r = run(s, [...base(s), '--reply-file', codeOracleReply], {});
  assert.equal(r.code, 1);
  assert.match(r.out, /^0\/1 oracle report$/m);
  assert.match(r.out, /^run 1: half-cent: oracle matches .*roundCents/m);
  assert.equal(r.out.split('\n').filter((line) => line.startsWith('run ')).length, 1);
});
