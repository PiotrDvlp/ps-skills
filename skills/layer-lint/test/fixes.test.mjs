import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateConfig,
  evaluateEdge,
  resolveSpecifier,
  extractImports,
  lintSource,
  isAllowlisted
} from '../core.mjs'

const F = (root, module, layer) => ({ root, module, layer })

// Fix 1 — severityOverrides validation
test('validateConfig: rejects an invalid severity value', () => {
  assert.throws(
    () => validateConfig({ severityOverrides: { 'layer-inversion': 'warning' } }),
    /severity|warn|error/i
  )
})
test('validateConfig: rejects an unknown rule name in overrides', () => {
  assert.throws(
    () => validateConfig({ severityOverrides: { 'layer-inverson': 'warn' } }),
    /rule|unknown/i
  )
})
test('validateConfig: accepts valid overrides', () => {
  const c = validateConfig({ severityOverrides: { 'cross-feature-internal': 'error' } })
  assert.equal(c.severityOverrides['cross-feature-internal'], 'error')
})

// Fix 2 — all-inline-type import is type-only
test('extractImports: drops an import whose bindings are all inline `type`', () => {
  const specs = extractImports("import { type A, type B } from '~/common/stores/x'\n").map(
    (i) => i.specifier
  )
  assert.deepEqual(specs, [])
})
test('extractImports: keeps a mixed value + inline-type import', () => {
  const specs = extractImports("import { foo, type B } from '~/common/stores/x'\n").map(
    (i) => i.specifier
  )
  assert.deepEqual(specs, ['~/common/stores/x'])
})
test('extractImports: keeps a default import even with an inline-type member', () => {
  const specs = extractImports("import Foo, { type B } from '~/common/stores/x'\n").map(
    (i) => i.specifier
  )
  assert.deepEqual(specs, ['~/common/stores/x'])
})

// Fix 3 — glob brace/charclass/? support
test('isAllowlisted: brace-expansion glob in files matches', () => {
  const v = {
    rule: 'layer-inversion',
    from: 'a/mappers',
    to: 'common/stores',
    file: 'src/pageModules/a/mappers/m.ts'
  }
  const cfg = validateConfig({
    allow: [
      { rule: 'layer-inversion', from: '*/mappers', to: 'common/stores', files: ['**/*.{ts,vue}'] }
    ]
  })
  assert.equal(isAllowlisted(v, cfg), true)
})
test('isAllowlisted: ? matches a single char and [..] matches a class', () => {
  const v = {
    rule: 'layer-inversion',
    from: 'a/mappers',
    to: 'common/stores',
    file: 'src/pageModules/a/mappers/m1.ts'
  }
  const cfg = validateConfig({
    allow: [
      { rule: 'layer-inversion', from: '*/mappers', to: 'common/stores', files: ['**/m?.[tj]s'] }
    ]
  })
  assert.equal(isAllowlisted(v, cfg), true)
})

// Fix 4 — unknown / non-canonical layer is surfaced, not silently skipped
test('lintSource: a file in a non-canonical layer emits an unknown-layer warning', () => {
  const r = lintSource(
    'src/pageModules/a/utils/x.ts',
    "import { s } from '~/common/stores/s'\n",
    validateConfig()
  )
  const unknown = r.violations.filter((v) => v.rule === 'unknown-layer')
  assert.equal(unknown.length, 1)
  assert.equal(unknown[0].severity, 'warn')
})

// Fix 5 — helpers/views are cross-feature internals; keys stays public
test('evaluateEdge: cross-feature helpers reach is flagged', () => {
  const v = evaluateEdge(
    F('pageModules', 'cart', 'views'),
    F('pageModules', 'staticContentPages', 'helpers')
  )
  assert.equal(v.rule, 'cross-feature-internal')
})
test('evaluateEdge: cross-feature keys reach stays allowed (injection-token surface)', () => {
  assert.equal(
    evaluateEdge(F('pageModules', 'a', 'components'), F('pageModules', 'b', 'keys')),
    null
  )
})

// Fix 6 — @/ alias
test('resolveSpecifier: @/ alias resolves like ~/', () => {
  assert.deepEqual(
    resolveSpecifier('@/pageModules/cart/stores/cart', 'src/pageModules/x/mappers/m.ts'),
    {
      kind: 'layer',
      root: 'pageModules',
      module: 'cart',
      layer: 'stores'
    }
  )
})

// Fix 7 — inline disable directive
test('lintSource: // layer-lint-disable-next-line suppresses the next line', () => {
  const src =
    "// layer-lint-disable-next-line layer-inversion\nimport { useS } from '~/common/stores/s'\n"
  const r = lintSource('src/pageModules/a/mappers/m.ts', src, validateConfig())
  assert.deepEqual(r.violations, [])
})
test('lintSource: a directive for a different rule does NOT suppress', () => {
  const src =
    "// layer-lint-disable-next-line skip-layer\nimport { useS } from '~/common/stores/s'\n"
  const r = lintSource('src/pageModules/a/mappers/m.ts', src, validateConfig())
  assert.equal(r.violations.length, 1)
})

// Fix 8 — line numbers stay correct (binary-search lineAt regression guard)
test('extractImports: line numbers correct across many preceding lines', () => {
  const src = '\n'.repeat(50) + "import { useS } from '~/common/stores/s'\n"
  assert.equal(extractImports(src)[0].line, 51)
})
