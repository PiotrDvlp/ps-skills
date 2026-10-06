import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildPrompt } from './build-prompt.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(HERE, '..', 'references', 'fixtures', name), 'utf8');

const RUBRIC = '# Rubric\nProduce a proposal.';

test('strips the withheld half so the canary never reaches Codex', () => {
  const out = buildPrompt({ rubric: RUBRIC, brief: fixture('brief-with-canary-in-withheld-half.md') });
  assert.ok(!out.includes('WITHHELD_CANARY_7f3a'), 'canary leaked into the Codex prompt');
  assert.ok(out.includes('Problem statement'), 'problem half was dropped');
});

// Control. Without this, a buildPrompt that returned '' would pass the test above
// vacuously. This case proves the assertion is wired to real content.
test('control: the same canary IS returned when it sits in the sent half', () => {
  const out = buildPrompt({ rubric: RUBRIC, brief: fixture('brief-with-canary-in-problem-half.md') });
  assert.ok(out.includes('WITHHELD_CANARY_7f3a'), 'test is vacuous — canary not found in the sent half either');
});

test('prepends the rubric', () => {
  const out = buildPrompt({ rubric: RUBRIC, brief: fixture('brief-plain.md') });
  assert.ok(out.startsWith('# Rubric'));
});

test('a brief with no WITHHELD marker sends everything after the SENT marker', () => {
  const brief = '=== SENT TO CODEX ===\nProblem statement\nJust this.';
  const out = buildPrompt({ rubric: RUBRIC, brief });
  assert.ok(out.includes('Just this.'));
});

test('throws when the SENT marker is missing rather than sending the whole document', () => {
  assert.throws(() => buildPrompt({ rubric: RUBRIC, brief: 'no markers here at all' }),
    /SENT TO CODEX/);
});

test('throws when WITHHELD precedes SENT, rather than guessing the boundary', () => {
  const brief = '=== WITHHELD ===\nsecret\n=== SENT TO CODEX ===\npublic';
  assert.throws(() => buildPrompt({ rubric: RUBRIC, brief }), /before/);
});

test('throws on non-string input', () => {
  assert.throws(() => buildPrompt({ rubric: RUBRIC, brief: null }), /must both be strings/);
});

test('throws on a near-miss WITHHELD marker instead of failing open and sending it', () => {
  const brief = '=== SENT TO CODEX ===\nProblem statement\nJust this.\n\n== WITHHELD ==\nsecret';
  assert.throws(() => buildPrompt({ rubric: RUBRIC, brief }), /WITHHELD-like/);
});

test('throws when the problem half is empty rather than sending a bare rubric', () => {
  const brief = '=== SENT TO CODEX ===\n   \n\n=== WITHHELD ===\nsecret';
  assert.throws(() => buildPrompt({ rubric: RUBRIC, brief }), /empty or whitespace-only/);
});

test('does not throw on ordinary prose starting a line with the word "withheld"', () => {
  const brief = '=== SENT TO CODEX ===\nProblem statement\n'
    + 'Withheld tax must be reported separately.\nNo marker appears anywhere in this brief.';
  const out = buildPrompt({ rubric: RUBRIC, brief });
  assert.ok(out.includes('Withheld tax must be reported separately.'));
});
