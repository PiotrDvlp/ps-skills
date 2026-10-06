import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'lint-layers.mjs')

/**
 * The ISFH-1795 shape: a common/ file with ONE explicit feature import and several
 * auto-imported feature calls. The explicit edge is the only thing v1 can see, so the
 * report must say out loud that the rest went unanalyzed.
 */
function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), 'layerlint-blind-'))
  const write = (rel, content) => {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  write(
    'src/common/composables/useCommonAsyncData.ts',
    "import useFlag from '~/pageModules/globalParameter/composables/useFlag'\n" +
      'export default function useCommonAsyncData() {\n' +
      '  useFlag()\n' +
      '  return [useCoreMainCategories(), useFindWishlistSimple(), useGetContentPageByLink()]\n' +
      '}\n'
  )
  write('src/pageModules/globalParameter/composables/useFlag.ts', 'export default () => true\n')
  return root
}

function run(args, cwd) {
  try {
    return { code: 0, stdout: execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8' }) }
  } catch (e) {
    return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' }
  }
}

test('CLI json: blindSpots counts are present without --report-dependencies', () => {
  const root = fixtureRepo()
  try {
    const { stdout } = run(['--format=json', `--root=${root}/src`], root)
    const out = JSON.parse(stdout)
    assert.equal(out.violations.length, 1)
    assert.equal(out.violations[0].rule, 'common-reaches-feature')
    // The headline number a consumer must not be able to miss.
    assert.equal(out.blindSpots.unresolvedCalls, 3)
    assert.equal(out.unresolvedCalls, undefined) // detail is opt-in
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('CLI json: --report-dependencies adds the unresolved-call detail', () => {
  const root = fixtureRepo()
  try {
    const { stdout } = run(['--format=json', '--report-dependencies', `--root=${root}/src`], root)
    const out = JSON.parse(stdout)
    assert.deepEqual(
      out.unresolvedCalls.map((c) => c.name).sort(),
      ['useCoreMainCategories', 'useFindWishlistSimple', 'useGetContentPageByLink']
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('CLI human: the finding carries the not-analyzed caveat for its own file', () => {
  const root = fixtureRepo()
  try {
    const { stdout } = run([`--root=${root}/src`], root)
    assert.match(stdout, /common-reaches-feature/)
    assert.match(stdout, /3 further call\(s\) in this file are auto-imports and were NOT analyzed/)
    assert.match(stdout, /useCoreMainCategories/)
    assert.match(stdout, /auto-import call\(s\) in 1 file\(s\)/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('CLI agent: the caveat warns against acting on the edge in isolation', () => {
  const root = fixtureRepo()
  try {
    const { stdout } = run(['--format=agent', `--root=${root}/src`], root)
    assert.match(stdout, /caveat: 3 further call\(s\)/)
    assert.match(stdout, /Confirm this edge is not one of many before acting/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('CLI: a root matching zero files exits 2, never a green pass', () => {
  const root = fixtureRepo()
  try {
    const { code, stderr } = run(['--format=json', `--root=${root}/does-not-exist`], root)
    assert.equal(code, 2)
    assert.match(stderr, /found no files/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('CLI: large --report-dependencies output is not truncated on a pipe', () => {
  const root = mkdtempSync(join(tmpdir(), 'layerlint-big-'))
  try {
    for (let i = 0; i < 400; i++) {
      mkdirSync(join(root, 'src/common/composables'), { recursive: true })
      writeFileSync(
        join(root, `src/common/composables/useF${i}.ts`),
        `export default () => [useAlpha${i}(), useBeta${i}(), useGamma${i}()]\n`
      )
    }
    const { stdout } = run(['--format=json', '--report-dependencies', `--root=${root}/src`], root)
    const out = JSON.parse(stdout) // would throw on a 64KB truncation
    assert.ok(stdout.length > 65536, `expected >64KB payload, got ${stdout.length}`)
    assert.equal(out.unresolvedCalls.length, 1200)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
