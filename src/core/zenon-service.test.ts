import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {config} from '@/config'

// Mock the SDK so the singleton's lifecycle can be exercised without a node or
// the real PoW worker. isPowWorkerSupported() is false so the worker branch is
// skipped (the extension/web-app PoW path is not what these tests cover).
const h = vi.hoisted(() => {
  const zenon = {
    initialize: vi.fn().mockResolvedValue(undefined),
    clearConnection: vi.fn(),
  }
  return {
    zenon,
    Zenon: {
      setChainID: vi.fn(),
      setNetworkID: vi.fn(),
      getInstance: vi.fn(() => zenon),
      setPowBasePath: vi.fn(),
      setPowProvider: vi.fn(),
      usePowWorker: vi.fn(),
    },
    isPowWorkerSupported: vi.fn(() => false),
  }
})

vi.mock('znn-typescript-sdk', () => ({
  Zenon: h.Zenon,
  isPowWorkerSupported: h.isPowWorkerSupported,
}))

beforeEach(() => {
  vi.resetModules()
  h.zenon.initialize.mockClear()
  h.zenon.clearConnection.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ZenonService singleton + config', () => {
  it('getInstance returns the same instance', async () => {
    const {ZenonService} = await import('./zenon-service')
    expect(ZenonService.getInstance()).toBe(ZenonService.getInstance())
  })

  it('exposes the configured node url and the underlying Zenon instance', async () => {
    const {ZenonService} = await import('./zenon-service')
    const svc = ZenonService.getInstance()
    expect(svc.getNodeUrl()).toBe(config.nodeUrl)
    expect(svc.getZenon()).toBe(h.zenon)
  })
})

describe('ZenonService initialization', () => {
  it('initializes the node exactly once for concurrent initialize() calls', async () => {
    const {ZenonService} = await import('./zenon-service')
    const svc = ZenonService.getInstance()

    await Promise.all([svc.initialize(), svc.initialize()])

    expect(h.zenon.initialize).toHaveBeenCalledTimes(1)
    expect(h.zenon.initialize).toHaveBeenCalledWith(config.nodeUrl)
    expect(svc.isConnected()).toBe(true)
  })

  it('ensureInitialized initializes once, then is a no-op while connected', async () => {
    const {ZenonService} = await import('./zenon-service')
    const svc = ZenonService.getInstance()

    await svc.ensureInitialized()
    await svc.ensureInitialized()

    expect(h.zenon.initialize).toHaveBeenCalledTimes(1)
  })

  it('retries after a transient initialization failure', async () => {
    const {ZenonService} = await import('./zenon-service')
    const svc = ZenonService.getInstance()

    h.zenon.initialize.mockRejectedValueOnce(new Error('node unreachable'))
    await expect(svc.initialize()).rejects.toThrow('node unreachable')
    expect(svc.isConnected()).toBe(false)

    await svc.initialize()
    expect(h.zenon.initialize).toHaveBeenCalledTimes(2)
    expect(svc.isConnected()).toBe(true)
  })
})

describe('ZenonService disconnect', () => {
  it('clears the connection and allows a fresh re-initialization', async () => {
    const {ZenonService} = await import('./zenon-service')
    const svc = ZenonService.getInstance()

    await svc.ensureInitialized()
    expect(svc.isConnected()).toBe(true)

    svc.disconnect()
    expect(h.zenon.clearConnection).toHaveBeenCalledTimes(1)
    expect(svc.isConnected()).toBe(false)

    await svc.ensureInitialized()
    expect(h.zenon.initialize).toHaveBeenCalledTimes(2)
  })

  it('disconnect is a no-op when never initialized', async () => {
    const {ZenonService} = await import('./zenon-service')
    const svc = ZenonService.getInstance()

    svc.disconnect()
    expect(h.zenon.clearConnection).not.toHaveBeenCalled()
  })
})
