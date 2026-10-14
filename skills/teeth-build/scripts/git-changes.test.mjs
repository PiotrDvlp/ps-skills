import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { changedLines } from './git-changes.mjs';
import { tmp } from './test-tmp.mjs';

const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
function repo() {
  const r = tmp('tb-git-');
  git(r, 'init', '-q'); git(r, 'config', 'user.email', 't@t'); git(r, 'config', 'user.name', 't');
  mkdirSync(join(r, 'f', '__tests__'), { recursive: true });
  writeFileSync(join(r, 'f', 'a.ts'), 'const a = 1\nconst b = 2\nconst c = 3\n');
  git(r, 'add', '.'); git(r, 'commit', '-qm', 'base');
  return { r, base: git(r, 'rev-parse', 'HEAD').stdout.trim() };
}

test('changed-lines: modified tracked lines and every line of an untracked file', () => {
  const { r, base } = repo();
  try {
    writeFileSync(join(r, 'f', 'a.ts'), 'const a = 1\nconst b = 20\nconst c = 3\n');
    writeFileSync(join(r, 'f', 'x.ts'), 'export const x = 1\nexport const y = 2\n');
    writeFileSync(join(r, 'f', '__tests__', 'x.test.ts'), 'test\n');
    const m = changedLines(r, base, 'f');
    assert.deepEqual([...m.entries()], [['f/a.ts', [2]], ['f/x.ts', [1, 2]]]);
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test('changed-lines: deletions alone produce no lines', () => {
  const { r, base } = repo();
  try {
    writeFileSync(join(r, 'f', 'a.ts'), 'const a = 1\nconst c = 3\n');
    assert.deepEqual([...changedLines(r, base, 'f').entries()], []);
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test('changed-lines: a base that is not an ancestor exits 3', () => {
  const { r } = repo();
  try {
    assert.throws(() => changedLines(r, '0000000000000000000000000000000000000000', 'f'), (e) => e.code === 3 && /not an ancestor of HEAD/.test(e.message));
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test('changed-lines: paths with spaces and non-ASCII names keep their real paths', () => {
  const { r } = repo();
  try {
    writeFileSync(join(r, 'f', 'a b.ts'), 'const s = 1\n');
    git(r, 'add', '.'); git(r, 'commit', '-qm', 'space');
    const base = git(r, 'rev-parse', 'HEAD').stdout.trim();
    writeFileSync(join(r, 'f', 'a b.ts'), 'const s = 2\n');
    writeFileSync(join(r, 'f', 'ä.ts'), 'export const u = 1\n');
    assert.deepEqual([...changedLines(r, base, 'f').entries()], [['f/a b.ts', [1]], ['f/ä.ts', [1]]]);
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test('changed-lines: a git failure throws code 3 instead of returning empty', () => {
  const { r, base } = repo();
  try {
    assert.throws(() => changedLines(r, base, '../outside'), (e) => e.code === 3 && /git diff failed/.test(e.message));
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test('changed-lines: vitest-default test files are not production files', () => {
  const { r, base } = repo();
  try {
    for (const n of ['x.test.js', 'y.spec.tsx', 'z.test.mts', 'w.test.ts']) writeFileSync(join(r, 'f', n), 'export const x = 1\n');
    assert.deepEqual([...changedLines(r, base, 'f').entries()], []);
  } finally { rmSync(r, { recursive: true, force: true }); }
});
