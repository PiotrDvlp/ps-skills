import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmp } from './test-tmp.mjs';
import { loadTypescript, setupTypescript } from './tools.mjs';

function fakeTypescript(base, version) {
  const dir = join(base, 'node_modules', 'typescript');
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'typescript', version, main: 'index.js' }));
  writeFileSync(join(dir, 'index.js'), `module.exports = { fake: '${version}' };`);
  writeFileSync(join(dir, 'bin', 'tsc'), '');
  return dir;
}

function gateInstall(cache, version) {
  mkdirSync(cache, { mode: 0o700 });
  const tool = join(cache, 'tool');
  const dir = fakeTypescript(tool, version);
  writeFileSync(join(tool, '.complete'), '');
  return dir;
}

test("loadTypescript prefers the repo's typescript", () => {
  const root = tmp('sk-tools-');
  const repo = join(root, 'repo');
  const cache = join(root, 'cache');
  const repoDir = fakeTypescript(repo, '5.0.0');
  gateInstall(cache, '5.9.3');
  const r = loadTypescript(repo, cache);
  assert.equal(r.source, 'repo');
  assert.equal(r.version, '5.0.0');
  assert.equal(r.ts.fake, '5.0.0');
  assert.equal(realpathSync(r.tscPath), realpathSync(join(repoDir, 'bin', 'tsc')));
});

test('loadTypescript falls back to the gate install', () => {
  const root = tmp('sk-tools-');
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const cache = join(root, 'cache');
  const gateDir = gateInstall(cache, '5.9.3');
  const r = loadTypescript(repo, cache);
  assert.equal(r.source, 'gate');
  assert.equal(r.version, '5.9.3');
  assert.equal(realpathSync(r.tscPath), realpathSync(join(gateDir, 'bin', 'tsc')));
});

test('loadTypescript asks for setup when neither resolves', () => {
  const root = tmp('sk-tools-');
  const repo = join(root, 'repo');
  mkdirSync(repo);
  assert.throws(
    () => loadTypescript(repo, join(root, 'cache')),
    (e) => e.code === 3 && e.message.includes('run: check-plan.mjs setup'),
  );
});

test('setup keeps a complete install', async () => {
  const cache = join(tmp('sk-tools-'), 'cache');
  gateInstall(cache, '5.9.3');
  let calls = 0;
  await setupTypescript(cache, async () => { calls++; });
  assert.equal(calls, 0);
});

test('CLI setup reports fs errors with exit 3 and no TypeError', () => {
  const file = join(tmp('sk-tools-'), 'not-a-dir');
  writeFileSync(file, 'x');
  const r = spawnSync(process.execPath, [join(import.meta.dirname, 'tools.mjs'), 'setup', '--cache-dir', file], { encoding: 'utf8' });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /EEXIST|ENOTDIR/);
  assert.doesNotMatch(r.stderr, /TypeError/);
});

test('setup replaces a partial install', async () => {
  const cache = join(tmp('sk-tools-'), 'cache');
  const tool = join(cache, 'tool');
  mkdirSync(cache, { mode: 0o700 });
  mkdirSync(tool);
  writeFileSync(join(tool, 'stale.txt'), 'x');
  let calls = 0;
  await setupTypescript(cache, async (dir) => {
    calls++;
    assert.equal(dir, tool);
    assert.equal(existsSync(join(tool, 'stale.txt')), false);
    fakeTypescript(tool, '5.9.3');
  });
  assert.equal(calls, 1);
  assert.equal(existsSync(join(tool, '.complete')), true);
});
