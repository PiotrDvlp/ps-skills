import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateConfig, effectiveSeverity, isAllowlisted } from '../core.mjs'

test('validateConfig: rejects an allow entry missing `rule`', () => {
  assert.throws(() => validateConfig({ allow: [{ from: 'a/mappers', to: 'b/stores' }] }), /rule/i)
})

test('validateConfig: accepts a well-formed config and returns it normalized', () => {
  const cfg = validateConfig({
    severityOverrides: { 'cross-feature-internal': 'error' },
    allow: []
  })
  assert.equal(cfg.severityOverrides['cross-feature-internal'], 'error')
  assert.deepEqual(cfg.allow, [])
})

test('validateConfig: empty/undefined config is valid', () => {
  assert.deepEqual(validateConfig(undefined), {
    severityOverrides: {},
    allow: [],
    layerAliases: {},
    sharedModules: []
  })
})

test('effectiveSeverity: override wins over default', () => {
  const cfg = validateConfig({ severityOverrides: { 'cross-feature-internal': 'error' } })
  assert.equal(effectiveSeverity('cross-feature-internal', 'warn', cfg), 'error')
  assert.equal(effectiveSeverity('layer-inversion', 'error', cfg), 'error')
})

const v = {
  rule: 'layer-inversion',
  from: 'analyticsTracking/mappers',
  to: 'common/stores',
  file: 'src/pageModules/analyticsTracking/mappers/mapProductPagePayload.ts'
}

test('isAllowlisted: exact from/to/rule match suppresses', () => {
  const cfg = validateConfig({
    allow: [{ rule: 'layer-inversion', from: 'analyticsTracking/mappers', to: 'common/stores' }]
  })
  assert.equal(isAllowlisted(v, cfg), true)
})

test('isAllowlisted: a different rule does NOT suppress', () => {
  const cfg = validateConfig({
    allow: [{ rule: 'skip-layer', from: 'analyticsTracking/mappers', to: 'common/stores' }]
  })
  assert.equal(isAllowlisted(v, cfg), false)
})

test('isAllowlisted: glob in from/to matches', () => {
  const cfg = validateConfig({
    allow: [{ rule: 'layer-inversion', from: '*/mappers', to: 'common/**' }]
  })
  assert.equal(isAllowlisted(v, cfg), true)
})

test('isAllowlisted: files narrows to specific importing file', () => {
  const match = validateConfig({
    allow: [
      {
        rule: 'layer-inversion',
        from: '*/mappers',
        to: 'common/stores',
        files: ['**/mapProductPagePayload.ts']
      }
    ]
  })
  const noMatch = validateConfig({
    allow: [
      { rule: 'layer-inversion', from: '*/mappers', to: 'common/stores', files: ['**/other.ts'] }
    ]
  })
  assert.equal(isAllowlisted(v, match), true)
  assert.equal(isAllowlisted(v, noMatch), false)
})
