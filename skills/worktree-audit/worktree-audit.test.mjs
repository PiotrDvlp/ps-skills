import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { audit, formatMr, targetFor } from './worktree-audit.mjs'

const repo = () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wt audit repo-')))
  const git = (...args) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: root }).toString().trim()
  git('init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\n')
  git('add', '.')
  git('commit', '-q', '-m', 'base')
  git('branch', 'develop')
  git('update-ref', 'refs/remotes/origin/main', 'main')
  git('update-ref', 'refs/remotes/origin/develop', 'develop')
  const commit = (cwd, name) => {
    fs.writeFileSync(path.join(cwd, `${name}.txt`), `${name}\n`)
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'add', '.'], { cwd })
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', name], { cwd })
  }
  return { root, git, commit }
}

const row = (rows, branch) => rows.find((r) => r.branch === branch)

test('targetFor picks develop for _develop and _dev twins, main otherwise', () => {
  assert.equal(targetFor('fix/PROJ-1/x_develop'), 'origin/develop')
  assert.equal(targetFor('fix/PROJ-1/x_dev'), 'origin/develop')
  assert.equal(targetFor('fix/PROJ-1/x'), 'origin/main')
  assert.equal(targetFor(null), null)
})

test('ahead, behind and contained are measured against the twin target', () => {
  const r = repo()
  const wt = path.join(r.root, '.claude', 'worktrees', 'fix x_develop')
  r.git('worktree', 'add', '-q', '-b', 'fix/x_develop', wt, 'develop')
  r.commit(wt, 'fix')
  r.git('checkout', '-q', 'develop')
  r.commit(r.root, 'upstream1')
  r.commit(r.root, 'upstream2')
  r.git('update-ref', 'refs/remotes/origin/develop', 'develop')
  const twin = row(audit(r.root), 'fix/x_develop')
  assert.equal(twin.target, 'origin/develop')
  assert.equal(twin.ahead, 1)
  assert.equal(twin.behind, 2)
  assert.equal(twin.contained, false)
})

test('a branch with no commits beyond its target is contained', () => {
  const r = repo()
  const wt = path.join(r.root, 'merged-wt')
  r.git('worktree', 'add', '-q', '-b', 'chore/done', wt, 'main')
  const done = row(audit(r.root), 'chore/done')
  assert.equal(done.ahead, 0)
  assert.equal(done.contained, true)
})

test('node_modules presence is reported per worktree', () => {
  const r = repo()
  const wt = path.join(r.root, 'deps wt')
  r.git('worktree', 'add', '-q', '-b', 'feat/deps', wt, 'main')
  fs.mkdirSync(path.join(wt, 'node_modules'))
  const rows = audit(r.root)
  assert.equal(row(rows, 'feat/deps').nodeModules, true)
  assert.equal(rows.find((x) => x.path === r.root).nodeModules, false)
})

test('a detached worktree has no target and does not crash', () => {
  const r = repo()
  const wt = path.join(r.root, 'detached')
  r.git('worktree', 'add', '-q', '--detach', wt, 'main')
  const d = audit(r.root).find((x) => x.path === wt)
  assert.equal(d.branch, null)
  assert.equal(d.target, null)
  assert.equal(d.ahead, null)
})

test('a missing target ref is reported, not thrown', () => {
  const r = repo()
  r.git('update-ref', '-d', 'refs/remotes/origin/develop')
  const wt = path.join(r.root, 'twin')
  r.git('worktree', 'add', '-q', '-b', 'fix/y_develop', wt, 'main')
  const twin = row(audit(r.root), 'fix/y_develop')
  assert.equal(twin.target, 'origin/develop')
  assert.equal(twin.ahead, null)
  assert.equal(twin.error, 'origin/develop missing')
})

test('formatMr summarises glab JSON and empty lists', () => {
  assert.equal(formatMr([]), 'none')
  assert.equal(formatMr([{ iid: 2200, state: 'opened', draft: false }, { iid: 2100, state: 'merged', draft: true }]), '!2200 opened, !2100 merged draft')
})

test('uncommitted work is reported as dirty even when the branch is contained', () => {
  const r = repo()
  const wt = `${r.root}-wip wt`
  r.git('worktree', 'add', '-q', '-b', 'perf/wip', wt, 'main')
  fs.writeFileSync(path.join(wt, 'draft.txt'), 'wip\n')
  const wip = row(audit(r.root), 'perf/wip')
  assert.equal(wip.contained, true)
  assert.equal(wip.dirty, true)
  assert.equal(audit(r.root).find((x) => x.path === r.root).dirty, false)
})
