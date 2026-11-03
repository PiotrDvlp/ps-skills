import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mismatches } from './retro-verdict.mjs'

const expected = {
  'PROJ-1': { verdict: 'START' },
  'PROJ-2': { verdict: 'START', minHandoffs: 1 },
  'PROJ-3': { verdict: 'BLOCKED' },
}

const allMatch = {
  'PROJ-1': { verdict: 'START', handoffs: 0 },
  'PROJ-2': { verdict: 'START', handoffs: 1 },
  'PROJ-3': { verdict: 'BLOCKED', handoffs: 0 },
}

test('all-match results produce no mismatches', () => {
  assert.deepEqual(mismatches(allMatch, expected), [])
})

test('a BLOCKED key flipped to START is reported', () => {
  const flipped = { ...allMatch, 'PROJ-3': { verdict: 'START', handoffs: 0 } }
  assert.deepEqual(mismatches(flipped, expected), ['PROJ-3: expected verdict BLOCKED, got START'])
})

test('a key below its handoff minimum is reported', () => {
  const noHandoff = { ...allMatch, 'PROJ-2': { verdict: 'START', handoffs: 0 } }
  assert.deepEqual(mismatches(noHandoff, expected), ['PROJ-2: expected handoffs >= 1, got 0'])
})

test('a missing key is reported', () => {
  const { 'PROJ-3': _, ...partial } = allMatch
  assert.deepEqual(mismatches(partial, expected), ['PROJ-3: missing from results'])
})

test('--check exits 1 and names the key on a flipped result file', () => {
  const dir = tmpdir()
  const expectedFile = join(dir, `retro-expected-${process.pid}.json`)
  const resultsFile = join(dir, `retro-flipped-${process.pid}.json`)
  writeFileSync(expectedFile, JSON.stringify(expected))
  writeFileSync(resultsFile, JSON.stringify({ ...allMatch, 'PROJ-3': { verdict: 'START', handoffs: 0 } }))
  const script = fileURLToPath(new URL('./retro-verdict.mjs', import.meta.url))
  const run = spawnSync(process.execPath, [script, '--expected', expectedFile, '--check', resultsFile], {
    encoding: 'utf8',
  })
  assert.equal(run.status, 1)
  assert.equal(run.stdout.trim(), 'PROJ-3: expected verdict BLOCKED, got START')
})
