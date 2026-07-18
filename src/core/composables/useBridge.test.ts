import {beforeEach, describe, expect, it, vi} from 'vitest'

const getNetworkInfo = vi.fn()
const getBridgeInfo = vi.fn()
const getOrchestratorInfo = vi.fn()
const getNativeTokenMetadata = vi.fn()
const getEvmTokenMetadata = vi.fn()
const getEvmTokenInfo = vi.fn()

vi.mock('../bridge-service', () => ({
  BridgeService: {
    getInstance: () => ({
      getNetworkInfo,
      getBridgeInfo,
      getOrchestratorInfo,
      getTokenMetadata: getNativeTokenMetadata,
    }),
  },
}))

vi.mock('../evm-service', () => ({
  EvmService: {
    getInstance: () => ({
      getTokenMetadata: getEvmTokenMetadata,
      getTokenInfo: getEvmTokenInfo,
    }),
  },
}))

function networkInfoFixture() {
  return {
    networkClass: 2,
    chainId: 1,
    name: 'Ethereum',
    contractAddress: '0xa98706106f7710d743186031be2245f33acea106',
    metadata: '{}',
    tokenPairs: [
      {
        tokenStandard: {toString: () => 'zts1znnxxxxxxxxxxxxx9z4ulx'},
        tokenAddress: '0xb2e96a63479c2edd2fd62b382c89d5ca79f572d3',
        bridgeable: true,
        redeemable: true,
        owned: false,
        minAmount: {toString: () => '100000000'},
        feePercentage: 25,
        redeemDelay: 6,
        metadata: '{}',
      },
      {
        tokenStandard: {toString: () => 'zts1qsrxxxxxxxxxxxxxmrhjll'},
        tokenAddress: '0x96546afe4a21515a3a30cd3fd64a70eb478dc174',
        bridgeable: false,
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

beforeEach(() => {
  vi.resetModules()
  getNetworkInfo.mockReset().mockResolvedValue(networkInfoFixture())
  getBridgeInfo.mockReset().mockResolvedValue({halted: false, allowKeyGen: false})
  getOrchestratorInfo.mockReset().mockResolvedValue({estimatedMomentumTime: 10})
  getNativeTokenMetadata.mockReset().mockImplementation(async (zts: string) => ({
    symbol: zts.includes('qsr') ? 'QSR' : 'ZNN',
    decimals: 8,
  }))
  getEvmTokenMetadata.mockReset().mockImplementation(async (address: string) => ({
    symbol: address.toLowerCase().includes('96546') ? 'wQSR' : 'wZNN',
    decimals: 8,
  }))
  getEvmTokenInfo.mockReset().mockResolvedValue({
    minAmount: 25000000n,
    redeemDelay: 90,
    bridgeable: true,
    redeemable: true,
    owned: true,
  })
})

describe('useBridge token metadata and safety mapping', () => {
  it('resolves native/EVM metadata and direction-specific limits', async () => {
    const {useBridge} = await import('./useBridge')
    const {tokenPairs, load} = useBridge()
    await load()

    expect(tokenPairs.value[0]).toEqual({
      zts: 'zts1znnxxxxxxxxxxxxx9z4ulx',
      tokenAddress: '0xb2e96a63479c2edd2fd62b382c89d5ca79f572d3',
      symbol: 'ZNN',
      evmSymbol: 'wZNN',
      decimals: 8,
      wrapMinAmount: 100000000n,
      unwrapMinAmount: 25000000n,
      feePercentage: 25,
      redeemDelay: 6,
      wrapEnabled: true,
      unwrapEnabled: true,
      owned: false,
      unwrapBonusBps: 0,
    })
    expect(tokenPairs.value[1].wrapEnabled).toBe(false)
    expect(tokenPairs.value[1].unwrapEnabled).toBe(true)
  })

  it('derives a live unwrap bonus from bridge metadata for every resolved pair', async () => {
    getBridgeInfo.mockResolvedValue({
      halted: false,
      allowKeyGen: false,
      metadata: JSON.stringify({
        affiliateProgram: {
          networks: {'1': {startingHeight: 17678862, wZNN: true, wQSR: true, ZNN: true, QSR: true}},
        },
      }),
    })
    const {useBridge} = await import('./useBridge')
    const {tokenPairs, load} = useBridge()
    await load()

    expect(tokenPairs.value.every(pair => pair.unwrapBonusBps === 300)).toBe(true)
  })

  it('yields no unwrap bonus when bridge metadata is empty', async () => {
    getBridgeInfo.mockResolvedValue({halted: false, allowKeyGen: false, metadata: ''})
    const {useBridge} = await import('./useBridge')
    const {tokenPairs, load} = useBridge()
    await load()

    expect(tokenPairs.value.every(pair => pair.unwrapBonusBps === 0)).toBe(true)
  })

  it('fails closed when native and EVM decimals differ', async () => {
    getEvmTokenMetadata.mockResolvedValue({symbol: 'wZNN', decimals: 18})
    const {useBridge} = await import('./useBridge')
    await expect(useBridge().load()).rejects.toThrow('Decimal mismatch')
  })

  it('rejects a node-supplied bridge address mismatch', async () => {
    getNetworkInfo.mockResolvedValue({...networkInfoFixture(), contractAddress: '0xattacker'})
    const {useBridge} = await import('./useBridge')
    await expect(useBridge().load()).rejects.toThrow('Bridge address mismatch')
  })

  it('rejects a node-supplied token address mismatch', async () => {
    const fixture = networkInfoFixture()
    fixture.tokenPairs[0].tokenAddress = '0xattacker'
    getNetworkInfo.mockResolvedValue(fixture)
    const {useBridge} = await import('./useBridge')
    await expect(useBridge().load()).rejects.toThrow('Token address mismatch')
  })

  it('retains halted and key-generation state', async () => {
    getBridgeInfo.mockResolvedValue({halted: true, allowKeyGen: true})
    const {useBridge} = await import('./useBridge')
    const {halted, allowKeyGen, load} = useBridge()
    await load()
    expect(halted.value).toBe(true)
    expect(allowKeyGen.value).toBe(true)
  })

  it('loads once normally and refreshes the full configuration on demand', async () => {
    const {useBridge} = await import('./useBridge')
    const {load, refresh} = useBridge()
    await load()
    await load()
    expect(getNetworkInfo).toHaveBeenCalledTimes(1)
    await refresh()
    expect(getNetworkInfo).toHaveBeenCalledTimes(2)
  })
})

describe('useBridge failure handling', () => {
  it('sets error and rethrows when the node rejects', async () => {
    getNetworkInfo.mockRejectedValue(new Error('node unreachable'))
    const {useBridge} = await import('./useBridge')
    const {error, isLoading, load} = useBridge()

    await expect(load()).rejects.toThrow('node unreachable')
    expect(error.value).toBe('node unreachable')
    expect(isLoading.value).toBe(false)
  })
})
