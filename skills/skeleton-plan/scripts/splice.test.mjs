import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTypescript } from './tools.mjs';
import { spliceFile, spliceSnapshot } from './splice.mjs';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const { ts } = loadTypescript(root, join(homedir(), '.cache/skeleton-plan'));

const block = (op, selectors, code = '', id = 'b1') =>
  ({ id, path: 'src/a.ts', op, selectors, label: id, code, line: 1 });

const THREE = [
  "import { x } from './x';",
  '',
  '/** First. */',
  'export const a = 1;',
  '',
  '/** Second. */',
  'export function b(n: number): number {',
  '  return n + x;',
  '}',
  '',
  '// Third.',
  'export interface C {',
  '  id: string;',
  '}',
  '',
].join('\n');

test('replace swaps one declaration and keeps every other byte', () => {
  const out = spliceFile(ts, 'src/a.ts', THREE, [
    block('replace', ['function:b'], '/** Second, typed. */\nexport function b(n: number): string {\n  return String(n);\n}'),
  ]);
  assert.equal(out, [
    "import { x } from './x';",
    '',
    '/** First. */',
    'export const a = 1;',
    '',
    '/** Second, typed. */',
    'export function b(n: number): string {',
    '  return String(n);',
    '}',
    '',
    '// Third.',
    'export interface C {',
    '  id: string;',
    '}',
    '',
  ].join('\n'));
});

test('selectors resolve against the base source', () => {
  const source = 'const a = 1;\nconst b = 2;\n';
  const out = spliceFile(ts, 'src/a.ts', source, [
    block('replace', ['const:a'], 'const b = 10;', 'b1'),
    block('replace', ['const:b'], 'const c = 20;', 'b2'),
  ]);
  assert.equal(out, 'const b = 10;\nconst c = 20;\n');
});

test('overlapping ranges fail', () => {
  const source = 'export const a = 1, b = 2;\nexport type T = string;\n';
  assert.throws(
    () => spliceFile(ts, 'src/a.ts', source, [
      block('replace', ['const:a'], 'export const a = 3;', 'b1'),
      block('delete-declaration', ['const:b'], '', 'b2'),
    ]),
    (e) => e.code === 1 && e.message.startsWith('format: overlapping'),
  );
});

test('a missing selector fails', () => {
  assert.throws(
    () => spliceFile(ts, 'src/a.ts', THREE, [block('delete-declaration', ['const:nope'])]),
    (e) => e.code === 1 && e.message.startsWith('failed: selector const:nope'),
  );
});

test('an ambiguous selector fails', () => {
  const source = 'interface X { a: string }\nconst y = 1;\ninterface X { b: string }\n';
  assert.throws(
    () => spliceFile(ts, 'src/a.ts', source, [block('replace', ['interface:X'], 'interface X { c: string }')]),
    (e) => e.code === 1 && e.message.startsWith('failed: ambiguous interface:X'),
  );
});

test('replace keeps a file header above the first declaration', () => {
  const source = '// Copyright X\n// @ts-nocheck\n\nconst a = 1;\nconst b = 2;\n';
  const out = spliceFile(ts, 'src/a.ts', source, [block('replace', ['const:a'], 'const a = 3;')]);
  assert.equal(out, '// Copyright X\n// @ts-nocheck\n\nconst a = 3;\nconst b = 2;\n');
});

test('an unknown or malformed selector fails as a format error', () => {
  assert.throws(
    () => spliceFile(ts, 'src/a.ts', THREE, [block('replace', ['klass:a'], 'class a {}')]),
    (e) => e.code === 1 && e.message === 'format: unknown selector kind klass',
  );
  assert.throws(
    () => spliceFile(ts, 'src/a.ts', THREE, [block('replace', ['const'], 'const a = 2;')]),
    (e) => e.code === 1 && e.message === 'format: bad selector const',
  );
});

test('delete-declaration removes only that declaration', () => {
  const out = spliceFile(ts, 'src/a.ts', THREE, [block('delete-declaration', ['function:b'])]);
  assert.equal(out, [
    "import { x } from './x';",
    '',
    '/** First. */',
    'export const a = 1;',
    '',
    '',
    '// Third.',
    'export interface C {',
    '  id: string;',
    '}',
    '',
  ].join('\n'));
});

test('leading imports move to the import section and merge duplicates', () => {
  const out = spliceFile(ts, 'src/a.ts', THREE, [
    block('replace', ['const:a'], "import {  x  } from './x'\nimport { y } from './y';\n\nexport const a = x + y;"),
  ]);
  assert.equal(out.split('\n').filter((l) => l.startsWith('import')).length, 2);
  assert.ok(out.startsWith("import { x } from './x';\nimport { y } from './y';\n\nexport const a = x + y;\n\n/** Second. */\n"));
});

test('insert into export-default adds the property', () => {
  const source = 'export default defineConfig({ a: 1 });\n';
  const insert = { ...block('insert', [], 'b: 2'), into: 'export-default', property: 'b' };
  const out = spliceFile(ts, 'src/a.ts', source, [insert]);
  const call = ts.createSourceFile('a.ts', out, ts.ScriptTarget.Latest, true).statements[0].expression;
  assert.deepEqual(call.arguments[0].properties.map((p) => p.name.text), ['a', 'b']);
  assert.throws(
    () => spliceFile(ts, 'src/a.ts', source, [{ ...insert, property: 'a' }]),
    (e) => e.code === 1 && e.message === 'failed: property a exists',
  );
  assert.throws(
    () => spliceFile(ts, 'src/a.ts', 'export default 1;\n', [insert]),
    (e) => e.code === 1 && e.message === 'failed: no export-default object',
  );
});

test('insert after imports places code below the last import', () => {
  const source = "import { x } from './x';\nimport { y } from './y';\n\nexport const a = x + y;\n";
  const out = spliceFile(ts, 'src/a.ts', source, [{ ...block('insert', [], 'const z = 3;'), after: 'imports' }]);
  assert.equal(out, "import { x } from './x';\nimport { y } from './y';\n\nconst z = 3;\n\nexport const a = x + y;\n");
});

const snapshot = () => {
  const dir = mkdtempSync(join(tmpdir(), 'splice-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/a.ts'), THREE);
  return dir;
};

test('create writes a new file and delete-file removes one', () => {
  const dir = snapshot();
  const result = spliceSnapshot(ts, dir, [
    { ...block('create', [], 'export const n = 1;', 'b1'), path: 'src/new/n.ts' },
    { ...block('delete-file', [], '', 'b2'), path: 'src/a.ts' },
  ]);
  assert.deepEqual(result, { gated: 2, ungated: [] });
  assert.equal(readFileSync(join(dir, 'src/new/n.ts'), 'utf8'), 'export const n = 1;\n');
  assert.equal(existsSync(join(dir, 'src/a.ts')), false);
  assert.throws(
    () => spliceSnapshot(ts, dir, [{ ...block('create', [], 'x'), path: 'src/new/n.ts' }]),
    (e) => e.code === 1 && e.message === 'failed: exists src/new/n.ts',
  );
  assert.throws(
    () => spliceSnapshot(ts, dir, [{ ...block('delete-file', []), path: 'src/a.ts' }]),
    (e) => e.code === 1 && e.message === 'failed: missing src/a.ts',
  );
});

test('.vue blocks are skipped and reported ungated', () => {
  const dir = snapshot();
  writeFileSync(join(dir, 'src/C.vue'), '<template />\n');
  const result = spliceSnapshot(ts, dir, [
    { ...block('replace', ['const:c'], 'const c = 2;', 'b1'), path: 'src/C.vue' },
    { ...block('delete-declaration', ['const:c'], '', 'b2'), path: 'src/C.vue' },
    block('delete-declaration', ['interface:C'], '', 'b3'),
  ]);
  assert.deepEqual(result, { gated: 1, ungated: ['src/C.vue'] });
  assert.equal(readFileSync(join(dir, 'src/C.vue'), 'utf8'), '<template />\n');
  assert.ok(!readFileSync(join(dir, 'src/a.ts'), 'utf8').includes('interface C'));
});

test('a target behind a symlink that leaves the snapshot fails', () => {
  const outside = mkdtempSync(join(tmpdir(), 'outside-'));
  writeFileSync(join(outside, 'a.ts'), THREE);
  const dir = mkdtempSync(join(tmpdir(), 'splice-'));
  symlinkSync(outside, join(dir, 'src'));
  symlinkSync(join(outside, 'a.ts'), join(dir, 'link.ts'));
  mkdirSync(`${dir}-evil`);
  symlinkSync(`${dir}-evil`, join(dir, 'sibling'));
  const blocked = (e) => e.code === 3 && e.message.startsWith('blocked: target leaves snapshot');
  assert.throws(() => spliceSnapshot(ts, dir, [block('delete-declaration', ['function:b'])]), blocked);
  assert.throws(() => spliceSnapshot(ts, dir, [{ ...block('delete-declaration', ['function:b']), path: 'link.ts' }]), blocked);
  assert.throws(() => spliceSnapshot(ts, dir, [{ ...block('create', [], 'x'), path: 'src/sub/new.ts' }]), blocked);
  assert.throws(() => spliceSnapshot(ts, dir, [{ ...block('create', [], 'x'), path: 'sibling/new.ts' }]), blocked);
  assert.throws(() => spliceSnapshot(ts, dir, [{ ...block('create', [], 'x'), path: '../evil.ts' }]), blocked);
  assert.throws(() => spliceSnapshot(ts, dir, [{ ...block('create', [], 'x'), path: '/etc/x.ts' }]), blocked);
  assert.equal(readFileSync(join(outside, 'a.ts'), 'utf8'), THREE);
  assert.equal(existsSync(join(outside, 'sub')), false);
  assert.equal(existsSync(`${dir}-evil/new.ts`), false);
});
