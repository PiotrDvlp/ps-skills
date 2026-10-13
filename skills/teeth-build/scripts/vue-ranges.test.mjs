import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadVueParsers, vueRanges } from './vue-ranges.mjs';
const ROOT = process.env.TEETH_BUILD_VITEST_ROOT;
const opts = ROOT ? {} : { skip: 'set TEETH_BUILD_VITEST_ROOT to a repo with @vue/compiler-sfc' };
const src = (n) => readFileSync(new URL(`../fixtures/vue/${n}.vue`, import.meta.url), 'utf8');
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

test('vue-ranges: template-first file maps to script-relative lines and skips the macro', opts, () => {
  const p = loadVueParsers(ROOT);
  const r = vueRanges(src('TemplateFirst'), range(1, 18), p);
  assert.deepEqual(r.mutate, [{ start: 2, end: 2 }, { start: 11, end: 11 }]);
  assert.deepEqual(r.mutable, [8, 17]);
  assert.deepEqual(r.notCovered.filter((n) => n.reason === 'macro').map((n) => n.line), range(9, 16));
  assert.equal(r.notCovered.filter((n) => n.reason === 'template').length, 8); // lines 1-7 and the </script> line 18
});

test('vue-ranges: two script blocks fail closed, one plain script is mutable', opts, () => {
  const p = loadVueParsers(ROOT);
  const two = vueRanges(src('TwoScripts'), range(1, 20), p);
  assert.deepEqual(two.mutate, []);
  assert.equal(two.notCovered.some((n) => n.reason === 'two script blocks'), true);
  assert.equal(vueRanges(src('PlainScript'), range(1, 20), p).mutable.length, 1);
});

test('vue-ranges: parens in comments and strings do not move the macro span', opts, () => {
  const r = vueRanges(src('CommentParens'), range(1, 20), loadVueParsers(ROOT));
  assert.equal(r.notCovered.filter((n) => n.reason === 'macro').length, 1);
});

test('vue-ranges: a line shared with a macro is excluded whole', opts, () => {
  const r = vueRanges(src('MixedLine'), range(1, 20), loadVueParsers(ROOT));
  assert.equal(r.mutable.length, 0);
});

test('vue-ranges: an unparsable script marks its changed lines unparsed', opts, () => {
  const r = vueRanges(src('Broken'), range(1, 5), loadVueParsers(ROOT));
  assert.deepEqual(r.mutate, []);
  assert.deepEqual(r.notCovered.filter((n) => n.reason === 'unparsed').map((n) => n.line), [2]);
  assert.equal(r.notCovered.every((n) => n.reason === 'unparsed' || n.reason === 'template'), true);
});

test('vue-ranges: no script means every changed line is template', opts, () => {
  const r = vueRanges(src('NoScript'), range(1, 3), loadVueParsers(ROOT));
  assert.deepEqual(r.notCovered.map((n) => n.reason), ['template', 'template', 'template']);
});
