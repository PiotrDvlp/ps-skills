import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmp } from './test-tmp.mjs';
import { makeSnapshot, detectAdapter } from './snapshot.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8' });

function fixtureRepo() {
  const root = tmp('sk-snap-');
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  writeFileSync(join(repo, '.gitignore'), 'generated/\n');
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const runRoot = join(root, 'runs');
  return { repo, runRoot, base: git(repo, 'rev-parse', 'HEAD').trim() };
}

test('the snapshot holds base content, not working-tree edits', () => {
  const { repo, runRoot, base } = fixtureRepo();
  writeFileSync(join(repo, 'a.ts'), 'export const a = 2;\n');
  const { dir } = makeSnapshot(repo, base, [], runRoot);
  assert.equal(readFileSync(join(dir, 'a.ts'), 'utf8'), 'export const a = 1;\n');
});

test('generated inputs are copied and fingerprinted', () => {
  const { repo, runRoot, base } = fixtureRepo();
  mkdirSync(join(repo, 'generated'));
  writeFileSync(join(repo, 'generated', 'x.ts'), 'export const x = 1;\n');
  const { dir, fingerprints } = makeSnapshot(repo, base, ['generated', 'missing'], runRoot);
  assert.equal(readFileSync(join(dir, 'generated', 'x.ts'), 'utf8'), 'export const x = 1;\n');
  assert.match(fingerprints.generated, /^[0-9a-f]{64}$/);
  assert.equal(fingerprints.missing, undefined);
  assert.equal(makeSnapshot(repo, base, ['generated'], runRoot).fingerprints.generated, fingerprints.generated);
  writeFileSync(join(repo, 'generated', 'x.ts'), 'export const x = 2;\n');
  assert.notEqual(makeSnapshot(repo, base, ['generated'], runRoot).fingerprints.generated, fingerprints.generated);
});

test('detectAdapter reads the snapshot, not the checkout', () => {
  const { repo, runRoot, base } = fixtureRepo();
  writeFileSync(join(repo, 'nuxt.config.ts'), 'export default {};\n');
  const { dir } = makeSnapshot(repo, base, [], runRoot);
  assert.equal(detectAdapter(dir, null).name, 'tsc');
  assert.deepEqual(detectAdapter(dir, null).generatedInputs, []);
  assert.equal(detectAdapter(repo, null).name, 'nuxt');
  assert.deepEqual(detectAdapter(repo, null).generatedInputs, ['generated']);
});

test('a symlink leaving the snapshot blocks it', () => {
  const { repo, runRoot } = fixtureRepo();
  symlinkSync('/etc', join(repo, 'out'));
  git(repo, 'add', 'out');
  git(repo, 'commit', '-q', '-m', 'link');
  const base = git(repo, 'rev-parse', 'HEAD').trim();
  assert.throws(() => makeSnapshot(repo, base, [], runRoot), (e) => e.code === 3 && /^blocked: link leaves snapshot: .*out$/.test(e.message));
});

test('run dirs older than 24 hours are deleted', () => {
  const { repo, runRoot, base } = fixtureRepo();
  mkdirSync(runRoot, { mode: 0o700 });
  const old = join(runRoot, '1-1');
  mkdirSync(old);
  const t = new Date(Date.now() - 25 * 3600 * 1000);
  utimesSync(old, t, t);
  makeSnapshot(repo, base, [], runRoot);
  assert.equal(existsSync(old), false);
});
