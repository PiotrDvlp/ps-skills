import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commitIdentity, ledgerPath } from './quiz-check.mjs';
import { commit, git, repoWithRemote } from './test-git.mjs';
import { tmp } from './test-tmp.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const QUIZ = join(here, 'quiz.mjs');
const CHECK = join(here, 'quiz-check.mjs');
const HUSKY_H = join(here, '..', 'fixtures', 'husky', 'h');
const HUSKY_WRAPPER = '#!/usr/bin/env sh\n. "$(dirname "$0")/h"';

function quiz(dir, ...args) {
  const r = spawnSync('node', [QUIZ, ...args], { cwd: dir, encoding: 'utf8' });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

function hooksDir(dir) {
  return join(resolve(dir, git(dir, 'rev-parse', '--git-common-dir')), 'hooks');
}

function push(dir, env = {}) {
  const r = spawnSync('git', ['push', 'origin', 'main'], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, err: r.stderr };
}

function huskyRepo() {
  const { dir, remote } = repoWithRemote();
  mkdirSync(join(dir, '.husky', '_'), { recursive: true });
  writeFileSync(join(dir, '.husky', 'pre-push'), 'cat > "$TEAM_STDIN"\nexit ${TEAM_EXIT:-0}\n');
  git(dir, 'add', '.husky/pre-push');
  git(dir, 'commit', '-q', '-m', 'team hook');
  git(dir, 'push', '-q', 'origin', 'main');
  writeFileSync(join(dir, '.husky', '_', '.gitignore'), '*');
  copyFileSync(HUSKY_H, join(dir, '.husky', '_', 'h'));
  writeFileSync(join(dir, '.husky', '_', 'pre-push'), HUSKY_WRAPPER, { mode: 0o755 });
  chmodSync(join(dir, '.husky', '_', 'pre-push'), 0o755);
  git(dir, 'config', 'core.hooksPath', '.husky/_');
  return { dir, remote };
}

function passLedger(dir, sha) {
  const file = ledgerPath(dir);
  mkdirSync(join(file, '..'), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ id: commitIdentity(dir, sha), sha, at: 'now', attempt: 'a' })}\n`);
}

test('default layout: install writes both files, executable, marker on line 2, idempotent', () => {
  const { dir } = repoWithRemote();
  const hooks = hooksDir(dir);
  const first = quiz(dir, 'install');
  assert.deepEqual([first.code, first.out], [0, 'installed']);
  assert.equal(readFileSync(join(hooks, 'pre-push'), 'utf8').split('\n')[1], '# quiz-gate hook v1');
  assert.equal(statSync(join(hooks, 'pre-push')).mode & 0o777, 0o755);
  assert.ok(existsSync(join(hooks, 'quiz-check.mjs')));
  const before = readFileSync(join(hooks, 'pre-push'));
  const second = quiz(dir, 'install');
  assert.deepEqual([second.code, second.out], [0, 'installed (already)']);
  assert.deepEqual(readFileSync(join(hooks, 'pre-push')), before);
});

test('default layout: the installed hook blocks an unpassed push and allows a passed one', () => {
  const { dir } = repoWithRemote();
  quiz(dir, 'install');
  const sha = commit(dir, 'b.txt', 'x\n', 'feat');
  const blocked = push(dir);
  assert.notEqual(blocked.code, 0);
  assert.match(blocked.err, /no quiz pass/);
  passLedger(dir, sha);
  assert.equal(push(dir).code, 0);
});

test('default layout: a foreign pre-push is never overwritten', () => {
  const { dir } = repoWithRemote();
  const file = join(hooksDir(dir), 'pre-push');
  writeFileSync(file, '#!/bin/sh\necho mine\n');
  const r = quiz(dir, 'install');
  assert.equal(r.code, 3);
  assert.match(r.err, /pre-push exists; chain it by hand/);
  assert.equal(readFileSync(file, 'utf8'), '#!/bin/sh\necho mine\n');
  assert.ok(!existsSync(join(hooksDir(dir), 'quiz-check.mjs')));
});

test('default layout: a foreign quiz-check.mjs is never overwritten or removed', () => {
  const { dir } = repoWithRemote();
  const file = join(hooksDir(dir), 'quiz-check.mjs');
  writeFileSync(file, 'console.log(1);\n');
  const r = quiz(dir, 'install');
  assert.equal(r.code, 3);
  assert.match(r.err, /quiz-check\.mjs exists; not ours/);
  assert.equal(readFileSync(file, 'utf8'), 'console.log(1);\n');
  assert.ok(!existsSync(join(hooksDir(dir), 'pre-push')));
  quiz(dir, 'uninstall');
  assert.equal(readFileSync(file, 'utf8'), 'console.log(1);\n');
});

test('default layout: uninstall removes both files and status reports it', () => {
  const { dir } = repoWithRemote();
  const hooks = hooksDir(dir);
  quiz(dir, 'install');
  assert.deepEqual(quiz(dir, 'status').out.split('\n'), ['hook: installed', 'passes: 0']);
  const r = quiz(dir, 'uninstall');
  assert.deepEqual([r.code, r.out], [0, 'removed']);
  assert.ok(!existsSync(join(hooks, 'pre-push')));
  assert.ok(!existsSync(join(hooks, 'quiz-check.mjs')));
  assert.deepEqual(quiz(dir, 'status').out.split('\n'), ['hook: missing', 'passes: 0']);
  assert.deepEqual([quiz(dir, 'uninstall').code, quiz(dir, 'uninstall').out], [0, 'not installed']);
});

test('status counts the passes in the ledger', () => {
  const { dir } = repoWithRemote();
  passLedger(dir, commit(dir, 'b.txt', 'x\n', 'one'));
  passLedger(dir, commit(dir, 'c.txt', 'y\n', 'two'));
  assert.equal(quiz(dir, 'status').out.split('\n')[1], 'passes: 2');
});

test('a half-written temp file is never the hook, and the next install overwrites the hook', () => {
  const { dir } = repoWithRemote();
  const hooks = hooksDir(dir);
  writeFileSync(join(hooks, '.pre-push.quiz-tmp'), '#!/bin/sh\nhalf');
  assert.equal(quiz(dir, 'status').out.split('\n')[0], 'hook: missing');
  assert.equal(quiz(dir, 'install').out, 'installed');
  assert.equal(readFileSync(join(hooks, 'pre-push'), 'utf8').split('\n')[1], '# quiz-gate hook v1');
});

test('husky: install replaces the wrapper, adds the check and keeps git status clean', () => {
  const { dir } = huskyRepo();
  const r = quiz(dir, 'install');
  assert.deepEqual([r.code, r.out], [0, 'installed']);
  const wrapper = readFileSync(join(dir, '.husky', '_', 'pre-push'), 'utf8');
  assert.equal(wrapper.split('\n')[1], '# quiz-gate hook v1');
  assert.ok(existsSync(join(dir, '.husky', '_', 'quiz-check.mjs')));
  assert.equal(git(dir, 'status', '--porcelain'), '');
  assert.equal(quiz(dir, 'install').out, 'installed (already)');
});

test('husky: check fails and team passes, push is blocked and the team hook never runs', () => {
  const { dir } = huskyRepo();
  quiz(dir, 'install');
  commit(dir, 'b.txt', 'x\n', 'feat');
  const teamStdin = join(tmp('qg-team-'), 'stdin');
  const r = push(dir, { TEAM_STDIN: teamStdin });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /no quiz pass/);
  assert.ok(!existsSync(teamStdin));
});

test('husky: check passes and team fails, push is blocked', () => {
  const { dir } = huskyRepo();
  quiz(dir, 'install');
  passLedger(dir, commit(dir, 'b.txt', 'x\n', 'feat'));
  const teamStdin = join(tmp('qg-team-'), 'stdin');
  const r = push(dir, { TEAM_STDIN: teamStdin, TEAM_EXIT: '1' });
  assert.notEqual(r.code, 0);
  assert.ok(existsSync(teamStdin));
});

test('husky: both pass, push succeeds and the team hook gets the refs line git sent', () => {
  const { dir } = huskyRepo();
  quiz(dir, 'install');
  const oldSha = git(dir, 'rev-parse', 'origin/main');
  const sha = commit(dir, 'b.txt', 'x\n', 'feat');
  passLedger(dir, sha);
  const teamStdin = join(tmp('qg-team-'), 'stdin');
  const r = push(dir, { TEAM_STDIN: teamStdin });
  assert.equal(r.code, 0);
  assert.equal(readFileSync(teamStdin, 'utf8'), `refs/heads/main ${sha} refs/heads/main ${oldSha}\n`);
});

test('husky: uninstall writes back the exact one-line wrapper', () => {
  const { dir } = huskyRepo();
  quiz(dir, 'install');
  const r = quiz(dir, 'uninstall');
  assert.deepEqual([r.code, r.out], [0, 'removed']);
  const bytes = readFileSync(join(dir, '.husky', '_', 'pre-push'));
  assert.equal(bytes.length, 39);
  assert.equal(bytes.toString('utf8'), HUSKY_WRAPPER);
  assert.ok(!existsSync(join(dir, '.husky', '_', 'quiz-check.mjs')));
  assert.equal(quiz(dir, 'status').out.split('\n')[0], 'hook: missing');
});

test('husky: a foreign husky pre-push is not overwritten', () => {
  const { dir } = huskyRepo();
  const file = join(dir, '.husky', '_', 'pre-push');
  writeFileSync(file, '#!/bin/sh\necho custom\n');
  const r = quiz(dir, 'install');
  assert.equal(r.code, 3);
  assert.match(r.err, /pre-push exists; chain it by hand/);
  assert.equal(readFileSync(file, 'utf8'), '#!/bin/sh\necho custom\n');
});

test('husky: no .husky/_ directory means npm install has not run', () => {
  const { dir } = repoWithRemote();
  git(dir, 'config', 'core.hooksPath', '.husky/_');
  const r = quiz(dir, 'install');
  assert.equal(r.code, 3);
  assert.match(r.err, /run npm install first/);
});

test('a tracked hooks dir is refused', () => {
  const { dir } = repoWithRemote();
  mkdirSync(join(dir, '.githooks'));
  commit(dir, '.githooks/pre-commit', '#!/bin/sh\n', 'team hooks');
  git(dir, 'config', 'core.hooksPath', '.githooks');
  const r = quiz(dir, 'install');
  assert.equal(r.code, 3);
  assert.match(r.err, /hooks dir is tracked; install would change a team file/);
  assert.ok(!existsSync(join(dir, '.githooks', 'pre-push')));
});

test('a hooks dir outside the repo is refused', () => {
  const { dir } = repoWithRemote();
  git(dir, 'config', 'core.hooksPath', tmp('qg-outside-'));
  const r = quiz(dir, 'install');
  assert.equal(r.code, 3);
  assert.match(r.err, /hooks dir is outside this repo/);
});

test('install works from a linked worktree and uses the shared hooks dir', () => {
  const { dir } = repoWithRemote();
  const wt = join(tmp('qg-wt-'), 'wt');
  git(dir, 'worktree', 'add', '-q', '-b', 'side', wt);
  const r = quiz(wt, 'install');
  assert.deepEqual([r.code, r.out], [0, 'installed']);
  assert.ok(existsSync(join(hooksDir(dir), 'pre-push')));
});

test('quiz-check.mjs runs alone from an empty directory', () => {
  const { dir } = repoWithRemote();
  const alone = join(tmp('qg-alone-'), 'quiz-check.mjs');
  copyFileSync(CHECK, alone);
  const r = spawnSync('node', [alone, 'origin'], { cwd: dir, input: '', encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
