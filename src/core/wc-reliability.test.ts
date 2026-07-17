import {describe, expect, it} from 'vitest'
import {classifyWalletError, delay, WC_TIMING, withTimeout} from './wc-reliability'

describe('withTimeout', () => {
  it('resolves with the value when the promise wins', async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, 'x')).resolves.toBe(42)
  })

  it('rejects with a labeled error when the timeout wins', async () => {
    const never = new Promise(() => {})
    await expect(withTimeout(never, 10, 'Syrius request (znn_info)')).rejects.toThrow(
      'Syrius request (znn_info) timed out — check that Syrius is open and responsive',
    )
  })

  it('propagates the original rejection', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000, 'x')).rejects.toThrow('boom')
  })
})

describe('delay', () => {
  it('resolves after the given time', async () => {
    const start = Date.now()
    await delay(20)
    expect(Date.now() - start).toBeGreaterThanOrEqual(15)
  })
})

describe('classifyWalletError', () => {
  const err = (code: number, message: string) => Object.assign(new Error(message), {code})

  it('classifies 5xxx as rejected', () => {
    expect(classifyWalletError(err(5000, 'User rejected'))).toBe('rejected')
    expect(classifyWalletError(err(5999, 'nope'))).toBe('rejected')
  })

  it('classifies EIP-1193-style 4001 as rejected', () => {
    expect(classifyWalletError(err(4001, 'User rejected the request'))).toBe('rejected')
  })

  it('classifies 9000 wallet-locked as locked', () => {
    expect(classifyWalletError(err(9000, 'Wallet is locked'))).toBe('locked')
  })

  it('classifies -32602 "Bad state: No element" as reconnect', () => {
    expect(classifyWalletError(err(-32602, 'Bad state: No element'))).toBe('reconnect')
  })

  it('classifies -32602 "No matching key" as retry', () => {
    expect(classifyWalletError(err(-32602, 'No matching key. session topic doesn\'t exist'))).toBe('retry')
  })

  it('classifies everything else as fatal', () => {
    expect(classifyWalletError(err(-32602, 'something else'))).toBe('fatal')
    expect(classifyWalletError(new Error('plain'))).toBe('fatal')
    expect(classifyWalletError('string error')).toBe('fatal')
    expect(classifyWalletError(err(9000, 'other 9000'))).toBe('fatal')
  })
})

describe('WC_TIMING', () => {
  it('ships the spec values', () => {
    expect(WC_TIMING).toEqual({
      requestTimeoutMs: 30_000,
      sendTimeoutMs: 120_000,
      approvalTimeoutMs: 300_000,
      settleMs: 5_000,
      relaySettleMs: 2_000,
      maxAttempts: 3,
    })
  })
})
