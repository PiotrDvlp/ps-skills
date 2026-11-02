import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('./twin-parity.mjs', import.meta.url));
const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null' };

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: ENV });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function commit(work, file, text, message) {
  writeFileSync(join(work, file), text);
  git(work, 'add', file);
  git(work, 'commit', '-m', message);
  return git(work, 'rev-parse', 'HEAD');
}

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'twin parity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  git(root, 'init', '--bare', '-b', 'main', origin);
  git(root, 'clone', origin, work);
  commit(work, 'base.txt', 'base\n', 'base');
  git(work, 'branch', '-M', 'main');
  git(work, 'push', 'origin', 'main');
  git(work, 'branch', 'develop');
  git(work, 'checkout', 'develop');
  commit(work, 'dev.txt', 'dev\n', 'develop only');
  git(work, 'push', 'origin', 'develop');
  git(work, 'checkout', '-b', 'fix/a', 'main');
  const first = commit(work, 'a.txt', 'one\n', 'first fix');
  git(work, 'checkout', '-b', 'fix/a_develop', 'develop');
  git(work, 'cherry-pick', first);
  git(work, 'push', 'origin', 'fix/a', 'fix/a_develop');
  git(work, 'checkout', 'fix/a');
  return { work };
}

function run(work, twin = 'fix/a_develop') {
  return spawnSync(process.execPath, [CLI, '--repo', work, '--branch', 'fix/a', '--twin', twin], { encoding: 'utf8' });
}

test('equal patch sets print parity ok', (t) => {
  const { work } = setup(t);
  const r = run(work);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /parity ok/);
});

test('a home commit missing from the twin exits 1 and names it', (t) => {
  const { work } = setup(t);
  commit(work, 'b.txt', 'two\n', 'second fix');
  git(work, 'push', 'origin', 'fix/a');
  const r = run(work);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /parity mismatch/);
  assert.match(r.stdout, /home-only [0-9a-f]{7,} second fix/);
});

test('a missing twin ref exits 2', (t) => {
  const { work } = setup(t);
  const r = run(work, 'fix/none_develop');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /fix\/none_develop/);
});

test('a local unpushed home commit does not break parity', (t) => {
  const { work } = setup(t);
  commit(work, 'c.txt', 'three\n', 'local only');
  const r = run(work);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /parity ok/);
});

test('a twin commit missing from home exits 1 and names it', (t) => {
  const { work } = setup(t);
  git(work, 'checkout', 'fix/a_develop');
  commit(work, 'd.txt', 'four\n', 'extra twin');
  git(work, 'push', 'origin', 'fix/a_develop');
  const r = run(work);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /twin-only [0-9a-f]{7,} extra twin/);
});

test('user git config for color and pretty formats does not hide a mismatch', (t) => {
  const { work } = setup(t);
  git(work, 'config', 'color.ui', 'always');
  git(work, 'config', 'format.pretty', 'format:%s');
  const second = commit(work, 'b.txt', 'two\n', 'second fix');
  git(work, 'push', 'origin', 'fix/a');
  const r = run(work);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`home-only ${second.slice(0, 12)} second fix`));
});

test('the same patches in a different order exit 1 and name the first differing position', (t) => {
  const { work } = setup(t);
  const first = git(work, 'rev-parse', 'fix/a');
  const second = commit(work, 'b.txt', 'two\n', 'second fix');
  git(work, 'push', 'origin', 'fix/a');
  git(work, 'checkout', 'fix/a_develop');
  git(work, 'reset', '--hard', 'develop');
  git(work, 'cherry-pick', second);
  git(work, 'cherry-pick', first);
  git(work, 'push', '--force', 'origin', 'fix/a_develop');
  git(work, 'checkout', 'fix/a');
  const r = run(work);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /parity mismatch/);
  assert.match(r.stdout, new RegExp(`order 0 home ${first.slice(0, 12)} twin [0-9a-f]{12}`));
});

function setupContext(t, twinSubject = 'fix five') {
  const root = mkdtempSync(join(tmpdir(), 'twin parity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
  const text = (edits) => lines.map((l, i) => edits[i] ?? l).join('\n') + '\n';
  git(root, 'init', '--bare', '-b', 'main', origin);
  git(root, 'clone', origin, work);
  commit(work, 'f.txt', text({}), 'base');
  git(work, 'branch', '-M', 'main');
  git(work, 'push', 'origin', 'main');
  git(work, 'checkout', '-b', 'develop');
  commit(work, 'f.txt', text({ 2: 'develop three' }), 'develop edits line 3');
  git(work, 'push', 'origin', 'develop');
  git(work, 'checkout', '-b', 'fix/a', 'main');
  const fix = commit(work, 'f.txt', text({ 4: 'fixed five' }), 'fix five');
  git(work, 'checkout', '-b', 'fix/a_develop', 'develop');
  git(work, 'cherry-pick', fix);
  if (twinSubject !== 'fix five') git(work, 'commit', '--amend', '-m', twinSubject);
  git(work, 'push', 'origin', 'fix/a', 'fix/a_develop');
  git(work, 'checkout', 'fix/a');
  return { work, fix, twin: git(work, 'rev-parse', 'fix/a_develop') };
}

test('a clean cherry-pick onto changed context exits 3 and pairs the commits', (t) => {
  const { work, fix, twin } = setupContext(t);
  const r = run(work);
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout, /^parity context-only$/m);
  assert.match(r.stdout, new RegExp(`^changed 0 home ${fix.slice(0, 12)} twin ${twin.slice(0, 12)} fix five$`, 'm'));
});

test('a twin with a different subject at the position still exits 1', (t) => {
  const { work } = setupContext(t, 'another subject');
  const r = run(work);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /parity mismatch/);
});

test('a different count of unmatched patches still exits 1', (t) => {
  const { work } = setupContext(t);
  git(work, 'checkout', 'fix/a_develop');
  commit(work, 'g.txt', 'x\n', 'extra twin');
  git(work, 'push', 'origin', 'fix/a_develop');
  const r = run(work);
  assert.equal(r.status, 1, r.stdout + r.stderr);
});
