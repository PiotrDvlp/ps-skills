import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan, planHash } from './plan-format.mjs';

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
