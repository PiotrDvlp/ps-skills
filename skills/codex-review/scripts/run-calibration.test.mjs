import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadManifest, materializeFixture, scoreCalibration, defectFindings, exitCodeFor, reviewFixture,
} from './run-calibration.mjs';
import { makeFakeCodex, goodResult } from './test-helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'run-calibration.mjs');

// ---------------------------------------------------------------------------
// Corpus integrity.
// ---------------------------------------------------------------------------

test('manifest has 6 fixtures: 4 buggy expecting NEEDS-WORK, 2 clean expecting PASS', () => {
  const manifest = loadManifest();
  assert.equal(manifest.fixtures.length, 6);
  const buggy = manifest.fixtures.filter((f) => f.kind === 'buggy');
  const clean = manifest.fixtures.filter((f) => f.kind === 'clean');
  assert.equal(buggy.length, 4);
  assert.equal(clean.length, 2);
  for (const f of buggy) assert.equal(f.expected_verdict, 'NEEDS-WORK');
  for (const f of clean) assert.equal(f.expected_verdict, 'PASS');
  for (const f of manifest.fixtures) {
    assert.ok(f.id && f.description && f.expected_verdict, `fixture ${f.id} is incomplete`);
  }
});

test('every fixture id has a base/ and change/ directory', () => {
  const manifest = loadManifest();
  const root = join(HERE, '..', 'references', 'calibration');
  for (const f of manifest.fixtures) {
    assert.ok(existsSync(join(root, f.id, 'base')), `${f.id}/base missing`);
    assert.ok(existsSync(join(root, f.id, 'change')), `${f.id}/change missing`);
  }
});

// ---------------------------------------------------------------------------
// Materialization — a fixture becomes a git repo with an uncommitted diff.
// ---------------------------------------------------------------------------

test('materializeFixture produces a repo whose working tree differs from HEAD', () => {
  const manifest = loadManifest();
  const root = join(HERE, '..', 'references', 'calibration');
  const m = materializeFixture(join(root, 'buggy-operator'));
  try {
    const status = execFileSync('git', ['-C', m.dir, 'status', '--porcelain'], { encoding: 'utf8' });
    assert.match(status, /M lib\.js/, 'the change must appear as a modification');
    const diff = execFileSync('git', ['-C', m.dir, 'diff'], { encoding: 'utf8' });
    assert.match(diff, /total > 100/, 'the diff must contain the planted change');
  } finally {
    m.cleanup();
  }
});

test('materializeFixture surfaces new test files as untracked', () => {
  const manifest = loadManifest();
  const root = join(HERE, '..', 'references', 'calibration');
  const m = materializeFixture(join(root, 'clean-additive'));
  try {
    const status = execFileSync('git', ['-C', m.dir, 'status', '--porcelain'], { encoding: 'utf8' });
    assert.match(status, /\?\? greet\.test\.js/, 'the new test file must be untracked');
  } finally {
    m.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Scoring — pure.
// ---------------------------------------------------------------------------

test('scoreCalibration builds the confusion matrix and rates recall/precision', () => {
  // 3 should-flag, 2 clean. Reviewer flags 2 of 3 buggy + 1 clean wrongly.
  const entries = [
    { id: 'a', expected_verdict: 'NEEDS-WORK', final_verdict: 'NEEDS-WORK' },  // tp
    { id: 'b', expected_verdict: 'NEEDS-WORK', final_verdict: 'BLOCKER' },     // tp (any non-PASS counts)
    { id: 'c', expected_verdict: 'NEEDS-WORK', final_verdict: 'PASS' },        // fn
    { id: 'd', expected_verdict: 'PASS', final_verdict: 'PASS' },              // tn
    { id: 'e', expected_verdict: 'PASS', final_verdict: 'NEEDS-WORK' },        // fp
  ];
  const s = scoreCalibration(entries);
  assert.deepEqual(s.matrix, { tp: 2, fn: 1, fp: 1, tn: 1 });
  assert.equal(s.recall, 2 / 3);
  assert.equal(s.precision, 2 / 3);
  assert.equal(s.cleanPassRate, 0.5);
  assert.equal(s.byId.c.cell, 'fn');
  assert.equal(s.byId.e.cell, 'fp');
});

test('scoreCalibration handles the all-clean and all-flagged extremes', () => {
  const clean = scoreCalibration([
    { id: 'a', expected_verdict: 'PASS', final_verdict: 'PASS' },
    { id: 'b', expected_verdict: 'PASS', final_verdict: 'PASS' },
  ]);
  assert.equal(clean.recall, null, 'no should-flag fixtures → recall is n/a');
  assert.equal(clean.precision, null, 'nothing flagged → precision is n/a');
  assert.equal(clean.cleanPassRate, 1);

  const all = scoreCalibration([
    { id: 'a', expected_verdict: 'NEEDS-WORK', final_verdict: 'NEEDS-WORK' },
    { id: 'b', expected_verdict: 'NEEDS-WORK', final_verdict: 'BLOCKER' },
  ]);
  assert.deepEqual(all.matrix, { tp: 2, fn: 0, fp: 0, tn: 0 });
  assert.equal(all.recall, 1);
  assert.equal(all.precision, 1);
});

test('scoreCalibration excludes errored fixtures from the matrix but lists them', () => {
  const s = scoreCalibration([
    { id: 'a', expected_verdict: 'NEEDS-WORK', final_verdict: 'NEEDS-WORK' },
    { id: 'b', expected_verdict: 'NEEDS-WORK', error: 'codex_failed: boom' },
  ]);
  assert.deepEqual(s.matrix, { tp: 1, fn: 0, fp: 0, tn: 0 });
  assert.equal(s.errors.length, 1);
  assert.equal(s.byId.b.error, 'codex_failed: boom');
});

test('defectFindings credits keywords found in issue text, case-insensitively', () => {
  const fixtures = [
    { id: 'x', defects: [{ keyword: 'null' }, { keyword: 'boundary' }] },
    { id: 'y', defects: [{ keyword: 'swallow' }] },
  ];
  const entries = [
    {
      id: 'x', expected_verdict: 'NEEDS-WORK', final_verdict: 'NEEDS-WORK',
      issues: [{ severity: 'WARNING', text: 'WARNING: unhandled NULL guard — discountPrice may be null' }],
    },
    { id: 'y', expected_verdict: 'NEEDS-WORK', error: 'codex_failed' },
  ];
  const d = defectFindings(entries, fixtures);
  assert.deepEqual(d.x.found, ['null']);
  assert.deepEqual(d.x.missing, ['boundary']);
  assert.equal(d.x.total, 2);
  assert.deepEqual(d.y.found, [], 'errored fixture credits nothing');
  assert.deepEqual(d.y.missing, ['swallow']);
});

test('exitCodeFor applies the threshold and surfaces errors', () => {
  const ok = { recall: 0.8, errors: [] };
  const low = { recall: 0.5, errors: [] };
  assert.equal(exitCodeFor(ok, 0.75), 0);
  assert.equal(exitCodeFor(low, 0.75), 1);
  assert.equal(exitCodeFor(ok, null), 0);
  assert.equal(exitCodeFor({ recall: 0.8, errors: [{}] }, 0.75), 1);
  assert.equal(exitCodeFor({ recall: null, errors: [] }, 0.75), 0, 'n/a recall never fails the threshold');
});

// ---------------------------------------------------------------------------
// CLI dry-run — the full corpus materializes and prepares WITHOUT spawning Codex.
// ---------------------------------------------------------------------------

test('dry-run prepares every fixture without spawning codex', () => {
  const r = spawnSync('node', [SCRIPT, 'dry-run'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const id of ['buggy-operator', 'missing-null-guard', 'swallowed-error', 'tautological-test', 'clean-refactor', 'clean-additive']) {
    assert.ok(r.stdout.includes(id), `${id} missing from dry-run output:\n${r.stdout}`);
  }
  assert.ok(r.stdout.includes('bytes'), r.stdout);
});

test('dry-run --filter prepares a single fixture', () => {
  const r = spawnSync('node', [SCRIPT, 'dry-run', '--filter', 'clean-refactor'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('clean-refactor'));
  assert.ok(!r.stdout.includes('buggy-operator'));
});

test('reviewFixture with keep reaches the runner with a flag it accepts', () => {
  const fake = makeFakeCodex({ json: goodResult() });
  const privateTmp = mkdtempSync(join(tmpdir(), 'cxr-caltest-'));
  const saved = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR };
  process.env.PATH = `${fake.dir}:${saved.PATH}`;
  process.env.TMPDIR = privateTmp;
  try {
    const entry = reviewFixture(loadManifest().fixtures[0], { keep: true });
    assert.equal(entry.error, undefined, entry.error);
    assert.ok(entry.final_verdict);
    assert.ok(readdirSync(privateTmp).some((n) => n.startsWith('cxr-bundle-')), 'keep must retain the bundle');
  } finally {
    Object.assign(process.env, saved);
    rmSync(privateTmp, { recursive: true, force: true });
    fake.cleanup();
  }
});

test('CLI refuses unknown commands and malformed thresholds', () => {
  const bad = spawnSync('node', [SCRIPT, 'bogus'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  const t = spawnSync('node', [SCRIPT, 'dry-run', '--threshold', 'abc'], { encoding: 'utf8' });
  assert.equal(t.status, 2);
  assert.match(t.stderr, /fraction/);
});
