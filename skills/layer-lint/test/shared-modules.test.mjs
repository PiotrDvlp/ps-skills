import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateEdge, validateConfig, lintSource, fixFor } from '../core.mjs'

const F = (root, module, layer) => ({ root, module, layer })

// --- evaluateEdge with a designated shared module -----------------------------

test('shared module is a public surface: feature -> form/components is allowed', () => {
  const v = evaluateEdge(F('pageModules', 'cart', 'components'), F('pageModules', 'form', 'components'), [
    'form'
  ])
  assert.equal(v, null)
})

test('without sharedModules, feature -> form/components is still cross-feature-internal', () => {
  const v = evaluateEdge(F('pageModules', 'cart', 'components'), F('pageModules', 'form', 'components'))
  assert.equal(v.rule, 'cross-feature-internal')
})

test('a shared module must not reach into a feature (shared-reaches-feature, error)', () => {
  // composables->stores would normally be a legal layer edge; the structural
  // shared-base rule takes priority, exactly like common-reaches-feature.
  const v = evaluateEdge(F('pageModules', 'form', 'composables'), F('pageModules', 'cart', 'stores'), [
    'form'
  ])
  assert.equal(v.rule, 'shared-reaches-feature')
  assert.equal(v.severity, 'error')
})

test('shared -> shared and shared -> common are allowed', () => {
  assert.equal(
    evaluateEdge(F('pageModules', 'form', 'composables'), F('common', 'common', 'helpers'), ['form']),
    null
  )
})

test('layer-direction still applies within a shared module', () => {
  // form/mappers -> form/stores is an inversion regardless of shared status
  const v = evaluateEdge(F('pageModules', 'form', 'mappers'), F('pageModules', 'form', 'stores'), [
    'form'
  ])
  assert.equal(v.rule, 'layer-inversion')
})

// --- config -------------------------------------------------------------------

test('validateConfig: parses sharedModules and defaults to []', () => {
  assert.deepEqual(validateConfig({ sharedModules: ['form'] }).sharedModules, ['form'])
  assert.deepEqual(validateConfig(undefined).sharedModules, [])
})

test('validateConfig: rejects a non-array / non-string sharedModules', () => {
  assert.throws(() => validateConfig({ sharedModules: 'form' }), /sharedModules/i)
  assert.throws(() => validateConfig({ sharedModules: [1] }), /sharedModules/i)
})

// --- lintSource integration ---------------------------------------------------

test('lintSource: feature importing a shared module is clean', () => {
  const src = "import Field from '~/pageModules/form/components/Field.vue'\n"
  const cfg = validateConfig({ sharedModules: ['form'] })
  assert.deepEqual(lintSource('pageModules/cart/components/CartX.vue', src, cfg).violations, [])
})

test('lintSource: without sharedModules the same edge warns', () => {
  const src = "import Field from '~/pageModules/form/components/Field.vue'\n"
  const { violations } = lintSource('pageModules/cart/components/CartX.vue', src, validateConfig())
  assert.equal(violations.length, 1)
  assert.equal(violations[0].rule, 'cross-feature-internal')
})

test('fixFor: shared-reaches-feature has agent-voice guidance', () => {
  const fix = fixFor('shared-reaches-feature', F('pageModules', 'form', 'composables'), F('pageModules', 'cart', 'stores'))
  assert.match(fix, /shared|feature/i)
})
