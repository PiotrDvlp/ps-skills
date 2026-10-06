import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveSpecifier } from '../core.mjs'

test('resolveSpecifier: ~/ alias into pageModules layer', () => {
  assert.deepEqual(
    resolveSpecifier('~/pageModules/cart/stores/cart', 'src/pageModules/x/composables/useX.ts'),
    {
      kind: 'layer',
      root: 'pageModules',
      module: 'cart',
      layer: 'stores'
    }
  )
})

test('resolveSpecifier: ~/ alias into common layer', () => {
  assert.deepEqual(resolveSpecifier('~/common/mappers/mapX', 'src/pageModules/x/stores/x.ts'), {
    kind: 'layer',
    root: 'common',
    module: 'common',
    layer: 'mappers'
  })
})

test('resolveSpecifier: relative path normalized against importer dir', () => {
  assert.deepEqual(
    resolveSpecifier(
      '../mappers/mapNavigation',
      'src/pageModules/navigation/composables/useMainNavigation.ts'
    ),
    { kind: 'layer', root: 'pageModules', module: 'navigation', layer: 'mappers' }
  )
})

test('resolveSpecifier: #imports is the declared v1 blind spot', () => {
  assert.deepEqual(resolveSpecifier('#imports', 'src/pageModules/x/composables/useX.ts'), {
    kind: 'sharp-imports'
  })
})

test('resolveSpecifier: external/bare module is ignored', () => {
  assert.deepEqual(resolveSpecifier('vue', 'src/pageModules/x/stores/x.ts'), { kind: 'ignored' })
  assert.deepEqual(resolveSpecifier('#app', 'src/pageModules/x/stores/x.ts'), { kind: 'ignored' })
})

test('resolveSpecifier: in-app path outside pageModules/common is ignored', () => {
  assert.deepEqual(resolveSpecifier('~/utils/format', 'src/pageModules/x/stores/x.ts'), {
    kind: 'ignored'
  })
})
