import {describe, expect, it, vi} from 'vitest'
import {
  createSubmitInterlock,
  sameBridgeSubmitIntent,
  type BridgeSubmitIntent,
} from './submit-interlock'

const intent = (overrides: Partial<BridgeSubmitIntent> = {}): BridgeSubmitIntent => ({
  direction: 'wrap',
  zts: 'zts1znn',
  amount: 125000000n,
  decimals: 8,
  evmAccount: '0xA98706106f7710d743186031be2245F33acEA106',
  zenonAddress: 'z1qsender',
  evmChainId: 1,
  bridgeAddress: '0xb2E96A63479C2eDD2fd62b382c89D5Ca79F572d3',
  ...overrides,
})

describe('createSubmitInterlock', () => {
  it('locks synchronously, refuses a second action, and releases after completion', async () => {
    let release: () => void = () => undefined
    const pending = new Promise<void>(resolve => {
      release = () => resolve()
    })
    const firstAction = vi.fn(() => pending)
    const secondAction = vi.fn(async () => undefined)
    const interlock = createSubmitInterlock()

    const first = interlock.run(firstAction)
    const second = interlock.run(secondAction)

    expect(interlock.inFlight.value).toBe(true)
    expect(firstAction).toHaveBeenCalledTimes(1)
    expect(secondAction).not.toHaveBeenCalled()
    await expect(second).resolves.toBeUndefined()

    release()
    await first
    expect(interlock.inFlight.value).toBe(false)
  })

  it('releases the form after an action fails', async () => {
    const interlock = createSubmitInterlock()

    await expect(interlock.run(async () => {
      throw new Error('refresh failed')
    })).rejects.toThrow('refresh failed')

    expect(interlock.inFlight.value).toBe(false)
  })
})

describe('sameBridgeSubmitIntent', () => {
  it('accepts address casing differences only', () => {
    expect(sameBridgeSubmitIntent(intent(), intent({
      evmAccount: intent().evmAccount.toLowerCase(),
      bridgeAddress: intent().bridgeAddress?.toLowerCase() ?? null,
    }))).toBe(true)
  })

  it.each([
    {field: 'direction', change: {direction: 'unwrap' as const}},
    {field: 'token', change: {zts: 'zts1qsr'}},
    {field: 'amount', change: {amount: 200000000n}},
    {field: 'decimals', change: {decimals: 18}},
    {field: 'EVM account', change: {evmAccount: '0x0000000000000000000000000000000000000001'}},
    {field: 'Zenon account', change: {zenonAddress: 'z1qother'}},
    {field: 'EVM chain', change: {evmChainId: 5}},
    {field: 'bridge', change: {bridgeAddress: '0x0000000000000000000000000000000000000002'}},
  ])('rejects a changed $field', ({change}) => {
    expect(sameBridgeSubmitIntent(intent(), intent(change))).toBe(false)
  })
})
