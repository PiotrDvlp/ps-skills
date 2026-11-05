import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkPush, commitIdentity, ledgerPath, readLedger, unpushed } from './quiz-check.mjs';
import { commit, git, repoWithRemote } from './test-git.mjs';
import { tmp } from './test-tmp.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'quiz-check.mjs');
const ZEROS = '0'.repeat(40);

function pass(dir, sha) {
  const id = commitIdentity(dir, sha);
  const file = ledgerPath(dir);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ id, sha, at: 'x', attempt: 'x' })}\n`);
}

test('commitIdentity of a commit survives a cherry-pick onto another branch', () => {
  const { dir } = repoWithRemote();
  git(dir, 'checkout', '-q', '-b', 'a');
  const original = commit(dir, 'a.txt', 'one\ntwo\nthree\nfour\n', 'add four');
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'checkout', '-q', '-b', 'b');
  commit(dir, 'other.txt', 'x\n', 'unrelated');
  git(dir, 'cherry-pick', original);
  const picked = git(dir, 'rev-parse', 'HEAD');
  assert.notEqual(picked, original);
  assert.match(commitIdentity(dir, original), /^[0-9a-f]{40}$/);
  assert.equal(commitIdentity(dir, picked), commitIdentity(dir, original));
});

test('colour config does not turn a commit into one without identity', () => {
  const { dir } = repoWithRemote();
  git(dir, 'checkout', '-q', '-b', 'f');
  const sha = commit(dir, 'a.txt', 'one\ntwo\nthree\nfour\n', 'add four');
  const plain = commitIdentity(dir, sha);
  git(dir, 'config', 'color.ui', 'always');
  git(dir, 'config', 'color.diff', 'always');
  assert.equal(commitIdentity(dir, sha), plain);
  assert.deepEqual(checkPush(dir, 'origin', `refs/heads/f ${sha} refs/heads/f ${ZEROS}\n`), [{ sha, ref: 'refs/heads/f' }]);
});

test('log.showRoot=false does not turn a root commit into one without identity', () => {
  const { dir } = repoWithRemote();
  const root = git(dir, 'rev-list', '--max-parents=0', 'HEAD');
  const plain = commitIdentity(dir, root);
  git(dir, 'config', 'log.showRoot', 'false');
  assert.match(commitIdentity(dir, root), /^[0-9a-f]{40}$/);
  assert.equal(commitIdentity(dir, root), plain);
});

test('commitIdentity of a clean merge is null', () => {
  const { dir } = repoWithRemote();
  git(dir, 'checkout', '-q', '-b', 'x');
  commit(dir, 'x.txt', 'x\n', 'x');
  git(dir, 'checkout', '-q', 'main');
  commit(dir, 'y.txt', 'y\n', 'y');
  git(dir, 'merge', '-q', '--no-ff', '-m', 'merge x', 'x');
  assert.equal(commitIdentity(dir, 'HEAD'), null);
});

test('commitIdentity of a merge with an added line starts with merge:', () => {
  const { dir } = repoWithRemote();
  git(dir, 'checkout', '-q', '-b', 'x');
  commit(dir, 'x.txt', 'x\n', 'x');
  git(dir, 'checkout', '-q', 'main');
  commit(dir, 'y.txt', 'y\n', 'y');
  git(dir, 'merge', '-q', '--no-ff', '--no-commit', 'x');
  appendFileSync(join(dir, 'a.txt'), 'EVIL\n');
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-q', '-m', 'merge x with edit');
  assert.match(commitIdentity(dir, 'HEAD'), /^merge:[0-9a-f]{64}$/);
});

test('commitIdentity of an empty commit is null', () => {
  const { dir } = repoWithRemote();
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'empty');
  assert.equal(commitIdentity(dir, 'HEAD'), null);
});

test('readLedger skips a truncated last line and a line without id; a missing file is empty', () => {
  const dir = tmp('qg-ledger-');
  const file = join(dir, 'passed.jsonl');
  assert.equal(readLedger(file).size, 0);
  writeFileSync(file, '{"id":"a"}\n{"sha":"no id"}\n{"id":7}\n{"id":"b"}\n{"id":"trunc');
  assert.deepEqual([...readLedger(file)].sort(), ['a', 'b']);
});

test('checkPush lists an unpushed commit until its id is in the ledger', () => {
  const { dir } = repoWithRemote();
  git(dir, 'checkout', '-q', '-b', 'f');
  const sha = commit(dir, 'a.txt', 'one\ntwo\nthree\nfour\n', 'add four');
  const stdin = `refs/heads/f ${sha} refs/heads/f ${ZEROS}\n`;
  assert.deepEqual(checkPush(dir, 'origin', stdin), [{ sha, ref: 'refs/heads/f' }]);
  pass(dir, sha);
  assert.deepEqual(checkPush(dir, 'origin', stdin), []);
});

test('checkPush with several refs lists only unpassed commits, each once', () => {
  const { dir } = repoWithRemote();
  git(dir, 'checkout', '-q', '-b', 'f');
  const c1 = commit(dir, 'a.txt', 'one\ntwo\nthree\nfour\n', 'c1');
  git(dir, 'checkout', '-q', '-b', 'g');
  const c2 = commit(dir, 'b.txt', 'b\n', 'c2');
  const stdin = `refs/heads/f ${c1} refs/heads/f ${ZEROS}\nrefs/heads/g ${c2} refs/heads/g ${ZEROS}\n`;
  assert.deepEqual(checkPush(dir, 'origin', stdin).map((c) => c.sha).sort(), [c1, c2].sort());
  pass(dir, c1);
  assert.deepEqual(checkPush(dir, 'origin', stdin).map((c) => c.sha), [c2]);
});

test('checkPush blocks an annotated tag on an unpassed commit and skips a deletion', () => {
  const { dir } = repoWithRemote();
  git(dir, 'checkout', '-q', '-b', 'f');
  const sha = commit(dir, 'a.txt', 'one\ntwo\nthree\nfour\n', 'add four');
  git(dir, 'tag', '-a', 'v1', '-m', 'v1', sha);
  const tagObject = git(dir, 'rev-parse', 'v1');
  assert.notEqual(tagObject, sha);
  assert.deepEqual(
    checkPush(dir, 'origin', `refs/tags/v1 ${tagObject} refs/tags/v1 ${ZEROS}\n`),
    [{ sha, ref: 'refs/tags/v1' }],
  );
  assert.deepEqual(checkPush(dir, 'origin', `(delete) ${ZEROS} refs/heads/f ${sha}\n`), []);
});

test('a remote sha known locally excludes commits the remote holds even without a tracking ref', () => {
  const { dir } = repoWithRemote();
  git(dir, 'checkout', '-q', '-b', 'f');
  const c1 = commit(dir, 'a.txt', 'one\ntwo\nthree\nfour\n', 'c1');
  git(dir, 'push', '-q', 'origin', 'f');
  git(dir, 'update-ref', '-d', 'refs/remotes/origin/f');
  const c2 = commit(dir, 'b.txt', 'b\n', 'c2');
  assert.deepEqual(unpushed(dir, c2, 'origin'), [c2, c1]);
  assert.deepEqual(unpushed(dir, c2, 'origin', c1), [c2]);
  assert.deepEqual(unpushed(dir, c2, 'origin', ZEROS), [c2, c1]);
  assert.deepEqual(unpushed(dir, c2, 'origin', 'f'.repeat(40)), [c2, c1]);
  assert.deepEqual(
    checkPush(dir, 'origin', `refs/heads/f ${c2} refs/heads/f ${c1}\n`).map((c) => c.sha),
    [c2],
  );
});

test('checkPush throws on a git failure', () => {
  const { dir } = repoWithRemote();
  assert.throws(() => checkPush(dir, 'origin', `refs/heads/f ${'a'.repeat(40)} refs/heads/f ${ZEROS}\n`));
});

test('CLI blocks a real git push without a pass and lets it through with one', () => {
  const { dir } = repoWithRemote();
  const hook = join(dir, '.git', 'hooks', 'pre-push');
  writeFileSync(hook, `#!/bin/sh\nexec node "${SCRIPT}" "$@"\n`);
  chmodSync(hook, 0o755);
  git(dir, 'checkout', '-q', '-b', 'f');
  const sha = commit(dir, 'a.txt', 'one\ntwo\nthree\nfour\n', 'add four');
  const blocked = spawnSync('git', ['push', 'origin', 'f'], { cwd: dir, encoding: 'utf8' });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /no quiz pass: [0-9a-f]+ add four/);
  assert.match(blocked.stderr, /run \/ps:quiz-gate in this worktree, then push again \(or with --remote <name>\)/);
  pass(dir, sha);
  const allowed = spawnSync('git', ['push', 'origin', 'f'], { cwd: dir, encoding: 'utf8' });
  assert.equal(allowed.status, 0, allowed.stderr);
});

test('CLI outside a git repo exits 1 and names the bypass', () => {
  const dir = tmp('qg-norepo-');
  const r = spawnSync('node', [SCRIPT, 'origin'], {
    cwd: dir,
    input: '',
    encoding: 'utf8',
    env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(dir) },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /git push --no-verify/);
});
