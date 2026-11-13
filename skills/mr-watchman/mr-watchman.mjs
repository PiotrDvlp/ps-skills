#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const HELP = `Read-only GitLab MR status pass (Node 22+, authenticated glab). Never merges, rebases, retries or comments.
Usage: node mr-watchman.mjs --repo <path> [--branch <name>] [--author <user>] [--replies] [--json | --json2]
       node mr-watchman.mjs --repo <path> --followup <iid> --out <absolute file> [--author <user>]
Order per MR: conflicts, then unresolved review threads, then CI. Twins (<name> and <name>_develop) are grouped.
An MR GitLab reports as still checking is re-read once after 60s (MR_WATCHMAN_RETRY_MS overrides the delay).
--json2 prints {coverage, rows}; coverage is partial when a row is unverified (a glab call for that MR failed).
Exit 0: every MR ready or waiting for approval; 1: at least one MR needs action, GitLab is still checking after the retry, a row is unverified, or --branch matched nothing;
2: glab or the MR list unavailable, invalid input (including --json with --json2), or the MR list at the 100-entry cap.
--followup writes a package for one MR in state conflicts, threads or ci-failed (exit 0, path printed); any other state prints state and next and exits 1; an existing --out exits 2.
Temp names left by an interrupted run (<out>.tmp-*, <stem>.threads.tmp-*) are listed on stderr as "leftover temp: <path>" and kept.
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

function glabText(args, cwd, { maxBuffer = 32 * 1024 * 1024 } = {}) {
  assertReadOnly(args)
  const r = spawnSync('glab', args, { cwd, encoding: 'utf8', timeout: 30_000, maxBuffer,
    env: { ...process.env, GLAB_CHECK_UPDATE: 'false' } })
  const what = `glab ${args.slice(0, 2).join(' ')}`
  if (r.error || r.status !== 0) throw new Error(`${what} unavailable: ${r.error?.message || r.stderr.trim() || `exit ${r.status}`}`)
  return r.stdout
}

export const pipelineSha = (p) => p.source_sha ?? p.sha

export const tailLines = (text, n) => text.replace(/\n$/, '').split('\n').slice(-n).join('\n')

export const baseName = (branch) => branch.replace(/_dev(elop)?$/, '')

export const plainBody = (text) => String(text ?? '').replace(/(?![\n\t])[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')

const plain = (text) => String(text ?? '').replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').trim()

const REVIEWED = /<!--[^>]*\bsha=([0-9a-f]{7,40})/

const openThreads = (discussions) => discussions.filter((d) => !d.individual_note && d.notes?.[0]?.resolvable && !d.notes[0].resolved)

export const unresolved = (discussions) => openThreads(discussions)
  .map(({ id, notes: [n, ...rest] }) => {
    const author = plain(n.author?.username ?? 'unknown')
    const replies = rest.filter((r) => !r.system).map((r) => ({
      author: plain(r.author?.username ?? 'unknown'),
      at: plain(r.created_at).slice(0, 16),
      head: plain((r.body ?? '').split('\n')[0]).slice(0, 120),
    }))
    return {
      id: plain(id),
      author,
      where: n.position ? `${plain(n.position.new_path)}:${n.position.new_line ?? n.position.old_line}` : 'general',
      head: plain((n.body ?? '').split('\n')[0]).slice(0, 80),
      replies,
      answered: replies.some((r) => r.author !== author),
      reviewed: (n.body ?? '').match(REVIEWED)?.[1].slice(0, 8) ?? null,
    }
  })

const threadNote = (th, headSha) => {
  if (!th.replies.length && !th.reviewed) return ''
  const n = th.replies.length
  const said = n ? `${n} ${n === 1 ? 'reply' : 'replies'}, last ${th.replies[n - 1].author}` : 'no replies'
  const commit = th.reviewed ? `; reviewed ${th.reviewed}${th.reviewed === headSha ? ' (head)' : `, head ${headSha}`}` : ''
  return ` (${said}${commit})`
}

const CONFLICT = new Set(['conflict', 'need_rebase'])
const CHECKING = new Set(['unchecked', 'checking', 'preparing', 'approvals_syncing'])
const RUNNING = new Set(['running', 'pending', 'created', 'waiting_for_resource', 'preparing', 'scheduled'])

const pipelineFailed = (mr) => {
  const p = mr.head_pipeline
  return Boolean(p) && pipelineSha(p) === mr.sha && !RUNNING.has(p.status) && p.status !== 'success'
}

const hasConflicts = (mr) => mr.has_conflicts || CONFLICT.has(mr.detailed_merge_status)

export function verdict(mr, threads, failedJobs) {
  if (hasConflicts(mr)) return { state: 'conflicts', next: `rebase ${mr.source_branch} onto ${mr.target_branch}; stop there` }
  if (threads.length) {
    const done = threads.filter((th) => th.answered).length
    if (done === threads.length) return { state: 'threads', next: `${done} answered thread(s): read the replies against the code, resolve the ones that hold` }
    return { state: 'threads', next: done
      ? `${threads.length} unresolved thread(s), ${done} already answered: triage the open ones against the code, fix in one push, resolve`
      : `${threads.length} unresolved thread(s): triage against the code, fix in one push, resolve` }
  }
  const p = mr.head_pipeline
  if (!p) return { state: 'ci-none', next: 'no pipeline for the head commit' }
  if (pipelineSha(p) !== mr.sha) return { state: 'ci-stale', next: `pipeline ${p.id} ran on ${String(pipelineSha(p)).slice(0, 8)}, head is ${mr.sha.slice(0, 8)}; wait for the new pipeline` }
  if (RUNNING.has(p.status)) return { state: 'ci-running', next: `pipeline ${p.id} is ${p.status}; re-run later` }
  if (pipelineFailed(mr)) {
    const jobs = failedJobs.length ? `failed: ${failedJobs.join(', ')}` : `pipeline ${p.id} ${p.status}`
    return { state: 'ci-failed', next: `${jobs}; one retry if flake, an identical second failure is real; ${mr.diverged_commits_count} commits behind ${mr.target_branch}, a failure outside the diff means stale base` }
  }
  if (CHECKING.has(mr.detailed_merge_status)) return { state: 'checking', next: 'GitLab is recomputing merge status; re-run in a minute' }
  if (mr.detailed_merge_status === 'mergeable') return { state: 'ready', next: 'nothing to do on your side' }
  if (mr.detailed_merge_status === 'not_approved') return { state: 'waiting-approval', next: "approval is the reviewer's; nothing on your side" }
  return { state: `blocked:${mr.detailed_merge_status}`, next: 'see the MR page' }
}

/** Blockers present on one MR in work order: 'conflicts', 'threads', 'ci-failed'; empty when none. */
export const blockersOf = (mr, threads, failedJobs) => [hasConflicts(mr) && 'conflicts', threads.length > 0 && 'threads', (failedJobs.length > 0 || pipelineFailed(mr)) && 'ci-failed'].filter(Boolean)

export const settled = (row) => row.state === 'ready' || row.state === 'waiting-approval'

// ponytail: no paging; a list that reaches the 100 cap fails closed with exit 2
const page = (what, list) => {
  if (!Array.isArray(list)) throw new Error(`${what} returned no array`)
  if (list.length >= 100) throw new Error(`truncated: ${what} returned 100 or more entries; page it before trusting a verdict`)
  return list
}

const listMine = (repo, author) => page('glab mr list', glab(['mr', 'list', '--author', author, '--per-page', '100', '-F', 'json'], repo))

const failedJobsOf = (repo, mr) => {
  const p = mr.head_pipeline
  return pipelineFailed(mr)
    ? page(`failed jobs of pipeline ${p.id}`, glab(['api', `projects/:id/pipelines/${p.id}/jobs?scope[]=failed&per_page=100`], repo)).filter((j) => !j.allow_failure)
    : []
}

export const CHECKING_RETRY_MS = 60_000

const retryMs = () => /^\d+$/.test(process.env.MR_WATCHMAN_RETRY_MS ?? '') ? Number(process.env.MR_WATCHMAN_RETRY_MS) : CHECKING_RETRY_MS

/**
 * One MR's row from its `glab mr list` entry. A failed `mr view`, discussions or failed-jobs call
 * returns an `unverified` row instead of throwing.
 */
const rowOf = (repo, entry) => {
  let call = 'mr view'
  let fullHeadSha = String(entry.sha ?? '')
  let mr, threads, failedJobs
  try {
    mr = glab(['mr', 'view', String(entry.iid), '-F', 'json'], repo)
    fullHeadSha = String(mr.sha)
    call = 'discussions read'
    threads = unresolved(page(`discussions of !${entry.iid}`, glab(['api', `projects/:id/merge_requests/${entry.iid}/discussions?per_page=100`], repo)))
    call = 'failed jobs read'
    failedJobs = failedJobsOf(repo, mr).map((j) => j.name)
  } catch (error) {
    return { iid: entry.iid, branch: entry.source_branch, target: entry.target_branch, headSha: fullHeadSha.slice(0, 8), fullHeadSha, pipelineSha: null,
      twin: baseName(entry.source_branch), twinIid: null, url: entry.web_url, threads: [], state: 'unverified', next: `${call} failed: ${plain(error.message)}; re-run` }
  }
  return { iid: mr.iid, branch: mr.source_branch, target: mr.target_branch, headSha: fullHeadSha.slice(0, 8), fullHeadSha, pipelineSha: mr.head_pipeline ? pipelineSha(mr.head_pipeline) : null,
    twin: baseName(mr.source_branch), twinIid: null, url: mr.web_url, threads, ...verdict(mr, threads, failedJobs) }
}

/**
 * Rows plus coverage for --json2: 'partial' when any row is 'unverified', else 'complete'.
 * Throws only when `glab mr list` fails or reaches the 100-entry cap.
 * @returns {{ coverage: 'complete' | 'partial', rows: object[] }}
 */
export function collectCoverage(repo, { branch, author = '@me' } = {}) {
  const list = listMine(repo, author)
  const wanted = branch ? list.filter((m) => baseName(m.source_branch) === baseName(branch)) : list
  let rows = wanted.map((m) => rowOf(repo, m))
  if (rows.some((r) => r.state === 'checking')) {
    const ms = retryMs()
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
    rows = rows.map((r, i) => r.state === 'checking' ? rowOf(repo, wanted[i]) : r)
    for (const r of rows) if (r.state === 'checking') r.next = `GitLab still recomputing merge status ${Math.round(ms / 1000)}s later, after one retry; not a blocker, re-run later`
  }
  rows.sort((a, b) => a.twin.localeCompare(b.twin) || a.branch.length - b.branch.length)
  for (const r of rows) {
    const other = rows.find((o) => o.twin === r.twin && o.iid !== r.iid && o.target !== r.target)
    if (!other) continue
    r.twinIid = other.iid
    if (r.state !== 'ready') r.next += `; twin !${other.iid}`
  }
  return { coverage: rows.some((r) => r.state === 'unverified') ? 'partial' : 'complete', rows }
}

export const collect = (repo, options) => collectCoverage(repo, options).rows

export const INLINE_CHARS = 4000
export const TRACE_LINES = 120
export const TRACE_CHARS = 20_000
const TOO_LARGE = /ENOBUFS|maxBuffer/
const ANSI_CSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g
const FOLLOWUP_STATES = new Set(['conflicts', 'threads', 'ci-failed'])

export const spillDirOf = (out) => path.join(path.dirname(out), `${path.basename(out, path.extname(out))}.threads`)

export const leftoverTemps = (out) => {
  const dir = path.dirname(out)
  if (!fs.existsSync(dir)) return []
  return [out, spillDirOf(out)].flatMap((p) => fs.readdirSync(dir).filter((n) => n.startsWith(`${path.basename(p)}.tmp-`)).map((n) => path.join(dir, n)))
}

export function collectFollowup(repo, iid, { author = '@me' } = {}) {
  const mine = listMine(repo, author).find((m) => m.iid === iid)
  if (!mine) throw new Error(`!${iid} is not open or not authored by ${author}`)
  const rows = collect(repo, { branch: mine.source_branch, author })
  const row = rows.find((r) => r.iid === iid)
  if (!row) throw new Error(`!${iid} is not open or not authored by ${author}`)
  if (row.state === 'unverified') throw new Error(row.next)
  const mr = glab(['mr', 'view', String(iid), '-F', 'json'], repo)
  if (!String(mr.sha).startsWith(row.headSha)) throw new Error('head moved; re-run')
  const twin = rows.find((r) => r.iid === row.twinIid)
  const out = { row: { ...row, headSha: String(mr.sha), twinBranch: twin?.branch ?? null }, discussions: [], jobs: [], traces: {} }
  if (!FOLLOWUP_STATES.has(row.state)) return out
  out.discussions = page(`discussions of !${iid}`, glab(['api', `projects/:id/merge_requests/${iid}/discussions?per_page=100`], repo))
  out.jobs = failedJobsOf(repo, mr)
  out.blockers = blockersOf(mr, unresolved(out.discussions), out.jobs)
  if (out.blockers[0] !== row.state) throw new Error('state changed; re-run')
  for (const j of out.jobs) {
    try {
      out.traces[j.id] = { text: tailLines(glabText(['api', `projects/:id/jobs/${j.id}/trace`], repo), TRACE_LINES) }
    } catch (error) {
      if (!TOO_LARGE.test(error.message)) throw error
      out.traces[j.id] = { error: 'too large' }
    }
  }
  return out
}

const threadText = (th, replies) => [`# thread ${th.id} by ${th.author} at ${th.where}`, th.body,
  ...replies.map((r) => `## reply by ${r.author} at ${r.at}\n${r.body}`)].join('\n\n') + '\n'

export function buildPackage({ row, discussions, jobs, traces, blockers, repoUrl, createdAt, spillDir }) {
  const spills = []
  const raw = openThreads(discussions)
  const threads = unresolved(discussions).map((th, i) => {
    const [first, ...rest] = raw[i].notes
    const body = plainBody(first.body)
    const replies = rest.filter((r) => !r.system).map((r) => ({ author: plain(r.author?.username ?? 'unknown'), at: plain(r.created_at), body: plainBody(r.body) }))
    const chars = body.length + replies.reduce((sum, r) => sum + r.body.length, 0)
    const out = { id: th.id, author: th.author, where: th.where, body, replies, answered: th.answered, reviewed: th.reviewed }
    if (![body, ...replies.map((r) => r.body)].some((b) => b.length > INLINE_CHARS)) return out
    spills.push({ file: `${th.id}.md`, text: threadText(out, replies) })
    return { ...out, body: body.slice(0, INLINE_CHARS), replies: replies.map((r) => ({ ...r, body: r.body.slice(0, INLINE_CHARS) })), truncated: true, chars, spill: `${path.basename(spillDir)}/${th.id}.md` }
  })
  const failedJobs = jobs.map((j) => {
    const trace = traces[j.id] ?? {}
    const job = { id: j.id, name: plain(j.name), stage: plain(j.stage), failureReason: plain(j.failure_reason), webUrl: plain(j.web_url),
      traceTail: trace.text === undefined ? null : plainBody(trace.text.replace(ANSI_CSI, '')).slice(-TRACE_CHARS) }
    return trace.error ? { ...job, traceError: trace.error } : job
  })
  const pkg = {
    schema: 'mr-followup/1', createdAt, repo: repoUrl,
    mr: { iid: row.iid, url: plain(row.url), source: plain(row.branch), target: plain(row.target), headSha: row.headSha, twinIid: row.twinIid, twinBranch: row.twinBranch === null ? null : plain(row.twinBranch), state: row.state, next: plain(row.next) },
    ...(blockers && { blockers }), threads, failedJobs, ticket: plain(row.branch).match(/[A-Z]+-\d+/)?.[0] ?? null,
  }
  return { pkg, spills }
}

export function writePackage(outPath, { pkg, spills }) {
  const spillDir = spillDirOf(outPath)
  if (fs.existsSync(outPath) || fs.existsSync(spillDir)) throw new Error(`${outPath} or ${spillDir} already exists`)
  for (const { file } of spills) if (path.basename(file) !== file) throw new Error(`invalid spill file name ${file}`)
  const tmpDir = `${spillDir}.tmp-${process.pid}`
  const tmpOut = `${outPath}.tmp-${process.pid}`
  let moved = false
  try {
    fs.writeFileSync(tmpOut, `${JSON.stringify(pkg, null, 2)}\n`)
    fs.mkdirSync(tmpDir)
    for (const { file, text } of spills) fs.writeFileSync(path.join(tmpDir, file), text)
    fs.renameSync(tmpDir, spillDir)
    moved = true
    fs.renameSync(tmpOut, outPath)
  } catch (error) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.rmSync(tmpOut, { force: true })
    if (moved) fs.rmSync(spillDir, { recursive: true, force: true })
    throw error
  }
}

const remoteUrl = (repo) => {
  const r = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: repo, encoding: 'utf8', timeout: 10_000 })
  if (r.error || r.status !== 0) throw new Error(`git remote get-url origin failed in ${repo}: ${r.error?.message || r.stderr.trim()}`)
  const url = r.stdout.trim()
  if (!/^https?:\/\//.test(url)) return url
  const parsed = new URL(url)
  parsed.username = ''
  parsed.password = ''
  return parsed.href
}

const jsonLine = (value) => JSON.stringify(value).replace(/[\u007f-\u009f\p{Zl}\p{Zp}]/gu, ' ')

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))

if (isMain) {
  try {
    const { values } = parseArgs({ options: { repo: { type: 'string' }, branch: { type: 'string' }, author: { type: 'string' }, json: { type: 'boolean' }, json2: { type: 'boolean' }, replies: { type: 'boolean' }, followup: { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean' } } })
    if (values.help) { console.log(HELP); process.exit(0) }
    if (values.json && values.json2) { console.error('--json and --json2 cannot be combined'); process.exit(2) }
    if (values.branch?.startsWith('-') || values.author?.startsWith('-')) throw new Error('invalid --branch or --author')
    if (values.followup !== undefined || values.out !== undefined) {
      if (!/^\d+$/.test(values.followup ?? '')) throw new Error('--followup <iid> needs a numeric IID')
      if (!values.out) throw new Error('--followup needs --out <absolute file>')
      if (!path.isAbsolute(values.out)) throw new Error('--out must be an absolute path')
      if (fs.existsSync(values.out) || fs.existsSync(spillDirOf(values.out))) throw new Error(`${values.out} or its .threads directory already exists`)
      for (const leftover of leftoverTemps(values.out)) console.error(`leftover temp: ${leftover}`)
      const repo = path.resolve(values.repo ?? process.cwd())
      const { row, discussions, jobs, traces, blockers } = collectFollowup(repo, Number(values.followup), { author: values.author })
      if (!FOLLOWUP_STATES.has(row.state)) {
        console.log(plain(`!${row.iid} ${row.state}: ${row.next}`))
        process.exitCode = 1
        process.exit()
      }
      const built = buildPackage({ row, discussions, jobs, traces, blockers, repoUrl: remoteUrl(repo), createdAt: new Date().toISOString(), spillDir: spillDirOf(values.out) })
      writePackage(values.out, built)
      console.log(values.out)
      process.exit()
    }
    const { coverage, rows } = collectCoverage(path.resolve(values.repo ?? process.cwd()), { branch: values.branch, author: values.author })
    if (values.branch && !rows.length) {
      console.log(values.json2 ? JSON.stringify({ coverage, rows }) : values.json ? '[]' : `no open MR for branch ${plain(values.branch)}`)
      process.exitCode = 1
      process.exit()
    }
    if (values.json2) console.log(jsonLine({ coverage, rows }))
    else if (values.json) console.log(jsonLine(rows))
    else if (!rows.length) console.log('no open MRs')
    else {
      const header = ['mr', 'branch', 'state', 'threads', 'next']
      const table = rows.map((r) => [`!${r.iid}`, `${r.branch} -> ${r.target}`, r.state, String(r.threads.length), r.next].map(plain))
      const widths = header.map((h, i) => Math.max(h.length, ...table.map((t) => t[i].length)))
      for (const t of [header, ...table]) console.log(t.map((c, i) => (i === t.length - 1 ? c : c.padEnd(widths[i]))).join('  '))
      for (const r of rows) {
        for (const th of r.threads) {
          console.log(plain(`  !${r.iid} ${th.author} ${th.where}: ${th.head}${threadNote(th, r.headSha)}`).replace(/^/, '  '))
          if (values.replies) for (const re of th.replies) console.log(`      ${plain(`${re.author} ${re.at}: ${re.head}`)}`)
        }
      }
      const ready = rows.filter(settled).length
      console.log(`${new Set(rows.map((r) => r.twin)).size} twin group(s), ${rows.length - ready} need action, ${ready} ready or waiting`)
    }
    process.exitCode = rows.every(settled) ? 0 : 1
  } catch (error) {
    console.log(JSON.stringify({ status: 'unavailable', problems: [error.message] }))
    process.exitCode = 2
  }
}
