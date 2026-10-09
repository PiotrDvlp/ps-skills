import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  maskedRanges, safeMatches, planMutations, applyMutation, changedLineRanges,
} from './mutation-ops.mjs';

// ---------------------------------------------------------------------------
// Masking — matches inside strings/comments must never be planned.
// ---------------------------------------------------------------------------

test('maskedRanges covers strings, templates, line and block comments', () => {
  const src = "const a = 'x === y'; // line ===\n/* block === */ const t = `tpl === x`; const r = a === b;";
  const ranges = maskedRanges(src);
  const eq = safeMatches(src, /===/g, ranges);
  // Exactly one code `===` survives masking: `a === b` at the end. The match index
  // points at the first `=`, so check the surrounding slice.
  assert.equal(eq.length, 1);
  assert.equal(src.slice(eq[0].index - 2, eq[0].index + 3), 'a ===');
});

test('planMutations never plans an equality mutation inside a string', () => {
  const files = [{ path: 'src/a.js', source: "const s = 'a === b'; const r = a === b;" }];
  const mutations = planMutations(files);
  const eq = mutations.filter((m) => m.kind === 'equality');
  assert.equal(eq.length, 1);
  // The planned one is the real comparison, not the one inside the string.
  const planned = applyMutation(files[0].source, eq[0]);
  assert.ok(planned.includes('const s = \'a === b\'; const r = a !== b;'));
});

// ---------------------------------------------------------------------------
// Operator-level planning.
// ---------------------------------------------------------------------------

test('equality op does not double-mutate the `===` inside `!==`', () => {
  const files = [{ path: 'src/a.js', source: 'const a = b !== c;' }];
  const mutations = planMutations(files);
  const kinds = mutations.map((m) => m.kind);
  assert.ok(kinds.includes('inequality'));
  assert.ok(!kinds.includes('equality'), '`===` inside `!==` must not be planned as equality');
});

test('if-invert skips already-negated conditions and risky prefixes', () => {
  const files = [{
    path: 'src/a.js',
    source: 'if (!x) return 1;\nif (typeof y === "undefined") return 2;\nif (z) return 3;',
  }];
  const mutations = planMutations(files).filter((m) => m.kind === 'if-invert');
  assert.equal(mutations.length, 1, 'only the `if (z)` is invertible');
  const applied = applyMutation(files[0].source, mutations[0]);
  assert.ok(applied.includes('if (!z) return 3;'));
});

test('empty-return skips bare returns and returns of undefined', () => {
  const files = [{
    path: 'src/a.js',
    source: 'function f(x) {\n  return;\n  return undefined;\n  return x;\n}',
  }];
  const mutations = planMutations(files).filter((m) => m.kind === 'empty-return');
  assert.equal(mutations.length, 1);
  assert.ok(applyMutation(files[0].source, mutations[0]).includes('return undefined;\n  return undefined;'));
  assert.ok(!applyMutation(files[0].source, mutations[0]).includes('  return x;'), 'the pinned return was replaced');
});

test('empty-return keeps a trailing comment syntactically valid', () => {
  const files = [{ path: 'src/a.js', source: 'function f() { return x; // keep me\n}' }];
  const mutations = planMutations(files).filter((m) => m.kind === 'empty-return');
  assert.equal(mutations.length, 1);
  const applied = applyMutation(files[0].source, mutations[0]);
  assert.ok(applied.includes('return undefined; // keep me'));
});

test('empty-return stops at its own statement before later same-line work', () => {
  const source = 'if (ok) return value; cleanup();';
  const mutation = planMutations([{ path: 'src/a.js', source }])
    .find((candidate) => candidate.kind === 'empty-return');

  assert.equal(applyMutation(source, mutation), 'if (ok) return undefined; cleanup();');
});

test('per-operator caps and the global maxMutations cap are honoured', () => {
  const files = [{ path: 'src/a.js', source: 'a === b; c === d; e === f; g === h;' }];
  assert.equal(planMutations(files, { maxMutations: 10 }).length, 3, 'equality cap is 3');
  assert.equal(planMutations(files, { maxMutations: 2 }).length, 2, 'global cap applies');
});

test('manual mutations run first and must be unique and present', () => {
  const files = [{ path: 'src/a.js', source: 'const x = 1;\nconst r = a === b;' }];
  const manual = [{ file: 'src/a.js', find: 'const x = 1', replace: 'const x = 2', note: 'tweak the constant' }];
  const mutations = planMutations(files, { manual });
  assert.equal(mutations[0].kind, 'manual');
  assert.equal(mutations[0].note, 'tweak the constant');

  assert.throws(
    () => planMutations(files, { manual: [{ file: 'src/a.js', find: 'const', replace: 'let' }] }),
    /not unique/,
  );
  assert.throws(
    () => planMutations(files, { manual: [{ file: 'src/a.js', find: 'nope', replace: 'y' }] }),
    /not present/,
  );
  assert.throws(
    () => planMutations(files, { manual: [{ file: 'src/a.js', find: 'const x = 1', replace: 'const x = 1' }] }),
    /no-op/,
  );
});

test('applyMutation replaces exactly the planned span', () => {
  const source = 'const r = a === b;'; // `===` sits at index 12
  const m = { at: 12, len: 3, replacement: '!==' };
  assert.equal(applyMutation(source, m), 'const r = a !== b;');
});

test('empty-return skips a multi-line return but still plans one before a closing brace', () => {
  const emptyReturns = (source) =>
    planMutations([{ path: 'src/a.js', source }]).filter((m) => m.kind === 'empty-return');

  assert.equal(
    emptyReturns('function f(cond, a, b) {\n  return cond\n    ? a\n    : b\n}\n').length, 0,
    'a semicolonless return continued by `? a` must not be planned',
  );
  assert.equal(
    emptyReturns('function f() {\n  return {\n    a: 1,\n  }\n}\n').length, 0,
    'a return opening a multi-line object literal must not be planned',
  );
  assert.equal(
    emptyReturns('function f(x) {\n  return x\n}\n').length, 1,
    'a semicolonless return closed by `}` is complete and must still be planned',
  );
});

// ---------------------------------------------------------------------------
// Diff scoping — built-in operators must not mutate code the task never touched.
// ---------------------------------------------------------------------------

test('changedLineRanges reads new-side hunk headers', () => {
  const diff = [
    'diff --git a/x.js b/x.js',
    '--- a/x.js',
    '+++ b/x.js',
    '@@ -1 +1 @@',
    '@@ -10,0 +12,3 @@',
    '@@ -30,2 +40,0 @@',
  ].join('\n');

  assert.deepEqual(changedLineRanges(diff), [[1, 1], [12, 14]]);
});

test('changedLineRanges returns nothing for an empty diff', () => {
  assert.deepEqual(changedLineRanges(''), []);
});

const SCOPE_SRC = [
  'export function untouched(a, b) {',
  '  return a === b && a !== null;',
  '}',
  '',
  'export function touched(a, b) {',
  '  return a === b;',
  '}',
  '',
].join('\n');

test('planMutations without changedLines mutates the whole file', () => {
  const plan = planMutations([{ path: 'x.js', source: SCOPE_SRC }]);
  const lines = plan.map((m) => SCOPE_SRC.slice(0, m.at).split('\n').length);

  assert.ok(lines.includes(2), `expected an untouched-function mutation, got lines ${lines}`);
  assert.ok(lines.includes(6), `expected a touched-function mutation, got lines ${lines}`);
});

test('planMutations with changedLines mutates only the changed hunk', () => {
  const plan = planMutations([{ path: 'x.js', source: SCOPE_SRC, changedLines: [[5, 7]] }]);
  const lines = plan.map((m) => SCOPE_SRC.slice(0, m.at).split('\n').length);

  assert.ok(plan.length > 0, 'the changed hunk has a mutable ===, so the plan must not be empty');
  assert.deepEqual([...new Set(lines)], [6], `every mutation must land in 5..7, got ${lines}`);
});

test('changedLines of [] yields no built-in mutations', () => {
  assert.deepEqual(planMutations([{ path: 'x.js', source: SCOPE_SRC, changedLines: [] }]), []);
});

test('hand-authored mutations are never scoped away', () => {
  const plan = planMutations(
    [{ path: 'x.js', source: SCOPE_SRC, changedLines: [] }],
    { manual: [{ file: 'x.js', find: 'a !== null', replace: 'true' }] },
  );

  assert.equal(plan.length, 1, 'the manual mutation must survive an empty changed-line set');
  assert.equal(plan[0].kind, 'manual');
});
