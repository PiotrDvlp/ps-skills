import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('./verify-mr.mjs', import.meta.url));
const SHA = 'a'.repeat(40);
const DESCRIPTION = '## Why\nFix submission.\n\n## Verification\nFocused test passed.\n';
const MR = { iid: 7, state: 'opened', source_branch: 'fix/form', target_branch: 'main',
  source_project_id: 1, target_project_id: 1, title: 'fix(form): await submission',
  description: DESCRIPTION, sha: SHA, web_url: 'https://gitlab.example.com/team/shop/-/merge_requests/7' };

function run(t, { mrs = [MR], detail = mrs[0], phase = 'after-push', remoteSha = SHA,
  glabError = false, malformed = false, description = DESCRIPTION } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mr handoff-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = join(root, 'calls.jsonl');
  const draft = join(root, 'MR draft.md');
  writeFileSync(draft, description);
  const config = { mrs, detail, remoteSha, glabError, malformed };
  const fake = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2), name = require('node:path').basename(process.argv[1]);
const config = ${JSON.stringify(config)};
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify([name, ...args]) + '\\n');
if (name === 'glab') {
  if (config.glabError) { console.error('network unavailable'); process.exit(1); }
  if (config.malformed) { console.log('not JSON'); process.exit(0); }
  console.log(JSON.stringify(args[1] === 'list' ? config.mrs : config.detail));
} else if (args[0] === 'rev-parse') console.log('${SHA}');
else if (args[0] === 'remote') console.log('https://gitlab.example.com/team/shop.git');
else if (args[0] === 'ls-remote') console.log(config.remoteSha ? config.remoteSha + '\\trefs/heads/fix/form' : '');
else process.exit(1);
`;
  for (const name of ['glab', 'git']) writeFileSync(join(root, name), fake, { mode: 0o755 });
  const result = spawnSync(process.execPath, [CLI, '--repo', root, '--branch', MR.source_branch,
    '--target', MR.target_branch, '--title', MR.title, '--description', draft, '--phase', phase],
  { encoding: 'utf8', env: { ...process.env, PATH: `${root}:${process.env.PATH}` } });
  return { ...result, calls: () => readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) };
}

test('discovers an MR without its number and verifies the exact pushed handoff', (t) => {
  const r = run(t);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).status, 'verified');
  const calls = r.calls();
  assert.ok(calls.some((c) => c[0] === 'glab' && c.includes('--all') && c.includes('--source-branch')));
  assert.ok(calls.some((c) => c[0] === 'glab' && c[1] === 'mr' && c[2] === 'view' && c[3] === '7'));
  assert.ok(calls.filter((c) => c[0] === 'glab').every((c) => c.includes('-R') && c.includes('https://gitlab.example.com/team/shop.git')));
  assert.ok(calls.every((c) => c[0] === 'git' ? ['remote', 'rev-parse', 'ls-remote'].includes(c[1]) : ['list', 'view'].includes(c[2])));
});

for (const state of ['merged', 'closed']) test(`blocks a ${state} MR before push`, (t) => {
  const r = run(t, { phase: 'before-push', mrs: [{ ...MR, state }] });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /inactive-mr/);
});

test('a new branch may be pushed but no MR means handoff is pending', (t) => {
  const before = run(t, { phase: 'before-push', mrs: [] });
  assert.equal(before.status, 0, before.stderr);
  assert.equal(JSON.parse(before.stdout).status, 'ready-to-push');
  const after = run(t, { mrs: [] });
  assert.equal(after.status, 1, after.stderr);
  assert.equal(JSON.parse(after.stdout).status, 'pending');
});

for (const [field, value] of [['title', 'wrong title'], ['target_branch', 'develop'],
  ['description', 'Nonempty but stale description'],
  ['sha', 'b'.repeat(40)], ['state', 'merged']]) {
  test(`rejects mismatched ${field} from the MR read-back`, (t) => {
    const r = run(t, { detail: { ...MR, [field]: value } });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, /pending/);
  });
}

test('rejects an absent or stale remote branch even when MR metadata is correct', (t) => {
  for (const remoteSha of ['', 'b'.repeat(40)]) {
    const r = run(t, { remoteSha });
    assert.equal(r.status, 1, r.stderr);
    assert.ok(JSON.parse(r.stdout).problems.includes('remote-commit-mismatch'));
  }
});

test('ignores fork MRs sharing the branch name', (t) => {
  const r = run(t, { mrs: [{ ...MR, source_project_id: 2 }] });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /missing-mr/);
});

test('selects the open MR over historical closed MRs and refuses duplicate open MRs', (t) => {
  assert.equal(run(t, { mrs: [{ ...MR, state: 'closed', iid: 3 }, MR], detail: MR }).status, 0);
  const duplicate = run(t, { mrs: [MR, { ...MR, iid: 8 }] });
  assert.equal(duplicate.status, 1, duplicate.stderr);
  assert.match(duplicate.stdout, /ambiguous-mr/);
});

test('tool failures and malformed responses cannot turn into success', (t) => {
  for (const options of [{ glabError: true }, { malformed: true }]) {
    const r = run(t, options);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stdout, /unverified/);
  }
});

test('normalizes line endings and a terminal newline, preserving actual content', (t) => {
  assert.equal(run(t, { detail: { ...MR, description: DESCRIPTION.trimEnd().replaceAll('\n', '\r\n') } }).status, 0);
  assert.equal(run(t, { description: ' \n' }).status, 2);
});

test('invalid list/detail schema is unverified rather than missing or complete', (t) => {
  for (const options of [{ mrs: {} }, { mrs: [{ ...MR, state: 'unknown' }] }, { detail: {} }]) {
    const r = run(t, options);
    assert.equal(r.status, 2, r.stderr);
    assert.equal(JSON.parse(r.stdout).status, 'unverified');
  }
});
