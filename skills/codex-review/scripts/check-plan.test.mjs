import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { check } from './check-plan.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'check-plan.mjs');

const GOOD = `# Plan
## Acceptance criteria
1. \`node --test scripts/\` exits 0 and prints \`pass 12\`.
2. \`grep -c foo bar.md\` prints \`1\`.
## Rollback
- delete the file
`;

const hidesExit = (findings) => findings.filter((f) => f.includes('hides the exit status')).length;

// ---------------------------------------------------------------- check/

test('check/ missing section is one finding', () => {
  assert.equal(check('# Plan\n## Steps\n1. do it\n').length, 1);
});

test('check/ good criteria pass', () => {
  assert.deepEqual(check(GOOD), []);
});

test('check/ item without command flagged', () => {
  assert.match(check('## Acceptance\n1. The page looks identical to before.\n')[0], /no command/);
});

test('check/ item without expected result flagged', () => {
  assert.match(check('## Acceptance\n1. Run `npm test` on the repo.\n')[0], /no expected result/);
});

test('check/ backticked prose is not a command', () => {
  assert.match(check('## Acceptance\n1. The page shows `Reserve button` and prints nothing else.\n')[0], /no command/);
});

test('check/ bare slash is not a command', () => {
  assert.match(check('## Acceptance\n1. Run `./` and it exits 0.\n')[0], /no command/);
});

test('check/ placeholder flagged', () => {
  assert.ok(check('## Acceptance\n1. `curl <pdp-url>` exits 0.\n')[0].includes('placeholder <pdp-url>'));
});

test('check/ fenced block counts as command', () => {
  const text = '## Acceptance\n1. Whole suite:\n   ```\n   for c in a b; do ./run $c; done\n   ```\n   Expected: 2 lines of `ok`.\n';
  assert.deepEqual(check(text), []);
});

test('check/ unassigned variable flagged', () => {
  const text = '## Acceptance\n1. `"$TOOLS/verify" origin/main --full` prints `ALL PASS`.\n';
  assert.ok(check(text)[0].includes('$TOOLS never assigned'));
});

test('check/ braced unassigned variable flagged', () => {
  assert.ok(check('## Acceptance\n1. `ls ${OUT_DIR}/a` exits 0.\n')[0].includes('$OUT_DIR never assigned'));
});

test('check/ inline assigned variable passes', () => {
  assert.deepEqual(check('## Acceptance\n1. `TOOLS=~/bin; "$TOOLS/verify" --full` prints `ALL PASS`.\n'), []);
});

test('check/ shell builtin variable passes', () => {
  assert.deepEqual(check('## Acceptance\n1. `ls "$TMPDIR" && test -d $HOME` exits 0.\n'), []);
});

test('check/ single-quoted and non-shell fence ignored', () => {
  const text = "## Acceptance\n1. `sh -c 'test -n \"$INNER\"'` exits 0 and\n   ```js\n   const s = `${taskId}`\n   ```\n";
  assert.deepEqual(check(text), []);
});

test('check/ variable in prose is ignored', () => {
  assert.deepEqual(check('## Acceptance\n1. Costs $5; `./x` exits 0.\n'), []);
});

test('check/ table rows checked, header skipped', () => {
  const text = '## Acceptance\n| Case | Assertion |\n|---|---|\n| `defects` | planted errors give nonzero |\n| `clean` | `./acceptance clean` exits 0 |\n';
  const findings = check(text);
  assert.equal(findings.length, 1);
  assert.match(findings[0], /item 1/);
});

test('check/ manual gate needs env', () => {
  const text = '## Acceptance\n1. Manually open the PDP and confirm `Reserve` shows.\n';
  assert.ok(check(text).some((f) => f.includes('manual gate')));
});

test('check/ heading inside fence is not a section', () => {
  const text = '# Plan\n```\n## [2026-09-14] plan | acceptance gate\n```\n## Acceptance\n1. `./x` exits 0.\n';
  assert.deepEqual(check(text), []);
});

test('check/ section ends at sibling heading', () => {
  assert.deepEqual(check('## Acceptance criteria\n1. `./x` exits 0.\n## Rollback\n- prose without command\n'), []);
});

test('check/ the finding excerpt is cut by code point, so an emoji is never split', () => {
  const head = `- \`x\` ${'a'.repeat(63)}🔧 tail`;
  const finding = check(`## Acceptance\n${head}\n`)[0];
  assert.ok(finding.endsWith(`${'a'.repeat(63)}🔧`), finding);
});

// ---------------------------------------------------------------- pipes/

test('pipes/ piped test in criterion flagged', () => {
  assert.ok(hidesExit(check('## Acceptance\n1. `npm test 2>&1 | tail -5` exits 0.\n')) > 0);
});

test('pipes/ piped typecheck in task fence flagged', () => {
  const text = GOOD + '### Task 1: wire it\n```bash\nnpm run typecheck | tail -3 && npm test\n```\nExpected: exit 0.\n';
  assert.ok(hidesExit(check(text)) > 0);
});

test('pipes/ pipefail in same block passes', () => {
  const text = GOOD + '### Task 1: wire it\n```bash\nset -o pipefail\nnpm test 2>&1 | tail -5\n```\nExpected: exit 0.\n';
  assert.deepEqual(check(text), []);
});

test('pipes/ match stops at command separators', () => {
  const text = '## Acceptance\n1. `npm test; git diff --stat | tail -1` exits 0.\n2. `npm test && git status | head -3` exits 0.\n';
  assert.deepEqual(check(text), []);
});

test('pipes/ pipefail after the pipeline or as a word does not protect', () => {
  const text = GOOD + '### Task 1: a\n```bash\nnpm test 2>&1 | tail -5\nset -o pipefail\n```\nExpected: exit 0.\n### Task 2: b\nRun `npm test | tail -3; echo pipefail`; exits 0.\n';
  assert.equal(hidesExit(check(text)), 2);
});

test('pipes/ combined set flags and PIPESTATUS check pass', () => {
  const text = GOOD + '### Task 1: a\n```bash\nset -euo pipefail\nnpm test 2>&1 | tail -5\n```\nExpected: exit 0.\n### Task 2: b\n```bash\nnpm test 2>&1 | tail -5; test "${PIPESTATUS[0]}" -eq 0\n```\nExpected: exit 0.\n';
  assert.deepEqual(check(text), []);
});

test('pipes/ pipe into tee or an || operator not flagged', () => {
  const text = '## Acceptance\n1. `npm test 2>&1 | tee out.log` exits 0.\n2. `npm test || echo failed` prints nothing.\n';
  assert.deepEqual(check(text), []);
});

test('pipes/ vitest list and config path not flagged', () => {
  const text = '## Acceptance\n1. `vitest list --filesOnly | grep -c spec` prints `3`.\n2. `ls vitest.config.ts packages/*/vitest.config.ts | grep -c .` prints `2`.\n';
  assert.deepEqual(check(text), []);
});

test('pipes/ vitest inside quoted source not flagged', () => {
  const text = '## Acceptance\n1. `printf \'import { it } from "vitest";\\nit("p", () => {})\' > x.test.ts; ls | grep -c x` prints `1`.\n';
  assert.deepEqual(check(text), []);
});

test('pipes/ vitest run piped flagged', () => {
  assert.ok(hidesExit(check('## Acceptance\n1. `vitest run 2>&1 | tail -3` exits 0.\n')) > 0);
});

test('pipes/ pipe in non-shell fence ignored', () => {
  assert.deepEqual(check(GOOD + "```ts\nconst s = 'npm test | tail';\n```\n"), []);
});

// ---------------------------------------------------------------- tasks/

test('tasks/ task without command flagged', () => {
  const text = GOOD + '### Task 1: Add helper\nEdit `lib/foo.ts` and export `bar`.\n';
  assert.ok(check(text).includes('[Task 1: Add helper] no verification command'));
});

test('tasks/ task with only a code fence flagged', () => {
  const text = GOOD + '### Task 2: Add helper\n```ts\nexport const bar = 1\n```\nIt should pass.\n';
  assert.ok(check(text).includes('[Task 2: Add helper] no verification command'));
});

test('tasks/ task without expected result flagged', () => {
  const text = GOOD + '### Task 3: Run it\nRun `node --test lib/`.\n';
  assert.ok(check(text).includes('[Task 3: Run it] no expected result'));
});

test('tasks/ task with command and expected passes', () => {
  const text = GOOD + '### Task 1: Add helper\n```bash\nnode --test lib/\n```\nExpected: `pass 3`, exit 0.\n### Task 2: Wire it\nRun `npm test` and expect exit 0.\n';
  assert.deepEqual(check(text), []);
});

test('tasks/ task section ends at sibling heading', () => {
  assert.deepEqual(check('### Task 1: Add helper\nRun `./x`; exits 0.\n### Notes\nprose only\n' + GOOD), []);
});

test('tasks/ no task headings, no task findings', () => {
  assert.deepEqual(check(GOOD + '## Tasks overview\nprose\n'), []);
});

// ---------------------------------------------------------------- negative proof/

const SCANNER = GOOD + '### Task 4: Add the leak scanner\n```bash\nnode scripts/scan.mjs fixtures/clean\n```\nExpected: exit 0, prints `scanned 2 files`.\n';
const startsWith = (findings, prefix) => findings.some((f) => f.startsWith(prefix));

test('negative proof/ a task adding a check needs one', () => {
  assert.ok(startsWith(check(SCANNER), '[Task 4: Add the leak scanner] no negative proof'));
});

test('negative proof/ with a failing expectation passes', () => {
  const text = SCANNER + 'Negative proof: `node scripts/scan.mjs fixtures/secret` exits 1 and names `secret.txt`.\n';
  assert.deepEqual(check(text), []);
});

test('negative proof/ expecting success is flagged', () => {
  const text = SCANNER + 'Negative proof: `node scripts/scan.mjs fixtures/secret` exits 0.\n';
  assert.ok(startsWith(check(text), '[Task 4: Add the leak scanner] negative proof names no failing result'));
});

test('negative proof/ a task that only runs existing tests is not classified', () => {
  assert.deepEqual(check(GOOD + '### Task 5: Wire the button\nRun `npm test`; exits 0.\n'), []);
});

test('negative proof/ a test file path in the body classifies the task', () => {
  const text = GOOD + '### Task 6: Guard the push\nEdit `hooks/guard.py` and `hooks/test_guard.py`; `python3 hooks/test_guard.py` prints `OK`.\n';
  assert.ok(startsWith(check(text), '[Task 6: Guard the push] no negative proof'));
});

// ---------------------------------------------------------------- cli/

function cliOn(content) {
  const dir = mkdtempSync(join(tmpdir(), 'check-plan-'));
  const path = join(dir, 'plan.md');
  if (content !== null) writeFileSync(path, content);
  const res = spawnSync('node', [CLI, path], { encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  return res;
}

test('cli/ a clean plan exits 0 and reports zero findings', () => {
  const res = cliOn(GOOD);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /check-plan: 0 finding\(s\) in plan\.md/);
});

test('cli/ a plan with findings exits 1 and prints them', () => {
  const res = cliOn('## Acceptance\n1. It works.\n');
  assert.equal(res.status, 1);
  assert.match(res.stdout, /no command/);
  assert.match(res.stdout, /check-plan: 1 finding\(s\)/);
});

test('cli/ an unreadable plan exits 2, not 1', () => {
  const res = cliOn(null);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /cannot read/);
});
