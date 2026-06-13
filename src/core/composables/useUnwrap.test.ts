import {beforeEach, describe, expect, it, vi} from 'vitest'

// Mock external boundaries: the services, the Zenon wallet send, the request
// store.
const h = vi.hoisted(() => ({
  ensureAllowance: vi.fn(),
  unwrap: vi.fn(),
  buildRedeemBlock: vi.fn(),
  send: vi.fn(),
  trackUnwrap: vi.fn(),
}))

vi.mock('../bridge-service', () => ({
  BridgeService: {getInstance: () => ({buildRedeemBlock: h.buildRedeemBlock})},
}))

vi.mock('../evm-service', () => ({
  EvmService: {getInstance: () => ({ensureAllowance: h.ensureAllowance, unwrap: h.unwrap})},
}))

vi.mock('./useZenonWallet', () => ({
  useZenonWallet: () => ({send: h.send}),
}))

vi.mock('../request-store', () => ({
  requestStore: {trackUnwrap: h.trackUnwrap},
}))

beforeEach(() => {
  vi.resetModules()
  Object.values(h).forEach(fn => fn.mockReset())
})

describe('useUnwrap.unwrap', () => {
  it('ensures allowance, unwraps, then tracks with id `${hash}:${provisionalLogIndex}`', async () => {
    h.ensureAllowance.mockResolvedValue(undefined)
    h.unwrap.mockResolvedValue({hash: '0xunwraptx', provisionalLogIndex: 3})
    h.trackUnwrap.mockResolvedValue(undefined)
    const {useUnwrap} = await import('./useUnwrap')

    const token = '0xToken0000000000000000000000000000000001' as `0x${string}`
    const bridge = '0xBridge00000000000000000000000000000000' as `0x${string}`
    const result = await useUnwrap().unwrap(token, 500n, 'z1qrecipient', bridge, 'zts1znn')

    expect(h.ensureAllowance).toHaveBeenCalledWith(token, bridge, 500n)
    expect(h.unwrap).toHaveBeenCalledWith(bridge, token, 500n, 'z1qrecipient')
    expect(h.trackUnwrap).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '0xunwraptx:3',
        zts: 'zts1znn',
        amount: '500',
        zenonToAddress: 'z1qrecipient',
      }),
    )
    expect(result).toEqual({hash: '0xunwraptx', provisionalLogIndex: 3})
  })

  it('ensures allowance BEFORE the unwrap call', async () => {
    const order: string[] = []
    h.ensureAllowance.mockImplementation(async () => {
      order.push('allowance')
    })
    h.unwrap.mockImplementation(async () => {
      order.push('unwrap')
      return {hash: '0xtx', provisionalLogIndex: 0}
    })
    h.trackUnwrap.mockResolvedValue(undefined)
    const {useUnwrap} = await import('./useUnwrap')

    await useUnwrap().unwrap(
      '0xToken0000000000000000000000000000000001' as `0x${string}`,
      1n,
      'z1q',
      '0xBridge00000000000000000000000000000000' as `0x${string}`,
      'zts1znn',
    )

    expect(order).toEqual(['allowance', 'unwrap'])
  })
})

describe('useUnwrap.redeemZenon', () => {
  it('builds the redeem block with the NODE logIndex then sends it', async () => {
    h.buildRedeemBlock.mockReturnValue({__block: true})
    h.send.mockResolvedValue(undefined)
    const {useUnwrap} = await import('./useUnwrap')

    const view = {
      id: '0xtx:9',
      transactionHash: '0xtx',
      logIndex: 9,
      zts: 'zts1znn',
      amount: 100n,
      toAddress: 'z1qrecipient',
      status: 'redeemable' as const,
    }

    await useUnwrap().redeemZenon(view)

    expect(h.buildRedeemBlock).toHaveBeenCalledWith('0xtx', 9)
    expect(h.send).toHaveBeenCalledWith({__block: true})
  })
})
