import {describe, expect, it} from 'vitest'
import {parseAmount} from './amount'

describe('parseAmount', () => {
  it('rejects numeric amounts that exceed JavaScript safe-integer precision', () => {
    const unsafe = Number.MAX_SAFE_INTEGER + 2
    expect(() => parseAmount(unsafe, 8)).toThrow('decimal string')
  })

  it('converts an exact human amount to base units', () => {
    expect(parseAmount('1.25', 8)).toBe(125000000n)
    expect(parseAmount(1.25, 8)).toBe(125000000n)
    expect(parseAmount('0.00000001', 8)).toBe(1n)
  })

  it('rejects precision that the SDK would otherwise truncate', () => {
    expect(() => parseAmount('1.000000001', 8)).toThrow('at most 8 decimal places')
  })

  it('rejects signs, exponent notation, and incomplete decimals', () => {
    for (const value of ['0', '-1', '+1', '1e3', '.5', '1.']) {
      expect(() => parseAmount(value, 8)).toThrow('positive decimal amount')
    }
  })
})
