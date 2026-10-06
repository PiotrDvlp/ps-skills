import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractImports } from '../core.mjs'

const specs = (src) => extractImports(src).map((i) => i.specifier)

test('extractImports: simple value import', () => {
  const r = extractImports("import { useCartStore } from '~/pageModules/cart/stores/cart'\n")
  assert.deepEqual(r, [{ specifier: '~/pageModules/cart/stores/cart', line: 1 }])
})

test('extractImports: drops leading `import type`', () => {
  const src = "import type { Foo } from '~/pageModules/x/composables/useX'\n"
  assert.deepEqual(specs(src), [])
})

test('extractImports: keeps mixed value+inline-type import', () => {
  const src = "import { foo, type Bar } from '~/common/stores/domain'\n"
  assert.deepEqual(specs(src), ['~/common/stores/domain'])
})

test('extractImports: multiline import, line is statement start', () => {
  const src = "const a = 1\nimport {\n  one,\n  two,\n} from '../mappers/mapNavigation'\n"
  assert.deepEqual(extractImports(src), [{ specifier: '../mappers/mapNavigation', line: 2 }])
})

test('extractImports: export ... from re-export', () => {
  const src = "export { mapX } from '~/common/mappers/mapX'\nexport * from './local'\n"
  assert.deepEqual(specs(src), ['~/common/mappers/mapX', './local'])
})

test('extractImports: ignores specifiers inside comments', () => {
  const src =
    "// import { evil } from '~/pageModules/x/stores/x'\n/* import y from '~/common/stores/y' */\nimport { ok } from '~/common/stores/z'\n"
  assert.deepEqual(specs(src), ['~/common/stores/z'])
})

test('extractImports: side-effect import', () => {
  const src = "import '~/pageModules/analyticsTracking/composables/useTrack'\n"
  assert.deepEqual(specs(src), ['~/pageModules/analyticsTracking/composables/useTrack'])
})

test('extractImports: drops `export type ... from`', () => {
  const src = "export type { T } from '~/common/graphql/types'\n"
  assert.deepEqual(specs(src), [])
})
