import { it, expect } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import Badge from '../Badge.vue'
it('shows 9+ above nine', async () => {
  const html = await renderToString(createSSRApp(Badge, { count: 12 }))
  expect(html).toContain('9+')
})
