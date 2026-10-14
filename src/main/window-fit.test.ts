import { describe, expect, it } from 'vitest'
import { fitWindowHeight } from './window-fit'

describe('fitWindowHeight', () => {
  it('grows for ten rooms and clamps to the work area', () => {
    expect(fitWindowHeight(660, 900)).toBe(696)
    expect(fitWindowHeight(1000, 768)).toBe(744)
  })
  it('handles invalid and tiny heights', () => {
    expect(fitWindowHeight(Number.NaN, 900)).toBe(640)
    expect(fitWindowHeight(20, 900)).toBe(640)
  })
})
