#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const run = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, encoding: 'utf8' })

export const targetFor = (branch) => (branch ? (/_dev(elop)?$/.test(branch) ? 'origin/develop' : 'origin/main') : null)

const worktrees = (repo) => {
  const blocks = run('git', ['worktree', 'list', '--porcelain'], repo).stdout.trim().split(/\n\n+/)
  return blocks.map((block) => {
    const lines = block.split('\n')
    const wt = lines.find((l) => l.startsWith('worktree ')).slice('worktree '.length)
    const ref = lines.find((l) => l.startsWith('branch '))
    return { path: wt, branch: ref ? ref.slice('branch refs/heads/'.length) : null }
  })
}

export const audit = (repo) =>
  worktrees(repo).map(({ path: wt, branch }) => {
    const target = targetFor(branch)
    const row = {
      path: wt,
      branch,
      target,
      ahead: null,
      behind: null,
      contained: null,
      dirty: run('git', ['status', '--porcelain'], wt).stdout.trim() !== '',
      nodeModules: fs.existsSync(path.join(wt, 'node_modules'))
    }
    if (!target) return row
    if (run('git', ['rev-parse', '--verify', '-q', target], repo).status !== 0) return { ...row, error: `${target} missing` }
    const [behind, ahead] = run('git', ['rev-list', '--left-right', '--count', `${target}...${branch}`], repo).stdout.trim().split(/\s+/).map(Number)
    return { ...row, ahead, behind, contained: ahead === 0 }
  })

export const formatMr = (list) => (list.length ? list.map((m) => `!${m.iid} ${m.state}${m.draft ? ' draft' : ''}`).join(', ') : 'none')

const mrFor = (repo, branch) => {
  const r = run('glab', ['mr', 'list', '--source-branch', branch, '--all', '-F', 'json'], repo)
  try {
    return formatMr(JSON.parse(r.stdout))
  } catch {
    return 'unavailable'
  }
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))

if (isMain) {
  const args = process.argv.slice(2)
  const repoIndex = args.indexOf('--repo')
  const repo = repoIndex >= 0 ? path.resolve(args[repoIndex + 1]) : process.cwd()
  const withMr = args.includes('--mr')
  const rows = audit(repo).map((r) => [
    r.branch ?? '(detached)',
    r.target ?? '-',
    r.error ?? (r.ahead === null ? '-' : `+${r.ahead}/-${r.behind}`),
    r.contained === null ? '-' : r.contained ? 'contained' : 'open',
    r.dirty ? 'dirty' : 'clean',
    r.nodeModules ? 'deps' : 'no-deps',
    ...(withMr ? [r.branch ? mrFor(repo, r.branch) : '-'] : []),
    path.relative(repo, r.path) || '.'
  ])
  const header = ['branch', 'target', 'ahead/behind', 'in-target', 'worktree', 'node_modules', ...(withMr ? ['mr'] : []), 'path']
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
  for (const r of [header, ...rows]) console.log(r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]))).join('  '))
}
