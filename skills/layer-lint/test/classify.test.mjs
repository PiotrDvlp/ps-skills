import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyFile } from '../core.mjs'

test('classifyFile: feature layer file', () => {
  assert.deepEqual(classifyFile('src/pageModules/cart/stores/cart.ts'), {
    root: 'pageModules',
    module: 'cart',
    layer: 'stores'
  })
})

test('classifyFile: feature component .vue', () => {
  assert.deepEqual(classifyFile('src/pageModules/product/components/Card.vue'), {
    root: 'pageModules',
    module: 'product',
    layer: 'components'
  })
})

test('classifyFile: nested file keeps its top layer', () => {
  assert.deepEqual(classifyFile('src/pageModules/cart/stores/sub/helpers.ts'), {
    root: 'pageModules',
    module: 'cart',
    layer: 'stores'
  })
})

test('classifyFile: common layer file (module is "common")', () => {
  assert.deepEqual(classifyFile('src/common/mappers/mapFoo.ts'), {
    root: 'common',
    module: 'common',
    layer: 'mappers'
  })
})

test('classifyFile: file outside pageModules/common is unclassified', () => {
  assert.equal(classifyFile('src/components/GlobalNav.vue'), null)
  assert.equal(classifyFile('src/utils/foo.ts'), null)
})
