import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeRepo } from '../lib/test-repo.mjs'

const CLI = fileURLToPath(new URL('./browser.mjs', import.meta.url))
const REAL_RUNTIME = path.join(os.homedir(), '.dev-browser', 'node_modules', 'playwright', 'index.mjs')

const FAKE_PLAYWRIGHT = `import fs from 'node:fs'
import { EventEmitter } from 'node:events'
const log = new URL('./screenshots.jsonl', import.meta.url)
export const chromium = {
  launchPersistentContext: async () => {
    const context = new EventEmitter()
    const page = {
      screenshot: async (options) => {
        fs.appendFileSync(log, JSON.stringify(options) + '\\n')
        fs.writeFileSync(options.path, Buffer.from([0]))
      }
    }
    context.pages = () => [page]
    context.newPage = async () => page
    context.close = async () => context.emit('close')
    return context
  }
}
`

const tempHome = (withRuntime = true) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'prove ui home-'))
  if (withRuntime) {
    const dir = path.join(home, '.dev-browser', 'node_modules', 'playwright')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'index.mjs'), FAKE_PLAYWRIGHT)
  }
  return home
}

const recorded = (home) =>
  fs.readFileSync(path.join(home, '.dev-browser', 'node_modules', 'playwright', 'screenshots.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))

const cli = (args, { cwd, home }) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, HOME: home } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })

const repoWithScript = (body) => {
  const r = makeRepo()
  fs.writeFileSync(path.join(r.root, 'check.mjs'), body)
  return r
}

test('no command: USAGE, exit 2', async () => {
  const r = await cli([], { cwd: os.tmpdir(), home: tempHome() })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /code: USAGE/)
})

test('run from a subfolder: CWD_NOT_WORKTREE_ROOT', async () => {
  const r = repoWithScript('export default async () => {}\n')
  const out = await cli(['run', '../check.mjs'], { cwd: path.join(r.root, '.claude'), home: tempHome() })
  assert.equal(out.status, 1)
  assert.match(out.stderr, /code: CWD_NOT_WORKTREE_ROOT/)
})

test('no Playwright runtime under HOME: BROWSER_RUNTIME_MISSING', async () => {
  const r = repoWithScript('export default async () => {}\n')
  const out = await cli(['run', 'check.mjs'], { cwd: r.root, home: tempHome(false) })
  assert.equal(out.status, 1)
  assert.match(out.stderr, /code: BROWSER_RUNTIME_MISSING/)
})

test('missing script: BROWSER_SCRIPT_MISSING', async () => {
  const r = makeRepo()
  const out = await cli(['run', 'nope.mjs'], { cwd: r.root, home: tempHome() })
  assert.equal(out.status, 1)
  assert.match(out.stderr, /code: BROWSER_SCRIPT_MISSING/)
})

test('script without a default export: BROWSER_SCRIPT_INVALID', async () => {
  const r = repoWithScript('export const x = 1\n')
  const out = await cli(['run', 'check.mjs'], { cwd: r.root, home: tempHome() })
  assert.equal(out.status, 1)
  assert.match(out.stderr, /code: BROWSER_SCRIPT_INVALID/)
})

test('script that throws: BROWSER_SCRIPT_FAILED', async () => {
  const r = repoWithScript("export default async () => { throw new Error('boom') }\n")
  const out = await cli(['run', 'check.mjs'], { cwd: r.root, home: tempHome() })
  assert.equal(out.status, 1)
  assert.match(out.stderr, /code: BROWSER_SCRIPT_FAILED/)
  assert.match(out.stderr, /check\.mjs threw: boom/)
})

test('script slower than --timeout: BROWSER_TIMEOUT', async () => {
  const r = repoWithScript('export default () => new Promise((resolve) => setTimeout(resolve, 5000))\n')
  const out = await cli(['run', 'check.mjs', '--timeout', '1'], { cwd: r.root, home: tempHome() })
  assert.equal(out.status, 1)
  assert.match(out.stderr, /code: BROWSER_TIMEOUT/)
})

test('--serve while the branch port is taken: BROWSER_PORT_BUSY', async (t) => {
  const r = repoWithScript('export default async () => {}\n')
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: r.root, encoding: 'utf8' }).trim()
  const port = 4100 + (parseInt(createHash('sha256').update(branch).digest('hex').slice(0, 4), 16) % 800)
  const server = net.createServer()
  await new Promise((resolve, reject) => server.once('error', reject).listen(port, '127.0.0.1', resolve))
  t.after(() => server.close())
  const out = await cli(['run', 'check.mjs', '--serve'], { cwd: r.root, home: tempHome() })
  assert.equal(out.status, 1)
  assert.match(out.stderr, /code: BROWSER_PORT_BUSY/)
  assert.match(out.stderr, new RegExp(`port ${port} `))
})

test('shot saves the viewport by default and the page with fullPage: true', async () => {
  const r = repoWithScript("export default async ({ shot }) => { await shot('view'); await shot('full', { fullPage: true }) }\n")
  const home = tempHome()
  const out = await cli(['run', 'check.mjs'], { cwd: r.root, home })
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /^shot: \.distro\/browser\/run-[^/]+\/view\.png$/m)
  assert.match(out.stdout, /^shot: \.distro\/browser\/run-[^/]+\/full\.png$/m)
  assert.deepEqual(recorded(home).map((o) => [path.basename(o.path), o.fullPage]), [['view.png', false], ['full.png', true]])
})

test('real Chromium: viewport 800 x 600, full page 800 x 3016', { skip: !fs.existsSync(REAL_RUNTIME) && `no Playwright runtime at ${REAL_RUNTIME}` }, async () => {
  const r = repoWithScript(`export default async ({ page, shot }) => {
  await page.setViewportSize({ width: 800, height: 600 })
  await page.setContent('<div style="height:3000px;background:linear-gradient(red,blue)"></div>')
  await shot('view')
  await shot('full', { fullPage: true })
}
`)
  const out = await cli(['run', 'check.mjs', '--timeout', '60'], { cwd: r.root, home: os.homedir() })
  assert.equal(out.status, 0, out.stderr)
  const size = (name) => {
    const rel = out.stdout.match(new RegExp(`^shot: (.+/${name}\\.png)$`, 'm'))[1]
    const png = fs.readFileSync(path.join(r.root, rel))
    return [png.readUInt32BE(16), png.readUInt32BE(20)]
  }
  assert.deepEqual(size('view'), [800, 600])
  assert.deepEqual(size('full'), [800, 3016])
})
