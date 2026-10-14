import { it, expect } from 'vitest'
import { sum } from '../sum'
it('adds', () => { expect(sum(2, 3)).toBe(5) })
