import { describe, it, expect } from 'vitest'
import { sum } from '../sum'
describe('sum', () => {
  it('adds', () => { expect(sum(2, 3)).toBe(5) })
  it('tautology', () => { expect(true).toBe(true) })
})
