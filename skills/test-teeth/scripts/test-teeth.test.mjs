import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync, cpSync, existsSync, realpathSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, '..', 'fixtures');
const fixture = (rel) => JSON.parse(readFileSync(join(FIX, rel), 'utf8'));
const VITEST_ROOT = process.env.TEST_TEETH_VITEST_ROOT;
const VITEST_BIN = VITEST_ROOT && join(VITEST_ROOT, 'node_modules', '.bin', 'vitest');
const VITEST_TEST_OPTIONS = VITEST_ROOT
  ? {}
  : { skip: 'set TEST_TEETH_VITEST_ROOT to a repo with vitest installed' };
const SCRIPT = join(HERE, 'test-teeth.mjs');

function miniWithVitest() {
  assert.equal(existsSync(VITEST_BIN), true, `integration needs ${VITEST_BIN}`);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tt-int-')));
  cpSync(join(FIX, 'mini'), root, { recursive: true });
  symlinkSync(join(VITEST_ROOT, 'node_modules'), join(root, 'node_modules'));
  return root;
}

const tt = await import('./test-teeth.mjs');

test('discovery: parseList yields repo-relative ids and flags duplicates', () => {
  const list = fixture('reporter/list-mini.json');
  const cases = tt.parseList(list, '/repo');
  assert.equal(cases.length, 2);
  assert.equal(cases[0].id, '__tests__/sum.test.ts::sum > adds::4');
  assert.equal(cases[0].spec, '__tests__/sum.test.ts');
  assert.equal(cases[0].duplicate, false);
  const dup = tt.parseList([...list, list[0]], '/repo');
  assert.equal(dup.filter((c) => c.duplicate).length, 2);
});

test('discovery: mapImpl finds the sibling or returns null', () => {
  assert.equal(
    tt.mapImpl('/r/src/pageModules/cart/components/__tests__/CartItem.test.ts',
      (p) => p === '/r/src/pageModules/cart/components/CartItem.vue'),
    '/r/src/pageModules/cart/components/CartItem.vue',
  );
  assert.equal(
    tt.mapImpl('/r/src/pageModules/cart/composables/__tests__/useX.test.ts',
      (p) => p === '/r/src/pageModules/cart/composables/useX.ts'),
    '/r/src/pageModules/cart/composables/useX.ts',
  );
  assert.equal(tt.mapImpl('/r/a/__tests__/none.test.ts', () => false), null);
  assert.equal(tt.mapImpl('/r/a/flat.test.ts', (p) => p === '/r/a/flat.ts'), '/r/a/flat.ts');
  assert.equal(tt.mapImpl('/r/a/__tests__/Thing.spec.ts', (p) => p === '/r/a/Thing.ts'), '/r/a/Thing.ts');
});

test('attribution: tautology', () => {
  const cases = tt.parseList(fixture('reporter/list-mini.json'), '/repo');
  const r = tt.attribute(fixture('reporter/tautology-m01.json'), cases, '/repo');
  assert.equal(r.mutantState, 'killed');
  assert.equal(r.byCase.get('__tests__/sum.test.ts::sum > adds::4').status, 'killed');
  assert.equal(r.byCase.get('__tests__/sum.test.ts::sum > tautology::5').status, 'passed');
  assert.deepEqual(r.runtimeFailures, []);
});

test('attribution: runtime failure credits nothing', () => {
  const cases = tt.parseList(fixture('reporter/list-mini.json'), '/repo');
  const r = tt.attribute(fixture('reporter/runtime-m01.json'), cases, '/repo');
  assert.equal(r.mutantState, 'survived');
  assert.equal(r.byCase.get('__tests__/sum.test.ts::sum > adds::4').status, 'runtime');
  assert.deepEqual(r.runtimeFailures, ['__tests__/sum.test.ts::sum > adds::4']);
});

test('attribution: invalid mutant', () => {
  const cases = tt.parseList(fixture('reporter/list-mini.json'), '/repo');
  const r = tt.attribute(fixture('reporter/invalid-m01.json'), cases, '/repo');
  assert.equal(r.mutantState, 'invalid');
  assert.equal(r.byCase.get('__tests__/sum.test.ts::sum > adds::4').status, 'missing');
});

test('attribution: invalid mutant without a message', () => {
  const cases = tt.parseList(fixture('reporter/list-mini.json'), '/repo');
  const r = tt.attribute(fixture('reporter/invalid-nomessage-m01.json'), cases, '/repo');
  assert.equal(r.mutantState, 'invalid');
});

test('attribution: invalid by file message demotes the killed case', () => {
  const cases = tt.parseList(fixture('reporter/list-mini.json'), '/repo');
  const r = tt.attribute(fixture('reporter/invalid-filemessage-m01.json'), cases, '/repo');
  assert.equal(r.mutantState, 'invalid');
  assert.equal(r.byCase.get('__tests__/sum.test.ts::sum > adds::4').status, 'missing');
  assert.deepEqual(r.runtimeFailures, []);
});

test('attribution: invalid by failureMessages', () => {
  const cases = tt.parseList(fixture('reporter/list-mini.json'), '/repo');
  const r = tt.attribute(fixture('reporter/invalid-import-m01.json'), cases, '/repo');
  assert.equal(r.mutantState, 'invalid');
  assert.equal(r.byCase.get('__tests__/sum.test.ts::sum > adds::4').status, 'missing');
  assert.deepEqual(r.runtimeFailures, []);
});

test('attribution: skipped case', () => {
  const cases = tt.parseList(fixture('reporter/list-mini.json'), '/repo');
  const addsId = '__tests__/sum.test.ts::sum > adds::4';
  const report = fixture('reporter/skipped-m01.json');

  for (const status of ['skipped', 'todo', 'pending']) {
    const candidate = structuredClone(report);
    candidate.testResults[0].assertionResults[0].status = status;
    const r = tt.attribute(candidate, cases, '/repo');
    assert.equal(r.byCase.get(addsId).status, 'skipped');
    assert.equal(r.mutantState, 'survived');
    assert.deepEqual(r.runtimeFailures, []);
  }
});

test('planning: template operators cover v-if, v-for, :prop, @event and respect quotes', () => {
  const src = `<template>
  <div v-if="a > b" :title="label" @click="onClick" v-for="x in xs" :key="x.id">
    <!-- <span v-if="hidden"> -->
  </div>
</template>
<script setup lang="ts">const a = 1</script>`;
  const ms = tt.templateMutations('C.vue', src);
  const kinds = ms.map((m) => m.kind).sort();
  assert.deepEqual(kinds, ['template-event', 'template-for', 'template-if', 'template-prop']);
  const vif = ms.find((m) => m.kind === 'template-if');
  assert.equal(tt.applyMutation(src, vif).includes('v-if="!(a > b)"'), true);
  const prop = ms.find((m) => m.kind === 'template-prop');
  assert.equal(tt.applyMutation(src, prop).includes(':title="undefined"'), true);
  assert.equal(ms.some((m) => src.slice(m.at, m.at + m.len).includes('hidden')), false);
  assert.equal(ms.some((m) => src.slice(m.at, m.at + m.len).startsWith(':key')), false);
});

test('planning: interleave is round-robin and capped', () => {
  const a = [{ file: 'a', at: 1 }, { file: 'a', at: 2 }, { file: 'a', at: 3 }];
  const b = [{ file: 'b', at: 1 }];
  const out = tt.interleave([a, b], 3);
  assert.deepEqual(out.map((m) => `${m.file}${m.at}`), ['a1', 'b1', 'a2']);
});

test('planning: planAll partitions manual mutations per file and ids in order', () => {
  const files = [
    { path: 'a.ts', file: '/r/a.ts', source: 'export const f = (x) => x === 1 && x !== 2;' },
    { path: 'b.ts', file: '/r/b.ts', source: 'export const g = (y) => y || 0;' },
  ];
  const manual = [{ file: 'b.ts', find: 'y || 0', replace: 'y', note: 'drop default' }];
  const ms = tt.planAll(files, { maxMutations: 3, manual });
  assert.equal(ms.length, 3);
  assert.deepEqual(ms.map((m) => m.id), ['M01', 'M02', 'M03']);
  assert.equal(ms[0].file, 'b.ts');
  assert.equal(ms[0].kind, 'manual');
});

test('planning: planAll wires template mutations after manual and before built-in for .vue files', () => {
  const files = [{
    path: 'C.vue',
    file: '/r/C.vue',
    source: '<template>\n  <div v-if="ok" @click="go">x</div>\n</template>\n<script setup lang="ts">const ok = a === b</script>',
  }];
  const manual = [{ file: 'C.vue', find: 'a === b', replace: 'true', note: 'force' }];
  const ms = tt.planAll(files, { maxMutations: 10, manual });
  assert.equal(ms[0].kind, 'manual');
  assert.equal(ms[1].kind.startsWith('template-'), true);
  assert.equal(ms.some((m) => m.kind === 'equality'), true);
  const firstBuiltIn = ms.findIndex((m) => m.kind === 'equality');
  assert.equal(ms.filter((m) => m.kind.startsWith('template-')).every((m) => ms.indexOf(m) < firstBuiltIn), true);
  assert.equal(ms.every((m) => m.file === 'C.vue'), true);
});

test('planning: planAll throws on a manual entry naming an unknown file', () => {
  assert.throws(
    () => tt.planAll(
      [{ path: 'a.ts', file: '/r/a.ts', source: 'export const f = (x) => x === 1;' }],
      { manual: [{ file: 'zzz.ts', find: 'x', replace: 'y' }] },
    ),
    /names a file not in the audited set/,
  );
});

test('planning: manual mutations run first and are never truncated', () => {
  const files = ['a', 'b', 'c'].map((name) => ({ path: `${name}.ts`, file: `/r/${name}.ts`, source: `export const ${name} = (x) => x === 1 && x !== 2;` }));
  const manual = [
    { file: 'c.ts', find: 'x === 1', replace: 'true', note: 'first' },
    { file: 'c.ts', find: 'x !== 2', replace: 'true', note: 'second' },
  ];
  const four = tt.planAll(files, { maxMutations: 4, manual });
  assert.deepEqual(four.slice(0, 2).map((m) => [m.id, m.kind, m.note]), [['M01', 'manual', 'first'], ['M02', 'manual', 'second']]);
  assert.equal(four.length, 4);
  const three = tt.planAll(files, { maxMutations: 2, manual: [...manual, { file: 'c.ts', find: 'export const c', replace: 'export const cc', note: 'third' }] });
  assert.equal(three.length, 3);
  assert.equal(three.every((m) => m.kind === 'manual'), true);
});

test('planning: template no-op replacements are skipped', () => {
  const source = '<template><X :x="undefined" @e="() => {}" /></template>';
  assert.deepEqual(tt.templateMutations('X.vue', source), []);
});

test('attribution: assertion mentioning SyntaxError is a kill', () => {
  const cases = [{ id: '__tests__/x.test.ts::x::1', spec: '__tests__/x.test.ts', name: 'x', line: 1 }];
  const report = { testResults: [{ name: '/repo/__tests__/x.test.ts', assertionResults: [{ title: 'x', location: { line: 1 }, status: 'failed', failureMessages: ['AssertionError: expected [Function] to throw "SyntaxError"'] }] }] };
  assert.equal(tt.attribute(report, cases, '/repo').mutantState, 'killed');
});

test('warnings: fingerprints normalise ansi, tmp paths and digits into one key', () => {
  const err = '\u001b[33m[Vue warn]\u001b[0m: Failed to resolve component: Foo at /tmp/claude-501/x/run-12.json\n[Vue warn]: Failed to resolve component: Foo\n[Vue warn]: Missing required prop: "id"\n';
  const fp = tt.fingerprints(err);
  assert.equal(fp.size, 2);
  assert.equal(fp.get('[Vue warn]: Failed to resolve component: Foo'), 2);
  assert.equal(fp.get('[Vue warn]: Missing required prop: "id"'), 1);

  const numbered = tt.fingerprints('Foo 12 of 40\nFoo 7 of 9\n');
  assert.equal(numbered.size, 1);
  assert.equal(numbered.get('Foo N of N'), 2);

  const tmp = tt.fingerprints('ENOENT: /private/tmp/x/a-1.txt\nENOENT: /tmp/y/b-2.txt\n');
  assert.equal(tmp.size, 1);
  assert.equal(tmp.get('ENOENT: TMP'), 2);
});

test('warnings: firstNewWarning on count increase, null on subset', () => {
  const base = tt.fingerprints('[Vue warn]: Failed to resolve component: Foo\n');
  const more = tt.fingerprints('[Vue warn]: Failed to resolve component: Foo\n[Vue warn]: Failed to resolve component: Foo\n');
  assert.equal(tt.firstNewWarning(base, more), '[Vue warn]: Failed to resolve component: Foo');
  assert.equal(tt.firstNewWarning(more, base), null);
  assert.equal(tt.firstNewWarning(base, tt.fingerprints('[Vue warn]: Failed to resolve component: Foo\n')), null);
  assert.equal(tt.firstNewWarning(new Map(), base), '[Vue warn]: Failed to resolve component: Foo');
});

test('parser: spans for plain, each, tagged each, concurrent; describe.each unsupported', () => {
  const src = readFileSync(join(FIX, 'specs/shapes.spec.txt'), 'utf8');
  const lines = src.split('\n');
  const lineOf = (needle) => lines.findIndex((l) => l.includes(needle)) + 1;
  const plain = tt.findCallSpan(src, lineOf("it('plain'"));
  assert.equal(src.slice(plain.start, plain.end).trim().endsWith('});'), true);
  assert.equal(src.slice(plain.start, plain.end).includes('`a)b`'), true);
  const each = tt.findCallSpan(src, lineOf("it.each([[1], [2]])"));
  assert.equal(src.slice(each.start, each.end).trim().endsWith('})'), true);
  const paren = tt.findCallSpan(src, lineOf("it.each([[Math.max(1, 2)]])"));
  assert.notEqual(paren, null);
  assert.equal(src.slice(paren.start, paren.end).includes('toBe(2)'), true);
  assert.equal(src.slice(paren.start, paren.end).trim().endsWith('})'), true);
  const tagged = tt.findCallSpan(src, lineOf('it.each`'));
  assert.equal(src.slice(tagged.start, tagged.end).includes('toBeLessThan'), true);
  const conc = tt.findCallSpan(src, lineOf("test.concurrent('conc'"));
  assert.equal(src.slice(conc.start, conc.end).includes("expect(1).toBe(1)"), true);
  assert.equal(tt.findCallSpan(src, lineOf("describe.each([[1]])")), null);
  const trimmed = tt.removeSpans(src, [plain, conc]);
  assert.equal(trimmed.includes("it('plain'"), false);
  assert.equal(trimmed.includes("test.concurrent"), false);
  assert.equal(trimmed.includes("it.each([[1], [2]])"), true);
  const withoutParen = tt.removeSpans(src, [paren]);
  assert.equal(withoutParen.includes('paren %i'), false);
  assert.equal(withoutParen.includes('each %i'), true);
});

test('manifest: reconcile restores on mutated hash, drops on original, conflicts otherwise', () => {
  const files = { '/r/a.ts': 'MUT', '/r/b.ts': 'ORIG', '/r/c.ts': 'EDITED', '/r/d.ts': 'EDITED' };
  const h = (s) => tt.sha256(Buffer.from(s));
  const entries = [
    { path: '/r/a.ts', originalHash: h('ORIG'), mutatedHash: h('MUT'), original: 'ORIG' },
    { path: '/r/b.ts', originalHash: h('ORIG'), mutatedHash: h('MUT'), original: 'ORIG' },
    { path: '/r/c.ts', originalHash: h('ORIG'), mutatedHash: h('MUT'), original: 'ORIG' },
    { path: '/r/d.ts', originalHash: h('ORIG'), mutatedHash: null, original: 'ORIG' },
  ];
  const r = tt.reconcile(entries, (p) => Buffer.from(files[p]));
  assert.deepEqual(r.restore.map((e) => e.path), ['/r/a.ts']);
  assert.deepEqual(r.drop.map((e) => e.path), ['/r/b.ts', '/r/d.ts']);
  assert.deepEqual(r.conflict.map((e) => e.path), ['/r/c.ts']);
});

function miniRepo() {
  const root = mkdtempSync(join(tmpdir(), 'tt-unit-'));
  mkdirSync(join(root, '__tests__'));
  writeFileSync(join(root, 'sum.ts'), 'export function sum(a: number, b: number): number {\n  if (a === 0) return b\n  return a + b\n}\n');
  writeFileSync(join(root, '__tests__', 'sum.test.ts'), readFileSync(join(FIX, 'mini', '__tests__', 'sum.test.ts')));
  return root;
}

function fakeRunner(root, perRun) {
  let n = 0;
  return (args, cwd) => {
    if (args[0] === 'list') {
      const list = fixture('reporter/list-mini.json').map((e) => ({ ...e, file: join(root, '__tests__', 'sum.test.ts') }));
      return { status: 0, stdout: JSON.stringify(list), stderr: '' };
    }
    const call = perRun[Math.min(n, perRun.length - 1)];
    n++;
    const out = args.find((a) => a.startsWith('--outputFile=')).slice('--outputFile='.length);
    const report = fixture(call.report);
    for (const f of report.testResults) f.name = join(root, '__tests__', 'sum.test.ts');
    writeFileSync(out, JSON.stringify(report));
    return { status: call.status === undefined ? 0 : call.status, stdout: '', stderr: call.stderr ?? '', signal: call.signal };
  };
}

test('audit: tautology case killed none, real case killed M01, deletion removable', async () => {
  const root = miniRepo();
  try {
    const green = { report: 'reporter/green.json' };
    const r = await tt.audit({ root, feature: '.', maxMutations: 1, run: fakeRunner(root, [green, { report: 'reporter/tautology-m01.json', status: 1 }, green]), log: () => {} });
    assert.equal(r.baseline, 'green');
    assert.equal(r.mutants.length, 1);
    const adds = r.verdicts.find((v) => v.id.endsWith('::sum > adds::4'));
    const taut = r.verdicts.find((v) => v.id.endsWith('::sum > tautology::5'));
    assert.equal(adds.result, 'killed [M01]');
    assert.equal(taut.result, 'killed none of 1 sampled mutants (1 in sum.ts)');
    assert.equal(taut.deletion, 'removable: suite green, no new warnings');
    assert.equal(adds.deletion, 'keep');
    assert.equal(readFileSync(join(root, 'sum.ts'), 'utf8').includes('a === 0'), true);
    assert.equal(readFileSync(join(root, '__tests__', 'sum.test.ts'), 'utf8').includes('tautology'), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('audit: works on an empty TMPDIR', async () => {
  const root = miniRepo();
  const freshTmp = mkdtempSync(join(tmpdir(), 'tt-empty-tmp-'));
  const oldTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = freshTmp;
  const lock = `${tt.manifestDir(root)}.lock`;
  try {
    const green = { report: 'reporter/green.json' };
    const r = await tt.audit({ root, feature: '.', maxMutations: 1, run: fakeRunner(root, [green, { report: 'reporter/tautology-m01.json', status: 1 }, green]), log: () => {} });
    assert.equal(r.baseline, 'green');
    assert.equal(existsSync(lock), false);
  } finally {
    if (oldTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = oldTmpdir;
    rmSync(root, { recursive: true, force: true });
    rmSync(freshTmp, { recursive: true, force: true });
  }
});

test('audit: creates owner-only manifest directories', async () => {
  const root = miniRepo();
  try {
    const green = { report: 'reporter/green.json' };
    await tt.audit({ root, feature: '.', maxMutations: 1, run: fakeRunner(root, [green, { report: 'reporter/tautology-m01.json', status: 1 }, green]), log: () => {} });
    const dir = tt.manifestDir(root);
    assert.equal(statSync(dirname(dir)).mode & 0o777, 0o700);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(tt.manifestDir(root), { recursive: true, force: true }); }
});

test('audit: reports that ownership checks require a POSIX platform', async () => {
  const root = miniRepo();
  const getuid = process.getuid;
  process.getuid = undefined;
  try {
    await assert.rejects(
      () => tt.audit({ root, feature: '.', run: fakeRunner(root, []), log: () => {} }),
      (error) => error.code === 3
        && error.message === `unsafe manifest directory ${dirname(tt.manifestDir(root))}: ownership cannot be checked on this platform (POSIX only)`,
    );
  } finally {
    process.getuid = getuid;
    rmSync(root, { recursive: true, force: true });
    rmSync(dirname(tt.manifestDir(root)), { recursive: true, force: true });
  }
});

test('audit: refuses an unsafe manifest directory without restoring its named file', async () => {
  const root = miniRepo();
  const dir = tt.manifestDir(root);
  const target = join(root, 'sum.ts');
  const edited = Buffer.from('do not overwrite me');
  try {
    mkdirSync(join(dir, 'originals'), { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o755);
    writeFileSync(join(dir, 'originals', 'k'), 'attacker bytes');
    writeFileSync(target, edited);
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ entries: [{ path: target, key: 'k', originalHash: tt.sha256(Buffer.from('original')), mutatedHash: tt.sha256(edited) }] }));

    await assert.rejects(
      () => tt.audit({ root, feature: '.', run: fakeRunner(root, []), log: () => {} }),
      (error) => error.code === 3 && /unsafe manifest directory/.test(error.message),
    );
    assert.deepEqual(readFileSync(target), edited);
  } finally { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});

test('audit: treats a restorable manifest entry outside the root as a conflict', async () => {
  const root = miniRepo();
  const elsewhere = mkdtempSync(join(tmpdir(), 'tt-elsewhere-'));
  const outside = join(elsewhere, 'outside.ts');
  const dir = tt.manifestDir(root);
  const current = Buffer.from('outside current');
  try {
    mkdirSync(join(dir, 'originals'), { recursive: true, mode: 0o700 });
    writeFileSync(outside, current);
    writeFileSync(join(dir, 'originals', 'k'), 'outside original');
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ entries: [{ path: outside, key: 'k', originalHash: tt.sha256(Buffer.from('outside original')), mutatedHash: tt.sha256(current) }] }));

    await assert.rejects(
      () => tt.audit({ root, feature: '.', run: fakeRunner(root, []), log: () => {} }),
      (error) => error.code === 3 && /manifest conflict/.test(error.message),
    );
    assert.deepEqual(readFileSync(outside), current);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); rmSync(elsewhere, { recursive: true, force: true }); }
});

test('audit: runtime failures appear on case and mutant rows', async () => {
  const root = miniRepo();
  try {
    const r = await tt.audit({ root, feature: '.', maxMutations: 1, run: fakeRunner(root, [{ report: 'reporter/green.json' }, { report: 'reporter/runtime-m01.json', status: 1 }]), log: () => {} });
    const adds = r.verdicts.find((v) => v.name.endsWith('adds'));
    assert.equal(adds.result, 'killed none of 1 sampled mutants (1 in sum.ts); runtime failure on [M01]');
    assert.equal(adds.deletion, 'not verified: runtime failure on [M01]');
    assert.equal(r.mutants[0].state, 'survived (runtime failure in 1 cases)');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(tt.manifestDir(root), { recursive: true, force: true }); }
});

test('audit: orphan zero-kill case reports zero mapped mutants and is not verified', async () => {
  const root = miniRepo();
  const orphan = join(root, '__tests__', 'orphan.test.ts');
  writeFileSync(orphan, "import { it } from 'vitest'\nit('orphan', () => {})\n");
  let runNo = 0;
  const run = (args) => {
    if (args[0] === 'list') return { status: 0, stdout: JSON.stringify([{ file: orphan, name: 'orphan', location: { line: 2 } }]), stderr: '' };
    const out = args.find((a) => a.startsWith('--outputFile=')).slice(13);
    writeFileSync(out, JSON.stringify({ numFailedTests: 0, numPassedTests: 1, testResults: [{ name: orphan, status: 'passed', assertionResults: [{ title: 'orphan', location: { line: 2 }, status: 'passed', failureMessages: [] }] }] }));
    runNo++;
    return { status: 0, stdout: '', stderr: '' };
  };
  try {
    const r = await tt.audit({ root, feature: '.', maxMutations: 1, run, log: () => {} });
    const v = r.verdicts[0];
    assert.equal(v.result, 'killed none of 1 sampled mutants (0 in mapped impl)');
    assert.equal(v.deletion, 'not verified: no impl mapped');
    assert.equal(runNo, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('audit: feature filter is repo-relative with slash, and root or its absolute path has no filter', async () => {
  for (const featureKind of ['src/x', '.', 'absolute-root']) {
    const root = miniRepo();
    const feature = featureKind === 'absolute-root' ? root : featureKind;
    const featureDir = feature === 'src/x' ? join(root, feature) : root;
    if (feature === 'src/x') {
      mkdirSync(join(featureDir, '__tests__'), { recursive: true });
      writeFileSync(join(featureDir, 'sum.ts'), readFileSync(join(root, 'sum.ts')));
      writeFileSync(join(featureDir, '__tests__', 'sum.test.ts'), readFileSync(join(root, '__tests__', 'sum.test.ts')));
    }
    const calls = [];
    const inner = fakeRunner(featureDir, [{ report: 'reporter/green.json' }, { report: 'reporter/tautology-m01.json', status: 1 }, { report: 'reporter/green.json' }]);
    try {
      await tt.audit({ root, feature, maxMutations: 1, run: (args, cwd) => { calls.push(args); return inner(args, cwd); }, log: () => {} });
      for (const args of calls) assert.equal(args[1], feature === 'src/x' ? 'src/x/' : '--root');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('audit: rejects a feature outside the root', async () => {
  const root = miniRepo();
  const elsewhere = mkdtempSync(join(tmpdir(), 'tt-feature-'));
  try {
    await assert.rejects(
      () => tt.audit({ root, feature: elsewhere, run: fakeRunner(root, []), log: () => {} }),
      (error) => error.code === 3 && error.message === '--feature must be inside --root',
    );
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(elsewhere, { recursive: true, force: true }); }
});

test('discovery: walk skips directory symlinks that leave the root', () => {
  const root = mkdtempSync(join(tmpdir(), 'tt-walk-root-'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'tt-walk-elsewhere-'));
  try {
    writeFileSync(join(elsewhere, 'outside.test.ts'), 'outside');
    symlinkSync(elsewhere, join(root, 'linked'));
    assert.deepEqual(tt.walk(root, (path) => path.endsWith('.test.ts')), []);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(elsewhere, { recursive: true, force: true }); }
});

test('discovery: walk skips dangling symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'tt-walk-dangling-'));
  try {
    symlinkSync(join(root, 'missing'), join(root, 'dangling'));
    writeFileSync(join(root, 'inside.test.ts'), 'inside');
    assert.deepEqual(tt.walk(root, (path) => path.endsWith('.test.ts')), [join(root, 'inside.test.ts')]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('discovery: walk visits a real directory only once through cyclic symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'tt-walk-cycle-'));
  const feature = join(root, 'feature');
  mkdirSync(feature);
  try {
    writeFileSync(join(feature, 'inside.test.ts'), 'inside');
    symlinkSync('..', join(feature, 'a'));
    assert.deepEqual(
      tt.walk(feature, (path) => path.endsWith('.test.ts'), [], realpathSync(root)),
      [join(feature, 'inside.test.ts')],
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('audit: SIGKILL timeout is caught unattributed', async () => {
  const root = miniRepo();
  try {
    const r = await tt.audit({ root, feature: '.', maxMutations: 1, run: fakeRunner(root, [{ report: 'reporter/green.json' }, { report: 'reporter/green.json', status: null, signal: 'SIGKILL' }, { report: 'reporter/green.json' }]), log: () => {} });
    assert.equal(r.mutants[0].state, 'caught, unattributed');
    assert.equal(r.verdicts.every((v) => v.deletion === 'not verified: no valid mutants on sum.ts'), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('audit: SIGKILL without reporter output is caught unattributed and defaultRun enforces its timeout', async () => {
  const root = miniRepo();
  let calls = 0;
  const inner = fakeRunner(root, [{ report: 'reporter/green.json' }]);
  const run = (args, cwd) => {
    if (args[0] === 'list' || calls++ === 0) return inner(args, cwd);
    return { status: null, stdout: '', stderr: '', signal: 'SIGKILL' };
  };
  try {
    const r = await tt.audit({ root, feature: '.', maxMutations: 1, run, log: () => {} });
    assert.equal(r.mutants[0].state, 'caught, unattributed');
    assert.match(r.verdicts[0].result, /0 sampled mutants/);
    assert.equal(r.verdicts[0].deletion, 'not verified: no valid mutants on sum.ts');
  } finally { rmSync(root, { recursive: true, force: true }); }

  const started = Date.now();
  const timed = tt.defaultRun('/bin/sleep', 200)(['5'], '/');
  assert.equal(timed.signal, 'SIGKILL');
  assert.equal(Date.now() - started < 3000, true);
});

test('audit: kills stay keep despite later runtime failures or no mapped implementation', async () => {
  const root = miniRepo();
  try {
    const r = await tt.audit({ root, feature: '.', maxMutations: 2, run: fakeRunner(root, [
      { report: 'reporter/green.json' },
      { report: 'reporter/tautology-m01.json', status: 1 },
      { report: 'reporter/runtime-m01.json', status: 1 },
    ]), log: () => {} });
    const adds = r.verdicts.find((v) => v.name.endsWith('adds'));
    assert.equal(adds.result, 'killed [M01]');
    assert.equal(adds.deletion, 'keep');
  } finally { rmSync(root, { recursive: true, force: true }); }

  const orphanRoot = miniRepo();
  const orphan = join(orphanRoot, '__tests__', 'orphan.test.ts');
  writeFileSync(orphan, "import { it } from 'vitest'\nit('orphan', () => {})\n");
  let n = 0;
  const run = (args) => {
    if (args[0] === 'list') return { status: 0, stdout: JSON.stringify([{ file: orphan, name: 'orphan', location: { line: 2 } }]), stderr: '' };
    const out = args.find((a) => a.startsWith('--outputFile=')).slice(13);
    const killed = n++ === 1;
    writeFileSync(out, JSON.stringify({ numFailedTests: killed ? 1 : 0, numPassedTests: killed ? 0 : 1, testResults: [{ name: orphan, status: killed ? 'failed' : 'passed', assertionResults: [{ title: 'orphan', location: { line: 2 }, status: killed ? 'failed' : 'passed', failureMessages: killed ? ['AssertionError: boom'] : [] }] }] }));
    return { status: killed ? 1 : 0, stdout: '', stderr: '' };
  };
  try {
    const r = await tt.audit({ root: orphanRoot, feature: '.', maxMutations: 1, run, log: () => {} });
    assert.equal(r.verdicts[0].result, 'killed [M01]');
    assert.equal(r.verdicts[0].deletion, 'keep');
  } finally { rmSync(orphanRoot, { recursive: true, force: true }); }
});

test('audit: trimmed run without reporter output is not removable even on exit zero', async () => {
  const root = miniRepo();
  let calls = 0;
  const inner = fakeRunner(root, [{ report: 'reporter/green.json' }, { report: 'reporter/tautology-m01.json', status: 1 }]);
  const run = (args, cwd) => {
    if (args[0] === 'list' || calls++ < 2) return inner(args, cwd);
    return { status: 0, stdout: '', stderr: '' };
  };
  try {
    const r = await tt.audit({ root, feature: '.', maxMutations: 1, run, log: () => {} });
    assert.equal(r.verdicts.find((v) => v.name.endsWith('tautology')).deletion, 'not removable: no reporter output (vitest exit 0)');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('audit: a timed-out trimmed run is not removable with the configured duration', async () => {
  const root = miniRepo();
  let calls = 0;
  const inner = fakeRunner(root, [{ report: 'reporter/green.json' }, { report: 'reporter/tautology-m01.json', status: 1 }]);
  const run = (args, cwd) => {
    if (args[0] === 'list' || calls++ < 2) return inner(args, cwd);
    return { status: null, stdout: '', stderr: '', signal: 'SIGKILL' };
  };
  try {
    const r = await tt.audit({ root, feature: '.', maxMutations: 1, timeoutMs: 321, run, log: () => {} });
    assert.equal(r.verdicts.find((v) => v.name.endsWith('tautology')).deletion, 'not removable: timed out after 321 ms');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('audit: a baseline edit is detected before the first mutant write', async () => {
  const root = miniRepo();
  const sum = join(root, 'sum.ts');
  const inner = fakeRunner(root, [{ report: 'reporter/green.json' }]);
  let runs = 0;
  const run = (args, cwd) => {
    const r = inner(args, cwd);
    if (args[0] === 'run' && runs++ === 0) writeFileSync(sum, readFileSync(sum, 'utf8') + '// appended\n');
    return r;
  };
  try {
    await assert.rejects(() => tt.audit({ root, feature: '.', maxMutations: 1, run, log: () => {} }), (e) => e.code === 3 && /concurrent edit/.test(e.message));
    assert.match(readFileSync(sum, 'utf8'), /\/\/ appended\n$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('audit: a mutant-run spec edit is detected before the trimmed write', async () => {
  const root = miniRepo();
  const spec = join(root, '__tests__', 'sum.test.ts');
  const inner = fakeRunner(root, [{ report: 'reporter/green.json' }, { report: 'reporter/tautology-m01.json', status: 1 }]);
  let runs = 0;
  const run = (args, cwd) => {
    const r = inner(args, cwd);
    if (args[0] === 'run' && ++runs === 2) writeFileSync(spec, readFileSync(spec, 'utf8') + '// user edit\n');
    return r;
  };
  try {
    await assert.rejects(
      () => tt.audit({ root, feature: '.', maxMutations: 1, run, log: () => {} }),
      (e) => e.code === 3 && /concurrent edit/.test(e.message),
    );
    assert.match(readFileSync(spec, 'utf8'), /\/\/ user edit\n$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('audit: no valid mutants skips deletion verification', async () => {
  const root = miniRepo();
  let runCalls = 0;
  const inner = fakeRunner(root, [{ report: 'reporter/green.json' }]);
  const run = (args, cwd) => {
    if (args[0] === 'list') return inner(args, cwd);
    if (runCalls++ === 0) return inner(args, cwd);
    return { status: 1, stdout: '', stderr: '' };
  };
  try {
    const r = await tt.audit({ root, feature: '.', maxMutations: 1, run, log: () => {} });
    assert.equal(runCalls, 2);
    assert.equal(r.verdicts.every((v) => v.deletion === 'not verified: no valid mutants on sum.ts'), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('audit: a mapped implementation without a valid mutant is never offered for removal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tt-two-impls-'));
  const tests = join(root, '__tests__');
  mkdirSync(tests);
  const aSpec = join(tests, 'a.test.ts');
  const bSpec = join(tests, 'b.test.ts');
  writeFileSync(join(root, 'a.ts'), 'export const a = (x: number) => x === 1\n');
  writeFileSync(join(root, 'b.ts'), 'export const b = (x: number) => x === 2\n');
  writeFileSync(aSpec, "it('a', () => {})\n");
  writeFileSync(bSpec, "it('b', () => {})\n");
  const listed = [
    { file: aSpec, name: 'a', location: { line: 1 } },
    { file: bSpec, name: 'b', location: { line: 1 } },
  ];
  let runNo = 0;
  const run = (args) => {
    if (args[0] === 'list') return { status: 0, stdout: JSON.stringify(listed), stderr: '' };
    const mutant = runNo++ === 1;
    const out = args.find((arg) => arg.startsWith('--outputFile=')).slice(13);
    writeFileSync(out, JSON.stringify({
      numFailedTests: mutant ? 1 : 0,
      numPassedTests: mutant ? 1 : 2,
      testResults: [
        { name: aSpec, status: mutant ? 'failed' : 'passed', assertionResults: [{ title: 'a', location: { line: 1 }, status: mutant ? 'failed' : 'passed', failureMessages: mutant ? ['AssertionError: boom'] : [] }] },
        { name: bSpec, status: 'passed', assertionResults: [{ title: 'b', location: { line: 1 }, status: 'passed', failureMessages: [] }] },
      ],
    }));
    return { status: mutant ? 1 : 0, stdout: '', stderr: '' };
  };
  try {
    const result = await tt.audit({ root, feature: '.', maxMutations: 1, run, log: () => {} });
    const b = result.verdicts.find((verdict) => verdict.name === 'b');
    assert.equal(b.result, 'killed none of 1 sampled mutants (0 in b.ts)');
    assert.equal(b.deletion, 'not verified: no valid mutants on b.ts');
    assert.equal(runNo, 2);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(tt.manifestDir(root), { recursive: true, force: true }); }
});

test('audit: listed cases absent from the baseline report are quarantined', async () => {
  const root = miniRepo();
  const logs = [];
  const inner = fakeRunner(root, [
    { report: 'reporter/green.json' },
    { report: 'reporter/tautology-m01.json', status: 1 },
    { report: 'reporter/green.json' },
  ]);
  const run = (args, cwd) => {
    if (args[0] === 'list') {
      const base = JSON.parse(inner(args, cwd).stdout);
      base.push({ file: join(root, '__tests__', 'sum.test.ts'), name: 'sum > never reported', location: { line: 99 } });
      return { status: 0, stdout: JSON.stringify(base), stderr: '' };
    }
    return inner(args, cwd);
  };
  try {
    const result = await tt.audit({ root, feature: '.', maxMutations: 1, run, log: (message) => logs.push(message) });
    const missing = result.verdicts.find((verdict) => verdict.name === 'sum > never reported');
    assert.equal(missing.result, 'not matched in reporter output');
    assert.equal(missing.deletion, 'not verified: not matched in reporter output');
    assert.deepEqual(logs.filter((message) => /listed cases not matched/.test(message)), ['test-teeth: 1 listed cases not matched in reporter output']);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(tt.manifestDir(root), { recursive: true, force: true }); }
});

test('audit: an unmatched case in a shared each span keeps its quarantine reason', async () => {
  const root = miniRepo();
  const spec = join(root, '__tests__', 'sum.test.ts');
  writeFileSync(spec, "import { it } from 'vitest'\nit.each([[1], [2]])('row %i', () => {})\n");
  const listed = [
    { file: spec, name: 'row 1', location: { line: 2 } },
    { file: spec, name: 'row 2', location: { line: 2 } },
  ];
  let runNo = 0;
  const run = (args) => {
    if (args[0] === 'list') return { status: 0, stdout: JSON.stringify(listed), stderr: '' };
    const out = args.find((arg) => arg.startsWith('--outputFile=')).slice('--outputFile='.length);
    writeFileSync(out, JSON.stringify({
      numFailedTests: 0,
      numPassedTests: 1,
      testResults: [{
        name: spec,
        status: 'passed',
        assertionResults: [{ title: 'row 1', location: { line: 2 }, status: 'passed', failureMessages: [] }],
      }],
    }));
    runNo++;
    return { status: 0, stdout: '', stderr: '' };
  };
  try {
    const result = await tt.audit({ root, feature: '.', maxMutations: 1, run, log: () => {} });
    assert.equal(
      result.verdicts.find((verdict) => verdict.name === 'row 2').deletion,
      'not verified: not matched in reporter output',
    );
    assert.equal(runNo, 2);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(tt.manifestDir(root), { recursive: true, force: true }); }
});

test('audit: detects a spec edit after every case killed the mutant', async () => {
  const root = miniRepo();
  const spec = join(root, '__tests__', 'sum.test.ts');
  const inner = fakeRunner(root, [{ report: 'reporter/green.json' }]);
  let runNo = 0;
  const run = (args, cwd) => {
    if (args[0] === 'list' || runNo++ === 0) return inner(args, cwd);
    const out = args.find((arg) => arg.startsWith('--outputFile=')).slice(13);
    const report = fixture('reporter/tautology-m01.json');
    report.testResults[0].name = spec;
    for (const assertion of report.testResults[0].assertionResults) {
      assertion.status = 'failed';
      assertion.failureMessages = ['AssertionError: boom'];
    }
    report.numFailedTests = 2;
    report.numPassedTests = 0;
    writeFileSync(out, JSON.stringify(report));
    writeFileSync(spec, readFileSync(spec, 'utf8') + '// concurrent edit\n');
    return { status: 1, stdout: '', stderr: '' };
  };
  try {
    await assert.rejects(
      () => tt.audit({ root, feature: '.', maxMutations: 1, run, log: () => {} }),
      (error) => error.code === 3 && /concurrent edit: .*sum\.test\.ts changed during the audit/.test(error.message),
    );
    assert.match(readFileSync(spec, 'utf8'), /\/\/ concurrent edit\n$/);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(tt.manifestDir(root), { recursive: true, force: true }); }
});

test('audit: no mutants planned skips deletion verification with a distinct reason', async () => {
  const root = miniRepo();
  writeFileSync(join(root, 'sum.ts'), 'export const x = 1\n');
  let runCalls = 0;
  const run = fakeRunner(root, [{ report: 'reporter/green.json' }]);
  try {
    const r = await tt.audit({ root, feature: '.', maxMutations: 1, run: (args, cwd) => {
      if (args[0] === 'run') runCalls++;
      return run(args, cwd);
    }, log: () => {} });
    assert.equal(r.mutants.length, 0);
    assert.equal(runCalls, 1);
    assert.equal(r.verdicts.every((v) => v.deletion === 'not verified: no mutants planned'), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('audit: distinct tests sharing one source line are not trimmed', async () => {
  const root = miniRepo();
  const spec = join(root, '__tests__', 'sum.test.ts');
  writeFileSync(spec, "import { it } from 'vitest'\nit('a', () => {}); it('b', () => {})\n");
  const listed = [{ file: spec, name: 'a', location: { line: 2 } }, { file: spec, name: 'b', location: { line: 2 } }];
  let runs = 0;
  const run = (args) => {
    if (args[0] === 'list') return { status: 0, stdout: JSON.stringify(listed), stderr: '' };
    const out = args.find((a) => a.startsWith('--outputFile=')).slice(13);
    writeFileSync(out, JSON.stringify({ numFailedTests: 0, numPassedTests: 2, testResults: [{ name: spec, status: 'passed', assertionResults: listed.map((c) => ({ title: c.name, location: c.location, status: 'passed', failureMessages: [] })) }] }));
    runs++;
    return { status: 0, stdout: '', stderr: '' };
  };
  try {
    const r = await tt.audit({ root, feature: '.', maxMutations: 1, run, log: () => {} });
    assert.equal(r.verdicts.every((v) => v.deletion === 'not verified: shared call line'), true);
    assert.equal(runs, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('audit: missing or bad mutant JSON is invalid; unattributed nonzero exit is caught', async () => {
  for (const mode of ['missing', 'unparseable', 'exit']) {
    const root = miniRepo();
    let n = 0;
    const inner = fakeRunner(root, [{ report: 'reporter/green.json' }, { report: 'reporter/green.json' }, { report: 'reporter/green.json' }]);
    const run = (args, cwd) => {
      if (args[0] === 'list' || n++ !== 1) return inner(args, cwd);
      if (mode === 'missing') return { status: 1, stdout: '', stderr: '' };
      if (mode === 'unparseable') {
        const out = args.find((a) => a.startsWith('--outputFile=')).slice(13);
        writeFileSync(out, '{bad');
        return { status: 1, stdout: '', stderr: '' };
      }
      const r = inner(args, cwd); return { ...r, status: 1 };
    };
    try {
      const r = await tt.audit({ root, feature: '.', maxMutations: 1, run, log: () => {} });
      assert.equal(r.mutants[0].state, mode === 'exit' ? 'caught, unattributed' : 'invalid');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('audit: every vitest call carries --no-cache', async () => {
  const root = miniRepo();
  const calls = [];
  try {
    const green = { report: 'reporter/green.json' };
    const inner = fakeRunner(root, [green, { report: 'reporter/tautology-m01.json', status: 1 }, green]);
    const run = (args, cwd) => {
      calls.push(args);
      return inner(args, cwd);
    };

    await tt.audit({ root, feature: '.', maxMutations: 1, run, log: () => {} });

    assert.equal(calls.length, 4);
    assert.equal(calls.some((args) => args[0] === 'list'), true);
    assert.equal(calls.every((args) => args.includes('--no-cache')), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('audit: manifest records the trimmed spec hash during the trimmed run', async () => {
  const root = miniRepo();
  let recordedMutatedHash;
  let recordedDiskHash;
  try {
    const green = { report: 'reporter/green.json' };
    const perRun = [green, { report: 'reporter/tautology-m01.json', status: 1 }, green];
    let n = 0;
    const run = (args, cwd) => {
      if (args[0] === 'list') {
        const list = fixture('reporter/list-mini.json').map((e) => ({ ...e, file: join(root, '__tests__', 'sum.test.ts') }));
        return { status: 0, stdout: JSON.stringify(list), stderr: '' };
      }
      const call = perRun[Math.min(n, perRun.length - 1)];
      n++;
      if (n === 3) {
        const spec = join(root, '__tests__', 'sum.test.ts');
        const manifest = JSON.parse(readFileSync(join(tt.manifestDir(root), 'manifest.json'), 'utf8'));
        const entry = manifest.entries.find((e) => e.path === spec);
        recordedMutatedHash = entry.mutatedHash;
        recordedDiskHash = tt.sha256(readFileSync(spec));
      }
      const out = args.find((a) => a.startsWith('--outputFile=')).slice('--outputFile='.length);
      const report = fixture(call.report);
      for (const f of report.testResults) f.name = join(root, '__tests__', 'sum.test.ts');
      writeFileSync(out, JSON.stringify(report));
      return { status: call.status ?? 0, stdout: '', stderr: call.stderr ?? '' };
    };

    await tt.audit({ root, feature: '.', maxMutations: 1, run, log: () => {} });

    assert.equal(typeof recordedMutatedHash, 'string');
    assert.notEqual(recordedMutatedHash, null);
    assert.equal(recordedMutatedHash, recordedDiskHash);
    assert.notEqual(recordedMutatedHash, tt.sha256(readFileSync(join(FIX, 'mini', '__tests__', 'sum.test.ts'))));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('audit: red baseline stops with code 2', async () => {
  const root = miniRepo();
  try {
    await assert.rejects(
      () => tt.audit({ root, feature: '.', maxMutations: 1, run: fakeRunner(root, [{ report: 'reporter/tautology-m01.json', status: 1 }]), log: () => {} }),
      (e) => e.code === 2 && /baseline not green/.test(e.message),
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('audit: deletion not removable when the trimmed run fails, named by reporter title', async () => {
  const root = miniRepo();
  try {
    const green = { report: 'reporter/green.json' };
    const r = await tt.audit({ root, feature: '.', maxMutations: 1, run: fakeRunner(root, [green, { report: 'reporter/tautology-m01.json', status: 1 }, { report: 'reporter/tautology-m01.json', status: 1 }]), log: () => {} });
    const taut = r.verdicts.find((v) => v.id.endsWith('::sum > tautology::5'));
    assert.equal(taut.deletion, 'not removable: sum > adds');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('audit: duplicate identity is excluded from deletion and runs no trimmed suite', async () => {
  const root = miniRepo();
  try {
    const green = { report: 'reporter/green.json' };
    const inner = fakeRunner(root, [green, { report: 'reporter/tautology-m01.json', status: 1 }, green]);
    let runCalls = 0;
    const run = (args, cwd) => {
      if (args[0] === 'list') {
        const list = fixture('reporter/list-mini.json').map((e) => ({ ...e, file: join(root, '__tests__', 'sum.test.ts') }));
        return { status: 0, stdout: JSON.stringify([...list, list[1]]), stderr: '' };
      }
      runCalls++;
      return inner(args, cwd);
    };
    const r = await tt.audit({ root, feature: '.', maxMutations: 1, run, log: () => {} });
    const dups = r.verdicts.filter((v) => v.id.endsWith('::sum > tautology::5'));
    assert.equal(dups.length, 2);
    assert.equal(dups[0].deletion, 'not verified: duplicate identity');
    assert.equal(runCalls, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('audit: deletion not removable when the trimmed run adds a warning', async () => {
  const root = miniRepo();
  try {
    const green = { report: 'reporter/green.json' };
    const warn = { report: 'reporter/green.json', stderr: '[Vue warn]: Failed to resolve component: Foo\n' };
    const r = await tt.audit({ root, feature: '.', maxMutations: 1, run: fakeRunner(root, [green, { report: 'reporter/tautology-m01.json', status: 1 }, warn]), log: () => {} });
    const taut = r.verdicts.find((v) => v.id.endsWith('::sum > tautology::5'));
    assert.equal(taut.deletion, 'not removable: [Vue warn]: Failed to resolve component: Foo');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('audit: recover restores a file left mutated by an earlier run', async () => {
  const root = miniRepo();
  const dir = tt.manifestDir(root);
  const originalBytes = readFileSync(join(FIX, 'mini', 'sum.ts'));
  const logs = [];
  try {
    mkdirSync(join(dir, 'originals'), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'originals', 'k1'), originalBytes);
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ entries: [{
      path: join(root, 'sum.ts'),
      key: 'k1',
      originalHash: tt.sha256(originalBytes),
      mutatedHash: tt.sha256(Buffer.from('MUTANT')),
    }] }));
    writeFileSync(join(root, 'sum.ts'), 'MUTANT');

    const green = { report: 'reporter/green.json' };
    const r = await tt.audit({
      root,
      feature: '.',
      maxMutations: 1,
      run: fakeRunner(root, [green, { report: 'reporter/tautology-m01.json', status: 1 }, green]),
      log: (message) => logs.push(message),
    });

    assert.deepEqual(readFileSync(join(root, 'sum.ts')), originalBytes);
    assert.equal(logs.some((line) => /restored .*sum\.ts from manifest/.test(line)), true);
    assert.equal(r.baseline, 'green');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('audit: recovery runs before the vitest binary check', async () => {
  const root = miniRepo();
  const dir = tt.manifestDir(root);
  const original = readFileSync(join(root, 'sum.ts'));
  try {
    mkdirSync(join(dir, 'originals'), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'originals', 'k'), original);
    writeFileSync(join(root, 'sum.ts'), 'MUTANT');
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ entries: [{ path: join(root, 'sum.ts'), key: 'k', originalHash: tt.sha256(original), mutatedHash: tt.sha256(Buffer.from('MUTANT')) }] }));
    await assert.rejects(() => tt.audit({ root, feature: '.', vitestBin: '/nonexistent', log: () => {} }), /vitest not found/);
    assert.deepEqual(readFileSync(join(root, 'sum.ts')), original);
    assert.equal(existsSync(`${dir}.lock`), false);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); rmSync(`${dir}.lock`, { force: true }); }
});

test('audit: recover throws code 3 on a conflicting edit', async () => {
  const root = miniRepo();
  const dir = tt.manifestDir(root);
  const originalBytes = readFileSync(join(FIX, 'mini', 'sum.ts'));
  try {
    mkdirSync(join(dir, 'originals'), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'originals', 'k1'), originalBytes);
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ entries: [{
      path: join(root, 'sum.ts'),
      key: 'k1',
      originalHash: tt.sha256(originalBytes),
      mutatedHash: tt.sha256(Buffer.from('MUTANT')),
    }] }));
    writeFileSync(join(root, 'sum.ts'), 'EDITED');

    await assert.rejects(
      () => tt.audit({ root, feature: '.', maxMutations: 1, run: fakeRunner(root, []), log: () => {} }),
      (e) => e.code === 3 && /manifest conflict/.test(e.message),
    );
    assert.equal(readFileSync(join(root, 'sum.ts'), 'utf8'), 'EDITED');
    assert.equal(readFileSync(join(dir, 'manifest.json'), 'utf8').length > 0, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('recover restores safe entries before reporting conflicts and keeps only conflicts', () => {
  const root = miniRepo();
  const dir = tt.manifestDir(root);
  const a = join(root, 'sum.ts');
  const b = join(root, 'other.ts');
  const originalA = readFileSync(a);
  const originalB = Buffer.from('ORIGINAL');
  writeFileSync(b, 'EDITED');
  mkdirSync(join(dir, 'originals'), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'originals', 'a'), originalA);
  writeFileSync(join(dir, 'originals', 'b'), originalB);
  writeFileSync(a, 'MUTANT');
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ entries: [
    { path: a, key: 'a', originalHash: tt.sha256(originalA), mutatedHash: tt.sha256(Buffer.from('MUTANT')) },
    { path: b, key: 'b', originalHash: tt.sha256(originalB), mutatedHash: tt.sha256(Buffer.from('MUTANT')) },
  ] }));
  try {
    assert.throws(() => tt.recover(root, () => {}), (e) => e.code === 3);
    assert.deepEqual(readFileSync(a), originalA);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'manifest.json'))).entries.map((e) => e.path), [b]);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); }
});

test('audit: concurrent edit is preserved with manifest and code 3', async () => {
  const root = miniRepo();
  const dir = tt.manifestDir(root);
  const inner = fakeRunner(root, [{ report: 'reporter/green.json' }, { report: 'reporter/green.json' }]);
  let runs = 0;
  const run = (args, cwd) => {
    const r = inner(args, cwd);
    if (args[0] === 'run' && ++runs === 2) writeFileSync(join(root, 'sum.ts'), 'EDITED');
    return r;
  };
  try {
    await assert.rejects(() => tt.audit({ root, feature: '.', maxMutations: 1, run, log: () => {} }), (e) => e.code === 3 && /concurrent edit/.test(e.message));
    assert.equal(readFileSync(join(root, 'sum.ts'), 'utf8'), 'EDITED');
    assert.equal(existsSync(join(dir, 'manifest.json')), true);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'manifest.json'))).entries.map((e) => e.path), [join(root, 'sum.ts')]);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); }
});

test('audit: live lock blocks recovery; stale lock permits recovery and successful audits release it', async () => {
  for (const pid of [process.pid, 999999]) {
    const root = miniRepo();
    const dir = tt.manifestDir(root);
    const lock = `${dir}.lock`;
    const original = readFileSync(join(root, 'sum.ts'));
    mkdirSync(join(dir, 'originals'), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'originals', 'k'), original);
    writeFileSync(join(root, 'sum.ts'), 'MUTANT');
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ entries: [{ path: join(root, 'sum.ts'), key: 'k', originalHash: tt.sha256(original), mutatedHash: tt.sha256(Buffer.from('MUTANT')) }] }));
    writeFileSync(lock, String(pid));
    try {
      const promise = tt.audit({ root, feature: '.', maxMutations: 1, run: fakeRunner(root, [{ report: 'reporter/green.json' }, { report: 'reporter/tautology-m01.json', status: 1 }, { report: 'reporter/green.json' }]), log: () => {} });
      if (pid === process.pid) {
        await assert.rejects(() => promise, (e) => e.code === 3 && e.message === `another audit is running on this root (pid ${pid})`);
        assert.equal(readFileSync(join(root, 'sum.ts'), 'utf8'), 'MUTANT');
        assert.equal(existsSync(join(dir, 'manifest.json')), true);
      } else {
        assert.equal((await promise).baseline, 'green');
        assert.deepEqual(readFileSync(join(root, 'sum.ts')), original);
        assert.equal(existsSync(lock), false);
      }
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); rmSync(lock, { force: true }); }
  }
});

test('audit: an empty lock file is held until the user removes it', async () => {
  const root = miniRepo();
  const lock = `${tt.manifestDir(root)}.lock`;
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  writeFileSync(lock, '');
  try {
    await assert.rejects(
      () => tt.audit({ root, feature: '.', maxMutations: 1, run: fakeRunner(root, []), log: () => {} }),
      (e) => e.code === 3 && e.message === `lock file ${lock} has no PID; if no audit is running, delete it and rerun`,
    );
    assert.equal(existsSync(lock), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(tt.manifestDir(root), { recursive: true, force: true });
    rmSync(lock, { force: true });
  }
});

test('audit: logs manifest recovery hint once', async () => {
  const root = miniRepo();
  const logs = [];
  try {
    await tt.audit({ root, feature: '.', maxMutations: 1, run: fakeRunner(root, [{ report: 'reporter/green.json' }, { report: 'reporter/tautology-m01.json', status: 1 }, { report: 'reporter/green.json' }]), log: (s) => logs.push(s) });
    assert.equal(logs.filter((s) => s.startsWith('test-teeth: manifest at ')).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('audit: logs once when manual mutations exceed the budget', async () => {
  const root = miniRepo();
  const logs = [];
  const manual = [
    { file: 'sum.ts', find: 'a === 0', replace: 'false', note: 'one' },
    { file: 'sum.ts', find: 'a + b', replace: 'a - b', note: 'two' },
  ];
  try {
    await tt.audit({ root, feature: '.', maxMutations: 1, manual, run: fakeRunner(root, [{ report: 'reporter/green.json' }, { report: 'reporter/green.json' }, { report: 'reporter/green.json' }, { report: 'reporter/green.json' }]), log: (s) => logs.push(s) });
    assert.deepEqual(logs.filter((s) => s.startsWith('--mutations has')), ['--mutations has 2 entries, more than --max-mutations 1; all 2 run']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('audit: vitest list failures are code 3', async () => {
  const root = miniRepo();
  try {
    await assert.rejects(() => tt.audit({ root, feature: '.', run: () => ({ status: 1, stdout: 'nope', stderr: 'bad list\nmore' }), log: () => {} }), (e) => e.code === 3 && e.message === 'vitest list failed: bad list');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('audit: baseline with vitest exit 1 and no failed case is red', async () => {
  const root = miniRepo();
  try {
    await assert.rejects(
      () => tt.audit({ root, feature: '.', maxMutations: 1, run: fakeRunner(root, [{ report: 'reporter/green.json', status: 1 }]), log: () => {} }),
      (e) => e.code === 2,
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('audit: interrupted run throws 130 and restores', async () => {
  const root = miniRepo();
  const originalBytes = readFileSync(join(FIX, 'mini', 'sum.ts'));
  try {
    const green = { report: 'reporter/green.json' };
    await assert.rejects(
      () => tt.audit({ root, feature: '.', maxMutations: 1, run: fakeRunner(root, [green, { report: 'reporter/green.json', status: null, signal: 'SIGINT' }]), log: () => {} }),
      (e) => e.code === 130,
    );
    assert.deepEqual(readFileSync(join(root, 'sum.ts')), originalBytes);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('audit: detects edits to tracked implementations it did not mutate', async () => {
  const root = miniRepo();
  const other = join(root, 'other.ts');
  writeFileSync(other, 'export const o = 1\n');
  writeFileSync(join(root, '__tests__', 'other.test.ts'), "import { expect, it } from 'vitest'\nit('other', () => { expect(1).toBe(1) })\n");
  try {
    const green = { report: 'reporter/green.json' };
    const inner = fakeRunner(root, [green, { report: 'reporter/tautology-m01.json', status: 1 }, green]);
    let runCalls = 0;
    const run = (args, cwd) => {
      if (args[0] !== 'list' && ++runCalls === 2) writeFileSync(other, 'export const o = 2\n');
      return inner(args, cwd);
    };
    await assert.rejects(
      () => tt.audit({ root, feature: '.', maxMutations: 1, run, log: () => {} }),
      (error) => error.code === 3 && error.message.includes(other),
    );
    assert.equal(readFileSync(other, 'utf8'), 'export const o = 2\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('audit: spec listed by vitest but outside the audited set is not verified', async () => {
  const root = miniRepo();
  const extraFile = join(root, 'extra.test.tsx');
  let n = 0;
  const perRun = ['reporter/green.json', 'reporter/tautology-m01.json', 'reporter/green.json'];
  const run = (args) => {
    if (args[0] === 'list') {
      const list = fixture('reporter/list-mini.json').map((e) => ({ ...e, file: join(root, '__tests__', 'sum.test.ts') }));
      list.push({ file: extraFile, name: 'x > y', location: { line: 1 } });
      return { status: 0, stdout: JSON.stringify(list), stderr: '' };
    }
    const out = args.find((a) => a.startsWith('--outputFile=')).slice('--outputFile='.length);
    const report = fixture(perRun[Math.min(n++, perRun.length - 1)]);
    for (const f of report.testResults) f.name = join(root, '__tests__', 'sum.test.ts');
    report.testResults.push({
      name: extraFile,
      status: 'passed',
      assertionResults: [{ ancestorTitles: ['x'], title: 'y', location: { line: 1 }, status: 'passed', failureMessages: [] }],
    });
    writeFileSync(out, JSON.stringify(report));
    return { status: n === 2 ? 1 : 0, stdout: '', stderr: '' };
  };
  try {
    const r = await tt.audit({ root, feature: '.', maxMutations: 1, run, log: () => {} });
    const extra = r.verdicts.find((v) => v.spec === 'extra.test.tsx');
    assert.equal(extra.deletion, 'not verified: spec not in audited set');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('audit: allGone excludes only when every case of the spec is removed', async () => {
  const root = miniRepo();
  const spec = join(root, '__tests__', 'sum.test.ts');
  writeFileSync(spec, "import { describe, expect, it } from 'vitest'\ndescribe('sum', () => {\n  it('a', () => { expect(1).toBe(1) })\n  describe.each([[1]])('d %i', (n) => { it('b', () => { expect(n).toBe(1) }) })\n})\n");
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[0] === 'list') {
      return { status: 0, stdout: JSON.stringify([
        { file: spec, name: 'sum > a', location: { line: 3 } },
        { file: spec, name: 'd 1 > b', location: { line: 4 } },
      ]), stderr: '' };
    }
    const out = args.find((a) => a.startsWith('--outputFile=')).slice('--outputFile='.length);
    writeFileSync(out, JSON.stringify({
      numFailedTests: 0,
      numPassedTests: 2,
      testResults: [{
        name: spec,
        status: 'passed',
        assertionResults: [
          { ancestorTitles: ['sum'], title: 'a', location: { line: 3 }, status: 'passed', failureMessages: [] },
          { ancestorTitles: ['d 1'], title: 'b', location: { line: 4 }, status: 'passed', failureMessages: [] },
        ],
      }],
    }));
    return { status: 0, stdout: '', stderr: '' };
  };
  try {
    const r = await tt.audit({ root, feature: '.', maxMutations: 1, run, log: () => {} });
    assert.equal(calls.some((args) => args.includes('--exclude')), false);
    assert.equal(r.verdicts.find((v) => v.name === 'sum > a').deletion, 'not verified: every test in describe "sum" is zero-kill; delete the describe block and rerun');
    assert.equal(r.verdicts.find((v) => v.name === 'd 1 > b').deletion, 'not verified: unsupported call shape');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('audit: shared each rows are removed once without removing the next test', async () => {
  const root = miniRepo();
  const spec = join(root, '__tests__', 'sum.test.ts');
  writeFileSync(spec, "import { it } from 'vitest'\nit.each([[1], [2]])('row %i', (n) => {})\nit('next', () => {})\n");
  const listed = [
    { file: spec, name: 'row 1', location: { line: 2 } },
    { file: spec, name: 'row 2', location: { line: 2 } },
    { file: spec, name: 'next', location: { line: 3 } },
  ];
  let runNo = 0;
  let trimmed = '';
  const report = (kill = null) => ({ numFailedTests: kill ? 1 : 0, numPassedTests: kill ? 2 : 3, testResults: [{ name: spec, status: kill ? 'failed' : 'passed', assertionResults: listed.map((c) => ({ title: c.name, location: c.location, status: c.name === kill ? 'failed' : 'passed', failureMessages: c.name === kill ? ['AssertionError: boom'] : [] })) }] });
  const run = (args) => {
    if (args[0] === 'list') return { status: 0, stdout: JSON.stringify(listed), stderr: '' };
    const out = args.find((a) => a.startsWith('--outputFile=')).slice(13);
    const body = runNo === 1 ? report('next') : report();
    if (runNo === 2) trimmed = readFileSync(spec, 'utf8');
    writeFileSync(out, JSON.stringify(body));
    return { status: runNo++ === 1 ? 1 : 0, stdout: '', stderr: '' };
  };
  try {
    const r = await tt.audit({ root, feature: '.', maxMutations: 1, run, log: () => {} });
    const rows = r.verdicts.filter((v) => v.name.startsWith('row'));
    assert.equal(trimmed.includes("it('next'"), true);
    assert.equal(trimmed.includes('row %i'), false);
    assert.equal(rows.every((v) => v.deletion === 'removable: suite green, no new warnings'), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('audit: mixed outcomes on one each span are not verified and skip trimming', async () => {
  const root = miniRepo();
  const spec = join(root, '__tests__', 'sum.test.ts');
  writeFileSync(spec, "import { it } from 'vitest'\nit.each([[1], [2]])('row %i', (n) => {})\n");
  const listed = [{ file: spec, name: 'row 1', location: { line: 2 } }, { file: spec, name: 'row 2', location: { line: 2 } }];
  let runs = 0;
  const run = (args) => {
    if (args[0] === 'list') return { status: 0, stdout: JSON.stringify(listed), stderr: '' };
    const out = args.find((a) => a.startsWith('--outputFile=')).slice(13);
    const kill = runs === 1;
    writeFileSync(out, JSON.stringify({ numFailedTests: kill ? 1 : 0, numPassedTests: kill ? 1 : 2, testResults: [{ name: spec, status: kill ? 'failed' : 'passed', assertionResults: listed.map((c, i) => ({ title: c.name, location: c.location, status: kill && i === 0 ? 'failed' : 'passed', failureMessages: kill && i === 0 ? ['AssertionError: boom'] : [] })) }] }));
    runs++;
    return { status: kill ? 1 : 0, stdout: '', stderr: '' };
  };
  try {
    const r = await tt.audit({ root, feature: '.', maxMutations: 1, run, log: () => {} });
    assert.equal(r.verdicts.every((v) => v.deletion === 'not verified: shared each() call'), true);
    assert.equal(runs, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('audit: failed batch but green singles records not-together pair', async () => {
  const root = miniRepo();
  const spec = join(root, '__tests__', 'sum.test.ts');
  writeFileSync(spec, "import { it } from 'vitest'\nit('a', () => {})\nit('b', () => {})\n");
  const listed = [{ file: spec, name: 'a', location: { line: 2 } }, { file: spec, name: 'b', location: { line: 3 } }];
  let runs = 0;
  const run = (args) => {
    if (args[0] === 'list') return { status: 0, stdout: JSON.stringify(listed), stderr: '' };
    const out = args.find((a) => a.startsWith('--outputFile=')).slice(13);
    const batchFail = runs === 2;
    writeFileSync(out, JSON.stringify({ numFailedTests: batchFail ? 1 : 0, numPassedTests: 2, testResults: [{ name: spec, status: batchFail ? 'failed' : 'passed', assertionResults: listed.map((c, i) => ({ title: c.name, location: c.location, status: batchFail && i === 0 ? 'failed' : 'passed', failureMessages: batchFail && i === 0 ? ['AssertionError: boom'] : [] })) }] }));
    runs++;
    return { status: batchFail ? 1 : 0, stdout: '', stderr: '' };
  };
  try {
    const r = await tt.audit({ root, feature: '.', maxMutations: 1, run, log: () => {} });
    for (const v of r.verdicts) {
      const other = r.verdicts.find((x) => x.id !== v.id).id;
      assert.equal(v.deletion, `removable: suite green, no new warnings; not together with [${other}]: not removable: a`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('audit: whole zero-kill describe is explained and never trimmed', async () => {
  const root = miniRepo();
  const spec = join(root, '__tests__', 'sum.test.ts');
  writeFileSync(spec, "import { describe, it } from 'vitest'\ndescribe('empty', () => {\n  it('a', () => {})\n  it('b', () => {})\n})\ndescribe('mixed', () => {\n  it('killer', () => {})\n  it('zero', () => {})\n})\n");
  const listed = [
    { file: spec, name: 'empty > a', location: { line: 3 } },
    { file: spec, name: 'empty > b', location: { line: 4 } },
    { file: spec, name: 'mixed > killer', location: { line: 7 } },
    { file: spec, name: 'mixed > zero', location: { line: 8 } },
  ];
  let runNo = 0;
  const trimmed = [];
  const run = (args) => {
    if (args[0] === 'list') return { status: 0, stdout: JSON.stringify(listed), stderr: '' };
    const out = args.find((a) => a.startsWith('--outputFile=')).slice(13);
    const mutant = runNo === 1;
    if (runNo >= 2) trimmed.push(readFileSync(spec, 'utf8'));
    const assertions = listed.map((c) => ({ ancestorTitles: c.name.split(' > ').slice(0, -1), title: c.name.split(' > ').at(-1), location: c.location, status: mutant && c.name.endsWith('killer') ? 'failed' : 'passed', failureMessages: mutant && c.name.endsWith('killer') ? ['AssertionError: boom'] : [] }));
    writeFileSync(out, JSON.stringify({ numFailedTests: mutant ? 1 : 0, numPassedTests: mutant ? 3 : 4, testResults: [{ name: spec, status: mutant ? 'failed' : 'passed', assertionResults: assertions }] }));
    runNo++;
    return { status: mutant ? 1 : 0, stdout: '', stderr: '' };
  };
  try {
    const r = await tt.audit({ root, feature: '.', maxMutations: 1, run, log: () => {} });
    const empty = r.verdicts.filter((v) => v.name.startsWith('empty >'));
    assert.equal(empty.every((v) => v.deletion === 'not verified: every test in describe "empty" is zero-kill; delete the describe block and rerun'), true);
    assert.equal(trimmed.every((source) => source.includes("it('a'") && source.includes("it('b'")), true);
    assert.equal(r.verdicts.find((v) => v.name === 'mixed > zero').deletion, 'removable: suite green, no new warnings');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('audit: a failed single prevents not-together notes on the rest of a three-case batch', async () => {
  const root = miniRepo();
  const spec = join(root, '__tests__', 'sum.test.ts');
  writeFileSync(spec, "import { it } from 'vitest'\nit('a', () => {})\nit('b', () => {})\nit('c', () => {})\n");
  const listed = ['a', 'b', 'c'].map((name, i) => ({ file: spec, name, location: { line: i + 2 } }));
  let runNo = 0;
  const run = (args) => {
    if (args[0] === 'list') return { status: 0, stdout: JSON.stringify(listed), stderr: '' };
    const out = args.find((a) => a.startsWith('--outputFile=')).slice(13);
    const source = readFileSync(spec, 'utf8');
    const fail = runNo >= 2 && !source.includes("it('a'");
    writeFileSync(out, JSON.stringify({ numFailedTests: fail ? 1 : 0, numPassedTests: fail ? 2 : 3, testResults: [{ name: spec, status: fail ? 'failed' : 'passed', assertionResults: listed.map((c) => ({ title: c.name, location: c.location, status: fail && c.name === 'b' ? 'failed' : 'passed', failureMessages: fail && c.name === 'b' ? ['AssertionError: boom'] : [] })) }] }));
    runNo++;
    return { status: fail ? 1 : 0, stdout: '', stderr: '' };
  };
  try {
    const r = await tt.audit({ root, feature: '.', maxMutations: 1, run, log: () => {} });
    assert.equal(r.verdicts.filter((v) => v.name !== 'a').every((v) => !v.deletion.includes('not together')), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('audit: suite-only trimmed failure has a dedicated verdict', async () => {
  for (const variant of ['suite-count', 'exit-only']) {
    const root = miniRepo();
    try {
      const green = { report: 'reporter/green.json' };
      const runner = fakeRunner(root, [green, { report: 'reporter/tautology-m01.json', status: 1 }, green]);
      let runs = 0;
      const run = (args, cwd) => {
        const r = runner(args, cwd);
        if (args[0] === 'run' && ++runs === 3) {
          const out = args.find((a) => a.startsWith('--outputFile=')).slice(13);
          const json = JSON.parse(readFileSync(out));
          json.numFailedTests = 0;
          if (variant === 'suite-count') json.numFailedTestSuites = 1;
          writeFileSync(out, JSON.stringify(json));
          return { ...r, status: variant === 'exit-only' ? 1 : 0 };
        }
        return r;
      };
      const r = await tt.audit({ root, feature: '.', maxMutations: 1, run, log: () => {} });
      assert.equal(r.verdicts.find((v) => v.name.endsWith('tautology')).deletion, 'not removable: suite-level failure (likely a describe left with no tests)');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('audit: vue implementation with only no-op template attributes has no mutation crash', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tt-vue-'));
  const spec = join(root, 'C.test.ts');
  writeFileSync(join(root, 'C.vue'), '<template><X :x="undefined" @e="() => {}" /></template>\n');
  writeFileSync(spec, "import { it } from 'vitest'\nit('x', () => {})\n");
  let calls = 0;
  const run = (args) => {
    if (args[0] === 'list') return { status: 0, stdout: JSON.stringify([{ file: spec, name: 'x', location: { line: 2 } }]), stderr: '' };
    const out = args.find((a) => a.startsWith('--outputFile=')).slice(13);
    writeFileSync(out, JSON.stringify({ numFailedTests: 0, numPassedTests: 1, testResults: [{ name: spec, status: 'passed', assertionResults: [{ title: 'x', location: { line: 2 }, status: 'passed', failureMessages: [] }] }] }));
    calls++;
    return { status: 0, stdout: '', stderr: '' };
  };
  try {
    const r = await tt.audit({ root, feature: '.', maxMutations: 1, run, log: () => {} });
    assert.equal(r.mutants.length, 0);
    assert.equal(calls, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('report: banned words absent, tables present, unmapped spec listed', async () => {
  const root = miniRepo();
  writeFileSync(join(root, '__tests__', 'orphan.test.ts'), "import { it, expect } from 'vitest'\nit('x', () => { expect(1).toBe(1) })\n");
  try {
    const green = { report: 'reporter/green.json' };
    const r = await tt.audit({ root, feature: '.', maxMutations: 1, run: fakeRunner(root, [green, { report: 'reporter/tautology-m01.json', status: 1 }, green]), log: () => {} });
    assert.deepEqual(r.unmapped, ['__tests__/orphan.test.ts']);
    const md = tt.renderReport(r);
    assert.equal(/no mutation reachable|obsolete|safe to delete/.test(md), false);
    assert.equal(md.includes('## Verdicts'), true);
    assert.equal(md.includes('## Mutants'), true);
    assert.equal(md.includes('## Run'), true);
    assert.equal(md.includes('no impl mapped: __tests__/orphan.test.ts'), true);
    assert.equal(md.split('\n')[0].includes('sum.ts'), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('report: pipes are escaped in every table cell', () => {
  const md = tt.renderReport({ touched: [], feature: '.', root: '/r', verdicts: [{ spec: 'a|b', name: 'x|y', result: 'r|s', deletion: 'd|e' }], mutants: [{ id: 'M|1', file: 'f|g', line: 1, note: 'a||b', state: 'survived', killedBy: ['x|y'], runtimeFailures: ['z|q'] }], runs: 1, ms: 0, unmapped: [], manifest: '/tmp/x' });
  assert.match(md, /a\\\|b/);
  assert.match(md, /r\\\|s/);
  assert.match(md, /d\\\|e/);
  assert.match(md, /a\\\|\\\|b/);
  const row = md.split('\n').find((line) => line.includes('M\\|1'));
  assert.equal(row.split(/(?<!\\)\|/).length, 8);
});

test('integration: vitest3 real run on the mini fixture', VITEST_TEST_OPTIONS, () => {
  const root = miniWithVitest();
  try {
    const r = spawnSync(process.execPath, [SCRIPT, 'audit', '--root', root, '--feature', '.', '--max-mutations', '2'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /sum > adds \| killed \[M0[12](, M0[12])?\]/);
    assert.match(r.stdout, /sum > tautology \| killed none of 2 sampled mutants \(2 in sum\.ts\) \| removable: suite green, no new warnings/);
    assert.equal(readFileSync(join(root, 'sum.ts'), 'utf8'), readFileSync(join(FIX, 'mini', 'sum.ts'), 'utf8'));
    const listed = spawnSync(process.execPath, [SCRIPT, 'audit', '--root', root, '--feature', '.', '--max-mutations', '2', '--list-only'], { encoding: 'utf8' });
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(listed.stdout.trim().split('\n').length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(tt.manifestDir(root), { recursive: true, force: true }); }
});

test('integration: SIGKILL mid-mutant leaves the mutant, next run restores it', VITEST_TEST_OPTIONS, () => {
  const root = miniWithVitest();
  try {
    const wrapper = join(FIX, 'kill-wrapper.sh');
    const first = spawnSync(process.execPath, [SCRIPT, 'audit', '--root', root, '--feature', '.', '--max-mutations', '1', '--vitest-bin', wrapper], { encoding: 'utf8', env: { ...process.env, TT_REAL_VITEST: VITEST_BIN, TT_COUNTER: join(root, 'counter') } });
    assert.equal(first.signal, 'SIGKILL');
    assert.doesNotThrow(() => JSON.parse(readFileSync(join(tt.manifestDir(root), 'manifest.json'), 'utf8')));
    assert.notEqual(readFileSync(join(root, 'sum.ts'), 'utf8'), readFileSync(join(FIX, 'mini', 'sum.ts'), 'utf8'));
    const second = spawnSync(process.execPath, [SCRIPT, 'audit', '--root', root + '/', '--feature', '.', '--max-mutations', '1'], { encoding: 'utf8' });
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stderr, /restored .*sum\.ts from manifest/);
    assert.equal(readFileSync(join(root, 'sum.ts'), 'utf8'), readFileSync(join(FIX, 'mini', 'sum.ts'), 'utf8'));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(tt.manifestDir(root), { recursive: true, force: true }); }
});

test('integration: manifest conflict exits 3 and touches nothing', VITEST_TEST_OPTIONS, () => {
  const root = miniWithVitest();
  try {
    const wrapper = join(FIX, 'kill-wrapper.sh');
    spawnSync(process.execPath, [SCRIPT, 'audit', '--root', root, '--feature', '.', '--max-mutations', '1', '--vitest-bin', wrapper], { encoding: 'utf8', env: { ...process.env, TT_REAL_VITEST: VITEST_BIN, TT_COUNTER: join(root, 'counter') } });
    const edited = readFileSync(join(root, 'sum.ts'), 'utf8') + '// edited\n';
    writeFileSync(join(root, 'sum.ts'), edited);
    const r = spawnSync(process.execPath, [SCRIPT, 'audit', '--root', root, '--feature', '.', '--max-mutations', '1'], { encoding: 'utf8' });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /manifest conflict/);
    assert.equal(readFileSync(join(root, 'sum.ts'), 'utf8'), edited);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(tt.manifestDir(root), { recursive: true, force: true }); }
});

test('cli: --report pointing at a directory prints the report to stdout and exits 3', VITEST_TEST_OPTIONS, () => {
  const root = miniWithVitest();
  try {
    const r = spawnSync(process.execPath, [SCRIPT, 'audit', '--root', root, '--feature', '.', '--max-mutations', '1', '--report', root], { encoding: 'utf8' });
    assert.equal(r.status, 3);
    assert.match(r.stdout, /## Verdicts/);
    assert.match(r.stderr, /EISDIR/);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(tt.manifestDir(root), { recursive: true, force: true }); }
});

test('cli: usage error exits 3', () => {
  const r = spawnSync(process.execPath, [SCRIPT, 'audit'], { encoding: 'utf8' });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /--root is required/);
});

test('cli: --max-mutations 0 and non-numeric exit 3', () => {
  for (const bad of ['0', 'ten']) {
    const r = spawnSync(process.execPath, [SCRIPT, 'audit', '--root', FIX, '--feature', 'mini', '--max-mutations', bad], { encoding: 'utf8' });
    assert.equal(r.status, 3, bad);
    assert.match(r.stderr, /--max-mutations must be a positive integer/);
  }
});

test('cli: --timeout-ms 0 exits 3', () => {
  const r = spawnSync(process.execPath, [SCRIPT, 'audit', '--root', FIX, '--feature', 'mini', '--timeout-ms', '0'], { encoding: 'utf8' });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /--timeout-ms must be a positive integer/);
});

test('cli: missing vitest binary exits 3 with its path', () => {
  const root = miniRepo();
  try {
    const r = spawnSync(process.execPath, [SCRIPT, 'audit', '--root', root, '--feature', '.', '--vitest-bin', '/nonexistent'], { encoding: 'utf8' });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /vitest not found at \/nonexistent/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
