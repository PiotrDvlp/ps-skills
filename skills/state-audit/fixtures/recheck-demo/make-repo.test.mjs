import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseLivingNote, checkRecords } from '../../scripts/check-records.mjs';

const CLI = fileURLToPath(new URL('./make-repo.mjs', import.meta.url));
const TAGS = ['v1-defect', 'v2-moved', 'v3-fixed', 'v4-wrapper', 'v5-missing'];

const temps = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'sa-demo-'));
  temps.push(dir);
  return dir;
};
after(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const git = (repo, ...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });

function make(env = {}) {
  const base = temp();
  const repo = join(base, 'demo');
  const out = join(base, 'demo-out');
  const res = spawnSync(process.execPath, [CLI, repo, out], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { base, repo, out, res };
}

const built = make();

test('the CLI exits 0 and creates the five tags', () => {
  assert.equal(built.res.status, 0, built.res.stderr);
  assert.deepEqual(git(built.repo, 'tag', '--list').stdout.trim().split('\n').sort(), [...TAGS].sort());
});

test('ground truth: the loading flag sticks at v1 and v2, is released at v3 and v4, and v5 cannot load', async () => {
  const expected = { 'v1-defect': true, 'v2-moved': true, 'v3-fixed': false, 'v4-wrapper': false };
  for (const tag of TAGS) {
    const dir = join(built.base, `export-${tag}`);
    mkdirSync(dir);
    const archive = spawnSync('git', ['-C', built.repo, 'archive', tag]);
    assert.equal(archive.status, 0);
    assert.equal(spawnSync('tar', ['-x', '-C', dir], { input: archive.stdout }).status, 0);
    const load = import(pathToFileURL(join(dir, 'app.mjs')).href);
    if (tag === 'v5-missing') {
      await assert.rejects(load);
      continue;
    }
    const app = await load;
    await app.selectItem('a', true);
    assert.equal(app.isItemLoading(), expected[tag], tag);
  }
});

test('v4-wrapper differs from v2-moved only in the client defaults', () => {
  assert.equal(git(built.repo, 'diff', '--name-only', 'v2-moved', 'v4-wrapper').stdout.trim(), 'src/client.mjs');
});

test('the seeded note is valid and records the repo root commit', () => {
  const text = readFileSync(join(built.out, 'demo.md'), 'utf8');
  assert.deepEqual(checkRecords(parseLivingNote(text)), []);
  const root = git(built.repo, 'rev-list', '--max-parents=0', 'HEAD').stdout.trim();
  assert.equal(parseLivingNote(text).frontmatter.repo_root_commit, root);
  const v1 = git(built.repo, 'rev-parse', 'v1-defect').stdout.trim();
  assert.equal(parseLivingNote(text).findings[0].observations[0].revision, v1);
});

test('two runs with different ambient git dates give the same commits', () => {
  const a = make({ GIT_AUTHOR_DATE: '2001-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2001-01-01T00:00:00Z' });
  const b = make({ GIT_AUTHOR_DATE: '2002-02-02T00:00:00Z', GIT_COMMITTER_DATE: '2002-02-02T00:00:00Z' });
  assert.equal(a.res.status, 0, a.res.stderr);
  assert.equal(b.res.status, 0, b.res.stderr);
  assert.equal(git(a.repo, 'rev-parse', 'v5-missing').stdout, git(b.repo, 'rev-parse', 'v5-missing').stdout);
});

for (const which of ['out', 'repo']) {
  test(`refuses a non-empty ${which} directory and writes nothing`, () => {
    const base = temp();
    const repo = join(base, 'demo');
    const out = join(base, 'demo-out');
    const full = which === 'out' ? out : repo;
    const other = which === 'out' ? repo : out;
    mkdirSync(full);
    writeFileSync(join(full, 'sentinel.txt'), 'keep');
    const res = spawnSync(process.execPath, [CLI, repo, out], { encoding: 'utf8' });
    assert.equal(res.status, 2);
    assert.deepEqual(readdirSync(full), ['sentinel.txt']);
    assert.equal(readFileSync(join(full, 'sentinel.txt'), 'utf8'), 'keep');
    assert.equal(existsSync(other), false);
  });
}

test('refuses an out directory inside the repo directory and writes nothing', () => {
  const repo = join(temp(), 'demo');
  const res = spawnSync(process.execPath, [CLI, repo, join(repo, 'notes')], { encoding: 'utf8' });
  assert.equal(res.status, 2, res.stderr);
  assert.match(res.stderr, /inside/);
  assert.equal(existsSync(repo), false);
});

test('a missing argument exits 2', () => {
  assert.equal(spawnSync(process.execPath, [CLI, temp()], { encoding: 'utf8' }).status, 2);
});
