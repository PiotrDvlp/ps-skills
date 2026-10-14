import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { scanTree } from './check-public-leaks.mjs';

const SCRIPT = new URL('./check-public-leaks.mjs', import.meta.url).pathname;
const USERS = ['', 'Users', ''].join('/');
const TICKET = ['ZZZ', '42'].join('-');

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'leak-'));
  spawnSync('git', ['init', '-q', root]);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

test('finds personal paths, ticket keys and denied names', () => {
  const root = tree({
    'a/SKILL.md': `see ${USERS}someone/x\nticket ${TICKET}\nclient acme here\n`,
  });
  const { findings } = scanTree({ root, deny: ['acme'], allowPaths: [] });
  assert.deepEqual(findings.map((f) => f.rule).sort(), ['deny-name', 'personal-path', 'ticket-key']);
});

test('allows placeholder prefixes', () => {
  const root = tree({ 'a/SKILL.md': 'use PROJ-123 or ABC-1 as examples\n' });
  assert.equal(scanTree({ root, deny: ['acme'], allowPaths: [] }).findings.length, 0);
});

test('skips allowed path prefixes for deny-name only', () => {
  const root = tree({ 'skills/layer-lint/x.md': `acme\n${USERS}me\n` });
  const { findings } = scanTree({ root, deny: ['acme'], allowPaths: ['skills/layer-lint'] });
  assert.deepEqual(findings.map((f) => f.rule), ['personal-path']);
});

test('an allowed path matches a directory boundary, not a string prefix', () => {
  const root = tree({ 'skills/layer-lint-private/x.md': 'acme\n' });
  const { findings } = scanTree({ root, deny: ['acme'], allowPaths: ['skills/layer-lint'] });
  assert.deepEqual(findings.map((f) => f.rule), ['deny-name']);
});

test('exits 2 on a missing deny file', () => {
  const r = spawnSync('node', [SCRIPT, '--root', tree({}), '--deny-file', '/nonexistent/deny.txt'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});

test('exits 2 on an empty deny file', () => {
  const root = tree({ 'deny.txt': '\n# comment only\n' });
  const r = spawnSync('node', [SCRIPT, '--root', root, '--deny-file', join(root, 'deny.txt')], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});

test('exits 0 and prints 0 findings on a clean tree', () => {
  const root = tree({ 'a/SKILL.md': 'clean\n' });
  const denyDir = tree({ 'deny.txt': 'acme\n' });
  const r = spawnSync('node', [SCRIPT, '--root', root, '--deny-file', join(denyDir, 'deny.txt')], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /0 findings/);
});

test('exits 2 when no file was scanned', () => {
  const denyDir = tree({ 'deny.txt': 'acme\n' });
  const r = spawnSync('node', [SCRIPT, '--root', tree({}), '--deny-file', join(denyDir, 'deny.txt')], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});

test('scans extensionless, upper-case-extension and assets files, skips binaries', () => {
  const root = tree({
    LICENSE: `${USERS}x\n`,
    'a/NOTES.MD': `${USERS}x\n`,
    'assets/page.vue': `${USERS}x\n`,
    'img.bin': `\0${USERS}x\n`,
  });
  const { findings } = scanTree({ root, deny: ['acme'], allowPaths: [] });
  assert.deepEqual(findings.map((f) => f.file).sort(), ['LICENSE', 'a/NOTES.MD', 'assets/page.vue']);
});

test('skips gitignored files, still scans untracked ones', () => {
  const root = tree({
    'work/.gitignore': '*\n',
    'work/plan.md': `${USERS}x\n`,
    'new/SKILL.md': `${USERS}x\n`,
  });
  const { findings } = scanTree({ root, deny: ['acme'], allowPaths: [] });
  assert.deepEqual(findings.map((f) => f.file), ['new/SKILL.md']);
});

test('exits 2 when the root is not a git work tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'leak-nogit-'));
  writeFileSync(join(root, 'a.md'), 'clean\n');
  const denyDir = tree({ 'deny.txt': 'acme\n' });
  const r = spawnSync('node', [SCRIPT, '--root', root, '--deny-file', join(denyDir, 'deny.txt')], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});

test('scans symlink text without following the link', () => {
  const root = tree({});
  symlinkSync(`${USERS}nobody/missing`, join(root, 'link'));
  const { findings } = scanTree({ root, deny: ['acme'], allowPaths: [] });
  assert.deepEqual(findings.map((f) => `${f.file}:${f.rule}`), ['link:personal-path']);
});
