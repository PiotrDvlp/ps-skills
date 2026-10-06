import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyFile, resolveSpecifier } from '../core.mjs'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'lint-layers.mjs')

// --- classification is srcDir-agnostic ---------------------------------------
// futterhaus srcDir is `src/`, betzold's srcDir is the repo root (no prefix),
// a stock Nuxt 4 srcDir is `app/`. Classification must not hardcode one layout.

test('classifyFile: root srcDir (no src/ prefix) feature file', () => {
  assert.deepEqual(classifyFile('pageModules/cart/stores/cart.ts'), {
    root: 'pageModules',
    module: 'cart',
    layer: 'stores'
  })
})

test('classifyFile: root srcDir (no src/ prefix) common file', () => {
  assert.deepEqual(classifyFile('common/mappers/mapFoo.ts'), {
    root: 'common',
    module: 'common',
    layer: 'mappers'
  })
})

test('classifyFile: app/ srcDir feature file', () => {
  assert.deepEqual(classifyFile('app/pageModules/product/components/Card.vue'), {
    root: 'pageModules',
    module: 'product',
    layer: 'components'
  })
})

test('classifyFile: root-relative non-layer paths still unclassified', () => {
  assert.equal(classifyFile('components/GlobalNav.vue'), null)
  assert.equal(classifyFile('utils/foo.ts'), null)
  assert.equal(classifyFile('server/api/x.ts'), null)
})

test('resolveSpecifier: ~/ alias from a root-srcDir importer', () => {
  assert.deepEqual(
    resolveSpecifier('~/common/stores/s', 'pageModules/a/mappers/mapA.ts'),
    { kind: 'layer', root: 'common', module: 'common', layer: 'stores' }
  )
})

// --- CLI end-to-end on a root-srcDir repo ------------------------------------

function rootSrcDirRepo() {
  const root = mkdtempSync(join(tmpdir(), 'layerlint-rootsrc-'))
  const write = (rel, content) => {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  // srcDir is the repo root: feature code lives at pageModules/…, common/…
  // mapper -> store == layer-inversion (error)
  write('pageModules/a/mappers/mapA.ts', "import { useS } from '~/common/stores/s'\n")
  write('common/stores/s.ts', 'export const useS = () => ({})\n')
  return root
}

function run(args, cwd) {
  const r = spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8' })
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
}

test('CLI: root srcDir repo (--root=.) detects the inversion, not a false green', () => {
  const root = rootSrcDirRepo()
  try {
    const { code, stdout } = run(['--format=json', '--root=.'], root)
    const out = JSON.parse(stdout)
    assert.equal(out.passes, false)
    const inv = out.violations.filter((v) => v.rule === 'layer-inversion')
    assert.equal(inv.length, 1)
    assert.equal(inv[0].from, 'a/mappers')
    assert.equal(inv[0].to, 'common/stores')
    assert.equal(code, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// --- zero-coverage guard: a scan that classifies nothing must fail loudly ----

test('CLI: scanning files but classifying none exits 2 with a clear message', () => {
  const root = mkdtempSync(join(tmpdir(), 'layerlint-nocov-'))
  try {
    mkdirSync(join(root, 'src', 'utils'), { recursive: true })
    writeFileSync(join(root, 'src', 'utils', 'foo.ts'), 'export const x = 1\n')
    const { code, stderr } = run(['--format=json', '--root=src'], root)
    assert.equal(code, 2)
    assert.match(stderr, /classified 0|no files.*layer|none.*layer/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('CLI: zero-coverage guard fires even under --report-only', () => {
  const root = mkdtempSync(join(tmpdir(), 'layerlint-nocov2-'))
  try {
    mkdirSync(join(root, 'src', 'utils'), { recursive: true })
    writeFileSync(join(root, 'src', 'utils', 'foo.ts'), 'export const x = 1\n')
    const { code } = run(['--report-only', '--root=src'], root)
    assert.equal(code, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
