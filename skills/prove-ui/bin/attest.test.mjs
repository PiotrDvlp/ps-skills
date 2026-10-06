import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createProof, manifestDir } from '../lib/proof.mjs'
import { makeRepo } from '../lib/test-repo.mjs'
import { attest } from './attest.mjs'

delete process.env.PROVE_UI_PHASE
delete process.env.PROVE_UI_EVIDENCE_ROOT

const CLI = fileURLToPath(new URL('./attest.mjs', import.meta.url))
const EXP = { baseline: 'rgba(0, 0, 0, 0)', candidate: { not: 'rgba(0, 0, 0, 0)' } }
const VALUE = { baseline: 'rgba(0, 0, 0, 0)', candidate: 'rgb(16, 16, 16)' }

const prove = async (r, phase, { ready = true, value = VALUE[phase] } = {}) => {
  const p = createProof({ id: r.id, feature: 'f', route: '/', interaction: 'focus link', baseUrl: 'http://127.0.0.1:4100', file: r.file, shot: r.shot, phase })
  try {
    await p.precondition('ready', ready)
    await p.observe('outline-color', value, EXP)
    await p.finish()
  } catch {}
}

const proven = async () => {
  const r = makeRepo()
  await prove(r, 'baseline')
  r.edit()
  await prove(r, 'candidate')
  return r
}

test('a check path that does not exist: CHECK_MISSING', () => {
  const r = makeRepo()
  assert.equal(attest(path.join(r.root, 'nope.mjs'), r.root).code, 'CHECK_MISSING')
})

test('a check path that is a directory: CHECK_MISSING', () => {
  const r = makeRepo()
  assert.equal(attest(path.dirname(r.checkPath), r.root).code, 'CHECK_MISSING')
})

test('a check file outside any git repo: NOT_A_REPO', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? '/tmp'), 'prove ui no-repo-'))
  const check = path.join(dir, 'loose-check.mjs')
  fs.writeFileSync(check, 'export default async () => {}\n')
  assert.equal(attest(check, dir).code, 'NOT_A_REPO')
})

test('no manifests: BASELINE_MISSING', () => {
  const r = makeRepo()
  assert.equal(attest(r.checkPath, r.root).code, 'BASELINE_MISSING')
})

test('baseline only: CANDIDATE_MISSING', async () => {
  const r = makeRepo()
  await prove(r, 'baseline')
  assert.equal(attest(r.checkPath, r.root).code, 'CANDIDATE_MISSING')
})

test('candidate precondition false: PRECONDITION_UNMET', async () => {
  const r = makeRepo()
  await prove(r, 'baseline')
  r.edit()
  await prove(r, 'candidate', { ready: false })
  assert.equal(attest(r.checkPath, r.root).code, 'PRECONDITION_UNMET')
})

test('candidate on the unchanged tree observing the old value: BEHAVIOR_MISMATCH', async () => {
  const r = makeRepo()
  await prove(r, 'baseline')
  await prove(r, 'candidate', { value: VALUE.baseline })
  assert.equal(attest(r.checkPath, r.root).code, 'BEHAVIOR_MISMATCH')
})

test('check file edited after the runs: CRITERION_CHANGED', async () => {
  const r = await proven()
  fs.appendFileSync(r.checkPath, '\n')
  assert.equal(attest(r.checkPath, r.root).code, 'CRITERION_CHANGED')
})

test('both phases on the same code: TREE_UNCHANGED', async () => {
  const r = makeRepo()
  await prove(r, 'baseline')
  await prove(r, 'candidate')
  assert.equal(attest(r.checkPath, r.root).code, 'TREE_UNCHANGED')
})

test('code changed again after the candidate run: CANDIDATE_STALE', async () => {
  const r = await proven()
  fs.appendFileSync(path.join(r.root, 'app.css'), 'a { outline: none }\n')
  assert.equal(attest(r.checkPath, r.root).code, 'CANDIDATE_STALE')
})

test('candidate screenshot deleted: SCREENSHOT_MISSING', async () => {
  const r = await proven()
  const candidate = JSON.parse(fs.readFileSync(path.join(manifestDir(r.root, r.id), 'candidate.json'), 'utf8'))
  fs.rmSync(candidate.screenshot)
  assert.equal(attest(r.checkPath, r.root).code, 'SCREENSHOT_MISSING')
})

test('corrupted manifest: MANIFEST_INVALID', async () => {
  const r = await proven()
  fs.writeFileSync(path.join(manifestDir(r.root, r.id), 'baseline.json'), '{not json')
  assert.equal(attest(r.checkPath, r.root).code, 'MANIFEST_INVALID')
})

test('valid JSON without a tree fingerprint: MANIFEST_INVALID', async () => {
  const r = await proven()
  const file = path.join(manifestDir(r.root, r.id), 'candidate.json')
  const { tree, ...rest } = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify(rest))
  assert.equal(attest(r.checkPath, r.root).code, 'MANIFEST_INVALID')
})

const baseCheckout = (fix) => {
  const root = `${fix.root}-base`
  spawnSync('git', ['worktree', 'add', '-q', '-b', 'prove-ui/base-demo', root, 'HEAD'], { cwd: fix.root })
  const check = path.join(root, '.claude', 'prove-ui', 'checks', `${fix.id}.mjs`)
  fs.mkdirSync(path.dirname(check), { recursive: true })
  fs.copyFileSync(fix.checkPath, check)
  const shot = async (name) => {
    const p = path.join(root, '.distro', 'browser', 'run-base', `${name}.png`)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, 'png')
    return p
  }
  return { root, file: pathToFileURL(check).href, shot, remove: () => spawnSync('git', ['worktree', 'remove', '--force', root], { cwd: fix.root }) }
}

const proveBaselineIn = async (base, fix) => {
  const p = createProof({ id: fix.id, feature: 'f', route: '/', interaction: 'focus link', baseUrl: 'http://127.0.0.1:4100', file: base.file, shot: base.shot, phase: 'baseline', evidenceRoot: fix.root })
  await p.precondition('ready', true)
  await p.observe('outline-color', VALUE.baseline, EXP)
  await p.finish()
}

test('verify-fix: baseline from a removed base worktree into the evidence root attests OK', async () => {
  const fix = makeRepo()
  const base = baseCheckout(fix)
  await proveBaselineIn(base, fix)
  base.remove()
  assert.equal(fs.existsSync(base.root), false)
  fix.edit()
  await prove(fix, 'candidate')
  assert.equal(attest(fix.checkPath, fix.root).code, 'OK')
})

test('verify-fix: a base checkout with uncommitted edits gives BASELINE_DIRTY', async () => {
  const fix = makeRepo()
  const base = baseCheckout(fix)
  fs.appendFileSync(path.join(base.root, 'app.css'), 'a { color: blue }\n')
  await proveBaselineIn(base, fix)
  fix.edit()
  await prove(fix, 'candidate')
  assert.equal(attest(fix.checkPath, fix.root).code, 'BASELINE_DIRTY')
})

test('verify-fix: a baseline from an unrelated repo gives BASELINE_NOT_ANCESTOR', async () => {
  const fix = makeRepo()
  const other = makeRepo()
  spawnSync('git', ['-c', 'user.email=o@example.com', '-c', 'user.name=o', 'commit', '-q', '--allow-empty', '-m', 'unrelated'], { cwd: other.root })
  await proveBaselineIn({ file: other.file, shot: other.shot }, fix)
  fix.edit()
  await prove(fix, 'candidate')
  assert.equal(attest(fix.checkPath, fix.root).code, 'BASELINE_NOT_ANCESTOR')
})

test('happy path prints the done-gate line with repo-relative paths', async () => {
  const r = await proven()
  const result = attest(r.checkPath, r.root)
  assert.equal(result.code, 'OK')
  assert.equal(result.line, 'verified in-browser: / — focus link (baseline: .distro/browser/prove-ui/demo-check/baseline.json; screenshot: .distro/browser/run-2/demo-check.png)')
})

test('relative check path from a subdirectory still passes', async () => {
  const r = await proven()
  assert.equal(attest(path.join('prove-ui', 'checks', 'demo-check.mjs'), path.join(r.root, '.claude')).code, 'OK')
})

test('CLI exit codes: 1 with the code first, 0 with the line, 2 without an argument', async () => {
  const r = makeRepo()
  const fail = spawnSync(process.execPath, [CLI, r.checkPath], { cwd: r.root, encoding: 'utf8' })
  assert.equal(fail.status, 1)
  assert.equal(fail.stdout.split(/\s/)[0], 'BASELINE_MISSING')
  await prove(r, 'baseline')
  r.edit()
  await prove(r, 'candidate')
  const ok = spawnSync(process.execPath, [CLI, r.checkPath], { cwd: r.root, encoding: 'utf8' })
  assert.equal(ok.status, 0)
  assert.match(ok.stdout, /^verified in-browser: \/ — focus link/)
  const usage = spawnSync(process.execPath, [CLI], { cwd: r.root, encoding: 'utf8' })
  assert.equal(usage.status, 2)
})
