import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'lint-layers.mjs')

function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), 'layerlint-'))
  const write = (rel, content) => {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  // mapper -> store == layer-inversion (error)
  write('src/pageModules/a/mappers/mapA.ts', "import { useS } from '~/common/stores/s'\n")
  write('src/common/stores/s.ts', 'export const useS = () => ({})\n')
  // a clean file (composable -> store, allowed)
  write('src/pageModules/a/composables/useA.ts', "import { useS } from '~/common/stores/s'\n")
  return root
}

function run(args, cwd) {
  try {
    const stdout = execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8' })
    return { code: 0, stdout }
  } catch (e) {
    return { code: e.status, stdout: e.stdout || '' }
  }
}

test('CLI --format=json reports the inversion and fails (gating mode)', () => {
  const root = fixtureRepo()
  try {
    const { code, stdout } = run(['--format=json', `--root=${root}/src`], root)
    const out = JSON.parse(stdout)
    assert.equal(out.passes, false)
    const inv = out.violations.filter((v) => v.rule === 'layer-inversion')
    assert.equal(inv.length, 1)
    assert.equal(inv[0].from, 'a/mappers')
    assert.equal(inv[0].to, 'common/stores')
    assert.equal(code, 1) // gating: nonzero on unallowlisted error
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('CLI --report-only exits 0 even with errors, but passes:false', () => {
  const root = fixtureRepo()
  try {
    const { code, stdout } = run(['--format=json', '--report-only', `--root=${root}/src`], root)
    const out = JSON.parse(stdout)
    assert.equal(out.passes, false)
    assert.equal(code, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('CLI: allowlisted inversion -> passes:true, exit 0', () => {
  const root = fixtureRepo()
  try {
    writeFileSync(
      join(root, 'layer-lint.config.json'),
      JSON.stringify({
        allow: [{ rule: 'layer-inversion', from: 'a/mappers', to: 'common/stores', reason: 'test' }]
      })
    )
    const { code, stdout } = run(
      ['--format=json', `--root=${root}/src`, `--config=${root}/layer-lint.config.json`],
      root
    )
    const out = JSON.parse(stdout)
    assert.equal(out.passes, true)
    assert.equal(code, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
