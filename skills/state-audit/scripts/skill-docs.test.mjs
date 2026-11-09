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

test('scan: budget, seams, ledger and inventory depth', () => {
  assertContains(read('SKILL.md'), ['--depth inventory', 'at most 4', 'cross-area', 'not_started']);
  assertContains(textOf('references/cues.md'), ['untangle-codebase']);
  assertContains(textOf('references/cues-vue-nuxt.md'), ['errorPolicy', 'hydration']);
  assertContains(textOf('references/investigator.md'), ['leads', 'coverage']);
});

test('prepare-fix: packet size, review, grouping and relay route', () => {
  assertContains(read('SKILL.md'), [
    '**Route:** relay',
    '40 KiB',
    'wc -c',
    'not independently reviewed',
    'one behaviour change and one regression strategy',
  ]);
});

test('writing a run: validate before the run is marked complete, quote paths, create the folder first', () => {
  const skill = read('SKILL.md');
  const section = skill.slice(skill.indexOf('## Writing a run'), skill.indexOf('**Existing lock.**'));
  assert.ok(section.indexOf('check-records.mjs') > -1 && section.indexOf('check-records.mjs') < section.indexOf('status: complete'), 'validation must come before status: complete');
  assertContains(section, ['mkdir -p "<out>"', 'mkdir "<out>/.lock"', 'check-records.mjs" "<out>/<repo-name>.md"']);
  assertContains(skill, ['field changes']);
});

test('an abandoned run can be discarded instead of re-applied', () => {
  const skill = read('SKILL.md');
  const section = skill.slice(skill.indexOf('**Existing lock.**'), skill.indexOf('**Re-apply rule.**'));
  assertContains(section, ['discard', 'status: discarded', 'discard_reason:']);
  assertContains(skill, ['Skip `status: discarded`']);
});

test('activity log is written only for runs saved under the notes root or by the extension', () => {
  const skill = read('SKILL.md');
  const rule = skill.slice(skill.indexOf('`Activity log: FILE`') - 200, skill.indexOf('## Writing a run'));
  assertContains(rule, ['`--out`', 'never logs']);
});

test('fixtures and tests use neutral identifiers', () => {
  const banned = ['untan' + 'gle_product', 'pdp' + 'Store', 'createApollo' + 'Client', 'isItemData' + 'Loading'];
  for (const file of filesUnder(SKILL_DIR)) {
    const text = readFileSync(file, 'utf8');
    for (const word of banned) assert.ok(!text.includes(word), `${relative(SKILL_DIR, file)} contains ${word}`);
  }
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
