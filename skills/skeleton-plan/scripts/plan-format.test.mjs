import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan, planHash, checkFormat } from './plan-format.mjs';

const MARKER = '*Below this line: for the implementer, the gates and the reviewer.*';

const plan = ({ code = 'export const a = 1', below = '', marker = true } = {}) => `---
title: Example
base: abc1234
---

# Example plan

## 1. Files

| Action | File | Change |
|---|---|---|
| Create | \`src/a.ts\` | the helper |
| Modify | \`src/b.ts\` | use the helper |

## 2. Interfaces

**Create \`src/a.ts\`**
<!-- skeleton {"id":"t1-a","path":"src/a.ts","op":"create"} -->
\`\`\`ts
${code}
\`\`\`

**Replace in \`src/b.ts\` — \`run\`, \`stop\`**
<!-- skeleton {"id":"t2-b","path":"src/b.ts","op":"replace","selectors":["function:run","const:stop"]} -->
\`\`\`ts
export function run(x: number): number { return x }
export const stop = (): void => undefined
\`\`\`

**Signature unchanged, behaviour changed**
- \`load\` in \`src/c.ts\`: now caches.
- The b test: uses the helper.

${marker ? MARKER : ''}

### Task 1: Helper

**Files:** Create \`src/a.ts\`.
**Interfaces:** Produces \`t1-a\`, \`t2-b\`, \`run(x: number): number\`. Consumes \`Fixtures\` (\`specs/support/cart.ts:5\`).
${below}`;

test('parsePlan stops the approval part at the marker line', () => {
  const p = parsePlan(plan());
  assert.ok(p.approval.includes('## 2. Interfaces'));
  assert.ok(!p.approval.includes('### Task'));
  assert.ok(!p.approval.includes(MARKER));
  assert.equal(p.base, 'abc1234');
  assert.deepEqual(p.files, [
    { action: 'create', path: 'src/a.ts', change: 'the helper' },
    { action: 'modify', path: 'src/b.ts', change: 'use the helper' },
  ]);
  assert.deepEqual(p.unchanged, ['`load` in `src/c.ts`: now caches.', 'The b test: uses the helper.']);
  assert.deepEqual([...p.taskSignatures], [['Task 1', ['t1-a', 't2-b', 'run(x: number): number']]]);
});

test("parsePlan reads each block's label, metadata and code", () => {
  const { blocks } = parsePlan(plan());
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], {
    id: 't1-a', path: 'src/a.ts', op: 'create', selectors: [],
    label: 'Create `src/a.ts`', code: 'export const a = 1', line: 18,
  });
  assert.deepEqual(blocks[1], {
    id: 't2-b', path: 'src/b.ts', op: 'replace', selectors: ['function:run', 'const:stop'],
    label: 'Replace in `src/b.ts` — `run`, `stop`',
    code: 'export function run(x: number): number { return x }\nexport const stop = (): void => undefined',
    line: 24,
  });
});

test('parsePlan rejects a splice comment that almost matches', () => {
  const good = '<!-- skeleton {"id":"t1-a","path":"src/a.ts","op":"create"} -->';
  for (const bad of [good.replace('<!-- ', '<!--'), good.replace(' -->', '-->'), good.replace(' -->', '')]) {
    const md = plan().replace(good, bad);
    assert.throws(() => parsePlan(md), { message: 'format: bad splice comment at line 18' }, bad);
  }
  assert.equal(parsePlan(plan().replace(good, `${good}  `)).blocks.length, 2);
});

test('parsePlan fails without the marker', () => {
  assert.throws(() => parsePlan(plan({ marker: false })), { message: 'format: no approval marker' });
});

test('planHash ignores text below the line', () => {
  const extra = '\n**teeth-build result**\n<!-- skeleton {"id":"x","path":"src/a.ts","op":"create"} -->\n```ts\nnope\n```\n';
  assert.equal(planHash(parsePlan(plan({ below: extra }))), planHash(parsePlan(plan())));
});

test('the Gate line above the files table is left out of the approval hash', () => {
  const withGate = (line) => plan().replace('# Example plan\n', `# Example plan\n${line}\n`);
  const passed = parsePlan(withGate('Gate: passed'));
  assert.equal(passed.gateLine, 'Gate: passed');
  assert.equal(parsePlan(plan()).gateLine, null);
  assert.ok(!passed.approval.includes('Gate: passed'));
  assert.equal(passed.blocks[0].line, 19);
  const hash = planHash(passed);
  assert.equal(planHash(parsePlan(withGate('Gate: blocked: baseline broken'))), hash);
  assert.equal(planHash(parsePlan(plan())), hash);
  assert.notEqual(planHash(parsePlan(withGate('Gate: passed').replace('# Example plan', '# Example plan, edited'))), hash);
  assert.notEqual(planHash(parsePlan(withGate('Gate: passed\nGate: other'))), planHash(parsePlan(withGate('Gate: passed\nGate: else'))));
  assert.notEqual(planHash(parsePlan(withGate('Gate:passed'))), hash);
  const inFiles = (line) => plan().replace('| Modify | `src/b.ts` | use the helper |\n', `| Modify | \`src/b.ts\` | use the helper |\n\n${line}\n`);
  assert.equal(parsePlan(inFiles('Gate: passed')).gateLine, null);
  assert.notEqual(planHash(parsePlan(inFiles('Gate: passed'))), planHash(parsePlan(inFiles('Gate: failed'))));
});

test("planHash changes when a block's code changes", () => {
  const a = planHash(parsePlan(plan()));
  const b = planHash(parsePlan(plan({ code: 'export const a = 2' })));
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});

const violations = (md) => checkFormat(parsePlan(md));
const kinds = (md) => violations(md).map((v) => v.match(/^format: (?:not in files table|\w+)/)[0]);

test('checkFormat flags a label that names another path', () => {
  const md = plan().replace('**Create `src/a.ts`**', '**Create `a.ts`**');
  assert.deepEqual(kinds(md), ['format: label']);
  assert.deepEqual(kinds(plan().replace('**Create `src/a.ts`**', '**Replace in `src/a.ts`**')), ['format: label']);
});

test('checkFormat flags a splice path missing from the files table', () => {
  const md = plan().replace('| Modify | `src/b.ts` | use the helper |\n', '');
  assert.deepEqual(kinds(md), ['format: not in files table']);
});

test('checkFormat flags two blocks with the same selector', () => {
  const second = '**Replace in `src/b.ts` — `stop`**\n<!-- skeleton {"id":"t3-b","path":"src/b.ts","op":"replace","selector":"const:stop"} -->\n```ts\nexport const stop = (): void => undefined\n```\n\n';
  const md = plan().replace('**Signature unchanged', `${second}**Signature unchanged`);
  assert.deepEqual(kinds(md), ['format: overlapping']);
  const both = plan().replace('"selectors":["function:run","const:stop"]', '"selector":"function:run","selectors":["const:stop"]');
  assert.deepEqual(kinds(both), ['format: selector']);
});

test('checkFormat flags a task signature that differs from its block', () => {
  const md = plan().replace('`run(x: number): number`', '`run(y: number): number`');
  assert.deepEqual(kinds(md), ['format: signature']);
  assert.deepEqual(violations(plan()), []);
  assert.deepEqual(kinds(plan().replace('`t2-b`, `run(x', '`run(x')), ['format: signature']);
});

const second = (label, meta, code = 'export const z = 1') =>
  plan().replace('**Signature unchanged', `**${label}**\n<!-- skeleton ${JSON.stringify(meta)} -->\n\`\`\`ts\n${code}\n\`\`\`\n\n**Signature unchanged`);

test('checkFormat wants the path tail as a whole backticked token in the label', () => {
  assert.deepEqual(violations(plan().replace('**Create `src/a.ts`**', '**Create `src/a.tsx`**')), [
    'format: label "Create `src/a.tsx`" does not name path `src/a.ts` in t1-a (line 18)',
  ]);
  assert.deepEqual(kinds(plan().replace('**Create `src/a.ts`**', '**Create src/a.ts**')), ['format: label']);
  const deep = plan()
    .replace('| `src/a.ts` | the helper', '| `lib/cart/a.ts` | the helper')
    .replace('"path":"src/a.ts"', '"path":"lib/cart/a.ts"');
  assert.deepEqual(violations(deep.replace('**Create `src/a.ts`**', '**Create `lib/cart/a.ts`**')), []);
  assert.deepEqual(violations(deep.replace('**Create `src/a.ts`**', '**Create `cart/a.ts`**')), []);
  assert.deepEqual(kinds(deep.replace('**Create `src/a.ts`**', '**Create `a.ts`**')), ['format: label']);
});

test('checkFormat wants every selector name and the export-default property in backticks', () => {
  assert.deepEqual(violations(plan().replace('— `run`, `stop`', '— `run`, stop')), [
    'format: label "Replace in `src/b.ts` — `run`, stop" does not name selector `stop` in t2-b (line 24)',
  ]);
  const meta = { id: 't3-b', path: 'src/b.ts', op: 'insert', into: 'export-default', property: 'mode' };
  assert.deepEqual(violations(second('Insert into `src/b.ts` — `mode`', meta, "mode: 'x'")), []);
  assert.deepEqual(kinds(second('Insert into `src/b.ts` — mode', meta, "mode: 'x'")), ['format: label']);
});

test('checkFormat wants a files-table row action that fits the op', () => {
  assert.deepEqual(violations(plan().replace('| Create | `src/a.ts`', '| Modify | `src/a.ts`')), [
    'format: row Modify for src/a.ts does not fit op create in t1-a',
  ]);
  assert.deepEqual(kinds(plan().replace('| Modify | `src/b.ts`', '| Create | `src/b.ts`')), ['format: row']);
  const del = plan()
    .replace('**Create `src/a.ts`**', '**Delete in `src/a.ts`**')
    .replace('"op":"create"', '"op":"delete-file"');
  assert.deepEqual(kinds(del), ['format: row']);
  assert.deepEqual(violations(del.replace('| Create | `src/a.ts`', '| Delete | `src/a.ts`')), []);
});

test('checkFormat wants a TypeScript or Vue block path', () => {
  const as = (path) => plan()
    .replace('| `src/a.ts` | the helper', `| \`${path}\` | the helper`)
    .replace('**Create `src/a.ts`**', `**Create \`${path}\`**`)
    .replace('"path":"src/a.ts"', `"path":"${path}"`);
  assert.deepEqual(violations(as('src/a.js')), ['format: path src/a.js is not a TypeScript or Vue file in t1-a']);
  for (const ok of ['src/a.tsx', 'src/a.mts', 'src/a.cts', 'src/A.VUE', 'src/a.TS']) assert.deepEqual(violations(as(ok)), [], ok);
});

test('parsePlan rejects a splice comment whose id, path or op is missing or not a string', () => {
  const good = '"id":"t1-a","path":"src/a.ts","op":"create"';
  for (const bad of ['"id":"t1-a","op":"create"', '"path":"src/a.ts","op":"create"', '"id":"t1-a","path":"src/a.ts"', '"id":1,"path":"src/a.ts","op":"create"', `${good},"selectors":5`]) {
    assert.throws(() => parsePlan(plan().replace(good, bad)), { message: 'format: bad splice comment at line 18' }, bad);
  }
});

test('checkFormat finds selector, path, op and insert errors before any snapshot', () => {
  const sel = (s) => plan().replace('"selectors":["function:run","const:stop"]', `"selectors":["function:run","${s}"]`);
  assert.ok(violations(sel('const')).includes('format: bad selector const'));
  assert.ok(violations(sel('klass:stop')).includes('format: unknown selector kind klass'));
  for (const path of ['./src/a.ts', 'src/./a.ts', 'src//a.ts']) {
    assert.ok(violations(plan().replace('"path":"src/a.ts"', `"path":"${path}"`)).includes(`format: path ${path} is not normalised`), path);
  }
  const twice = second('Replace in `src/a.ts` — `a`', { id: 't3-a', path: 'src/a.ts', op: 'replace', selector: 'const:a' });
  assert.ok(violations(twice).includes('format: create must be the only block for src/a.ts'));
  const insert = { id: 't3-b', path: 'src/b.ts', op: 'insert' };
  assert.deepEqual(violations(second('Insert into `src/b.ts`', insert)), ['format: insert needs after or into in block t3-b']);
  assert.deepEqual(violations(second('Insert into `src/b.ts`', { ...insert, after: 'imports' })), []);
  assert.deepEqual(violations(second('Insert into `src/b.ts`', { ...insert, into: 'export-default' })), ['format: insert into export-default needs property in block t3-b']);
  assert.deepEqual(violations(second('Insert into `src/b.ts`', { ...insert, op: 'rename' })), ['format: unsupported op rename in block t3-b']);
});

test('checkFormat flags a path that leaves the repo', () => {
  const md = plan()
    .replace('"id":"t1-a","path":"src/a.ts"', '"id":"t1-a","path":"../x.ts"')
    .replace('"id":"t2-b","path":"src/b.ts"', '"id":"t2-b","path":"/tmp/x.ts"');
  assert.equal(violations(md).filter((v) => v.startsWith('format: path')).length, 2);
});
