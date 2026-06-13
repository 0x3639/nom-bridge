import {beforeEach, describe, expect, it, vi} from 'vitest'
import {config} from '@/config'

// Mock ZenonService so BridgeService never touches a real node. The fake exposes
// the two things BridgeService uses: ensureInitialized() (the gate) and
// getZenon().embedded.bridge.getNetworkInfo (the read).
const h = vi.hoisted(() => {
  const getNetworkInfo = vi.fn()
  const getAllWrapTokenRequestsByToAddress = vi.fn()
  const getAllUnwrapTokenRequestsByToAddress = vi.fn()
  const wrapToken = vi.fn()
  const redeem = vi.fn()
  const ensureInitialized = vi.fn().mockResolvedValue(undefined)
  const zenon = {
    embedded: {
      bridge: {
        getNetworkInfo,
        getAllWrapTokenRequestsByToAddress,
        getAllUnwrapTokenRequestsByToAddress,
        wrapToken,
        redeem,
      },
    },
  }
  const zenonService = {ensureInitialized, getZenon: vi.fn(() => zenon)}
  const extractNumberDecimals = vi.fn()
  const parse = vi.fn()
  const hashParse = vi.fn()
  return {
    getNetworkInfo,
    getAllWrapTokenRequestsByToAddress,
    getAllUnwrapTokenRequestsByToAddress,
    wrapToken,
    redeem,
    ensureInitialized,
    zenonService,
    extractNumberDecimals,
    parse,
    hashParse,
  }
})

vi.mock('./zenon-service', () => ({
  ZenonService: {getInstance: vi.fn(() => h.zenonService)},
}))

vi.mock('znn-typescript-sdk', () => ({
  extractNumberDecimals: h.extractNumberDecimals,
  TokenStandard: {parse: h.parse},
  Hash: {parse: h.hashParse},
}))

beforeEach(() => {
  vi.resetModules()
  h.getNetworkInfo.mockReset()
  h.getAllWrapTokenRequestsByToAddress.mockReset()
  h.getAllUnwrapTokenRequestsByToAddress.mockReset()
  h.wrapToken.mockReset()
  h.redeem.mockReset()
  h.extractNumberDecimals.mockReset()
  h.parse.mockReset()
  h.hashParse.mockReset()
  h.ensureInitialized.mockClear()
})

describe('BridgeService singleton', () => {
  it('getInstance returns the same instance', async () => {
    const {BridgeService} = await import('./bridge-service')
    expect(BridgeService.getInstance()).toBe(BridgeService.getInstance())
  })
})

describe('BridgeService.getNetworkInfo', () => {
  it('calls the bridge read with config.networkClass and config.evmChainId (in that order)', async () => {
    h.getNetworkInfo.mockResolvedValue({contractAddress: '0xBridge', tokenPairs: []})
    const {BridgeService} = await import('./bridge-service')

    await BridgeService.getInstance().getNetworkInfo()

    expect(h.getNetworkInfo).toHaveBeenCalledWith(config.networkClass, config.evmChainId)
  })

  it('ensures the node is initialized BEFORE issuing the read', async () => {
    h.getNetworkInfo.mockResolvedValue({tokenPairs: []})
    const {BridgeService} = await import('./bridge-service')

    await BridgeService.getInstance().getNetworkInfo()

    expect(h.ensureInitialized).toHaveBeenCalledTimes(1)
    expect(h.ensureInitialized.mock.invocationCallOrder[0]).toBeLessThan(
      h.getNetworkInfo.mock.invocationCallOrder[0],
    )
  })

  it('returns the SDK result unchanged', async () => {
    const info = {contractAddress: '0xBridge', tokenPairs: [{tokenAddress: '0xT'}]}
    h.getNetworkInfo.mockResolvedValue(info)
    const {BridgeService} = await import('./bridge-service')

    await expect(BridgeService.getInstance().getNetworkInfo()).resolves.toBe(info)
  })

  it('propagates a read failure to the caller', async () => {
    h.getNetworkInfo.mockRejectedValue(new Error('node unreachable'))
    const {BridgeService} = await import('./bridge-service')

    await expect(BridgeService.getInstance().getNetworkInfo()).rejects.toThrow('node unreachable')
  })
})

describe('BridgeService.getWrapRequests', () => {
  it('calls getAllWrapTokenRequestsByToAddress(evmToAddress, 0, 50)', async () => {
    h.getAllWrapTokenRequestsByToAddress.mockResolvedValue({count: 0, list: []})
    const {BridgeService} = await import('./bridge-service')

    await BridgeService.getInstance().getWrapRequests('0xRecipient')

    expect(h.getAllWrapTokenRequestsByToAddress).toHaveBeenCalledWith('0xRecipient', 0, 50)
  })
})

describe('BridgeService.buildWrapBlock', () => {
  it('builds the SDK BigNumber via extractNumberDecimals and passes it to wrapToken', async () => {
    const bn = {__bigNumber: true}
    const parsed = {__tokenStandard: true}
    h.extractNumberDecimals.mockReturnValue(bn)
    h.parse.mockReturnValue(parsed)
    h.wrapToken.mockReturnValue({__block: true})
    const {BridgeService} = await import('./bridge-service')
    const {config} = await import('@/config')

    const block = BridgeService.getInstance().buildWrapBlock('0xRecipient', '1.5', 8, 'zts1znn')

    expect(h.extractNumberDecimals).toHaveBeenCalledWith('1.5', 8)
    expect(h.parse).toHaveBeenCalledWith('zts1znn')
    expect(h.wrapToken).toHaveBeenCalledWith(
      config.networkClass,
      config.evmChainId,
      '0xRecipient',
      bn, // the extractNumberDecimals return — NOT a raw string / `as never`
      parsed,
    )
    // the amount arg is the BigNumber object, never the human string
    expect(h.wrapToken.mock.calls[0][3]).toBe(bn)
    expect(h.wrapToken.mock.calls[0][3]).not.toBe('1.5')
    expect(block).toEqual({__block: true})
  })
})

describe('BridgeService.getUnwrapRequests', () => {
  it('calls getAllUnwrapTokenRequestsByToAddress(zenonAddr, 0, 50)', async () => {
    h.getAllUnwrapTokenRequestsByToAddress.mockResolvedValue({count: 0, list: []})
    const {BridgeService} = await import('./bridge-service')

    await BridgeService.getInstance().getUnwrapRequests('z1qrecipient')

    expect(h.getAllUnwrapTokenRequestsByToAddress).toHaveBeenCalledWith('z1qrecipient', 0, 50)
  })
})

describe('BridgeService.buildRedeemBlock', () => {
  it('calls redeem(Hash.parse(txHash), nodeLogIndex)', async () => {
    const parsedHash = {__hash: true}
    h.hashParse.mockReturnValue(parsedHash)
    h.redeem.mockReturnValue({__block: true})
    const {BridgeService} = await import('./bridge-service')

    const block = BridgeService.getInstance().buildRedeemBlock('0xevmtxhash', 4)

    expect(h.hashParse).toHaveBeenCalledWith('0xevmtxhash')
    expect(h.redeem).toHaveBeenCalledWith(parsedHash, 4)
    expect(block).toEqual({__block: true})
  })
})
