import { test } from 'node:test'
import assert from 'node:assert/strict'
import { vueScript, extractImports } from '../core.mjs'

test('vueScript: keeps <script> content, blanks the rest, preserves line numbers', () => {
  const src = [
    '<template>', // 1
    '  <div/>', // 2
    '</template>', // 3
    '<script setup lang="ts">', // 4
    "import { useX } from '~/pageModules/a/composables/useX'", // 5
    '</script>', // 6
    ''
  ].join('\n')
  const out = vueScript(src)
  const imports = extractImports(out)
  assert.equal(imports.length, 1)
  assert.equal(imports[0].specifier, '~/pageModules/a/composables/useX')
  assert.equal(imports[0].line, 5)
})

test('vueScript: concatenates multiple script blocks', () => {
  const src = [
    '<script>', // 1
    "import a from '~/common/stores/a'", // 2
    '</script>', // 3
    '<script setup>', // 4
    "import b from '~/common/stores/b'", // 5
    '</script>' // 6
  ].join('\n')
  const specs = extractImports(vueScript(src)).map((i) => i.specifier)
  assert.deepEqual(specs.sort(), ['~/common/stores/a', '~/common/stores/b'])
})

test('vueScript: a template "import" word is not treated as code', () => {
  const src = '<template>\n  <p>how to import things</p>\n</template>\n'
  assert.deepEqual(extractImports(vueScript(src)), [])
})
