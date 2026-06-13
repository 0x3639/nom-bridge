import {beforeEach, describe, expect, it, vi} from 'vitest'

// Mock the service so the composable never touches a real Zenon node.
// getNetworkInfo's return value is set per-test via the mock below.
const getNetworkInfo = vi.fn()
const getBridgeInfo = vi.fn()
const getOrchestratorInfo = vi.fn()
vi.mock('../bridge-service', () => ({
  BridgeService: {
    getInstance: () => ({getNetworkInfo, getBridgeInfo, getOrchestratorInfo}),
  },
}))

// A minimal BridgeNetworkInfo-shaped fixture. TokenPair.tokenStandard and
// minAmount are objects exposing toString() (as the SDK's TokenStandard /
// BigNumber do).
function networkInfoFixture() {
  return {
    networkClass: 2,
    chainId: 1,
    name: 'Ethereum',
    contractAddress: '0xBridgeContract',
    metadata: '{}',
    tokenPairs: [
      {
        tokenStandard: {toString: () => 'zts1znnxxxxxxxxxxxxx9z4ulx'},
        tokenAddress: '0xToken0',
        bridgeable: true,
        redeemable: true,
        owned: false,
        minAmount: {toString: () => '100000000'},
        feePercentage: 25,
        redeemDelay: 6,
        metadata: '{}',
      },
      {
        tokenStandard: {toString: () => 'zts1qsrxxxxxxxxxxxxxxmrhjll'},
        tokenAddress: '0xToken1',
        bridgeable: true,
        redeemable: true,
        owned: false,
        minAmount: {toString: () => '5000000000'},
        feePercentage: 30,
        redeemDelay: 10,
        metadata: '{}',
      },
    ],
  }
}

// useBridge holds module-level state (loads once). Reset modules between tests
// so each test starts from a clean, unloaded composable.
beforeEach(() => {
  vi.resetModules()
  getNetworkInfo.mockReset()
  getBridgeInfo.mockReset().mockResolvedValue({halted: false})
  getOrchestratorInfo.mockReset().mockResolvedValue({estimatedMomentumTime: 10})
})

describe('useBridge tokenPairs mapping', () => {
  it('maps TokenPair[] to TokenPairView[] with the expected fields', async () => {
    getNetworkInfo.mockResolvedValue(networkInfoFixture())
    const {useBridge} = await import('./useBridge')
    const {tokenPairs, load} = useBridge()
    await load()

    expect(tokenPairs.value).toHaveLength(2)
    expect(tokenPairs.value[0]).toEqual({
      zts: 'zts1znnxxxxxxxxxxxxx9z4ulx',
      tokenAddress: '0xToken0',
      decimals: 8,
      minAmount: 100000000n,
      feePercentage: 25,
      redeemDelay: 6,
    })
    expect(tokenPairs.value[1].zts).toBe('zts1qsrxxxxxxxxxxxxxxmrhjll')
    expect(tokenPairs.value[1].minAmount).toBe(5000000000n)
    expect(tokenPairs.value[1].redeemDelay).toBe(10)
  })

  it('stubs decimals to 8 for every pair (Phase 1 deferral)', async () => {
    getNetworkInfo.mockResolvedValue(networkInfoFixture())
    const {useBridge} = await import('./useBridge')
    const {tokenPairs, load} = useBridge()
    await load()
    expect(tokenPairs.value.every(p => p.decimals === 8)).toBe(true)
  })

  it('converts minAmount via BigInt and exposes bridgeAddress', async () => {
    getNetworkInfo.mockResolvedValue(networkInfoFixture())
    const {useBridge} = await import('./useBridge')
    const {tokenPairs, bridgeAddress, load} = useBridge()
    await load()
    expect(typeof tokenPairs.value[0].minAmount).toBe('bigint')
    expect(bridgeAddress.value).toBe('0xBridgeContract')
  })

  it('starts empty before load and exposes a null bridgeAddress', async () => {
    const {useBridge} = await import('./useBridge')
    const {tokenPairs, bridgeAddress} = useBridge()
    expect(tokenPairs.value).toEqual([])
    expect(bridgeAddress.value).toBeNull()
  })

  it('loads getNetworkInfo only once across repeated load() calls', async () => {
    getNetworkInfo.mockResolvedValue(networkInfoFixture())
    const {useBridge} = await import('./useBridge')
    const {load} = useBridge()
    await load()
    await load()
    expect(getNetworkInfo).toHaveBeenCalledTimes(1)
  })
})

describe('useBridge failure handling', () => {
  it('sets error and rethrows when getNetworkInfo rejects', async () => {
    getNetworkInfo.mockRejectedValue(new Error('node unreachable'))
    const {useBridge} = await import('./useBridge')
    const {error, isLoading, load} = useBridge()

    await expect(load()).rejects.toThrow('node unreachable')
    expect(error.value).toBe('node unreachable')
    expect(isLoading.value).toBe(false)
  })
})
