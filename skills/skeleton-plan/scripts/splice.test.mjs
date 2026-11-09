import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTypescript } from './tools.mjs';
import { spliceFile } from './splice.mjs';

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
