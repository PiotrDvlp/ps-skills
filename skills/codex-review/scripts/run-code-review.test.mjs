import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync, statSync, readdirSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeRepo, write, commitAll, makeFakeCodex, goodResult } from './test-helpers.mjs';
import { decideWrite } from './write-decision.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, 'run-code-review.mjs');
const WRITER = join(HERE, 'write-note.mjs');

function runner(cmd, args, { fakeDir, cwd } = {}) {
  const env = { ...process.env };
  if (fakeDir) env.PATH = `${fakeDir}:${env.PATH}`;
  return spawnSync('node', [RUNNER, cmd, ...args], { encoding: 'utf8', env, cwd });
}

function dirtyRepo() {
  const r = makeRepo();
  write(r.dir, 'a.txt', 'v1\n');
  commitAll(r.g);
  write(r.dir, 'a.txt', 'v2\n');
  return r;
}

// ---------------------------------------------------------------- two-phase/

test('two-phase/ prepare emits sizing JSON and spawns no codex', () => {
  const r = dirtyRepo();
  // No fake codex on PATH at all: if prepare spawned one it would fail here.
  const res = runner('prepare', ['--uncommitted', '--repo', r.dir]);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.ok(out.bundle && existsSync(out.bundle));
  assert.ok(out.bytes > 0);
  assert.equal(out.soft_warn, false);
  assert.match(out.diff_sha256, /^[0-9a-f]{64}$/);
  rmSync(out.bundle, { recursive: true, force: true });
  r.cleanup();
});

test('two-phase/ run aborts when the patch is mutated between phases', () => {
  const r = dirtyRepo();
  const prep = JSON.parse(runner('prepare', ['--uncommitted', '--repo', r.dir]).stdout);
  const fake = makeFakeCodex({ json: goodResult() });

  writeFileSync(join(prep.bundle, 'patch.diff'), 'tampered\n');

  const res = runner('run', ['--bundle', prep.bundle], { fakeDir: fake.dir });
  assert.notEqual(res.status, 0, 'a tampered bundle must abort');
  assert.match(res.stderr, /bundle_tampered/);
  fake.cleanup(); r.cleanup();
});

test('two-phase/ happy path produces a structured result', () => {
  const r = dirtyRepo();
  const prep = JSON.parse(runner('prepare', ['--uncommitted', '--repo', r.dir]).stdout);
  const fake = makeFakeCodex({ json: goodResult() });

  const res = runner('run', ['--bundle', prep.bundle], { fakeDir: fake.dir });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.reviewer_verdict, 'PASS');
  assert.equal(out.final_verdict, 'PASS');
  assert.match(out.body, /## Verdict/);
  assert.equal(out.frontmatter.reasoning_effort, 'high');
  assert.equal(existsSync(prep.bundle), false, 'run cleans the bundle');
  fake.cleanup(); r.cleanup();
});

// ---------------------------------------------------------------- reachability/

test('reachability/ PASS, NEEDS-WORK and BLOCKER all reach a rendered note', () => {
  for (const [verdict, severity] of [['PASS', null], ['NEEDS-WORK', 'WARNING'], ['BLOCKER', 'BLOCKER']]) {
    const r = dirtyRepo();
    const prep = JSON.parse(runner('prepare', ['--uncommitted', '--repo', r.dir]).stdout);
    const patch = readFileSync(join(prep.bundle, 'patch.diff'), 'utf8');
    const line = parseInt(patch.match(/@@ -\d+(?:,\d+)? \+(\d+)/)[1], 10);

    const issues = severity
      ? [{ severity, title: 'finding', path: 'a.txt', side: 'new', line, body: 'because' }]
      : [];
    const fake = makeFakeCodex({ json: goodResult({ verdict, issues }) });

    const res = runner('run', ['--bundle', prep.bundle], { fakeDir: fake.dir });
    assert.equal(res.status, 0, `${verdict}: ${res.stderr}`);
    const out = JSON.parse(res.stdout);
    assert.equal(out.reviewer_verdict, verdict);
    assert.equal(out.final_verdict, verdict);
    assert.doesNotMatch(out.body, /\(default —/);
    fake.cleanup(); r.cleanup();
  }
});

// ---------------------------------------------------------------- fatal/

const fatalCases = [
  ['invalid JSON', { json: 'not json at all' }, /invalid_json/],
  ['missing required property', { json: '{"protocol_version":"codex-review-code/v1","verdict":"PASS","issues":[]}' }, /schema_violation/],
  ['additional property', { json: '{"protocol_version":"codex-review-code/v1","verdict":"PASS","issues":[],"unresolved_assumptions":[],"extra":1}' }, /schema_violation/],
  ['empty output', { json: '' }, /empty_output/],
  ['nonzero codex exit', { json: goodResult(), exit: 3 }, /codex_failed/],
  ['model fallback warning', { json: goodResult(), stderr: 'Model metadata for typo not found. Defaulting to fallback metadata' }, /model_fallback/],
];

for (const [name, behavior, expected] of fatalCases) {
  test(`fatal/ ${name} aborts with no result`, () => {
    const r = dirtyRepo();
    const prep = JSON.parse(runner('prepare', ['--uncommitted', '--repo', r.dir]).stdout);
    const fake = makeFakeCodex(behavior);
    const res = runner('run', ['--bundle', prep.bundle], { fakeDir: fake.dir });
    assert.notEqual(res.status, 0, `${name} must abort`);
    assert.match(res.stderr, expected);
    assert.equal(res.stdout.trim(), '', 'a failed run must emit no result object');
    fake.cleanup(); r.cleanup();
  });
}

test('fatal/ verdict contradicting severities aborts', () => {
  const r = dirtyRepo();
  const prep = JSON.parse(runner('prepare', ['--uncommitted', '--repo', r.dir]).stdout);
  const patch = readFileSync(join(prep.bundle, 'patch.diff'), 'utf8');
  const line = parseInt(patch.match(/@@ -\d+(?:,\d+)? \+(\d+)/)[1], 10);
  const fake = makeFakeCodex({
    json: goodResult({ verdict: 'PASS', issues: [{ severity: 'BLOCKER', title: 't', path: 'a.txt', side: 'new', line, body: 'b' }] }),
  });
  const res = runner('run', ['--bundle', prep.bundle], { fakeDir: fake.dir });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /verdict_mismatch/);
  fake.cleanup(); r.cleanup();
});

test('fatal/ out-of-scope citation aborts', () => {
  const r = dirtyRepo();
  const prep = JSON.parse(runner('prepare', ['--uncommitted', '--repo', r.dir]).stdout);
  const fake = makeFakeCodex({
    json: goodResult({
      verdict: 'NEEDS-WORK',
      issues: [{ severity: 'WARNING', title: 'off', path: '.codex/x.json', side: 'new', line: 99, body: 'b' }],
    }),
  });
  const res = runner('run', ['--bundle', prep.bundle], { fakeDir: fake.dir });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /citation_invalid/);
  fake.cleanup(); r.cleanup();
});

test('fatal/ empty patch aborts in prepare', () => {
  const r = makeRepo();
  write(r.dir, 'a.txt', 'v1\n');
  commitAll(r.g);
  const res = runner('prepare', ['--uncommitted', '--repo', r.dir]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /empty_patch/);
  r.cleanup();
});

// ---------------------------------------------------------------- drift/

test('drift/ a codex that edits an already-modified file aborts the run', () => {
  const r = dirtyRepo();
  const prep = JSON.parse(runner('prepare', ['--uncommitted', '--repo', r.dir]).stdout);
  const fake = makeFakeCodex({
    json: goodResult(),
    mutate: `printf 'v3-drifted\\n' > ${JSON.stringify(join(r.dir, 'a.txt'))}`,
  });
  const res = runner('run', ['--bundle', prep.bundle], { fakeDir: fake.dir });
  assert.notEqual(res.status, 0, 'content-only drift must abort');
  assert.match(res.stderr, /drift_during_run/);
  assert.equal(res.stdout.trim(), '');
  fake.cleanup(); r.cleanup();
});

test('drift/ a change between prepare and run aborts before spawning', () => {
  const r = dirtyRepo();
  const prep = JSON.parse(runner('prepare', ['--uncommitted', '--repo', r.dir]).stdout);
  write(r.dir, 'a.txt', 'v3-changed-during-the-prompt\n');
  const fake = makeFakeCodex({ json: goodResult() });
  const res = runner('run', ['--bundle', prep.bundle], { fakeDir: fake.dir });
  assert.notEqual(res.status, 0, 'the prepare->run window must be guarded');
  assert.match(res.stderr, /drift_before_run/);
  fake.cleanup(); r.cleanup();
});

// ---------------------------------------------------------------- unreviewable/

test('unreviewable/ binary change caps a reviewer PASS at NEEDS-WORK without aborting', () => {
  const r = makeRepo();
  write(r.dir, 'keep.txt', 'x\n');
  commitAll(r.g);
  writeFileSync(join(r.dir, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
  const prep = JSON.parse(runner('prepare', ['--uncommitted', '--repo', r.dir]).stdout);
  assert.ok(prep.unreviewable_paths.length > 0, 'binary path must be flagged unreviewable');

  const fake = makeFakeCodex({ json: goodResult({ verdict: 'PASS' }) });
  const res = runner('run', ['--bundle', prep.bundle], { fakeDir: fake.dir });
  assert.equal(res.status, 0, `must succeed, not abort: ${res.stderr}`);
  const out = JSON.parse(res.stdout);
  assert.equal(out.reviewer_verdict, 'PASS', 'reviewer verdict must be preserved verbatim');
  assert.equal(out.final_verdict, 'NEEDS-WORK', 'coverage cap must apply');
  assert.match(out.body, /## Incomplete coverage/);
  fake.cleanup(); r.cleanup();
});

// ---------------------------------------------------------------- argv/

test('argv/ exactly one codex spawn, always read-only with required flags', () => {
  const r = dirtyRepo();
  const prep = JSON.parse(runner('prepare', ['--uncommitted', '--repo', r.dir]).stdout);
  const spy = mkdtempSync(join(tmpdir(), 'cxr-spy-'));
  const log = join(spy, 'calls.log');
  writeFileSync(join(spy, 'codex'), `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
OUT=""
while [ $# -gt 0 ]; do case "$1" in -o) OUT="$2"; shift 2 ;; *) shift ;; esac; done
cat > /dev/null
printf 'model: gpt-5.6-terra\\n' >&2
[ -n "$OUT" ] && cat > "$OUT" <<'EOF'
${goodResult()}
EOF
exit 0
`);
  execFileSync('chmod', ['755', join(spy, 'codex')]);

  const res = runner('run', ['--bundle', prep.bundle], { fakeDir: spy });
  assert.equal(res.status, 0, res.stderr);
  const calls = readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(calls.length, 1, 'exactly one codex invocation per run');
  const argv = calls[0];
  assert.match(argv, /-m gpt-5.6-terra/, 'the review default must use the cost-balanced Terra tier');
  assert.match(argv, /-s read-only/);
  assert.match(argv, /-C /);
  assert.match(argv, /--output-schema /);
  assert.match(argv, /-c model_reasoning_effort="high"/);
  assert.doesNotMatch(argv, /--json/,
    '--json must NOT be passed: it carries no model field and suppresses the `model:` header, '
    + 'which is the only provenance channel on codex-cli 0.144.5');
  assert.doesNotMatch(argv, /workspace-write|danger-full-access/);
  rmSync(spy, { recursive: true, force: true });
  r.cleanup();
});

test('argv/ --deep raises effort without changing the model', () => {
  const r = dirtyRepo();
  const prep = JSON.parse(runner('prepare', ['--uncommitted', '--repo', r.dir]).stdout);
  const spy = mkdtempSync(join(tmpdir(), 'cxr-spy-'));
  const log = join(spy, 'calls.log');
  writeFileSync(join(spy, 'codex'), `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
OUT=""
while [ $# -gt 0 ]; do case "$1" in -o) OUT="$2"; shift 2 ;; *) shift ;; esac; done
cat > /dev/null
printf 'model: gpt-5.6-terra\\n' >&2
[ -n "$OUT" ] && cat > "$OUT" <<'EOF'
${goodResult()}
EOF
exit 0
`);
  execFileSync('chmod', ['755', join(spy, 'codex')]);

  const res = runner('run', ['--bundle', prep.bundle, '--deep', '--model', 'gpt-5.6-terra'], { fakeDir: spy });
  assert.equal(res.status, 0, res.stderr);
  const argv = readFileSync(log, 'utf8').trim();
  assert.match(argv, /-m gpt-5.6-terra/, '--deep must not override an explicit --model');
  assert.match(argv, /-c model_reasoning_effort="xhigh"/);
  rmSync(spy, { recursive: true, force: true });
  r.cleanup();
});

// ---------------------------------------------------------------- provenance/

test('provenance/ a disallowed model is rejected before any spawn', () => {
  const r = dirtyRepo();
  const prep = JSON.parse(runner('prepare', ['--uncommitted', '--repo', r.dir]).stdout);
  const res = runner('run', ['--bundle', prep.bundle, '--model', 'gpt-5.6-pro'], {});
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /model_not_allowed/);
  rmSync(prep.bundle, { recursive: true, force: true });
  r.cleanup();
});

test('provenance/ resolved != requested aborts', () => {
  const r = dirtyRepo();
  const prep = JSON.parse(runner('prepare', ['--uncommitted', '--repo', r.dir]).stdout);
  const fake = makeFakeCodex({ json: goodResult(), model: 'gpt-5.6-luna' });
  const res = runner('run', ['--bundle', prep.bundle, '--model', 'gpt-5.6-sol'], { fakeDir: fake.dir });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /model_mismatch/);
  fake.cleanup(); r.cleanup();
});

// ---------------------------------------------------------------- lifecycle/

test('lifecycle/ prepare keeps the bundle on success and removes it on failure', () => {
  const r = dirtyRepo();
  const ok = JSON.parse(runner('prepare', ['--uncommitted', '--repo', r.dir]).stdout);
  assert.ok(existsSync(ok.bundle), 'prepare success must LEAVE the bundle for run');
  assert.equal(statSync(ok.bundle).mode & 0o777, 0o700, 'bundle must be 0700');
  rmSync(ok.bundle, { recursive: true, force: true });

  const clean = makeRepo();
  write(clean.dir, 'a.txt', 'x\n');
  commitAll(clean.g);
  const bundles = () => readdirSync(tmpdir()).filter((n) => n.startsWith('cxr-bundle-'));
  const before = new Set(bundles());
  const fail = runner('prepare', ['--uncommitted', '--repo', clean.dir]);
  assert.notEqual(fail.status, 0, 'a clean repo has an empty patch and must fail');
  assert.deepEqual(bundles().filter((d) => !before.has(d)), [],
    'prepare failure must leave no bundle behind');
  clean.cleanup(); r.cleanup();
});

test('lifecycle/ discard removes a bundle', () => {
  const r = dirtyRepo();
  const prep = JSON.parse(runner('prepare', ['--uncommitted', '--repo', r.dir]).stdout);
  assert.ok(existsSync(prep.bundle));
  const res = runner('discard', ['--bundle', prep.bundle]);
  assert.equal(res.status, 0);
  assert.equal(existsSync(prep.bundle), false);
  r.cleanup();
});

test('lifecycle/ --keep-artifacts retains the bundle and prints the path', () => {
  const r = dirtyRepo();
  const prep = JSON.parse(runner('prepare', ['--uncommitted', '--repo', r.dir]).stdout);
  const fake = makeFakeCodex({ json: goodResult() });
  const res = runner('run', ['--bundle', prep.bundle, '--keep-artifacts'], { fakeDir: fake.dir });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(existsSync(prep.bundle), 'bundle must be retained');
  assert.match(res.stderr, /\[kept\]/);
  rmSync(prep.bundle, { recursive: true, force: true });
  fake.cleanup(); r.cleanup();
});

test('lifecycle/ prepare sweeps an abandoned bundle older than the TTL', () => {
  const stale = mkdtempSync(join(tmpdir(), 'cxr-bundle-'));
  writeFileSync(join(stale, 'manifest.json'), JSON.stringify({
    created_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
  }));
  const r = dirtyRepo();
  const prep = JSON.parse(runner('prepare', ['--uncommitted', '--repo', r.dir]).stdout);
  assert.equal(existsSync(stale), false, 'stale bundle must be swept');
  rmSync(prep.bundle, { recursive: true, force: true });
  r.cleanup();
});

test('lifecycle/ prepare never sweeps a prefix-matching directory that holds no manifest', () => {
  const foreign = mkdtempSync(join(tmpdir(), 'cxr-bundle-'));
  writeFileSync(join(foreign, 'sentinel'), 'keep me');
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  utimesSync(foreign, old, old);
  const r = dirtyRepo();
  const prep = JSON.parse(runner('prepare', ['--uncommitted', '--repo', r.dir]).stdout);
  assert.equal(readFileSync(join(foreign, 'sentinel'), 'utf8'), 'keep me', 'a directory without a manifest is not ours');
  rmSync(foreign, { recursive: true, force: true });
  rmSync(prep.bundle, { recursive: true, force: true });
  r.cleanup();
});

for (const cmd of ['run', 'discard']) {
  test(`lifecycle/ ${cmd} refuses a directory that is not a bundle and deletes nothing`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'cxr-notabundle-'));
    writeFileSync(join(dir, 'sentinel'), 'keep me');
    const res = runner(cmd, ['--bundle', dir]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /\[not_a_bundle\]/);
    assert.equal(readFileSync(join(dir, 'sentinel'), 'utf8'), 'keep me');
    rmSync(dir, { recursive: true, force: true });
  });
}

// ---------------------------------------------------------------- cli/

for (const [name, args] of [
  ['an unknown flag', ['--uncommitted', '--bogus']],
  ['a value flag with no value', ['--base']],
  ['a value flag followed by another flag', ['--base', '--tracked-only']],
  ['two target selectors', ['--uncommitted', '--commit', 'HEAD']],
]) {
  test(`cli/ prepare refuses ${name} before touching the repo`, () => {
    const r = dirtyRepo();
    const res = runner('prepare', [...args, '--repo', r.dir]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /\[usage\]/);
    r.cleanup();
  });
}

test('cli/ a patch at or above 500 KiB is refused even with --force', () => {
  const r = dirtyRepo();
  write(r.dir, 'big.txt', 'a\n'.repeat(300 * 1024));
  const plain = runner('prepare', ['--uncommitted', '--repo', r.dir]);
  assert.notEqual(plain.status, 0);
  assert.match(plain.stderr, /\[too_large\]/);
  const forced = runner('prepare', ['--uncommitted', '--force', '--repo', r.dir]);
  assert.notEqual(forced.status, 0, '--force must not waive the hard limit');
  assert.match(forced.stderr, /\[usage\]/);
  r.cleanup();
});

// ---------------------------------------------------------------- write-decision/

test('write-decision/ refuses on every failure shape', () => {
  const base = { routing: 'project', baseDir: 'outputs/p/codex-reviews', slug: 's', existing: [] };
  for (const result of [null, undefined, { ok: false, error: 'boom' }, {}]) {
    assert.equal(decideWrite({ ...base, result }).shouldWrite, false);
  }
});

test('write-decision/ suffixes on collision and defers on unknown routing', () => {
  const result = { ok: true, date: '2026-08-15', title: 'T' };
  const baseDir = 'outputs/p/codex-reviews';
  const d1 = decideWrite({ result, routing: 'project', baseDir, slug: 's', existing: [] });
  assert.equal(d1.path, `${baseDir}/s.md`);

  const d2 = decideWrite({ result, routing: 'project', baseDir, slug: 's', existing: [`${baseDir}/s.md`] });
  assert.equal(d2.path, `${baseDir}/s-2.md`);

  const d3 = decideWrite({ result, routing: 'unknown', baseDir, slug: 's', existing: [] });
  assert.equal(d3.shouldWrite, false, 'unknown namespace needs confirmation');
  assert.equal(decideWrite({ result, routing: 'unknown', baseDir, slug: 's', existing: [], confirmed: true }).shouldWrite, true);
});

// ---------------------------------------------------------------- writer-gate/

function fakeVault() {
  const v = mkdtempSync(join(tmpdir(), 'cxr-vault-'));
  mkdirSync(join(v, 'outputs/p/codex-reviews'), { recursive: true });
  writeFileSync(join(v, 'log.md'), `# Log\n\n<!-- log:entries -->\n\n## [2026-08-01] x | y → [[z]]\n`);
  return v;
}

test('writer-gate/ a failed run leaves no note and log.md byte-identical', () => {
  const v = fakeVault();
  const logBefore = readFileSync(join(v, 'log.md'));
  const resultPath = join(v, 'result.json');

  for (const bad of ['{"ok":false,"error":"citation_invalid"}', 'not json', '']) {
    writeFileSync(resultPath, bad);
    const res = spawnSync('node', [WRITER,
      '--result', resultPath, '--vault', v,
      '--base-dir', 'outputs/p/codex-reviews', '--slug', 'note', '--routing', 'project',
    ], { encoding: 'utf8' });
    assert.notEqual(res.status, 0, `writer must refuse for: ${bad}`);
    assert.equal(existsSync(join(v, 'outputs/p/codex-reviews/note.md')), false, 'no note may be written');
    assert.deepEqual(readFileSync(join(v, 'log.md')), logBefore, 'log.md must be untouched');
  }
  rmSync(v, { recursive: true, force: true });
});

test('writer-gate/ a successful run writes the note and prepends log.md once', () => {
  const v = fakeVault();
  const resultPath = join(v, 'result.json');
  writeFileSync(resultPath, JSON.stringify({
    ok: true, date: '2026-08-15', title: 'Codex review — abc',
    body: '## Verdict\n\nPASS\n\n## Issues\n\nNo findings.\n',
    frontmatter: { model_requested: 'gpt-5.6-sol', final_verdict: 'PASS' },
  }));

  const res = spawnSync('node', [WRITER,
    '--result', resultPath, '--vault', v,
    '--base-dir', 'outputs/p/codex-reviews', '--slug', 'note', '--routing', 'project',
  ], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);

  const note = readFileSync(join(v, 'outputs/p/codex-reviews/note.md'), 'utf8');
  assert.match(note, /^---\n/);
  assert.match(note, /source: codex-review/);
  assert.match(note, /## Verdict/);

  const log = readFileSync(join(v, 'log.md'), 'utf8');
  assert.match(log, /<!-- log:entries -->\n\n## \[2026-08-15\] codex-review \| Codex review — abc → \[\[note\]\]/);
  assert.equal((log.match(/codex-review \|/g) || []).length, 1, 'exactly one entry prepended');
  rmSync(v, { recursive: true, force: true });
});

test('writer-gate/ unknown routing without confirmation writes nothing', () => {
  const v = fakeVault();
  const resultPath = join(v, 'result.json');
  writeFileSync(resultPath, JSON.stringify({
    ok: true, date: '2026-08-15', title: 'T', body: 'x', frontmatter: {},
  }));
  const res = spawnSync('node', [WRITER,
    '--result', resultPath, '--vault', v,
    '--base-dir', 'outputs/p/codex-reviews', '--slug', 'note', '--routing', 'unknown',
  ], { encoding: 'utf8' });
  assert.notEqual(res.status, 0);
  assert.equal(existsSync(join(v, 'outputs/p/codex-reviews/note.md')), false);
  rmSync(v, { recursive: true, force: true });
});

test('writer-gate/ missing sentinel aborts before the note write (all-or-nothing)', () => {
  const v = fakeVault();
  const resultPath = join(v, 'result.json');
  writeFileSync(resultPath, JSON.stringify({
    ok: true, date: '2026-08-15', title: 'T', body: 'x', frontmatter: {},
  }));
  writeFileSync(join(v, 'log.md'), '# Log\n\nno sentinel here\n');

  const res = spawnSync('node', [WRITER,
    '--result', resultPath, '--vault', v,
    '--base-dir', 'outputs/p/codex-reviews', '--slug', 'note', '--routing', 'project',
  ], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /\[abort\].*sentinel/);
  assert.equal(JSON.parse(res.stdout).written, false, 'abort path must emit the JSON contract');
  assert.match(JSON.parse(res.stdout).reason, /log handoff failed/);
  assert.equal(existsSync(join(v, 'outputs/p/codex-reviews/note.md')), false, 'no note may precede the log guard');
  assert.match(readFileSync(join(v, 'log.md'), 'utf8'), /no sentinel here/); // untouched
  rmSync(v, { recursive: true, force: true });
});

test('writer-gate/ missing log.md aborts cleanly with no stack trace and no note', () => {
  const v = fakeVault();
  rmSync(join(v, 'log.md'));
  const resultPath = join(v, 'result.json');
  writeFileSync(resultPath, JSON.stringify({
    ok: true, date: '2026-08-15', title: 'T', body: 'x', frontmatter: {},
  }));

  const res = spawnSync('node', [WRITER,
    '--result', resultPath, '--vault', v,
    '--base-dir', 'outputs/p/codex-reviews', '--slug', 'note', '--routing', 'project',
  ], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /\[abort\] cannot read/);
  assert.doesNotMatch(res.stderr, /at /, 'no stack trace on the clean-abort path');
  assert.equal(JSON.parse(res.stdout).written, false, 'abort path must emit the JSON contract');
  assert.match(JSON.parse(res.stdout).reason, /log handoff failed/);
  assert.equal(existsSync(join(v, 'outputs/p/codex-reviews/note.md')), false);
  rmSync(v, { recursive: true, force: true });
});

test('writer-gate/ --no-log writes the note into a new directory and never touches log.md', () => {
  const v = fakeVault();
  rmSync(join(v, 'log.md'));
  const resultPath = join(v, 'result.json');
  writeFileSync(resultPath, JSON.stringify({
    ok: true, date: '2026-08-15', title: 'T', body: '## Verdict\n\nPASS\n', frontmatter: {},
  }));

  const res = spawnSync('node', [WRITER,
    '--result', resultPath, '--vault', v,
    '--base-dir', 'codex-reviews', '--slug', 'note', '--routing', 'other', '--no-log',
  ], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.written, true);
  assert.equal(out.logLine, null);
  assert.equal(out.path, join(v, 'codex-reviews/note.md'), 'no-log path is absolute');
  assert.match(readFileSync(join(v, 'codex-reviews/note.md'), 'utf8'), /## Verdict/);
  assert.equal(existsSync(join(v, 'log.md')), false, 'no log.md may be created');
  rmSync(v, { recursive: true, force: true });
});

test('writer-gate/ a log.md that cannot be read (directory) aborts cleanly with no note', () => {
  const v = fakeVault();
  rmSync(join(v, 'log.md'));
  mkdirSync(join(v, 'log.md'));
  const resultPath = join(v, 'result.json');
  writeFileSync(resultPath, JSON.stringify({
    ok: true, date: '2026-08-15', title: 'T', body: 'x', frontmatter: {},
  }));

  const res = spawnSync('node', [WRITER,
    '--result', resultPath, '--vault', v,
    '--base-dir', 'outputs/p/codex-reviews', '--slug', 'note', '--routing', 'project',
  ], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /\[abort\] cannot read/);
  assert.doesNotMatch(res.stderr, /at /, 'no stack trace on the clean-abort path');
  assert.equal(JSON.parse(res.stdout).written, false, 'abort path must emit the JSON contract');
  assert.match(JSON.parse(res.stdout).reason, /log handoff failed/);
  assert.equal(existsSync(join(v, 'outputs/p/codex-reviews/note.md')), false);
  rmSync(v, { recursive: true, force: true });
});

test('writer-gate/ a $& in the title is written literally, never splicing the sentinel', () => {
  const v = fakeVault();
  const resultPath = join(v, 'result.json');
  writeFileSync(resultPath, JSON.stringify({
    ok: true, date: '2026-08-15', title: 'review of foo$& bar',
    body: '## Verdict\n\nPASS\n', frontmatter: {},
  }));

  const res = spawnSync('node', [WRITER,
    '--result', resultPath, '--vault', v,
    '--base-dir', 'outputs/p/codex-reviews', '--slug', 'note', '--routing', 'project',
  ], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);

  const log = readFileSync(join(v, 'log.md'), 'utf8');
  assert.match(log, /## \[2026-08-15\] codex-review \| review of foo\$& bar → \[\[note\]\]/,
    'the title must survive literally in the log line');
  assert.equal((log.match(/<!-- log:entries -->/g) || []).length, 1,
    'exactly one sentinel must remain in log.md');
  rmSync(v, { recursive: true, force: true });
});

test('writer-gate/ a held log.md.lock aborts cleanly with no note written', () => {
  const v = fakeVault();
  const lockPath = join(v, 'log.md.lock');
  writeFileSync(lockPath, '999999'); // fresh mtime: not stale, must not be stolen
  const logBefore = readFileSync(join(v, 'log.md'));
  const resultPath = join(v, 'result.json');
  writeFileSync(resultPath, JSON.stringify({
    ok: true, date: '2026-08-15', title: 'T', body: 'x', frontmatter: {},
  }));

  const res = spawnSync('node', [WRITER,
    '--result', resultPath, '--vault', v,
    '--base-dir', 'outputs/p/codex-reviews', '--slug', 'note', '--routing', 'project',
  ], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(res.status, 1, 'a held lock must abort with exit 1');
  assert.match(res.stderr, /\[abort\] another writer holds log\.md\.lock/);
  const out = JSON.parse(res.stdout);
  assert.equal(out.written, false);
  assert.equal(out.reason, 'log.md lock timeout');
  assert.equal(existsSync(join(v, 'outputs/p/codex-reviews/note.md')), false, 'no note may be written');
  assert.deepEqual(readFileSync(join(v, 'log.md')), logBefore, 'log.md must be untouched');
  assert.equal(existsSync(lockPath), true, 'the foreign lock must not be removed by the losing writer');
  rmSync(v, { recursive: true, force: true });
});

test('writer-gate/ a successful run removes its log.md.lock', () => {
  const v = fakeVault();
  const lockPath = join(v, 'log.md.lock');
  const resultPath = join(v, 'result.json');
  writeFileSync(resultPath, JSON.stringify({
    ok: true, date: '2026-08-15', title: 'T',
    body: '## Verdict\n\nPASS\n', frontmatter: {},
  }));

  const res = spawnSync('node', [WRITER,
    '--result', resultPath, '--vault', v,
    '--base-dir', 'outputs/p/codex-reviews', '--slug', 'note', '--routing', 'project',
  ], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).written, true);
  assert.equal(existsSync(lockPath), false, 'the lock must be released after success');
  rmSync(v, { recursive: true, force: true });
});

test('writer-gate/ a stale log.md.lock is stolen so a crashed writer cannot wedge the queue', () => {
  const v = fakeVault();
  const lockPath = join(v, 'log.md.lock');
  writeFileSync(lockPath, '999999');
  const stale = new Date(Date.now() - 60_000);
  utimesSync(lockPath, stale, stale); // older than the 30s staleness window
  const resultPath = join(v, 'result.json');
  writeFileSync(resultPath, JSON.stringify({
    ok: true, date: '2026-08-15', title: 'T',
    body: '## Verdict\n\nPASS\n', frontmatter: {},
  }));

  const res = spawnSync('node', [WRITER,
    '--result', resultPath, '--vault', v,
    '--base-dir', 'outputs/p/codex-reviews', '--slug', 'note', '--routing', 'project',
  ], { encoding: 'utf8' });
  assert.equal(res.status, 0, `a stale lock must be stolen: ${res.stderr}`);
  assert.equal(existsSync(lockPath), false, 'the stolen lock must be released after success');
  rmSync(v, { recursive: true, force: true });
});

test('writer-gate/ dry-run agrees with a real run on a sentinel-less vault (exit 1)', () => {
  const v = fakeVault();
  const resultPath = join(v, 'result.json');
  writeFileSync(resultPath, JSON.stringify({
    ok: true, date: '2026-08-15', title: 'T', body: 'x', frontmatter: {},
  }));
  writeFileSync(join(v, 'log.md'), '# Log\n\nno sentinel here\n');

  const res = spawnSync('node', [WRITER,
    '--result', resultPath, '--vault', v,
    '--base-dir', 'outputs/p/codex-reviews', '--slug', 'note', '--routing', 'project',
    '--dry-run',
  ], { encoding: 'utf8' });
  assert.equal(res.status, 1, 'dry-run must preview the same abort a real run would take');
  assert.match(res.stderr, /\[abort\].*sentinel/);
  assert.equal(existsSync(join(v, 'outputs/p/codex-reviews/note.md')), false);
  rmSync(v, { recursive: true, force: true });
});

test('run/ an unspawnable codex binary dies with a [code] line, no stack, and no leaked bundle', () => {
  const r = dirtyRepo();
  const prep = JSON.parse(runner('prepare', ['--uncommitted', '--repo', r.dir]).stdout);
  const fakeDir = mkdtempSync(join(tmpdir(), 'cxr-nocodex-'));
  const env = { ...process.env, PATH: `${fakeDir}:${dirname(process.execPath)}:/usr/bin:/bin` };
  const res = spawnSync('node', [RUNNER, 'run', '--bundle', prep.bundle], { encoding: 'utf8', env });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /^\[codex_spawn_failed\] /m, res.stderr);
  assert.doesNotMatch(res.stderr, /at .*node:/, 'no stack trace on a clean abort');
  assert.equal(existsSync(prep.bundle), false, 'bundle is cleaned up');
  rmSync(fakeDir, { recursive: true, force: true }); r.cleanup();
});

test('writer-gate/ the log path creates a missing base directory like --no-log does', () => {
  const v = fakeVault();
  const resultPath = join(v, 'result.json');
  writeFileSync(resultPath, JSON.stringify({
    ok: true, date: '2026-08-15', title: 'T', body: '## Verdict\n\nPASS\n', frontmatter: {},
  }));
  const res = spawnSync('node', [WRITER,
    '--result', resultPath, '--vault', v,
    '--base-dir', 'outputs/newproj/codex-reviews', '--slug', 'note', '--routing', 'project',
  ], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(readFileSync(join(v, 'outputs/newproj/codex-reviews/note.md'), 'utf8'), /## Verdict/);
  assert.match(readFileSync(join(v, 'log.md'), 'utf8'), /\[\[note\]\]/);
  rmSync(v, { recursive: true, force: true });
});
