import {beforeEach, describe, expect, it, vi} from 'vitest'

// Mock external boundaries: the services, the Zenon wallet send, the request
// store, and the SDK helpers. tssSignatureToHex is exercised for real via the
// real evm-service export — but here we mock evm-service to drive redeem.
const h = vi.hoisted(() => ({
  buildWrapBlock: vi.fn(),
  getWrapRedeemProgress: vi.fn(),
  redeem: vi.fn(),
  tssSignatureToHex: vi.fn(),
  send: vi.fn(),
  trackWrap: vi.fn(),
  extractNumberDecimals: vi.fn(),
}))

vi.mock('../bridge-service', () => ({
  BridgeService: {getInstance: () => ({buildWrapBlock: h.buildWrapBlock})},
}))

vi.mock('../evm-service', () => ({
  EvmService: {getInstance: () => ({getWrapRedeemProgress: h.getWrapRedeemProgress, redeem: h.redeem})},
  tssSignatureToHex: h.tssSignatureToHex,
}))

vi.mock('./useZenonWallet', () => ({
  useZenonWallet: () => ({send: h.send}),
}))

vi.mock('../request-store', () => ({
  requestStore: {trackWrap: h.trackWrap},
}))

vi.mock('znn-typescript-sdk', () => ({
  extractNumberDecimals: h.extractNumberDecimals,
}))

beforeEach(() => {
  vi.resetModules()
  Object.values(h).forEach(fn => fn.mockReset())
})

describe('useWrap.wrap', () => {
  it('builds the block, sends it, tracks the published hash, returns it', async () => {
    h.buildWrapBlock.mockReturnValue({__block: true})
    h.send.mockResolvedValue({hash: {toString: () => 'wraphash'}})
    h.extractNumberDecimals.mockReturnValue({toString: () => '150000000'})
    h.trackWrap.mockResolvedValue(undefined)
    const {useWrap} = await import('./useWrap')

    const id = await useWrap().wrap('0xRecipient', '1.5', 8, 'zts1znn', 'ZNN')

    expect(h.buildWrapBlock).toHaveBeenCalledWith('0xRecipient', '1.5', 8, 'zts1znn')
    expect(h.send).toHaveBeenCalledWith({__block: true})
    expect(h.trackWrap).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'wraphash',
        evmToAddress: '0xRecipient',
        amount: '150000000',
        decimals: 8,
        symbol: 'ZNN',
      }),
    )
    expect(id).toBe('wraphash')
  })
})

describe('useWrap.redeemEvm', () => {
  function requestFixture() {
    return {
      id: {toString: () => '1a2b'},
      toAddress: '0xTo00000000000000000000000000000000000001',
      tokenAddress: '0xToken00000000000000000000000000000000002',
      amount: {toString: () => '100000000'},
      fee: {toString: () => '250000'},
      signature: 'c2lnbmF0dXJl',
    }
  }

  it('sources the five redeem args from the WrapTokenRequest', async () => {
    h.getWrapRedeemProgress.mockResolvedValue({kind: 'unredeemed'})
    h.tssSignatureToHex.mockReturnValue('0xsig')
    h.redeem.mockResolvedValue('0xtxhash')
    const {useWrap} = await import('./useWrap')
    const bridge = '0xBridge00000000000000000000000000000000' as `0x${string}`

    const tx = await useWrap().redeemEvm(requestFixture() as never, bridge)

    expect(h.tssSignatureToHex).toHaveBeenCalledWith('c2lnbmF0dXJl')
    expect(h.redeem).toHaveBeenCalledWith(
      bridge,
      '0xTo00000000000000000000000000000000000001', // to
      '0xToken00000000000000000000000000000000002', // token
      100000000n - 250000n, // netAmount = amount - fee
      BigInt('0x1a2b'), // nonce
      '0xsig', // signature
    )
    expect(tx).toBe('0xtxhash')
  })

  it('no-ops when already fully-redeemed', async () => {
    h.getWrapRedeemProgress.mockResolvedValue({kind: 'fully-redeemed'})
    const {useWrap} = await import('./useWrap')
    const bridge = '0xBridge00000000000000000000000000000000' as `0x${string}`

    await useWrap().redeemEvm(requestFixture() as never, bridge)

    expect(h.redeem).not.toHaveBeenCalled()
  })
})
