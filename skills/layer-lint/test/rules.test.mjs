import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateEdge } from '../core.mjs'

const F = (root, module, layer) => ({ root, module, layer })
const rule = (from, to) => {
  const v = evaluateEdge(from, to)
  return v ? v.rule : null
}

test('allowed: composable -> store (same module)', () => {
  assert.equal(
    rule(F('pageModules', 'cart', 'composables'), F('pageModules', 'cart', 'stores')),
    null
  )
})

test('allowed: self-layer import (mapper -> mapper)', () => {
  assert.equal(rule(F('pageModules', 'x', 'mappers'), F('pageModules', 'x', 'mappers')), null)
})

test('layer-inversion: mapper -> store (verified analyticsTracking/mappers -> common/stores)', () => {
  const v = evaluateEdge(
    F('pageModules', 'analyticsTracking', 'mappers'),
    F('common', 'common', 'stores')
  )
  assert.equal(v.rule, 'layer-inversion')
  assert.equal(v.severity, 'error')
})

test('layer-inversion: helper -> store (verified novomindIshopTracking/helpers -> cart/stores)', () => {
  assert.equal(
    rule(F('pageModules', 'novomindIshopTracking', 'helpers'), F('pageModules', 'cart', 'stores')),
    'layer-inversion'
  )
})

test('skip-layer: component -> mapper is a warn, not an error', () => {
  const v = evaluateEdge(F('pageModules', 'x', 'components'), F('pageModules', 'x', 'mappers'))
  assert.equal(v.rule, 'skip-layer')
  assert.equal(v.severity, 'warn')
})

test('allowed: cross-feature composable -> store (verified search -> productList/stores)', () => {
  assert.equal(
    rule(F('pageModules', 'search', 'composables'), F('pageModules', 'productList', 'stores')),
    null
  )
})

test('common-reaches-feature: common may not import pageModules', () => {
  const v = evaluateEdge(F('common', 'common', 'composables'), F('pageModules', 'cart', 'stores'))
  assert.equal(v.rule, 'common-reaches-feature')
  assert.equal(v.severity, 'error')
})

test('cross-feature-internal: component -> another feature component (layer ok, boundary not)', () => {
  const v = evaluateEdge(F('pageModules', 'a', 'components'), F('pageModules', 'b', 'components'))
  assert.equal(v.rule, 'cross-feature-internal')
  assert.equal(v.severity, 'warn')
})

test('allowed: feature may import common public surface', () => {
  assert.equal(rule(F('pageModules', 'cart', 'composables'), F('common', 'common', 'stores')), null)
})

test('graphql is a leaf: graphql -> store is an inversion', () => {
  assert.equal(
    rule(F('pageModules', 'x', 'graphql'), F('pageModules', 'x', 'stores')),
    'layer-inversion'
  )
})
