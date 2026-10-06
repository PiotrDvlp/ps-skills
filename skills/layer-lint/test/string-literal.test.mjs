import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractImports, lintSource, validateConfig } from '../core.mjs'

const specs = (s) => extractImports(s).map((i) => i.specifier)

test('extractImports: import-looking text inside a double-quoted string is ignored', () => {
  const src = 'const example = "import { useS } from \'~/common/stores/s\'"\n'
  assert.deepEqual(specs(src), [])
})

test('extractImports: import-looking text inside a template literal is ignored', () => {
  const src = 'const tpl = `import { useS } from \x27~/common/stores/s\x27`\n'
  assert.deepEqual(specs(src), [])
})

test('extractImports: real specifier string is still captured (regression)', () => {
  const src = "import { useS } from '~/common/stores/s'\n"
  assert.deepEqual(specs(src), ['~/common/stores/s'])
})

test('extractImports: side-effect import specifier still captured', () => {
  const src = "import '~/pageModules/a/composables/useA'\n"
  assert.deepEqual(specs(src), ['~/pageModules/a/composables/useA'])
})

test('extractImports: real import after a string containing import-text is still found', () => {
  const src =
    "const doc = \"import x from '~/pageModules/b/stores/b'\"\nimport { useS } from '~/common/stores/s'\n"
  assert.deepEqual(specs(src), ['~/common/stores/s'])
})

test('lintSource: a string-literal example does not produce a false violation', () => {
  const src = 'export const help = "import { x } from \'~/common/stores/s\'"\n'
  const r = lintSource('src/pageModules/a/mappers/m.ts', src, validateConfig())
  assert.deepEqual(r.violations, [])
})
