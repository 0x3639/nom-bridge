import {beforeEach, describe, expect, it, vi} from 'vitest'
import {config} from '@/config'

const h = vi.hoisted(() => ({addNumberDecimals: vi.fn()}))

vi.mock('znn-typescript-sdk', () => ({
  addNumberDecimals: h.addNumberDecimals,
}))

beforeEach(() => {
  h.addNumberDecimals.mockReset()
})

describe('formatCountdown', () => {
  it('0 → Ready', async () => {
    const {formatCountdown} = await import('./formatters')
    expect(formatCountdown(0)).toBe('Ready')
    expect(formatCountdown(-5)).toBe('Ready')
  })

  it('sub-minute', async () => {
    const {formatCountdown} = await import('./formatters')
    expect(formatCountdown(45)).toBe('45s')
  })

  it('minutes + seconds', async () => {
    const {formatCountdown} = await import('./formatters')
    expect(formatCountdown(75)).toBe('1m 15s')
  })

  it('hours + minutes + seconds', async () => {
    const {formatCountdown} = await import('./formatters')
    expect(formatCountdown(3725)).toBe('1h 2m 5s')
  })
})

describe('truncateAddress', () => {
  it('truncates long addresses', async () => {
    const {truncateAddress} = await import('./formatters')
    expect(truncateAddress('0x1234567890abcdef')).toBe('0x1234…cdef')
  })

  it('passes through short strings', async () => {
    const {truncateAddress} = await import('./formatters')
    expect(truncateAddress('0x1234')).toBe('0x1234')
  })
})

describe('tx url helpers', () => {
  it('evmTxUrl prepends config.evmExplorerTxUrl', async () => {
    const {evmTxUrl} = await import('./formatters')
    expect(evmTxUrl('0xabc')).toBe(config.evmExplorerTxUrl + '0xabc')
  })

  it('zenonTxUrl prepends config.zenonExplorerTxUrl', async () => {
    const {zenonTxUrl} = await import('./formatters')
    expect(zenonTxUrl('hash')).toBe(config.zenonExplorerTxUrl + 'hash')
  })
})

describe('formatAmount', () => {
  it('delegates to addNumberDecimals(base.toString(), decimals)', async () => {
    h.addNumberDecimals.mockReturnValue('1.5')
    const {formatAmount} = await import('./formatters')
    expect(formatAmount(150000000n, 8)).toBe('1.5')
    expect(h.addNumberDecimals).toHaveBeenCalledWith('150000000', 8)
  })
})
