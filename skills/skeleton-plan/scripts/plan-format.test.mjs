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
**Interfaces:** Produces \`t1-a\`. Consumes \`run(x: number): number\`.
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
  assert.deepEqual([...p.taskSignatures], [['Task 1', ['t1-a', 'run(x: number): number']]]);
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
  const md = plan().replace('Consumes `run(x: number): number`', 'Consumes `run(y: number): number`');
  assert.deepEqual(kinds(md), ['format: signature']);
  assert.deepEqual(violations(plan().replace('Produces `t1-a`', 'Produces `t1-a`, `t2-b`')), []);
});

test('checkFormat flags a path that leaves the repo', () => {
  const md = plan()
    .replace('"id":"t1-a","path":"src/a.ts"', '"id":"t1-a","path":"../x.ts"')
    .replace('"id":"t2-b","path":"src/b.ts"', '"id":"t2-b","path":"/tmp/x.ts"');
  assert.equal(violations(md).filter((v) => v.startsWith('format: path')).length, 2);
});
