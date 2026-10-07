#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const HELP = `Read-only GitLab MR status pass (Node 22+, authenticated glab). Never merges, rebases, retries or comments.
Usage: node mr-watchman.mjs --repo <path> [--branch <name>] [--author <user>] [--json]
Order per MR: conflicts, then unresolved review threads, then CI. Twins (<name> and <name>_develop) are grouped.
Exit 0: every MR ready; 1: at least one MR needs action or GitLab is still checking; 2: glab unavailable or invalid input.
`

export function assertReadOnly(args) {
  const [cmd, sub, ...rest] = args
  const readOnly = (cmd === 'mr' && ['list', 'view'].includes(sub)) ||
    (cmd === 'api' && typeof sub === 'string' && !sub.startsWith('-') && rest.length === 0)
  if (!readOnly) throw new Error(`refused: not a read-only glab call (${args.join(' ')})`)
}

function glab(args, cwd) {
  assertReadOnly(args)
  const r = spawnSync('glab', args, { cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GLAB_CHECK_UPDATE: 'false' } })
  const what = `glab ${args.slice(0, 2).join(' ')}`
  if (r.error || r.status !== 0) throw new Error(`${what} unavailable: ${r.error?.message || r.stderr.trim() || `exit ${r.status}`}`)
  try { return JSON.parse(r.stdout) } catch { throw new Error(`${what} returned invalid JSON`) }
}

export const baseName = (branch) => branch.replace(/_dev(elop)?$/, '')

const plain = (text) => String(text ?? '').replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').trim()

export const unresolved = (discussions) => discussions
  .filter((d) => !d.individual_note && d.notes?.[0]?.resolvable && !d.notes[0].resolved)
  .map(({ notes: [n] }) => ({
    author: plain(n.author?.username ?? 'unknown'),
    where: n.position ? `${plain(n.position.new_path)}:${n.position.new_line ?? n.position.old_line}` : 'general',
    head: plain((n.body ?? '').split('\n')[0]).slice(0, 80),
  }))

const CONFLICT = new Set(['conflict', 'need_rebase'])
const CHECKING = new Set(['unchecked', 'checking', 'preparing', 'approvals_syncing'])
const RUNNING = new Set(['running', 'pending', 'created', 'waiting_for_resource', 'preparing', 'scheduled'])

export function verdict(mr, threads, failedJobs) {
  if (mr.has_conflicts || CONFLICT.has(mr.detailed_merge_status)) return { state: 'conflicts', next: `rebase ${mr.source_branch} onto ${mr.target_branch}; stop there` }
  if (threads.length) return { state: 'threads', next: `${threads.length} unresolved thread(s): triage against the code, fix in one push, resolve` }
  const p = mr.head_pipeline
  if (!p) return { state: 'ci-none', next: 'no pipeline for the head commit' }
  if (p.sha !== mr.sha) return { state: 'ci-stale', next: `pipeline ${p.id} ran on ${p.sha.slice(0, 8)}, head is ${mr.sha.slice(0, 8)}; wait for the new pipeline` }
  if (RUNNING.has(p.status)) return { state: 'ci-running', next: `pipeline ${p.id} is ${p.status}; re-run later` }
  if (p.status !== 'success') {
    const jobs = failedJobs.length ? `failed: ${failedJobs.join(', ')}` : `pipeline ${p.id} ${p.status}`
    return { state: 'ci-failed', next: `${jobs}; one retry if flake, an identical second failure is real; ${mr.diverged_commits_count} commits behind ${mr.target_branch}, a failure outside the diff means stale base` }
  }
  if (CHECKING.has(mr.detailed_merge_status)) return { state: 'checking', next: 'GitLab is recomputing merge status; re-run in a minute' }
  if (mr.detailed_merge_status === 'mergeable') return { state: 'ready', next: 'nothing to do on your side' }
  return { state: `blocked:${mr.detailed_merge_status}`, next: 'see the MR page' }
}

// ponytail: no paging; a list that reaches the 100 cap fails closed with exit 2
const page = (what, list) => {
  if (!Array.isArray(list)) throw new Error(`${what} returned no array`)
  if (list.length >= 100) throw new Error(`truncated: ${what} returned 100 or more entries; page it before trusting a verdict`)
  return list
}

export function collect(repo, { branch, author = '@me' } = {}) {
  const list = page('glab mr list', glab(['mr', 'list', '--author', author, '--per-page', '100', '-F', 'json'], repo))
  const wanted = branch ? list.filter((m) => baseName(m.source_branch) === baseName(branch)) : list
  const rows = wanted.map((m) => {
    const mr = glab(['mr', 'view', String(m.iid), '-F', 'json'], repo)
    const threads = unresolved(page(`discussions of !${m.iid}`, glab(['api', `projects/:id/merge_requests/${m.iid}/discussions?per_page=100`], repo)))
    const p = mr.head_pipeline
    const failedJobs = p && p.sha === mr.sha && !RUNNING.has(p.status) && p.status !== 'success'
      ? page(`failed jobs of pipeline ${p.id}`, glab(['api', `projects/:id/pipelines/${p.id}/jobs?scope[]=failed&per_page=100`], repo)).filter((j) => !j.allow_failure).map((j) => j.name)
      : []
    return { iid: mr.iid, branch: mr.source_branch, target: mr.target_branch, twin: baseName(mr.source_branch), twinIid: null, url: mr.web_url, threads, ...verdict(mr, threads, failedJobs) }
  }).sort((a, b) => a.twin.localeCompare(b.twin) || a.branch.length - b.branch.length)
  for (const r of rows) {
    const other = rows.find((o) => o.twin === r.twin && o.iid !== r.iid && o.target !== r.target)
    if (!other) continue
    r.twinIid = other.iid
    if (r.state !== 'ready') r.next += `; twin !${other.iid}`
  }
  return rows
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))

if (isMain) {
  try {
    const { values } = parseArgs({ options: { repo: { type: 'string' }, branch: { type: 'string' }, author: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean' } } })
    if (values.help) { console.log(HELP); process.exit(0) }
    if (values.branch?.startsWith('-') || values.author?.startsWith('-')) throw new Error('invalid --branch or --author')
    const rows = collect(path.resolve(values.repo ?? process.cwd()), { branch: values.branch, author: values.author })
    if (values.json) console.log(JSON.stringify(rows))
    else if (!rows.length) console.log('no open MRs')
    else {
      const header = ['mr', 'branch', 'state', 'threads', 'next']
      const table = rows.map((r) => [`!${r.iid}`, `${r.branch} -> ${r.target}`, r.state, String(r.threads.length), r.next])
      const widths = header.map((h, i) => Math.max(h.length, ...table.map((t) => t[i].length)))
      for (const t of [header, ...table]) console.log(t.map((c, i) => (i === t.length - 1 ? c : c.padEnd(widths[i]))).join('  '))
      for (const r of rows) for (const th of r.threads) console.log(`  !${r.iid} ${th.author} ${th.where}: ${th.head}`)
      const ready = rows.filter((r) => r.state === 'ready').length
      console.log(`${new Set(rows.map((r) => r.twin)).size} twin group(s), ${rows.length - ready} need action, ${ready} ready`)
    }
    process.exitCode = rows.every((r) => r.state === 'ready') ? 0 : 1
  } catch (error) {
    console.log(JSON.stringify({ status: 'unavailable', problems: [error.message] }))
    process.exitCode = 2
  }
}
