import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { assertReadOnly, baseName, unresolved, verdict } from './mr-watchman.mjs'

const CLI = fileURLToPath(new URL('./mr-watchman.mjs', import.meta.url))
const SHA = 'a'.repeat(40)
const mr = (iid, branch, over = {}) => ({
  iid, source_branch: branch, target_branch: /_dev(elop)?$/.test(branch) ? 'develop' : 'main',
  has_conflicts: false, detailed_merge_status: 'mergeable', blocking_discussions_resolved: true,
  sha: SHA, diverged_commits_count: 3, draft: false,
  head_pipeline: { id: 100 + iid, status: 'success', sha: SHA, web_url: `https://gitlab.example.com/team/shop/-/pipelines/${100 + iid}` },
  web_url: `https://gitlab.example.com/team/shop/-/merge_requests/${iid}`, ...over,
})
const thread = (author, path, line, body, resolved = false) => ({
  id: 'd1', individual_note: false, notes: [{ resolvable: true, resolved, type: 'DiffNote', system: false,
    author: { username: author }, position: { new_path: path, new_line: line }, body }],
})
const summary = (body) => ({ id: 'd2', individual_note: true, notes: [{ resolvable: false, system: false, author: { username: 'review-bot' }, body }] })

function run(t, { mrs, discussions = {}, jobs = {}, args = [], json = true, glabError = false, malformed = false }) {
  const root = mkdtempSync(join(tmpdir(), 'mr watchman-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const log = join(root, 'calls.jsonl')
  const config = { mrs, discussions, jobs, glabError, malformed }
  writeFileSync(join(root, 'glab'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const config = ${JSON.stringify(config)};
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (config.glabError) { console.error('x509: certificate error'); process.exit(1); }
if (config.malformed) { console.log('<html>'); process.exit(0); }
if (args[0] === 'mr' && args[1] === 'list') console.log(JSON.stringify(config.mrs));
else if (args[0] === 'mr' && args[1] === 'view') console.log(JSON.stringify(config.mrs.find((m) => String(m.iid) === args[2])));
else if (args[0] === 'api' && /discussions/.test(args[1])) console.log(JSON.stringify(config.discussions[args[1].match(/merge_requests\\/(\\d+)/)[1]] ?? []));
else if (args[0] === 'api' && /pipelines/.test(args[1])) console.log(JSON.stringify(config.jobs[args[1].match(/pipelines\\/(\\d+)/)[1]] ?? []));
else process.exit(1);
`, { mode: 0o755 })
  const result = spawnSync(process.execPath, [CLI, '--repo', root, ...(json ? ['--json'] : []), ...args],
    { encoding: 'utf8', env: { ...process.env, PATH: `${root}:${process.env.PATH}` } })
  const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  for (const c of calls) assertReadOnly(c)
  return { status: result.status, out: result.stdout, rows: json && result.status !== 2 ? JSON.parse(result.stdout) : null, calls }
}

test('baseName strips the develop twin suffix only', () => {
  assert.equal(baseName('fix/PROJ-1/x_develop'), 'fix/PROJ-1/x')
  assert.equal(baseName('fix/PROJ-1/x_dev'), 'fix/PROJ-1/x')
  assert.equal(baseName('fix/PROJ-1/dev_tools'), 'fix/PROJ-1/dev_tools')
})

test('conflicts win over threads and CI', (t) => {
  const { status, rows } = run(t, { mrs: [mr(1, 'fix/a', { has_conflicts: true, detailed_merge_status: 'conflict' })],
    discussions: { 1: [thread('alice', 'src/a.vue', 4, 'nit')] } })
  assert.equal(status, 1)
  assert.equal(rows[0].state, 'conflicts')
  assert.match(rows[0].next, /rebase fix\/a onto main/)
})

test('threads: counts unresolved resolvable threads, ignores resolved ones and bot summaries, in JSON and in the table', (t) => {
  const config = { mrs: [mr(2, 'fix/b', { detailed_merge_status: 'discussions_not_resolved', blocking_discussions_resolved: false })],
    discussions: { 2: [thread('review-bot', 'src/b.vue', 54, '[P2] Await loading\nmore'), thread('alice', 'src/c.vue', 9, 'done', true), summary('No blocking issues; 0 findings.')] } }
  const { status, rows } = run(t, config)
  assert.equal(status, 1)
  assert.equal(rows[0].state, 'threads')
  assert.deepEqual(rows[0].threads, [{ author: 'review-bot', where: 'src/b.vue:54', head: '[P2] Await loading' }])
  const text = run(t, { ...config, json: false })
  assert.equal(text.status, 1)
  assert.match(text.out, /^mr\s+branch\s+state\s+threads\s+next$/m)
  assert.match(text.out, /^!2\s+fix\/b -> main\s+threads\s+1\s+1 unresolved thread\(s\)/m)
  assert.match(text.out, /^ {2}!2 review-bot src\/b\.vue:54: \[P2\] Await loading$/m)
  assert.match(text.out, /^1 twin group\(s\), 1 need action, 0 ready$/m)
  assert.doesNotMatch(text.out, /src\/c\.vue|No blocking issues|more/)
})

test('a list at the 100 cap fails closed with exit 2', (t) => {
  const mrs = Array.from({ length: 100 }, (_, i) => mr(i + 1, `fix/n${i + 1}`))
  const { status, out } = run(t, { mrs })
  assert.equal(status, 2)
  assert.match(JSON.parse(out).problems[0], /truncated: glab mr list/)
})

test('twins pair only across different targets', (t) => {
  const { rows } = run(t, { mrs: [mr(11, 'feat/enable_dev', { target_branch: 'main' }), mr(12, 'feat/enable')] })
  assert.deepEqual(rows.map((r) => r.twinIid), [null, null])
})

test('ci-failed lists failed jobs and drops allow_failure ones', (t) => {
  const { status, rows, calls } = run(t, { mrs: [mr(3, 'fix/c', { detailed_merge_status: 'ci_must_pass', head_pipeline: { id: 103, status: 'failed', sha: SHA } })],
    jobs: { 103: [{ name: 'Lint', allow_failure: false }, { name: 'Audit', allow_failure: true }] } })
  assert.equal(status, 1)
  assert.equal(rows[0].state, 'ci-failed')
  assert.match(rows[0].next, /Lint/)
  assert.doesNotMatch(rows[0].next, /Audit/)
  assert.ok(calls.some((c) => c[0] === 'api' && c[1].includes('pipelines/103/jobs')))
})

test('ci-stale when the head pipeline ran on an older commit', (t) => {
  const { rows } = run(t, { mrs: [mr(4, 'fix/d', { head_pipeline: { id: 104, status: 'success', sha: 'b'.repeat(40) } })] })
  assert.equal(rows[0].state, 'ci-stale')
})

test('checking is not ready', (t) => {
  const { status, rows } = run(t, { mrs: [mr(5, 'fix/e', { detailed_merge_status: 'checking' })] })
  assert.equal(status, 1)
  assert.equal(rows[0].state, 'checking')
})

test('all mergeable exits 0', (t) => {
  const { status, rows } = run(t, { mrs: [mr(6, 'fix/f')] })
  assert.equal(status, 0)
  assert.equal(rows[0].state, 'ready')
})

test('twins: --branch on the develop twin selects both, home first, and a blocker names the twin', (t) => {
  const { rows } = run(t, { mrs: [mr(9, 'fix/g_develop', { detailed_merge_status: 'discussions_not_resolved' }), mr(8, 'fix/g'), mr(7, 'fix/other')],
    discussions: { 9: [thread('alice', 'src/g.vue', 1, 'please guard null')] }, args: ['--branch', 'fix/g_develop'] })
  assert.deepEqual(rows.map((r) => r.iid), [8, 9])
  assert.equal(rows[0].twinIid, 9)
  assert.match(rows[1].next, /twin !8/)
})

test('glab failure exits 2 with an unavailable line, malformed JSON too', (t) => {
  const broken = run(t, { mrs: [], glabError: true })
  assert.equal(broken.status, 2)
  assert.equal(JSON.parse(broken.out).status, 'unavailable')
  const html = run(t, { mrs: [], malformed: true })
  assert.equal(html.status, 2)
})

test('assertReadOnly admits only mr list, mr view and a bare api path', () => {
  for (const ok of [['mr', 'list', '--author', '@me', '-F', 'json'], ['mr', 'view', '7', '-F', 'json'], ['api', 'projects/:id/merge_requests/7/discussions?per_page=100']]) {
    assert.doesNotThrow(() => assertReadOnly(ok))
  }
  for (const bad of [['mr', 'merge', '7'], ['mr', 'note', '7', '-m', 'x'], ['mr', 'rebase', '7'], ['ci', 'retry', '1'],
    ['api', 'projects/:id/x', '--method', 'POST'], ['api', 'projects/:id/x', '-X', 'PUT'], ['api', 'projects/:id/x', '--raw-field', 'a=b'], ['api', '--method', 'DELETE']]) {
    assert.throws(() => assertReadOnly(bad), /read-only/)
  }
})

test('verdict and unresolved are pure', () => {
  assert.equal(verdict(mr(1, 'x', { head_pipeline: null }), [], []).state, 'ci-none')
  assert.equal(unresolved([summary('x')]).length, 0)
})
