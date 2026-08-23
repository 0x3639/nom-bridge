import {afterEach, describe, expect, it, vi} from 'vitest'

// config.ts derives its exports at module-eval time, so unsupported modes are
// exercised via resetModules + dynamic import.
afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('config constants', () => {
  it('FEE_DENOMINATOR is 10_000n', async () => {
    const {FEE_DENOMINATOR} = await import('./config')
    expect(FEE_DENOMINATOR).toBe(10_000n)
  })

  it('DEFAULT_MOMENTUM_TIME is 10', async () => {
    const {DEFAULT_MOMENTUM_TIME} = await import('./config')
    expect(DEFAULT_MOMENTUM_TIME).toBe(10)
  })

  it('WC_PROJECT_ID falls back to the placeholder when the env var is unset', async () => {
    // `??` only catches null/undefined; an unset Vite var resolves to undefined.
    vi.stubEnv('VITE_WC_PROJECT_ID', undefined as unknown as string)
    vi.resetModules()
    const {WC_PROJECT_ID} = await import('./config')
    expect(WC_PROJECT_ID).toBe('REPLACE_ME_WC_PROJECT_ID')
  })

  it('WC_PROJECT_ID uses the env var when it is set', async () => {
    vi.stubEnv('VITE_WC_PROJECT_ID', 'my-project-id')
    vi.resetModules()
    const {WC_PROJECT_ID} = await import('./config')
    expect(WC_PROJECT_ID).toBe('my-project-id')
  })
})

describe('network selection by MODE', () => {
  it('defaults to mainnet (zenonChainId 1) outside testnet mode', async () => {
    vi.stubEnv('MODE', 'production')
    vi.resetModules()
    const {config, ZENON_CHAIN} = await import('./config')
    expect(config.zenonChainId).toBe(1)
    expect(config.zenonNetworkId).toBe(1)
    expect(config.evmChainId).toBe(1)
    expect(new Set(config.zenonRpcUrls).size).toBeGreaterThanOrEqual(2)
    expect(config.zenonRpcUrls).toContain(config.nodeUrl)
    expect(config.evmRpcUrls.length).toBeGreaterThan(1)
    expect(ZENON_CHAIN).toBe('zenon:1')
  })

  it('fails closed in testnet mode until verified endpoints are configured', async () => {
    vi.stubEnv('MODE', 'testnet')
    vi.resetModules()
    await expect(import('./config')).rejects.toThrow('Testnet mode is disabled')
  })

  it('derives ZENON_CHAIN as `zenon:${zenonChainId}`', async () => {
    const {config, ZENON_CHAIN} = await import('./config')
    expect(ZENON_CHAIN).toBe(`zenon:${config.zenonChainId}`)
  })

  it('pins the deployed bridge and supported token contracts', async () => {
    const {config} = await import('./config')
    expect(config.expectedBridgeAddress).toBe('0xa98706106f7710d743186031be2245f33acea106')
    expect(config.expectedTokenPairs.zts1znnxxxxxxxxxxxxx9z4ulx).toEqual({
      tokenAddress: '0xb2e96a63479c2edd2fd62b382c89d5ca79f572d3',
      decimals: 8,
    })
    expect(config.expectedTokenPairs.zts17d6yr02kh0r9qr566p7tg6.decimals).toBe(18)
  })
})
