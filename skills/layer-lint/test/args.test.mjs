import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'lint-layers.mjs')

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'layerlint-args-'))
  const write = (rel, content) => {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  write('src/pageModules/a/composables/useA.ts', "import { useS } from '~/common/stores/s'\n")
  write('src/common/stores/s.ts', 'export const useS = () => ({})\n')
  return root
}

function run(args, cwd) {
  const r = spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8' })
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
}

test('CLI: space-form --config is rejected, not silently ignored', () => {
  const root = repo()
  try {
    // The classic trap: `--config <path>` (space) used to run with NO config,
    // silently dropping the allowlist/severity overrides and looking green.
    const { code, stderr } = run(['--config', `${root}/cfg.json`, '--root=src'], root)
    assert.equal(code, 2)
    assert.match(stderr, /--config/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('CLI: an unknown flag is rejected loudly', () => {
  const root = repo()
  try {
    const { code, stderr } = run(['--fromat=json', '--root=src'], root)
    assert.equal(code, 2)
    assert.match(stderr, /unknown|unrecognized/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('CLI: valid = -form args are still accepted', () => {
  const root = repo()
  try {
    const { code } = run(['--format=json', '--root=src', `--config=${root}/nope.json`], root)
    // missing config file falls back to empty config; clean fixture => exit 0
    assert.equal(code, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
