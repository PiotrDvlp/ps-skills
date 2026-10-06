import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lintSource } from '../core.mjs'
import { validateConfig } from '../core.mjs'

const FILE = 'src/pageModules/analyticsTracking/mappers/mapProductPagePayload.ts'

test('lintSource: flags a mapper -> store layer-inversion with location and fix', () => {
  const src = "import { useDomainStore } from '~/common/stores/domain'\n"
  const { violations } = lintSource(FILE, src, validateConfig())
  assert.equal(violations.length, 1)
  const v = violations[0]
  assert.equal(v.rule, 'layer-inversion')
  assert.equal(v.severity, 'error')
  assert.equal(v.from, 'analyticsTracking/mappers')
  assert.equal(v.to, 'common/stores')
  assert.equal(v.line, 1)
  assert.match(v.fix, /mapper/i) // agent-voice remediation present
})

test('lintSource: allowlisted edge produces no violation', () => {
  const src = "import { useDomainStore } from '~/common/stores/domain'\n"
  const cfg = validateConfig({
    allow: [{ rule: 'layer-inversion', from: '*/mappers', to: 'common/stores' }]
  })
  assert.deepEqual(lintSource(FILE, src, cfg).violations, [])
})

test('lintSource: #imports edge is recorded as a blind spot, not a violation', () => {
  const src = "import { mapColors } from '#imports'\n"
  const r = lintSource(FILE, src, validateConfig())
  assert.deepEqual(r.violations, [])
  assert.equal(r.sharpImports.length, 1)
  assert.equal(r.sharpImports[0].specifier, '#imports')
})

test('lintSource: type-only import is ignored entirely', () => {
  const src = "import type { Domain } from '~/common/stores/domain'\n"
  const r = lintSource(FILE, src, validateConfig())
  assert.deepEqual(r.violations, [])
  assert.deepEqual(r.sharpImports, [])
})

test('lintSource: file outside pageModules/common yields nothing', () => {
  const src = "import { useDomainStore } from '~/common/stores/domain'\n"
  assert.deepEqual(lintSource('src/utils/foo.ts', src, validateConfig()).violations, [])
})
