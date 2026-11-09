import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = fileURLToPath(new URL('..', import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const read = (rel) => readFileSync(join(SKILL_DIR, rel), 'utf8');
const exists = (rel) => existsSync(join(SKILL_DIR, rel));

const HOME_PREFIX = ['', 'Us' + 'ers', ''].join('/');
const VAULT_NAME = 'Obsid' + 'ian';

function filesUnder(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

function textOf(...rels) {
  return rels.filter(exists).map(read).join('\n');
}

function assertContains(text, needles) {
  for (const needle of needles) assert.ok(text.includes(needle), `missing: ${needle}`);
}

test('SKILL.md frontmatter names the skill and starts its description with "Use when"', () => {
  const fm = read('SKILL.md').match(/^---\n([\s\S]*?)\n---/);
  assert.ok(fm, 'no frontmatter');
  assert.match(fm[1], /^name: state-audit$/m);
  assert.match(fm[1], /^description: "?Use when/m);
});

test('every reference named in SKILL.md exists, and every reference file is named', () => {
  const skill = read('SKILL.md');
  const named = new Set([...skill.matchAll(/references\/([\w.-]+\.md)/g)].map((m) => m[1]));
  for (const name of named) assert.ok(exists(`references/${name}`), `named but missing: references/${name}`);
  for (const name of readdirSync(join(SKILL_DIR, 'references'))) {
    assert.ok(named.has(name), `not named in SKILL.md: references/${name}`);
  }
});

test('core: routing, identity, lock, recovery and recheck output', () => {
  assertContains(textOf('SKILL.md', 'references/recheck.md'), [
    'mkdir',
    '.lock',
    'owner.txt',
    'abandoned',
    'run ID',
    'status: incomplete',
    'repo_root_commit',
    '~/.state-audit/',
    'state-audit extension:',
    'Notes root:',
    '--path-format=absolute --git-common-dir',
    '<ID> <assessment> <rev as given>',
    'check-records.mjs',
  ]);
});

test('no personal path or vault name outside fixtures', () => {
  const files = filesUnder(SKILL_DIR).filter((f) => !relative(SKILL_DIR, f).startsWith('fixtures'));
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    assert.ok(!text.includes(HOME_PREFIX), `${relative(SKILL_DIR, file)} contains a home path`);
    assert.ok(!text.includes(VAULT_NAME), `${relative(SKILL_DIR, file)} names the vault app`);
  }
});

test('this test does not contain the patterns it forbids', () => {
  const own = readFileSync(SELF, 'utf8');
  assert.ok(!own.includes(HOME_PREFIX));
  assert.ok(!own.includes(VAULT_NAME));
});
