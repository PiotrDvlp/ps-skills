import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256 } from './code-review-core.mjs';
import { verifySymmetry } from './verify-duel-symmetry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'verify-duel-symmetry.mjs');

function run(args) {
  return spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
}

function scratchFile(content = 'shared prompt bytes\n') {
  const dir = mkdtempSync(join(tmpdir(), 'cxr-duel-'));
  const p = join(dir, 'shared-prompt.txt');
  writeFileSync(p, content);
  return { dir, p, sha: sha256(Buffer.from(content)), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('symmetry/happy path — recorded and claude hashes match current bytes', () => {
  const s = scratchFile();
  try {
    const r = run(['--shared-prompt', s.p, '--recorded-sha', s.sha, '--claude-sha', s.sha]);
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.computed, s.sha);
    assert.equal(out.recorded, s.sha);
    assert.equal(out.claudeReported, s.sha);
  } finally { s.cleanup(); }
});

test('symmetry/drift — file modified after build fails against the recorded hash', () => {
  const s = scratchFile();
  try {
    writeFileSync(s.p, 'mutated after both tracks launched\n');
    const r = run(['--shared-prompt', s.p, '--recorded-sha', s.sha, '--claude-sha', s.sha]);
    assert.equal(r.status, 1);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.notEqual(out.computed, out.recorded);
  } finally { s.cleanup(); }
});

test('symmetry/claude divergence — intact file but claude-reported hash differs', () => {
  const s = scratchFile();
  try {
    const r = run(['--shared-prompt', s.p, '--recorded-sha', s.sha, '--claude-sha', 'deadbeef']);
    assert.equal(r.status, 1);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.equal(out.computed, out.recorded); // file intact; only the claude hash disagrees
    assert.notEqual(out.computed, out.claudeReported);
  } finally { s.cleanup(); }
});

test('symmetry/missing file — clean abort, exit 1, no stack trace', () => {
  const missing = join(tmpdir(), `cxr-duel-absent-${process.pid}`, 'shared-prompt.txt');
  const r = run(['--shared-prompt', missing, '--recorded-sha', 'x', '--claude-sha', 'x']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[abort\] cannot read shared prompt file: ENOENT/);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'shared prompt file missing or unreadable at verify time');
});

test('symmetry/missing arguments — usage error, exit 2', () => {
  for (const [omitFlag, flagName] of [
    [['--recorded-sha', 'x', '--claude-sha', 'x'], '--shared-prompt'],
    [['--shared-prompt', 'x', '--claude-sha', 'x'], '--recorded-sha'],
    [['--shared-prompt', 'x', '--recorded-sha', 'x'], '--claude-sha'],
  ]) {
    const r = run(omitFlag);
    assert.equal(r.status, 2);
    assert.match(r.stderr, new RegExp(`\\[usage\\] ${flagName} is required`));
  }
});

test('symmetry/emit — success writes a JSON sidecar with the three hashes and ok:true', () => {
  const s = scratchFile();
  try {
    const sidecar = join(s.dir, 'shared-prompt.verified.json');
    const r = run(['--shared-prompt', s.p, '--recorded-sha', s.sha, '--claude-sha', s.sha, '--emit', sidecar]);
    assert.equal(r.status, 0);
    assert.ok(existsSync(sidecar), 'sidecar must exist on success');
    const out = JSON.parse(readFileSync(sidecar, 'utf8'));
    assert.equal(out.ok, true);
    assert.equal(out.computed, s.sha);
    assert.equal(out.recorded, s.sha);
    assert.equal(out.claudeReported, s.sha);
    assert.match(out.verified_at, /^\d{4}-\d{2}-\d{2}T/); // ISO date
  } finally { s.cleanup(); }
});

test('symmetry/emit — drift mismatch exits 1 and writes NO sidecar file', () => {
  const s = scratchFile();
  try {
    writeFileSync(s.p, 'mutated after both tracks launched\n');
    const sidecar = join(s.dir, 'shared-prompt.verified.json');
    const r = run(['--shared-prompt', s.p, '--recorded-sha', s.sha, '--claude-sha', s.sha, '--emit', sidecar]);
    assert.equal(r.status, 1);
    assert.equal(existsSync(sidecar), false, 'sidecar must not be written on failure');
  } finally { s.cleanup(); }
});

test('symmetry/byte-strict — non-canonical claude hash text (uppercase or whitespace) exits 1', () => {
  const s = scratchFile();
  try {
    for (const reported of [s.sha.toUpperCase(), `  ${s.sha}  `]) {
      const r = run(['--shared-prompt', s.p, '--recorded-sha', s.sha, '--claude-sha', reported]);
      assert.equal(r.status, 1, `expected exit 1 for ${JSON.stringify(reported)}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, false);
      assert.match(out.reason, /consumed different bytes/);
    }
  } finally { s.cleanup(); }
});

test('symmetry/pure core — drift and divergence produce distinct failure reasons', () => {
  const drift = verifySymmetry({ computed: 'a', recorded: 'b', claudeReported: 'b' });
  assert.equal(drift.ok, false);
  assert.match(drift.reason, /drifted after build/);
  const divergence = verifySymmetry({ computed: 'a', recorded: 'a', claudeReported: 'c' });
  assert.equal(divergence.ok, false);
  assert.match(divergence.reason, /consumed different bytes/);
});
