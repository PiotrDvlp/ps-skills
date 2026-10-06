import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractUnresolvedCalls, lintSource, validateConfig } from '../core.mjs'

const names = (src) => extractUnresolvedCalls(src).map((c) => c.name)

test('extractUnresolvedCalls: a bare auto-imported call is unresolved', () => {
  assert.deepEqual(names('const x = useCoreMainCategories({ sync: true })\n'), [
    'useCoreMainCategories'
  ])
})

test('extractUnresolvedCalls: an explicitly imported call is resolved, not reported', () => {
  const src =
    "import useThing from '~/pageModules/a/composables/useThing'\nconst x = useThing()\n"
  assert.deepEqual(names(src), [])
})

test('extractUnresolvedCalls: named and aliased import bindings count as resolved', () => {
  const src = "import { a, b as c } from '~/common/helpers/x'\na()\nc()\n"
  assert.deepEqual(names(src), [])
})

test('extractUnresolvedCalls: locally declared functions are not unresolved', () => {
  const src = 'function local() {}\nconst arrow = () => {}\nlocal()\narrow()\n'
  assert.deepEqual(names(src), [])
})

test('extractUnresolvedCalls: destructured bindings are bound, their source is not', () => {
  const src = 'const { setFromParameters } = useClickAndReserveActivation()\nsetFromParameters()\n'
  assert.deepEqual(names(src), ['useClickAndReserveActivation'])
})

test('extractUnresolvedCalls: framework globals are not reported', () => {
  const src = 'const r = ref(0)\nconst c = computed(() => r.value)\nwatch(r, () => {})\nuseState("k")\n'
  assert.deepEqual(names(src), [])
})

test('extractUnresolvedCalls: control-flow keywords are not calls', () => {
  const src = 'if (a) { for (const x of y) { while (z) {} } }\ntry { await q() } catch (e) {}\n'
  assert.deepEqual(names(src), ['q'])
})

test('extractUnresolvedCalls: method definitions are definitions, not calls', () => {
  const src = 'const o = {\n  pause() { return 1 },\n  addToCart(state) { return state }\n}\n'
  assert.deepEqual(names(src), [])
})

test('extractUnresolvedCalls: member calls are ignored (only bare identifiers)', () => {
  const src = 'foo.bar()\nobj?.baz()\nJSON.parse("{}")\n'
  assert.deepEqual(names(src), [])
})

test('extractUnresolvedCalls: text inside comments and strings is not a call', () => {
  const src = '// useGhost()\n/* useOther() */\nconst s = "useString()"\nuseReal()\n'
  assert.deepEqual(names(src), ['useReal'])
})

test('extractUnresolvedCalls: reports first line and dedupes repeat calls', () => {
  const src = '\n\nuseThing()\nuseThing()\n'
  assert.deepEqual(extractUnresolvedCalls(src), [{ name: 'useThing', line: 3 }])
})

test('lintSource: unresolved calls are reported but are never violations', () => {
  const file = 'src/common/composables/useCommonAsyncData.ts'
  const src = 'const a = useCoreMainCategories()\nconst b = useFindWishlistSimple()\n'
  const { violations, unresolvedCalls } = lintSource(file, src, validateConfig())
  assert.deepEqual(violations, [])
  assert.deepEqual(
    unresolvedCalls.map((c) => c.name),
    ['useCoreMainCategories', 'useFindWishlistSimple']
  )
  assert.equal(unresolvedCalls[0].file, file)
})

test('lintSource: an unclassified file reports no unresolved calls', () => {
  const { unresolvedCalls } = lintSource('src/utils/thing.ts', 'useThing()\n', validateConfig())
  assert.deepEqual(unresolvedCalls, [])
})

test('lintSource: a real violation and unresolved calls coexist in one file', () => {
  const file = 'src/common/composables/useCommonAsyncData.ts'
  const src =
    "import x, { F } from '~/pageModules/globalParameter/composables/useFlag'\n" +
    'const a = useCoreMainCategories()\nx()\nconst f = F\n'
  const { violations, unresolvedCalls } = lintSource(file, src, validateConfig())
  assert.equal(violations.length, 1)
  assert.equal(violations[0].rule, 'common-reaches-feature')
  // The whole point of step 1: the explicit edge is NOT the file's only feature edge.
  assert.deepEqual(
    unresolvedCalls.map((c) => c.name),
    ['useCoreMainCategories']
  )
})
