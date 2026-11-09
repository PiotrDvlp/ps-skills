import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ENUMS, parseLivingNote, checkRecords } from './check-records.mjs';

const CLI = fileURLToPath(new URL('./check-records.mjs', import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const RECORDS_MD = fileURLToPath(new URL('../references/records.md', import.meta.url));
const VALID = readFileSync(fixture('valid-living-note.md'), 'utf8');

const problemsOf = (text) => checkRecords(parseLivingNote(text));

function edit(text, from, to) {
  assert.ok(text.includes(from), `fixture lacks: ${from}`);
  return text.replace(from, to);
}

function oneProblem(text, keyword) {
  const problems = problemsOf(text);
  assert.equal(problems.length, 1, JSON.stringify(problems));
  assert.match(problems[0].message, new RegExp(keyword));
  return problems[0];
}

test('parse: the valid note gives no problems', () => {
  assert.deepEqual(problemsOf(VALID), []);
});

test('parse: records, fields, invariants and observations', () => {
  const note = parseLivingNote(VALID);
  assert.deepEqual(note.machines.map((m) => m.id), ['M001', 'M002']);
  assert.deepEqual(note.findings.map((f) => f.id), ['F001', 'F002', 'F003']);
  assert.deepEqual(note.issues.map((i) => i.id), ['I001']);
  assert.equal(note.frontmatter.target_branch, 'main');
  assert.equal(note.findings[0].fields.disposition, 'deferred');
  assert.deepEqual(note.machines[1].invariants.map((i) => [i.id, i.basis]), [
    ['M002-I1', 'product requirement'],
    ['M002-I2', 'investigator assumption'],
  ]);
  const rows = note.findings[0].observations;
  assert.equal(rows.length, 2);
  assert.equal(rows[1].revision, 'f3c24361');
  assert.equal(rows[1].on_target, 'no');
  assert.ok(note.findings[0].sections.Recipe.body.includes('"${REV}:src'));
});

test('parse: CRLF endings, padded cells and an escaped pipe give the same result', () => {
  let text = edit(VALID, '| R001 | f3c24361 | present |', '|  R001   |   f3c24361 |  present  |');
  text = edit(text, '| no | anchors moved |', '| no | anchors a \\| b |');
  text = text.replace(/\n/g, '\r\n');
  assert.deepEqual(problemsOf(text), []);
  const row = parseLivingNote(text).findings[0].observations[1];
  assert.equal(row.run, 'R001');
  assert.equal(row.note, 'anchors a | b');
});

test('parse: an inventory-only note with no findings is valid', () => {
  const text = VALID.slice(0, VALID.indexOf('### M002')) + '## Findings\n\n## Issues\n';
  assert.deepEqual(problemsOf(text), []);
});

test('parse: IDs past three digits are accepted', () => {
  const text = VALID.replaceAll('F003', 'F1000');
  assert.deepEqual(problemsOf(text), []);
});

test('C1 frontmatter', () => {
  oneProblem(edit(VALID, 'target_branch: main\n', ''), 'frontmatter');
});

test('C2 duplicate ID', () => {
  const text = VALID + '\n### I001: Another issue\n- findings: F001\n';
  oneProblem(text, 'duplicate');
});

test('C3 unknown invariant on the machine', () => {
  oneProblem(edit(VALID, '- invariant: M001-I1', '- invariant: M001-I9'), 'machine');
});

test('C4 missing section', () => {
  oneProblem(edit(VALID, '#### Trace\n', ''), 'section');
});

test('C4 observation without revision', () => {
  oneProblem(edit(VALID, '| R001 | f3c24361 | present |', '| R001 |  | present |'), 'revision');
});

test('C5 enum', () => {
  oneProblem(edit(VALID, '- severity: P2', '- severity: P9'), 'enum');
});

test('C6 absent without blocker', () => {
  oneProblem(edit(VALID, 'blocker: the write queue keeps the last intent', 'the write queue keeps the last intent'), 'blocker');
});

test('C6 unresolved without reason', () => {
  oneProblem(edit(VALID, 'reason: the wrapper source is not readable', 'the wrapper source is not readable'), 'reason');
});

test('C7 quoting: an unbraced revision before a path', () => {
  const p = oneProblem(edit(VALID, 'REV=feature/item_refactor\n', 'REV=feature/item_refactor\ngit show $REV:src/a.js\n'), 'quoting');
  assert.equal(p.id, 'F001');
});

test('C7 quoting: a braced revision outside double quotes', () => {
  oneProblem(edit(VALID, 'REV=feature/item_refactor\n', 'REV=feature/item_refactor\ngit show ${REV}:src/a.js\n'), 'quoting');
});

test('C7 quoting: PATH extension is not flagged', () => {
  const text = edit(VALID, 'REV=feature/item_refactor\n', 'REV=feature/item_refactor\nexport PATH="$PATH:/usr/bin"\n');
  assert.deepEqual(problemsOf(text), []);
});

test('C8 lifecycle and disposition pair', () => {
  oneProblem(edit(VALID, '- disposition: deferred', '- disposition: rejected'), 'pair');
});

test('C9 resolved needs a passing regression test on target', () => {
  oneProblem(edit(VALID, '| absent | confirmed | regression_test | yes |', '| absent | confirmed | code_trace | yes |'), 'resolved');
});

test('C1 frontmatter that is opened but never closed', () => {
  oneProblem(edit(VALID, '---\n\n# State audit', '\n# State audit'), 'frontmatter');
});

test('records under an unknown ## section are reported, not skipped', () => {
  const problems = problemsOf(edit(VALID, '## Findings\n', '## Open findings\n'));
  assert.ok(problems.some((p) => /outside a known section/.test(p.message)), JSON.stringify(problems));
});

test('an owner-rejected finding whose latest observation is present is valid', () => {
  const text = edit(VALID, '- lifecycle: open\n- disposition: deferred', '- lifecycle: closed\n- disposition: rejected');
  assert.deepEqual(problemsOf(text), []);
});

test('a resolved finding rechecked later as absent stays valid', () => {
  const row = '| R002 | bbbb222 | absent | confirmed | regression_test | yes | blocker: the write queue keeps the last intent |';
  const text = edit(VALID, row, `${row}\n| R003 | cccc333 | absent | confirmed | code_trace | yes | blocker: the write queue keeps the last intent |`);
  assert.deepEqual(problemsOf(text), []);
});

test('C11 selected finding on an investigator assumption', () => {
  oneProblem(edit(VALID, '- disposition: proposed', '- disposition: selected'), 'assumption');
});

test('C12 issue names an unknown finding', () => {
  oneProblem(edit(VALID, '- findings: F001', '- findings: F001, F009'), 'issue');
});

test('records.md lists exactly the validator enums', () => {
  const md = readFileSync(RECORDS_MD, 'utf8');
  for (const [key, values] of Object.entries(ENUMS)) {
    const line = md.split('\n').find((l) => l.startsWith(`- \`${key}\`:`));
    assert.ok(line, `records.md has no enum line for ${key}`);
    const listed = [...line.slice(line.indexOf(':') + 1).matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    assert.deepEqual(listed.sort(), [...values].sort(), key);
  }
});

function cli(...args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

test('CLI: valid note exits 0 and ends with 0 problems', () => {
  const res = cli(fixture('valid-living-note.md'));
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout.trimEnd(), /0 problems$/);
});

for (const name of ['invalid-absent-without-blocker.md', 'invalid-recipe-quoting.md', 'invalid-resolved-then-present.md']) {
  test(`CLI: ${name} exits 1`, () => {
    const res = cli(fixture(name));
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stdout.trimEnd(), /1 problems$/);
  });
}

test('CLI: no argument exits 2', () => {
  assert.equal(cli().status, 2);
});

test('CLI: missing file exits 2', () => {
  assert.equal(cli(fixture('does-not-exist.md')).status, 2);
});
