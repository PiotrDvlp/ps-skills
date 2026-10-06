import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateConfig, lintSource } from '../core.mjs'

const ALIASED = validateConfig({
  layerAliases: { utils: 'helpers', 'lazy-composables': 'composables' }
})

test('validateConfig: accepts layerAliases mapping dir names to canonical layers', () => {
  assert.deepEqual(ALIASED.layerAliases, { utils: 'helpers', 'lazy-composables': 'composables' })
})

test('validateConfig: rejects an alias pointing at an unknown canonical layer', () => {
  assert.throws(() => validateConfig({ layerAliases: { utils: 'widgets' } }), /widgets|unknown/i)
})

test('validateConfig: empty/undefined config exposes an empty layerAliases', () => {
  assert.deepEqual(validateConfig(undefined).layerAliases, {})
})

test('aliased layer is enforced: utils(=helpers) -> store is a layer-inversion', () => {
  const src = "import { useS } from '~/common/stores/s'\n"
  const { violations } = lintSource('pageModules/a/utils/x.ts', src, ALIASED)
  assert.equal(violations.length, 1)
  const v = violations[0]
  assert.equal(v.rule, 'layer-inversion')
  // display keeps the REAL dir name, not the canonical alias target
  assert.equal(v.from, 'a/utils')
  assert.equal(v.to, 'common/stores')
})

test('aliased layer no longer trips unknown-layer', () => {
  const src = "import { fmt } from '~/common/helpers/fmt'\n"
  const { violations } = lintSource('pageModules/a/utils/x.ts', src, ALIASED)
  // utils(=helpers) importing common/helpers is allowed, and NOT unknown-layer
  assert.deepEqual(violations, [])
})

test('importing an aliased layer is allowed where the canonical layer is', () => {
  // a mapper importing a same-module utils(=helpers) file is legal (mappers allow helpers)
  const src = "import { helper } from '../utils/helper'\n"
  const { violations } = lintSource('pageModules/a/mappers/m.ts', src, ALIASED)
  assert.deepEqual(violations, [])
})

test('without an alias, utils still reports unknown-layer (default unchanged)', () => {
  const src = "import { useS } from '~/common/stores/s'\n"
  const { violations } = lintSource('pageModules/a/utils/x.ts', src, validateConfig())
  assert.equal(violations.length, 1)
  assert.equal(violations[0].rule, 'unknown-layer')
})
