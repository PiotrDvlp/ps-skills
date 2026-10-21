import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const PHASES = ['baseline', 'candidate']

export class ProofError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`)
    this.code = code
  }
}

export const sha256 = (data) => createHash('sha256').update(data).digest('hex')

const git = (args, cwd) => execFileSync('git', args, { cwd, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })

export const repoRoot = (cwd = process.cwd()) => git(['rev-parse', '--show-toplevel'], cwd).toString().trim()

const entryContent = (file) => {
  const stat = fs.lstatSync(file)
  return stat.isSymbolicLink() ? fs.readlinkSync(file) : stat.isFile() ? fs.readFileSync(file) : ''
}

export const treeFingerprint = (root) => {
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z'], root).toString().split('\0').filter(Boolean).sort()
  const hash = createHash('sha256')
  for (const file of untracked) hash.update(file).update('\0').update(entryContent(path.join(root, file))).update('\0')
  return {
    head: git(['rev-parse', 'HEAD'], root).toString().trim(),
    diff: sha256(git(['diff', 'HEAD', '--binary'], root)),
    untracked: hash.digest('hex')
  }
}

export const manifestDir = (root, id) => path.join(root, '.distro', 'browser', 'prove-ui', id)

const isNot = (expected) => expected !== null && typeof expected === 'object' && !Array.isArray(expected) && Object.keys(expected).length === 1 && 'not' in expected

const matches = (value, expected) => (isNot(expected) ? !isDeepStrictEqual(value, expected.not) : isDeepStrictEqual(value, expected))

/**
 * @remarks The code under proof is the repo of `cwd` (the harness pins it to the checkout root),
 * not the repo holding the check file, so a check can live in a per-project store outside the repo.
 */
export const createProof = ({ id, feature, route, interaction, baseUrl, file, shot, phase = process.env.PROVE_UI_PHASE, evidenceRoot = process.env.PROVE_UI_EVIDENCE_ROOT, cwd = process.cwd() }) => {
  if (!PHASES.includes(phase)) throw new ProofError('PHASE_INVALID', `PROVE_UI_PHASE must be baseline or candidate, got ${JSON.stringify(phase)}`)
  const filePath = fileURLToPath(file)
  if (path.basename(filePath, '.mjs') !== id) throw new ProofError('ID_MISMATCH', `id ${id} must equal the check file name ${path.basename(filePath)}`)
  for (const [key, value] of Object.entries({ feature, route, interaction })) {
    if (typeof value !== 'string' || !value) throw new ProofError('FIELD_MISSING', key)
  }
  if (typeof shot !== 'function') throw new ProofError('FIELD_MISSING', 'shot')
  let root
  try {
    root = repoRoot(cwd)
  } catch {
    throw new ProofError('NOT_A_REPO', `${cwd} is not inside a git repo; run from the checkout root`)
  }
  let outRoot = root
  if (evidenceRoot) {
    try {
      outRoot = repoRoot(path.resolve(evidenceRoot))
    } catch {
      throw new ProofError('EVIDENCE_ROOT_INVALID', `${evidenceRoot} is missing or not inside a git repo`)
    }
  }
  try {
    git(['check-ignore', '-q', path.join('.distro', 'browser', 'prove-ui')], outRoot)
  } catch {
    throw new ProofError('DISTRO_NOT_IGNORED', `${outRoot}/.distro/ must be gitignored, or manifests change the tree fingerprint`)
  }
  const dir = manifestDir(outRoot, id)
  const target = path.join(dir, `${phase}.json`)
  fs.rmSync(target, { force: true })
  const base = { schemaVersion: 1, id, phase, feature, route, interaction, baseUrl, codeRoot: root, criterionSha256: sha256(fs.readFileSync(filePath)), tree: treeFingerprint(root) }
  const preconditions = []
  const observations = []
  const write = (outcome, extra = {}) => {
    fs.mkdirSync(dir, { recursive: true })
    const tmp = `${target}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ ...base, preconditions, observations, outcome, ...extra, finishedAt: new Date().toISOString() }, null, 2))
    fs.renameSync(tmp, target)
  }
  return {
    async precondition(name, ok) {
      preconditions.push({ name, ok: ok === true })
      if (ok !== true) {
        write('PRECONDITION_UNMET')
        throw new ProofError('PRECONDITION_UNMET', name)
      }
    },
    async observe(name, value, expected) {
      if (!expected || !('baseline' in expected) || !('candidate' in expected) || isNot(expected.baseline)) {
        throw new ProofError('EXPECTED_INVALID', `${name}: needs a literal baseline and a literal or { not } candidate`)
      }
      if (matches(expected.baseline, expected.candidate)) throw new ProofError('NOT_DISTINCT', name)
      const ok = matches(value, expected[phase])
      observations.push({ name, value: value === undefined ? null : value, expected, ok })
      if (!ok) {
        write('BEHAVIOR_MISMATCH')
        throw new ProofError('BEHAVIOR_MISMATCH', `${name}: observed ${JSON.stringify(value)}`)
      }
    },
    async finish() {
      if (!preconditions.length || !observations.length) throw new ProofError('PROOF_INCOMPLETE', 'needs at least one precondition and one observation')
      const failed = preconditions.some((c) => !c.ok) ? 'PRECONDITION_UNMET' : observations.some((o) => !o.ok) ? 'BEHAVIOR_MISMATCH' : null
      if (failed) throw new ProofError(failed, 'a failed step was caught before finish()')
      const shotPath = await shot(id)
      let screenshot = shotPath
      if (outRoot !== root) {
        fs.mkdirSync(dir, { recursive: true })
        screenshot = path.join(dir, `${phase}${path.extname(shotPath)}`)
        fs.copyFileSync(shotPath, screenshot)
      }
      write('OBSERVED', { screenshot })
    }
  }
}
