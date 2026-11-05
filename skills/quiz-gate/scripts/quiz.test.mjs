import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commitIdentity, ledgerPath, readLedger } from './quiz-check.mjs';
import { assumptionLines, chooseLines, eligibleLines, parseGrades, priorityEntries, quizBase } from './quiz.mjs';
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

function commitFiles(dir, files, msg) {
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', msg);
  return git(dir, 'rev-parse', 'HEAD');
}

function passed(dir) {
  return readLedger(ledgerPath(dir));
}

function pick(dir, ...args) {
  const r = quiz(dir, 'pick', ...args);
  assert.equal(r.code, 0, r.err);
  return JSON.parse(r.out);
}

function attemptFiles(dir) {
  const attempts = join(resolve(dir, git(dir, 'rev-parse', '--git-common-dir')), 'quiz', 'attempts');
  return existsSync(attempts) ? readdirSync(attempts) : [];
}

function numberedLines(count, prefix = 'v') {
  return Array.from({ length: count }, (_, i) => `const ${prefix}${i + 1} = compute(${i + 1});`).join('\n') + '\n';
}

test('quizBase: the base is the last passed commit, or the parent of the oldest unpassed one', () => {
  const { dir } = repoWithRemote();
  const pushed = git(dir, 'rev-parse', 'HEAD');
  const a = commit(dir, 'a.ts', 'const a = 1;\n', 'A');
  const b = commit(dir, 'b.ts', 'const b = 1;\n', 'B');
  assert.equal(quizBase(dir, b, 'origin', passed(dir)), pushed);
  passLedger(dir, a);
  assert.equal(quizBase(dir, b, 'origin', passed(dir)), a);
  passLedger(dir, b);
  assert.equal(quizBase(dir, b, 'origin', passed(dir)), null);
});

test('quizBase: a passed commit after an unpassed one does not move the base', () => {
  const { dir } = repoWithRemote();
  const pushed = git(dir, 'rev-parse', 'HEAD');
  commit(dir, 'a.ts', 'const a = 1;\n', 'A');
  const b = commit(dir, 'b.ts', 'const b = 1;\n', 'B');
  passLedger(dir, b);
  assert.equal(quizBase(dir, b, 'origin', passed(dir)), pushed);
});

function repoWithMergedSide() {
  const { dir } = repoWithRemote();
  const pushed = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', '-b', 'side');
  const side = commit(dir, 'side.ts', 'const fromSide = sideValue();\n', 'side work');
  git(dir, 'checkout', '-q', 'main');
  const main = commit(dir, 'main.ts', 'const fromMain = mainValue();\n', 'main work');
  git(dir, 'merge', '-q', '--no-ff', 'side', '-m', 'merge side');
  return { dir, pushed, side, main, tip: git(dir, 'rev-parse', 'HEAD') };
}

test('a merged side branch: the base walks first-parent only and the side lines are eligible', () => {
  const { dir, pushed, tip } = repoWithMergedSide();
  assert.equal(quizBase(dir, tip, 'origin', passed(dir)), pushed);
  const codes = eligibleLines(dir, pushed, tip).map((l) => l.code).sort();
  assert.deepEqual(codes, ['const fromMain = mainValue();', 'const fromSide = sideValue();']);
});

test('a clean merge brings an unpassed side commit into the range even when the first-parent commits are passed', () => {
  const { dir, main, tip } = repoWithMergedSide();
  passLedger(dir, main);
  assert.equal(quizBase(dir, tip, 'origin', passed(dir)), main);
});

test('eligibleLines skips test, lock, docs, binary files and import, comment, punctuation and blank lines', () => {
  const { dir } = repoWithRemote();
  const base = git(dir, 'rev-parse', 'HEAD');
  const code = 'const hidden = secret();\n';
  const tip = commitFiles(dir, {
    'src/ok.ts': "import x from 'y'\n// note\n  }\n\n});\nconst real = compute();\n  # shell comment\n * jsdoc line\nreturn value;\n",
    'src/a.test.ts': code,
    'src/x.spec.js': code,
    'src/__tests__/y.ts': code,
    'src/__snapshots__/z.snap': code,
    'package-lock.json': code,
    'pnpm-lock.yaml': code,
    'yarn.lock': code,
    'README.md': code,
    'notes.mdx': code,
    'notes.txt': code,
    'docs/guide.ts': code,
    'src/blob.bin': Buffer.from([0, 1, 2, 0, 255, 0, 7]),
  }, 'mixed');
  const lines = eligibleLines(dir, base, tip);
  assert.deepEqual(lines.map((l) => [l.file, l.line, l.code]), [
    ['src/ok.ts', 6, 'const real = compute();'],
    ['src/ok.ts', 9, 'return value;'],
  ]);
});

test('eligibleLines numbers hunks across files and keeps lines of one hunk together', () => {
  const { dir } = repoWithRemote();
  const first = commitFiles(dir, { 'a.ts': numberedLines(30), 'b.ts': numberedLines(3, 'w') }, 'two files');
  const lines = eligibleLines(dir, `${first}^`, first);
  assert.equal(lines.length, 33);
  assert.deepEqual([...new Set(lines.filter((l) => l.file === 'a.ts').map((l) => l.hunk))].length, 1);
  assert.notEqual(lines.find((l) => l.file === 'a.ts').hunk, lines.find((l) => l.file === 'b.ts').hunk);
});

test('eligibleLines in a range that rewrites a file only returns lines present at the tip', () => {
  const { dir } = repoWithRemote();
  const base = git(dir, 'rev-parse', 'HEAD');
  commit(dir, 'a.ts', 'const one = 1;\nconst two = 2;\n', 'first');
  const tip = commit(dir, 'a.ts', 'const one = 1;\nconst three = 3;\n', 'second');
  assert.deepEqual(eligibleLines(dir, base, tip).map((l) => [l.line, l.code]), [[1, 'const one = 1;'], [2, 'const three = 3;']]);
});

test('pick: a docs-only range prints no eligible lines and writes an attempt with no questions', () => {
  const { dir } = repoWithRemote();
  commitFiles(dir, { 'README.md': '# Title\nsome text\n', 'docs/a.ts': 'const x = 1;\n', 'package-lock.json': '{"a": 1}\n' }, 'docs');
  const out = pick(dir);
  assert.equal(out.status, 'no eligible lines');
  const attempt = JSON.parse(readFileSync(join(resolve(dir, git(dir, 'rev-parse', '--git-common-dir')), 'quiz', 'attempts', `${out.attempt}.json`), 'utf8'));
  assert.deepEqual(attempt.questions, []);
  assert.equal(attempt.tip, git(dir, 'rev-parse', 'HEAD'));
});

test('pick: every unpushed commit already passed means nothing to quiz and no attempt file', () => {
  const { dir } = repoWithRemote();
  passLedger(dir, commit(dir, 'a.ts', 'const a = 1;\n', 'A'));
  assert.deepEqual(pick(dir), { status: 'nothing to quiz' });
  assert.deepEqual(attemptFiles(dir), []);
});

test('pick: one new 300-line file gives four line questions and one assumption question', () => {
  const { dir } = repoWithRemote();
  commitFiles(dir, { 'big.ts': numberedLines(300) }, 'big');
  const out = pick(dir);
  assert.equal(out.status, 'quiz');
  assert.deepEqual(out.questions.map((q) => q.kind), ['line', 'line', 'line', 'line', 'assumption']);
  assert.deepEqual(out.questions.map((q) => q.n), [1, 2, 3, 4, 5]);
  const numbers = out.questions.slice(0, 4).map((q) => q.line).sort((a, b) => a - b);
  for (let i = 1; i < numbers.length; i++) assert.ok(numbers[i] - numbers[i - 1] >= 5, numbers.join(','));
  for (const q of out.questions.slice(0, 4)) {
    assert.equal(q.file, 'big.ts');
    const rows = q.context.split('\n');
    assert.equal(rows.length, Math.min(q.line + 3, 300) - Math.max(1, q.line - 3) + 1);
    assert.equal(rows.filter((r) => r.startsWith('>')).length, 1);
    assert.match(rows.find((r) => r.startsWith('>')), new RegExp(`^> +${q.line}  const v${q.line} = `));
  }
  assert.deepEqual(out.skipped, []);
});

test('pick: attempt file holds tip, base, remote, ids and questions; each run makes a new attempt', () => {
  const { dir } = repoWithRemote();
  const pushed = git(dir, 'rev-parse', 'HEAD');
  const sha = commit(dir, 'a.ts', numberedLines(4), 'A');
  const first = pick(dir);
  const second = pick(dir);
  assert.notEqual(first.attempt, second.attempt);
  assert.equal(attemptFiles(dir).length, 2);
  const common = resolve(dir, git(dir, 'rev-parse', '--git-common-dir'));
  const attempt = JSON.parse(readFileSync(join(common, 'quiz', 'attempts', `${first.attempt}.json`), 'utf8'));
  assert.deepEqual(
    { tip: attempt.tip, base: attempt.base, remote: attempt.remote, ids: attempt.ids, questions: attempt.questions },
    { tip: sha, base: pushed, remote: 'origin', ids: [commitIdentity(dir, sha)], questions: first.questions },
  );
  assert.match(attempt.createdAt, /^\d{4}-\d\d-\d\dT/);
});

test('pick: the remote is the upstream remote unless --remote is given', () => {
  const { dir, remote } = repoWithRemote();
  git(dir, 'remote', 'rename', 'origin', 'upstream');
  git(dir, 'config', 'branch.main.remote', 'upstream');
  git(dir, 'config', 'branch.main.merge', 'refs/heads/main');
  git(dir, 'fetch', '-q', 'upstream');
  commit(dir, 'a.ts', numberedLines(4), 'A');
  const common = resolve(dir, git(dir, 'rev-parse', '--git-common-dir'));
  const read = (id) => JSON.parse(readFileSync(join(common, 'quiz', 'attempts', `${id}.json`), 'utf8')).remote;
  assert.equal(read(pick(dir).attempt), 'upstream');
  assert.equal(read(pick(dir, '--remote', 'elsewhere').attempt), 'elsewhere');
  assert.ok(remote);
});

test('pick: the context block is clipped at the first and last line and shows no row after the file end', () => {
  const { dir } = repoWithRemote();
  commit(dir, 'one.ts', 'const answer = compute(42);\n', 'A');
  assert.equal(pick(dir).questions[0].context, '> 1  const answer = compute(42);');
  commit(dir, 'ten.ts', numberedLines(10, 'k'), 'B');
  const contexts = new Map();
  for (let run = 0; run < 40 && contexts.size < 3; run++) {
    for (const q of pick(dir).questions) if (q.file === 'ten.ts') contexts.set(q.line, q.context);
  }
  for (const [line, context] of contexts) {
    const rows = context.split('\n');
    assert.equal(rows.length, Math.min(line + 3, 10) - Math.max(1, line - 3) + 1);
    assert.ok(rows.every((r) => /\S$/.test(r)), JSON.stringify(context));
  }
  assert.ok(contexts.size > 0);
});

test('pick: a pushed commit is not in the range', () => {
  const { dir } = repoWithRemote();
  commit(dir, 'a.ts', numberedLines(4), 'A');
  git(dir, 'push', '-q', 'origin', 'main');
  assert.deepEqual(pick(dir), { status: 'nothing to quiz' });
});

function teammateRepo() {
  const { dir, remote } = repoWithRemote();
  commit(dir, 'shared.ts', 'const shared = original();\nconst keep = 1;\n', 'shared');
  git(dir, 'push', '-q', 'origin', 'main');
  const other = tmp('qg-other-');
  git(other, 'clone', '-q', remote, '.');
  git(other, 'config', 'user.email', 't@t');
  git(other, 'config', 'user.name', 't');
  git(dir, 'checkout', '-q', '-b', 'feat');
  return { dir, other };
}

function teammatePushes(dir, other, files) {
  commitFiles(other, files, 'teammate');
  git(other, 'push', '-q', 'origin', 'main');
  git(dir, 'fetch', '-q', 'origin');
}

test('pick: lines merged in from a fetched main are never asked about', () => {
  const { dir, other } = teammateRepo();
  commit(dir, 'feat.ts', numberedLines(30, 'f'), 'feature');
  teammatePushes(dir, other, { 'team.ts': numberedLines(30, 't') });
  git(dir, 'merge', '-q', '--no-ff', 'origin/main', '-m', 'merge main');
  for (let i = 0; i < 6; i++) {
    const out = pick(dir);
    const lineQuestions = out.questions.filter((q) => q.kind === 'line');
    assert.ok(lineQuestions.length > 0);
    assert.deepEqual([...new Set(lineQuestions.map((q) => q.file))], ['feat.ts']);
  }
});

test('pick: a line added only in a conflict resolution of the merge stays eligible', () => {
  const { dir, other } = teammateRepo();
  commit(dir, 'shared.ts', 'const shared = featValue();\nconst keep = 1;\n', 'feature edit');
  teammatePushes(dir, other, { 'shared.ts': 'const shared = teamValue();\nconst keep = 1;\n', 'team.ts': numberedLines(30, 't') });
  assert.notEqual(spawnSync('git', ['merge', '--no-ff', 'origin/main', '-m', 'merge main'], { cwd: dir }).status, 0);
  writeFileSync(join(dir, 'shared.ts'), 'const shared = resolvedValue();\nconst keep = 1;\n');
  git(dir, 'add', 'shared.ts');
  git(dir, 'commit', '-q', '--no-edit');
  const out = pick(dir);
  const lineQuestions = out.questions.filter((q) => q.kind === 'line');
  assert.deepEqual(lineQuestions.map((q) => [q.file, q.line]), [['shared.ts', 1]]);
});

test('pick: a commit listed in blame.ignoreRevsFile is still quizzed', () => {
  const { dir } = repoWithRemote();
  commit(dir, 'feat.ts', numberedLines(20, 'old'), 'pushed feature');
  git(dir, 'push', '-q', 'origin', 'main');
  const rewrite = commit(dir, 'feat.ts', numberedLines(20, 'new'), 'rewrite all lines');
  const ignoreFile = join(tmp('qg-ignore-'), 'ignore-revs');
  writeFileSync(ignoreFile, `${rewrite}\n`);
  git(dir, 'config', 'blame.ignoreRevsFile', ignoreFile);
  const out = pick(dir);
  assert.equal(out.status, 'quiz');
  const lineQuestions = out.questions.filter((q) => q.kind === 'line');
  assert.ok(lineQuestions.length > 0);
  assert.deepEqual([...new Set(lineQuestions.map((q) => q.file))], ['feat.ts']);
});

test('pick: a submodule pointer in the range is skipped and the normal file is quizzed', () => {
  const { dir } = repoWithRemote();
  writeFileSync(join(dir, 'feat.ts'), numberedLines(10));
  git(dir, 'add', 'feat.ts');
  git(dir, 'update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},sub`);
  git(dir, 'commit', '-q', '-m', 'feature and submodule');
  const out = pick(dir);
  assert.equal(out.status, 'quiz');
  const lineQuestions = out.questions.filter((q) => q.kind === 'line');
  assert.ok(lineQuestions.length > 0);
  assert.deepEqual([...new Set(lineQuestions.map((q) => q.file))], ['feat.ts']);
});

test('pick: diff.suppressBlankEmpty does not shift line numbers after a blank context line', () => {
  const { dir } = repoWithRemote();
  commit(dir, 'f.ts', 'const a1 = 1;\n\nconst a3 = 3;\nconst a4 = 4;\n', 'pushed');
  git(dir, 'push', '-q', 'origin', 'main');
  git(dir, 'config', 'diff.suppressBlankEmpty', 'true');
  commit(dir, 'f.ts', 'const a1 = 1;\n\nconst a3 = 3;\nconst NEW = 9;\nconst a4 = 4;\n', 'insert');
  const out = pick(dir);
  assert.equal(out.status, 'quiz');
  const lineQuestions = out.questions.filter((q) => q.kind === 'line');
  assert.deepEqual(lineQuestions.map((q) => [q.file, q.line]), [['f.ts', 4]]);
});

function lcg(seed) {
  let state = seed;
  return (n) => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state % n;
  };
}

test('chooseLines: no two picked lines are within five lines of each other in one file', () => {
  const eligible = Array.from({ length: 60 }, (_, i) => ({ file: 'f.ts', line: i + 1, code: `x${i}`, hunk: i < 30 ? 1 : 2 }));
  for (const rand of [() => 0, (n) => n - 1, lcg(1), lcg(7), lcg(42)]) {
    const picked = chooseLines(eligible, [], rand);
    assert.equal(picked.length, 4);
    for (const a of picked) for (const b of picked) if (a !== b) assert.ok(Math.abs(a.line - b.line) >= 5, picked.map((l) => l.line).join(','));
  }
});

test('chooseLines: one line per hunk first, then fills; priority lines come first and count toward four', () => {
  const eligible = [
    ...Array.from({ length: 20 }, (_, i) => ({ file: 'a.ts', line: i + 1, code: `a${i}`, hunk: 1 })),
    { file: 'b.ts', line: 1, code: 'b', hunk: 2 },
    { file: 'c.ts', line: 1, code: 'c', hunk: 3 },
  ];
  const picked = chooseLines(eligible, [], () => 0);
  assert.deepEqual(new Set(picked.map((l) => l.hunk)), new Set([1, 2, 3]));
  const priority = [{ ...eligible[7], kind: 'equivalent' }, { ...eligible[8], kind: 'not covered' }, { ...eligible[9], kind: 'not covered' }];
  const withPriority = chooseLines(eligible, priority, () => 0);
  assert.deepEqual(withPriority.slice(0, 2).map((l) => l.line), [8, 9]);
  assert.equal(withPriority.length, 4);
  assert.equal(new Set(withPriority.map((l) => `${l.file}:${l.line}`)).size, 4);
});

test('chooseLines: fewer eligible lines than four gives fewer picks', () => {
  const eligible = [{ file: 'a.ts', line: 1, code: 'a', hunk: 1 }, { file: 'a.ts', line: 3, code: 'b', hunk: 1 }];
  assert.equal(chooseLines(eligible, [], () => 0).length, 1);
  assert.deepEqual(chooseLines([], [], () => 0), []);
});

const TWO_BLOCKS = [
  '**teeth-build result (T1):** done',
  '- base: abc1234, route: relay',
  '- tests: 4 red-proven, 1 mutation-proven repair',
  '- not covered: src/b.vue:3 template',
  '- proposed equivalents: src/a.ts:4 EqualityOperator → `n <= max` (same result)',
  '- decisions: route inferred as relay (helpers/)',
  '- assumptions: implementer: callers pass finite numbers',
  '',
  '**teeth-build result (T2):** done',
  '- base: def5678, route: gate',
  '- not covered: none',
  '- proposed equivalents: none',
  '- not covered: src/c.ts:9 branch',
  '- decisions: none',
  '- assumptions: none',
].join('\n');

test('priorityEntries: parses both entry kinds and keeps each block base', () => {
  assert.deepEqual(priorityEntries(TWO_BLOCKS), [
    { kind: 'not covered', file: 'src/b.vue', line: 3, base: 'abc1234' },
    { kind: 'equivalent', file: 'src/a.ts', line: 4, base: 'abc1234', mutator: 'EqualityOperator', replacement: 'n <= max' },
    { kind: 'not covered', file: 'src/c.ts', line: 9, base: 'def5678' },
  ]);
  assert.deepEqual(priorityEntries('nothing here'), []);
});

test('assumptionLines: values of assumptions and decisions, without none', () => {
  assert.deepEqual(assumptionLines(TWO_BLOCKS), ['route inferred as relay (helpers/)', 'implementer: callers pass finite numbers']);
  assert.deepEqual(assumptionLines('- assumptions: none\n- decisions: none'), []);
});

function repoWithTaskCommit() {
  const { dir } = repoWithRemote();
  const base = git(dir, 'rev-parse', '--short', 'HEAD');
  const body = ['export function clamp(n, max) {', '  if (n > max) return max;', '  return n;', '}', ''].join('\n');
  commitFiles(dir, { 'src/a.ts': body, 'src/pad.ts': numberedLines(40) }, 'task: clamp');
  return { dir, base, body };
}

function writeSrcWithTwoInsertedLines(dir, body) {
  commit(dir, 'src/a.ts', `const headerOne = 1;\nconst headerTwo = 2;\n${body}`, 'later task');
}

function planFile(text) {
  const file = join(tmp('qg-plan-'), 'plan.md');
  writeFileSync(file, text);
  return file;
}

test('pick --plan: a priority entry with unique text is the first question at its tip line', () => {
  const { dir, base, body } = repoWithTaskCommit();
  writeSrcWithTwoInsertedLines(dir, body);
  const plan = planFile(`- base: ${base}, route: relay\n- proposed equivalents: src/a.ts:2 RelationalOperator → \`n >= max\` (same result)\n`);
  const out = pick(dir, '--plan', plan);
  const first = out.questions[0];
  assert.deepEqual([first.kind, first.file, first.line], ['equivalent', 'src/a.ts', 4]);
  assert.equal(first.text, '`src/a.ts:4` is `if (n > max) return max;`. Mutation testing (`RelationalOperator`) replaced part of it with `n >= max` and no test failed. Can any caller see a difference? Explain why or why not.');
  assert.equal(first.context.split('\n').length, 6);
  assert.deepEqual(out.skipped, []);
  assert.equal(out.questions.length, 5);
});

test('pick --plan: a not covered entry becomes a line question', () => {
  const { dir, base, body } = repoWithTaskCommit();
  writeSrcWithTwoInsertedLines(dir, body);
  const plan = planFile(`- base: ${base}, route: relay\n- not covered: src/a.ts:3 branch\n`);
  const first = pick(dir, '--plan', plan).questions[0];
  assert.deepEqual([first.kind, first.file, first.line], ['line', 'src/a.ts', 5]);
  assert.equal(first.text, '`src/a.ts:5` is `return n;` (context shown below). What does this line do, and what breaks if it is removed or changed?');
});

test('pick --plan: text that occurs twice or has gone is skipped and listed', () => {
  const { dir, base, body } = repoWithTaskCommit();
  commit(dir, 'src/a.ts', `${body}${body}`, 'later task');
  const plan = planFile(`- base: ${base}, route: relay\n- not covered: src/a.ts:2 branch\n- not covered: src/a.ts:99 branch\n- not covered: src/gone.ts:1 branch\n`);
  const out = pick(dir, '--plan', plan);
  assert.deepEqual(out.skipped, ['skipped priority: src/a.ts:2 moved or not found', 'skipped priority: src/a.ts:99 moved or not found']);
  assert.equal(out.status, 'quiz');
});

test('pick --plan: with an unknown base the entry is skipped', () => {
  const { dir } = repoWithTaskCommit();
  const plan = planFile('- base: 0000000, route: relay\n- not covered: src/a.ts:2 branch\n');
  assert.deepEqual(pick(dir, '--plan', plan).skipped, ['skipped priority: src/a.ts:2 moved or not found']);
});

test('pick --plan: at most two priority entries are considered', () => {
  const { dir, base } = repoWithTaskCommit();
  const plan = planFile(`- base: ${base}, route: relay\n- not covered: src/a.ts:1 a\n- not covered: src/a.ts:2 b\n- not covered: src/gone.ts:1 c\n`);
  const out = pick(dir, '--plan', plan);
  assert.deepEqual(out.questions.slice(0, 2).map((q) => [q.file, q.line]), [['src/a.ts', 1], ['src/a.ts', 2]]);
  assert.deepEqual(out.skipped, []);
  assert.equal(out.questions.filter((q) => q.kind === 'line').length, 4);
});

test('pick: question templates, without and with recorded assumptions', () => {
  const { dir } = repoWithRemote();
  const base = git(dir, 'rev-parse', '--short', 'HEAD');
  commit(dir, 'only.ts', 'const answer = compute(42);\n', 'A');
  const plain = pick(dir);
  assert.deepEqual(plain.questions.map((q) => q.text), [
    '`only.ts:1` is `const answer = compute(42);` (context shown below). What does this line do, and what breaks if it is removed or changed?',
    'What is the main assumption this change depends on that the code does not check, and what breaks if it is wrong?',
  ]);
  assert.equal(plain.questions[1].file, undefined);
  const plan = planFile(`- base: ${base}\n- decisions: route inferred as relay\n- assumptions: implementer: callers pass finite numbers\n- assumptions: none\n`);
  assert.equal(pick(dir, '--plan', plan).questions.at(-1).text, 'The build recorded these assumptions and decisions: route inferred as relay; implementer: callers pass finite numbers. Which one does this change depend on most, and what breaks if it is wrong?');
});

test('pick: a plan file that cannot be read exits 3', () => {
  const { dir } = repoWithRemote();
  commit(dir, 'a.ts', numberedLines(4), 'A');
  const r = quiz(dir, 'pick', '--plan', join(tmp('qg-none-'), 'missing.md'));
  assert.equal(r.code, 3);
  assert.match(r.err, /missing\.md/);
});

function replyText(verdicts, score = verdicts.filter((v) => v === 'pass').length) {
  return `score: ${score}/${verdicts.length}\n${verdicts.map((v, i) => `q${i + 1}: ${v}\nreason: r\nfull answer: a\n`).join('')}`;
}

function gradesFile(text) {
  const file = join(tmp('qg-grades-'), 'grades.txt');
  writeFileSync(file, text);
  return file;
}

function record(dir, attempt, ...args) {
  return quiz(dir, 'record', '--attempt', attempt, ...args);
}

function ledgerLines(dir) {
  const file = ledgerPath(dir);
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
}

test('parseGrades: accepts a well-formed five-question reply', () => {
  assert.deepEqual(parseGrades(replyText(['pass', 'pass', 'pass', 'pass', 'pass']), 5), ['pass', 'pass', 'pass', 'pass', 'pass']);
  assert.deepEqual(parseGrades(`\n\n${replyText(['pass', 'fail', 'pass', 'pass', 'pass'])}`, 5), ['pass', 'fail', 'pass', 'pass', 'pass']);
});

test('parseGrades: rejects a fenced reply, a line before score, a wrong score, a short or misordered list', () => {
  const good = replyText(['pass', 'pass', 'pass', 'pass', 'pass']);
  assert.equal(parseGrades(`\`\`\`text\n${good}\`\`\``, 5), null);
  assert.equal(parseGrades(`Here are the grades.\n${good}`, 5), null);
  assert.equal(parseGrades(replyText(['pass', 'pass', 'pass', 'pass', 'fail'], 5), 5), null);
  assert.equal(parseGrades(replyText(['pass', 'pass', 'pass', 'pass']), 5), null);
  assert.equal(parseGrades(good, 4), null);
  assert.equal(parseGrades(good.replace('q1: pass', 'q9: pass').replace('q2: pass', 'q1: pass').replace('q9: pass', 'q2: pass'), 5), null);
  assert.equal(parseGrades(good.replace('q3: pass', 'q3: maybe'), 5), null);
});

test('record: a full score appends one ledger line per unpushed commit and the installed hook then lets the push through', () => {
  const { dir } = repoWithRemote();
  quiz(dir, 'install');
  const first = commit(dir, 'a.ts', numberedLines(4), 'A');
  const second = commit(dir, 'b.ts', numberedLines(4, 'w'), 'B');
  const out = pick(dir);
  assert.notEqual(push(dir).code, 0);
  const r = record(dir, out.attempt, '--grades', gradesFile(replyText(out.questions.map(() => 'pass'))));
  assert.deepEqual([r.code, r.out], [0, 'recorded 2 commits']);
  const lines = ledgerLines(dir).map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.id, l.sha]).sort(), [[commitIdentity(dir, first), first], [commitIdentity(dir, second), second]].sort());
  for (const l of lines) {
    assert.equal(l.attempt, out.attempt);
    assert.match(l.at, /^\d{4}-\d\d-\d\dT/);
  }
  assert.equal(push(dir).code, 0);
});

test('record: a score below full exits 1 and leaves the ledger unchanged', () => {
  const { dir } = repoWithRemote();
  commit(dir, 'a.ts', numberedLines(60), 'A');
  const out = pick(dir);
  const verdicts = out.questions.map((_, i) => (i === 0 ? 'fail' : 'pass'));
  const r = record(dir, out.attempt, '--grades', gradesFile(replyText(verdicts)));
  assert.equal(r.code, 1);
  assert.equal(r.out, `score ${verdicts.length - 1}/${verdicts.length}; nothing recorded`);
  assert.deepEqual(ledgerLines(dir), []);
});

test('record: a reply that does not match the attempt exits 3 and records nothing', () => {
  const { dir } = repoWithRemote();
  commit(dir, 'a.ts', numberedLines(60), 'A');
  const out = pick(dir);
  const short = replyText(out.questions.slice(1).map(() => 'pass'));
  const r = record(dir, out.attempt, '--grades', gradesFile(short));
  assert.equal(r.code, 3);
  assert.match(r.err, /grader reply does not match the attempt/);
  assert.deepEqual(ledgerLines(dir), []);
});

test('record: an attempt that already failed cannot be re-graded', () => {
  const { dir } = repoWithRemote();
  commit(dir, 'a.ts', numberedLines(60), 'A');
  const out = pick(dir);
  const failing = out.questions.map((_, i) => (i === 0 ? 'fail' : 'pass'));
  assert.equal(record(dir, out.attempt, '--grades', gradesFile(replyText(failing))).code, 1);
  const again = record(dir, out.attempt, '--grades', gradesFile(replyText(out.questions.map(() => 'pass'))));
  assert.equal(again.code, 3);
  assert.match(again.err, /attempt already graded; run pick again/);
  assert.deepEqual(ledgerLines(dir), []);
});

test('an unknown flag exits 3 instead of being dropped', () => {
  const { dir } = repoWithRemote();
  commit(dir, 'a.ts', numberedLines(4), 'A');
  const r = quiz(dir, 'pick', '--pln', 'x');
  assert.equal(r.code, 3);
  assert.match(r.err, /unknown flag --pln/);
  assert.equal(quiz(dir, 'status', '--plan', 'x').code, 3);
});

test('record: a commit made after pick exits 3 with range changed', () => {
  const { dir } = repoWithRemote();
  commit(dir, 'a.ts', numberedLines(4), 'A');
  const out = pick(dir);
  commit(dir, 'b.ts', numberedLines(4), 'B');
  const r = record(dir, out.attempt, '--grades', gradesFile(replyText(out.questions.map(() => 'pass'))));
  assert.equal(r.code, 3);
  assert.match(r.err, /range changed; run pick again/);
  assert.deepEqual(ledgerLines(dir), []);
});

test('record: an unknown attempt, or a path-like attempt id, exits 3', () => {
  const { dir } = repoWithRemote();
  commit(dir, 'a.ts', numberedLines(4), 'A');
  for (const id of ['20990101000000-deadbeef', '../attempts/x', '']) {
    const r = record(dir, id, '--grades', gradesFile(replyText(['pass'])));
    assert.equal(r.code, 3, id);
    assert.match(r.err, /unknown attempt/);
  }
});

test('record: needs exactly one of --grades and --no-eligible', () => {
  const { dir } = repoWithRemote();
  commit(dir, 'a.ts', numberedLines(4), 'A');
  const out = pick(dir);
  assert.equal(record(dir, out.attempt).code, 3);
  assert.equal(record(dir, out.attempt, '--grades', gradesFile(replyText(['pass'])), '--no-eligible').code, 3);
});

test('record --no-eligible: refused on an attempt with questions, accepted without a grades file on a docs-only range', () => {
  const quizzed = repoWithRemote();
  commit(quizzed.dir, 'a.ts', numberedLines(4), 'A');
  const asked = pick(quizzed.dir);
  const refused = record(quizzed.dir, asked.attempt, '--no-eligible');
  assert.equal(refused.code, 3);
  assert.match(refused.err, /attempt has questions; --no-eligible refused/);
  assert.deepEqual(ledgerLines(quizzed.dir), []);

  const docs = repoWithRemote();
  quiz(docs.dir, 'install');
  const sha = commitFiles(docs.dir, { 'README.md': '# Title\ntext\n' }, 'docs');
  const out = pick(docs.dir);
  assert.equal(out.status, 'no eligible lines');
  const r = record(docs.dir, out.attempt, '--no-eligible');
  assert.deepEqual([r.code, r.out], [0, 'recorded 1 commits']);
  assert.equal(JSON.parse(ledgerLines(docs.dir)[0]).sha, sha);
  assert.equal(push(docs.dir).code, 0);
});

test('record: a no-eligible attempt does not accept a grades file', () => {
  const { dir } = repoWithRemote();
  commitFiles(dir, { 'README.md': '# Title\ntext\n' }, 'docs');
  const out = pick(dir);
  const r = record(dir, out.attempt, '--grades', gradesFile('score: 0/0\n'));
  assert.equal(r.code, 3);
  assert.deepEqual(ledgerLines(dir), []);
});

test('record: a second record of the same attempt adds duplicate lines that readLedger folds', () => {
  const { dir } = repoWithRemote();
  commit(dir, 'a.ts', numberedLines(4), 'A');
  const out = pick(dir);
  const grades = gradesFile(replyText(out.questions.map(() => 'pass')));
  record(dir, out.attempt, '--grades', grades);
  record(dir, out.attempt, '--grades', grades);
  assert.equal(ledgerLines(dir).length, 2);
  assert.equal(readLedger(ledgerPath(dir)).size, 1);
});

test('record: a partial last ledger line from a crash is skipped and the next record starts a fresh line', () => {
  const { dir } = repoWithRemote();
  const first = commit(dir, 'a.ts', numberedLines(4), 'A');
  const second = commit(dir, 'b.ts', numberedLines(4, 'w'), 'B');
  mkdirSync(join(ledgerPath(dir), '..'), { recursive: true });
  writeFileSync(ledgerPath(dir), `${JSON.stringify({ id: commitIdentity(dir, first), sha: first, at: 'now', attempt: 'a' })}\n{"id":"par`);
  assert.deepEqual([...readLedger(ledgerPath(dir))], [commitIdentity(dir, first)]);
  const out = pick(dir);
  assert.equal(out.status, 'quiz');
  record(dir, out.attempt, '--grades', gradesFile(replyText(out.questions.map(() => 'pass'))));
  assert.ok(readLedger(ledgerPath(dir)).has(commitIdentity(dir, second)));
});

test('record: a clean rebase onto a moved main keeps the pass and the push of the rebased branch exits 0', () => {
  const { dir, remote } = repoWithRemote();
  quiz(dir, 'install');
  git(dir, 'checkout', '-q', '-b', 'feat');
  commit(dir, 'feat.ts', numberedLines(4), 'feature');
  const out = pick(dir);
  record(dir, out.attempt, '--grades', gradesFile(replyText(out.questions.map(() => 'pass'))));
  const other = tmp('qg-other-');
  git(other, 'clone', '-q', remote, '.');
  git(other, 'config', 'user.email', 't@t');
  git(other, 'config', 'user.name', 't');
  commit(other, 'main-change.txt', 'moved\n', 'main moves');
  git(other, 'push', '-q', 'origin', 'main');
  git(dir, 'fetch', '-q', 'origin');
  git(dir, 'rebase', '-q', 'origin/main');
  const r = spawnSync('git', ['push', 'origin', 'feat'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(pick(dir), { status: 'nothing to quiz' });
});

test('record then a new commit on top: pick asks only about lines of the new commit', () => {
  const { dir } = repoWithRemote();
  commit(dir, 'a.ts', numberedLines(30), 'A');
  const first = pick(dir);
  record(dir, first.attempt, '--grades', gradesFile(replyText(first.questions.map(() => 'pass'))));
  commit(dir, 'b.ts', numberedLines(30, 'w'), 'B');
  const second = pick(dir);
  assert.equal(second.status, 'quiz');
  const lineQuestions = second.questions.filter((q) => q.kind === 'line');
  assert.ok(lineQuestions.length > 0);
  assert.ok(lineQuestions.every((q) => q.file === 'b.ts'));
});
