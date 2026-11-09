import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, utimesSync, realpathSync, renameSync } from 'node:fs';
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
  const recent = join(runRoot, `${Date.now()}-1`);
  mkdirSync(recent);
  makeSnapshot(repo, base, [], runRoot);
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(recent), true);
});

test('a link that stays inside the snapshot is allowed', () => {
  const { repo, runRoot } = fixtureRepo();
  symlinkSync('a.ts', join(repo, 'alias.ts'));
  git(repo, 'add', 'alias.ts');
  git(repo, 'commit', '-q', '-m', 'inner link');
  const base = git(repo, 'rev-parse', 'HEAD').trim();
  const { dir } = makeSnapshot(repo, base, [], runRoot);
  assert.equal(readFileSync(join(dir, 'alias.ts'), 'utf8'), 'export const a = 1;\n');
});

test('a two-link chain that escapes through .. blocks the snapshot', () => {
  const { repo, runRoot } = fixtureRepo();
  symlinkSync('.', join(repo, 's'));
  symlinkSync('s/..', join(repo, 'x'));
  git(repo, 'add', 's', 'x');
  git(repo, 'commit', '-q', '-m', 'chain');
  const base = git(repo, 'rev-parse', 'HEAD').trim();
  assert.throws(() => makeSnapshot(repo, base, [], runRoot), (e) => e.code === 3 && /^blocked: link leaves snapshot: /.test(e.message));
});

test('a dangling link blocks the snapshot', () => {
  const { repo, runRoot } = fixtureRepo();
  symlinkSync('nowhere', join(repo, 'dangling'));
  git(repo, 'add', 'dangling');
  git(repo, 'commit', '-q', '-m', 'dangling');
  const base = git(repo, 'rev-parse', 'HEAD').trim();
  assert.throws(() => makeSnapshot(repo, base, [], runRoot), (e) => e.code === 3 && /link leaves snapshot/.test(e.message));
});

test('a base that is not a commit is rejected and cannot inject git options', () => {
  const { repo, runRoot, base } = fixtureRepo();
  const out = join(runRoot, '..', 'injected.tar');
  assert.throws(() => makeSnapshot(repo, `--output=${out}`, [], runRoot), (e) => e.code === 3 && /^blocked: base .* is not a commit$/.test(e.message));
  assert.equal(existsSync(out), false);
  assert.equal(makeSnapshot(repo, base, [], runRoot).dir.length > 0, true);
});

function depsRepo(lock) {
  const { repo, runRoot } = fixtureRepo();
  writeFileSync(join(repo, '.gitignore'), 'generated/\nnode_modules/\n');
  writeFileSync(join(repo, 'package-lock.json'), lock);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'lock');
  mkdirSync(join(repo, 'node_modules', 'pkg-a'), { recursive: true });
  writeFileSync(join(repo, 'node_modules', 'pkg-a', 'index.js'), 'module.exports = 1;\n');
  return { repo, runRoot, base: git(repo, 'rev-parse', 'HEAD').trim() };
}

test('node_modules is cloned when the lockfile matches base', () => {
  const { repo, runRoot, base } = depsRepo('{"v":1}\n');
  const { dir, fingerprints } = makeSnapshot(repo, base, [], runRoot);
  assert.equal(readFileSync(join(dir, 'node_modules', 'pkg-a', 'index.js'), 'utf8'), 'module.exports = 1;\n');
  assert.match(fingerprints.lockfileHash, /^[0-9a-f]{64}$/);
  assert.equal(fingerprints.nodeVersion, process.version);
});

test('a lockfile change blocks the snapshot', () => {
  const { repo, runRoot, base } = depsRepo('{"v":1}\n');
  writeFileSync(join(repo, 'package-lock.json'), '{"v":2}\n');
  assert.throws(() => makeSnapshot(repo, base, [], runRoot), (e) => e.code === 3 && e.message === 'blocked: dependencies differ from base');
});

test('a dependency link leaving the run dir blocks the snapshot', () => {
  const { repo, runRoot, base } = depsRepo('{"v":1}\n');
  const original = join(repo, 'node_modules', 'pkg-a', 'index.js');
  symlinkSync(realpathSync(join(repo, 'node_modules', 'pkg-a')), join(repo, 'node_modules', 'linked'));
  assert.throws(() => makeSnapshot(repo, base, [], runRoot), (e) => e.code === 3 && /^blocked: dependency link leaves snapshot: .*linked$/.test(e.message));
  assert.equal(readFileSync(original, 'utf8'), 'module.exports = 1;\n');
});

test('a node_modules that is itself a link leaving the run dir blocks the snapshot', () => {
  const { repo, runRoot, base } = depsRepo('{"v":1}\n');
  const external = join(repo, '..', 'external-modules');
  renameSync(join(repo, 'node_modules'), external);
  symlinkSync(external, join(repo, 'node_modules'));
  assert.throws(() => makeSnapshot(repo, base, [], runRoot), (e) => e.code === 3 && /^blocked: dependency link leaves snapshot: .*node_modules$/.test(e.message));
  assert.equal(readFileSync(join(external, 'pkg-a', 'index.js'), 'utf8'), 'module.exports = 1;\n');
});
