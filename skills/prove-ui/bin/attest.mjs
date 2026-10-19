#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { manifestDir, repoRoot, sha256, treeFingerprint } from '../lib/proof.mjs'

const FAILED_OUTCOMES = ['PRECONDITION_UNMET', 'BEHAVIOR_MISMATCH']
const EMPTY = sha256('')

const isAncestor = (root, ancestor, descendant) =>
  spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd: root, stdio: 'ignore' }).status === 0

const isString = (value) => typeof value === 'string'

const isValid = (manifest, phase) =>
  manifest !== null && typeof manifest === 'object' && manifest.phase === phase &&
  [manifest.outcome, manifest.criterionSha256, manifest.route, manifest.interaction].every(isString) &&
  manifest.tree !== null && typeof manifest.tree === 'object' && ['head', 'diff', 'untracked'].every((key) => isString(manifest.tree[key]))

const readManifest = (dir, phase) => {
  const file = path.join(dir, `${phase}.json`)
  if (!fs.existsSync(file)) return null
  try {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
    return isValid(manifest, phase) ? manifest : { invalid: true }
  } catch {
    return { invalid: true }
  }
}

export const attest = (checkPath, cwd = process.cwd()) => {
  const check = path.resolve(cwd, checkPath)
  if (!fs.existsSync(check) || !fs.statSync(check).isFile()) return { code: 'CHECK_MISSING' }
  const id = path.basename(check, '.mjs')
  let root
  try {
    root = repoRoot(cwd)
  } catch {
    return { code: 'NOT_A_REPO' }
  }
  const dir = manifestDir(root, id)
  const baseline = readManifest(dir, 'baseline')
  if (!baseline) return { code: 'BASELINE_MISSING' }
  const candidate = readManifest(dir, 'candidate')
  if (!candidate) return { code: 'CANDIDATE_MISSING' }
  for (const manifest of [baseline, candidate]) {
    if (manifest.invalid) return { code: 'MANIFEST_INVALID' }
    if (FAILED_OUTCOMES.includes(manifest.outcome)) return { code: manifest.outcome, detail: manifest.phase }
    if (manifest.outcome !== 'OBSERVED') return { code: 'MANIFEST_INVALID', detail: manifest.phase }
  }
  const current = sha256(fs.readFileSync(check))
  if (baseline.criterionSha256 !== current || candidate.criterionSha256 !== current) return { code: 'CRITERION_CHANGED' }
  if (isString(baseline.codeRoot) && baseline.codeRoot !== root) {
    if (baseline.tree.diff !== EMPTY || baseline.tree.untracked !== EMPTY) return { code: 'BASELINE_DIRTY' }
    if (!isAncestor(root, baseline.tree.head, candidate.tree.head)) return { code: 'BASELINE_NOT_ANCESTOR' }
  }
  if (isDeepStrictEqual(baseline.tree, candidate.tree)) return { code: 'TREE_UNCHANGED' }
  if (!isDeepStrictEqual(candidate.tree, treeFingerprint(root))) return { code: 'CANDIDATE_STALE' }
  for (const manifest of [baseline, candidate]) {
    if (typeof manifest.screenshot !== 'string' || !fs.existsSync(manifest.screenshot)) return { code: 'SCREENSHOT_MISSING', detail: manifest.phase }
  }
  const rel = (p) => path.relative(root, p)
  return {
    code: 'OK',
    line: `verified in-browser: ${candidate.route} — ${candidate.interaction} (baseline: ${rel(path.join(dir, 'baseline.json'))}; screenshot: ${rel(candidate.screenshot)})`
  }
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))

if (isMain) {
  const [checkPath] = process.argv.slice(2)
  if (!checkPath) {
    console.log('USAGE: node attest.mjs <path/to/check.mjs>')
    process.exit(2)
  }
  const result = attest(checkPath)
  console.log(result.code === 'OK' ? result.line : [result.code, result.detail].filter(Boolean).join(' '))
  process.exit(result.code === 'OK' ? 0 : 1)
}
