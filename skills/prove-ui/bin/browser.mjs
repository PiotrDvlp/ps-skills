#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

class HarnessError extends Error {
  constructor(code, message, help = []) {
    super(message)
    this.code = code
    this.help = help
  }
}

const fail = (code, message, help = []) => {
  throw new HarnessError(code, message, help)
}

const report = (e) => {
  const known = e instanceof HarnessError
  const lines = [`error: ${e.message}`, `code: ${known ? e.code : 'UNEXPECTED'}`]
  ;(known ? e.help : []).forEach((h, i) => lines.push(`help[${i + 1}]: ${h}`))
  console.error(lines.join('\n'))
  process.exitCode = known && e.code === 'USAGE' ? 2 : 1
}

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.error) fail('GIT_SPAWN_FAILED', `git could not be executed: ${r.error.message}`)
  if (r.status !== 0) fail('GIT_FAILED', `git ${args.join(' ')} exited ${r.status}: ${r.stderr.trim()}`)
  return r.stdout.trim()
}

const resolveIdentity = (cwd) => {
  const topLevel = git(cwd, 'rev-parse', '--path-format=absolute', '--show-toplevel')
  const branch = git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')
  if (branch === 'HEAD') fail('BRANCH_IDENTITY_UNRESOLVED', 'refusing to key a run on a detached HEAD', ['check out a branch; the dev-server port is derived from its name'])
  return { topLevel, slug: createHash('sha256').update(branch, 'utf8').digest('hex') }
}

/** macOS `/tmp` is a symlink to `/private/tmp` and git reports resolved paths, so compare real paths. */
const samePath = (a, b) => {
  if (a === b) return true
  try {
    return fs.realpathSync(a) === fs.realpathSync(b)
  } catch {
    return false
  }
}

const devServerPort = (slug) => 4100 + (parseInt(slug.slice(0, 4), 16) % 800)
/** Short enough for vite-node's unix socket path. */
const devServerTmp = (slug) => path.join('/tmp', `claude-${process.getuid()}`, `dv-${slug.slice(0, 8)}`)

const USAGE = `usage: browser run <script.mjs> [--serve] [--timeout <seconds>]

  Runs the script's default export against headless Chromium inside this session's sandbox,
  from the worktree root (worker-side). The export receives { page, context, shot, baseUrl };
  shot(name, { fullPage }) saves <run>/<name>.png under .distro/browser/: the viewport, or the
  whole page when fullPage is true. --serve starts npm run dev on this task's port first and always stops it. Default timeout 180 s, dev-server start included.`

const flagValue = (argv, name) => {
  const i = argv.indexOf(`--${name}`)
  if (i === -1) return undefined
  const v = argv[i + 1]
  if (v === undefined || v.startsWith('--')) fail('USAGE', `flag --${name} needs a value\n${USAGE}`)
  return v
}

const PROXY_PRELOAD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib','dev-server-proxy.mjs')
const runtimePath = () => path.join(os.homedir(), '.dev-browser', 'node_modules', 'playwright', 'index.mjs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const portOpen = (port) =>
  new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1')
    s.once('connect', () => {
      s.destroy()
      resolve(true)
    })
    s.once('error', () => resolve(false))
  })

/** Chromium ignores HTTPS_PROXY and cannot take credentials in --proxy-server, so the sandbox proxy is handed to Playwright split. */
const proxyFromEnv = () => {
  const raw = process.env.HTTPS_PROXY ?? process.env.https_proxy
  if (!raw) return undefined
  const u = new URL(raw)
  return { server: `${u.protocol}//${u.host}`, ...(u.username ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } : {}) }
}

const groupAlive = (pid) => {
  try {
    process.kill(-pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

/** The dev server runs in its own process group; `stop` signals the whole group and escalates until it is gone, whether or not the port ever opened. */
const serve = ({ worktree, port, log, tmpdir }) => {
  const out = fs.openSync(log, 'a')
  const child = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port)], { cwd: worktree, detached: true, stdio: ['ignore', out, out], env: { ...process.env, TMPDIR: tmpdir, NITRO_NO_UNIX_SOCKET: '1', NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${pathToFileURL(PROXY_PRELOAD).href}`.trim(), BROWSER_PROXY_LOG: path.join(path.dirname(log), 'dev-proxy.log') } })
  let exited = null
  child.on('exit', (code, signal) => {
    exited = signal ?? code ?? 'exit'
  })
  child.on('error', (e) => {
    exited = e.code ?? e.message
  })
  const stop = async () => {
    if (child.pid === undefined) return
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      try {
        process.kill(-child.pid, signal)
      } catch {}
      for (let i = 0; i < 20 && groupAlive(child.pid); i++) await sleep(250)
      if (!groupAlive(child.pid)) return
    }
    fail('BROWSER_SERVER_LEFT_RUNNING', `the dev server's process group ${child.pid} survived SIGKILL`, [`log: ${log}`])
  }
  const ready = async (deadline) => {
    while (!(await portOpen(port))) {
      if (exited !== null) fail('BROWSER_SERVER_FAILED', `npm run dev exited (${exited}) before port ${port} opened`, [`log: ${log}`])
      if (Date.now() > deadline) fail('BROWSER_TIMEOUT', `the dev server did not open port ${port} within the timeout`, [`log: ${log}`])
      await sleep(500)
    }
  }
  return { stop, ready }
}

const runCmd = async (argv) => {
  const script = argv[1]
  if (!script || script.startsWith('--')) fail('USAGE', USAGE)
  const timeout = Number(flagValue(argv, 'timeout') ?? 180)
  if (!Number.isFinite(timeout) || timeout <= 0) fail('USAGE', `--timeout must be a positive number of seconds\n${USAGE}`)
  const id = resolveIdentity(process.cwd())
  if (!samePath(id.topLevel, process.cwd())) fail('CWD_NOT_WORKTREE_ROOT', `run browser from the worktree root (${id.topLevel})`)
  const scriptPath = path.resolve(script)
  if (!fs.existsSync(scriptPath)) fail('BROWSER_SCRIPT_MISSING', `${scriptPath} does not exist`)
  const runtime = runtimePath()
  if (!fs.existsSync(runtime)) {
    fail('BROWSER_RUNTIME_MISSING', `no Playwright runtime at ${runtime}`, ['the Captain provides it with dev-browser install; a worker never installs it'])
  }

  const port = devServerPort(id.slug)
  const root = path.join(id.topLevel, '.distro', 'browser')
  fs.mkdirSync(root, { recursive: true })
  const run = fs.mkdtempSync(path.join(root, `run-${new Date().toISOString().replace(/[:.]/g, '-')}-`))
  const tmp = path.join(run, 'tmp')
  const profile = path.join(run, 'profile')
  fs.mkdirSync(tmp)
  // The dev server gets the task's socket-granted TMPDIR: vite-node needs a unix socket there, Nitro moves to TCP via NITRO_NO_UNIX_SOCKET.
  const serverTmp = devServerTmp(id.slug)
  fs.mkdirSync(serverTmp, { recursive: true, mode: 0o700 })
  process.env.TMPDIR = tmp
  const deadline = Date.now() + timeout * 1000

  let server = null
  let context = null
  let settled = false
  let cleaning = null
  const cleanup = () => (cleaning ??= teardown())
  const teardown = async () => {
    settled = true
    if (context) await context.close().catch(() => {})
    context = null
    const s = server
    server = null
    try {
      if (s) await s.stop()
    } finally {
      fs.rmSync(profile, { recursive: true, force: true })
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }
  let stopping = false
  const onSignal = () => {
    if (stopping) return
    stopping = true
    cleanup().finally(() => process.exit(130))
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  process.on('SIGHUP', onSignal)
  for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {})

  try {
    if (argv.includes('--serve')) {
      if (await portOpen(port)) fail('BROWSER_PORT_BUSY', `port ${port} already accepts connections`, ['a dev server for this task is still running; stop it before --serve'])
      server = serve({ worktree: id.topLevel, port, log: path.join(run, 'dev-server.log'), tmpdir: serverTmp })
      await server.ready(deadline)
    }
    const { chromium } = await import(pathToFileURL(runtime).href)
    const proxy = proxyFromEnv()
    context = await chromium.launchPersistentContext(profile, { headless: true, args: ['--single-process'], timeout: 30000, ...(proxy ? { proxy } : {}) })
    const page = context.pages()[0] ?? (await context.newPage())
    const shots = []
    const shot = async (name, { fullPage = false } = {}) => {
      if (!/^[\w.-]+$/.test(name)) fail('BROWSER_SHOT_NAME', `screenshot name ${JSON.stringify(name)} must match [A-Za-z0-9_.-]+`)
      const p = path.join(run, `${name}.png`)
      await page.screenshot({ path: p, fullPage })
      shots.push(p)
      return p
    }
    const mod = await import(pathToFileURL(scriptPath).href)
    if (typeof mod.default !== 'function') fail('BROWSER_SCRIPT_INVALID', `${scriptPath} has no default-exported function`)

    let timer
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new HarnessError('BROWSER_TIMEOUT', `the script did not finish within ${timeout} s`)), Math.max(0, deadline - Date.now()))
    })
    const crashed = new Promise((_, reject) => {
      context.once('close', () => {
        if (!settled) reject(new HarnessError('BROWSER_CRASHED', 'Chromium closed while the script was running', ['a --single-process browser can crash under load; re-run once before treating it as a finding']))
      })
    })
    const body = Promise.resolve()
      .then(() => mod.default({ page, context, shot, baseUrl: `http://127.0.0.1:${port}` }))
      .catch((e) => {
        if (e instanceof HarnessError) throw e
        throw new HarnessError('BROWSER_SCRIPT_FAILED', `${path.basename(scriptPath)} threw: ${e?.message ?? e}`, [`run directory: ${run}`])
      })
    try {
      await Promise.race([body, expired, crashed])
    } finally {
      clearTimeout(timer)
      settled = true
      for (const p of [body, expired, crashed]) p.catch(() => {})
    }
    process.stdout.write(`browser: ${path.relative(id.topLevel, run)}\n${shots.map((s) => `shot: ${path.relative(id.topLevel, s)}\n`).join('')}`)
    return 0
  } finally {
    await cleanup()
  }
}

const cmd = process.argv[2]
if (cmd !== 'run') {
  report(new HarnessError('USAGE', cmd ? `unknown command ${cmd}\n${USAGE}` : USAGE))
} else {
  runCmd(process.argv.slice(2))
    .then(
      (code) => {
        process.exitCode = code
      },
      report
    )
    .finally(() => process.stdout.write('', () => process.stderr.write('', () => process.exit())))
}
