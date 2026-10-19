import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createProof, manifestDir, treeFingerprint } from './proof.mjs'
import { makeRepo } from './test-repo.mjs'

delete process.env.PROVE_UI_PHASE
delete process.env.PROVE_UI_EVIDENCE_ROOT

const EXP = { baseline: 'rgba(0, 0, 0, 0)', candidate: { not: 'rgba(0, 0, 0, 0)' } }

const setup = (over = {}) => {
  const r = makeRepo()
  const opts = { id: r.id, feature: 'f', route: '/', interaction: 'focus link', baseUrl: 'http://127.0.0.1:4100', file: r.file, shot: r.shot, phase: 'baseline', cwd: r.root, ...over }
  const manifestPath = (phase = opts.phase) => path.join(manifestDir(r.root, r.id), `${phase}.json`)
  const manifest = (phase) => (fs.existsSync(manifestPath(phase)) ? JSON.parse(fs.readFileSync(manifestPath(phase), 'utf8')) : null)
  return { r, opts, manifestPath, manifest }
}

test('fixture repo path contains a space', () => {
  const { r } = setup()
  assert.match(r.root, / /)
})

test('missing or unknown phase throws PHASE_INVALID', () => {
  for (const phase of [undefined, 'other']) {
    const { opts } = setup({ phase })
    assert.throws(() => createProof(opts), { code: 'PHASE_INVALID' })
  }
})

test('id must equal the check file basename', () => {
  const { opts } = setup({ id: 'other-id' })
  assert.throws(() => createProof(opts), { code: 'ID_MISMATCH' })
})

test('createProof deletes a stale manifest of its own phase', () => {
  const { opts, manifestPath } = setup()
  fs.mkdirSync(path.dirname(manifestPath()), { recursive: true })
  fs.writeFileSync(manifestPath(), '{"outcome":"OBSERVED"}')
  createProof(opts)
  assert.equal(fs.existsSync(manifestPath()), false)
})

test('identical expectations throw NOT_DISTINCT', async () => {
  for (const expected of [{ baseline: 'x', candidate: 'x' }, { baseline: 'x', candidate: { not: 'y' } }]) {
    const { opts } = setup()
    const p = createProof(opts)
    await assert.rejects(p.observe('v', 'x', expected), { code: 'NOT_DISTINCT' })
  }
})

test('false precondition writes PRECONDITION_UNMET and throws', async () => {
  const { opts, manifest } = setup()
  const p = createProof(opts)
  await assert.rejects(p.precondition('ready', false), { code: 'PRECONDITION_UNMET' })
  assert.equal(manifest().outcome, 'PRECONDITION_UNMET')
})

test('baseline observing the candidate value writes BEHAVIOR_MISMATCH', async () => {
  const { opts, manifest } = setup()
  const p = createProof(opts)
  await p.precondition('ready', true)
  await assert.rejects(p.observe('outline-color', 'rgb(16, 16, 16)', EXP), { code: 'BEHAVIOR_MISMATCH' })
  assert.equal(manifest().outcome, 'BEHAVIOR_MISMATCH')
})

test('a later failing observation records both and ends BEHAVIOR_MISMATCH', async () => {
  const { opts, manifest } = setup()
  const p = createProof(opts)
  await p.precondition('ready', true)
  await p.observe('first', 'rgba(0, 0, 0, 0)', EXP)
  await assert.rejects(p.observe('second', 'rgb(16, 16, 16)', EXP), { code: 'BEHAVIOR_MISMATCH' })
  assert.equal(manifest().observations.length, 2)
  assert.equal(manifest().outcome, 'BEHAVIOR_MISMATCH')
})

test('an undefined observed value is a mismatch with a readable manifest', async () => {
  const { opts, manifest } = setup()
  const p = createProof(opts)
  await p.precondition('ready', true)
  await assert.rejects(p.observe('outline-color', undefined, EXP), { code: 'BEHAVIOR_MISMATCH' })
  assert.equal(manifest().outcome, 'BEHAVIOR_MISMATCH')
})

test('finish after a caught mismatch keeps BEHAVIOR_MISMATCH instead of writing OBSERVED', async () => {
  const { opts, manifest } = setup()
  const p = createProof(opts)
  await p.precondition('ready', true)
  await p.observe('outline-color', 'rgb(16, 16, 16)', EXP).catch(() => {})
  await assert.rejects(p.finish(), { code: 'BEHAVIOR_MISMATCH' })
  assert.equal(manifest().outcome, 'BEHAVIOR_MISMATCH')
})

test('finish after a caught unmet precondition keeps PRECONDITION_UNMET', async () => {
  const { opts, manifest } = setup()
  const p = createProof(opts)
  await p.precondition('ready', false).catch(() => {})
  await p.observe('outline-color', 'rgba(0, 0, 0, 0)', EXP)
  await assert.rejects(p.finish(), { code: 'PRECONDITION_UNMET' })
  assert.equal(manifest().outcome, 'PRECONDITION_UNMET')
})

test('finish without a precondition or an observation throws PROOF_INCOMPLETE', async () => {
  const { opts, manifest } = setup()
  const p = createProof(opts)
  await assert.rejects(p.finish(), { code: 'PROOF_INCOMPLETE' })
  assert.equal(manifest(), null)
})

test('a throwing shot leaves no manifest and no temp file', async () => {
  const { opts, manifestPath } = setup({ shot: async () => { throw new Error('crash') } })
  const p = createProof(opts)
  await p.precondition('ready', true)
  await p.observe('outline-color', 'rgba(0, 0, 0, 0)', EXP)
  await assert.rejects(p.finish(), /crash/)
  const dir = path.dirname(manifestPath())
  assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], [])
})

test('happy path writes OBSERVED with screenshot and hashes', async () => {
  const { opts, manifest } = setup()
  const p = createProof(opts)
  await p.precondition('ready', true)
  await p.observe('outline-color', 'rgba(0, 0, 0, 0)', EXP)
  await p.finish()
  const m = manifest()
  assert.equal(m.outcome, 'OBSERVED')
  assert.equal(fs.existsSync(m.screenshot), true)
  assert.match(m.criterionSha256, /^[0-9a-f]{64}$/)
  assert.match(m.tree.head, /^[0-9a-f]{40}$/)
  assert.equal(m.baseUrl, 'http://127.0.0.1:4100')
})

test('adding only an untracked file changes the tree fingerprint', () => {
  const { r } = setup()
  const before = treeFingerprint(r.root)
  fs.writeFileSync(path.join(r.root, 'NewBadge.vue'), '<template />\n')
  assert.notDeepEqual(treeFingerprint(r.root), before)
})

test('an untracked symlink to a directory does not crash the fingerprint', () => {
  const { r } = setup()
  fs.mkdirSync(path.join(r.root, 'vendor-src'))
  fs.writeFileSync(path.join(r.root, 'vendor-src', 'a.txt'), 'a\n')
  fs.symlinkSync(path.join(r.root, 'vendor-src'), path.join(r.root, 'vendor-link'))
  assert.doesNotThrow(() => treeFingerprint(r.root))
})

test('manifests outside an ignored .distro/ throw DISTRO_NOT_IGNORED', () => {
  const { r, opts } = setup()
  fs.writeFileSync(path.join(r.root, '.gitignore'), '.claude/\n')
  assert.throws(() => createProof(opts), { code: 'DISTRO_NOT_IGNORED' })
})

test('an evidence root receives the manifest and a screenshot copy, fingerprinting the code that ran', async () => {
  const { r, opts } = setup()
  const evidence = makeRepo()
  const p = createProof({ ...opts, evidenceRoot: evidence.root })
  await p.precondition('ready', true)
  await p.observe('outline-color', 'rgba(0, 0, 0, 0)', EXP)
  await p.finish()
  const file = path.join(manifestDir(evidence.root, r.id), 'baseline.json')
  const m = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(m.outcome, 'OBSERVED')
  assert.equal(path.dirname(m.screenshot), manifestDir(evidence.root, r.id))
  assert.equal(fs.existsSync(m.screenshot), true)
  assert.deepEqual(m.tree, treeFingerprint(r.root))
  assert.equal(fs.existsSync(path.join(manifestDir(r.root, r.id), 'baseline.json')), false)
})

test('an evidence root without an ignored .distro/ throws DISTRO_NOT_IGNORED', () => {
  const { opts } = setup()
  const evidence = makeRepo()
  fs.writeFileSync(path.join(evidence.root, '.gitignore'), '.claude/\n')
  assert.throws(() => createProof({ ...opts, evidenceRoot: evidence.root }), { code: 'DISTRO_NOT_IGNORED' })
})

test('PROVE_UI_EVIDENCE_ROOT from the environment redirects the manifest', async () => {
  const { r, opts } = setup()
  const evidence = makeRepo()
  process.env.PROVE_UI_EVIDENCE_ROOT = evidence.root
  try {
    const p = createProof(opts)
    await p.precondition('ready', true)
    await p.observe('outline-color', 'rgba(0, 0, 0, 0)', EXP)
    await p.finish()
  } finally {
    delete process.env.PROVE_UI_EVIDENCE_ROOT
  }
  assert.equal(fs.existsSync(path.join(manifestDir(evidence.root, r.id), 'baseline.json')), true)
})

test('an evidence root inside the same repo keeps the normal path and records codeRoot', async () => {
  const { r, opts, manifest } = setup()
  const p = createProof({ ...opts, evidenceRoot: path.join(r.root, '.claude') })
  await p.precondition('ready', true)
  await p.observe('outline-color', 'rgba(0, 0, 0, 0)', EXP)
  await p.finish()
  const m = manifest()
  assert.equal(path.basename(m.screenshot), `${r.id}.png`)
  assert.equal(m.codeRoot, r.root)
})

test('an evidence root that is missing or outside git throws EVIDENCE_ROOT_INVALID', () => {
  const { opts } = setup()
  const loose = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? '/tmp'), 'prove ui loose-'))
  for (const evidenceRoot of [path.join(loose, 'missing'), loose]) {
    assert.throws(() => createProof({ ...opts, evidenceRoot }), { code: 'EVIDENCE_ROOT_INVALID' })
  }
})
