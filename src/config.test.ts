import {afterEach, describe, expect, it, vi} from 'vitest'

// config.ts derives its exports at module-eval time, so the MODE-dependent
// selection (mainnet vs testnet) is exercised via resetModules + dynamic import.
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
    expect(config.evmChainId).toBe(1)
    expect(ZENON_CHAIN).toBe('zenon:1')
  })

  it('selects testnet (zenonChainId 3, sepolia) when MODE is testnet', async () => {
    vi.stubEnv('MODE', 'testnet')
    vi.resetModules()
    const {config, ZENON_CHAIN} = await import('./config')
    expect(config.zenonChainId).toBe(3)
    expect(config.evmChainId).toBe(11155111)
    expect(ZENON_CHAIN).toBe('zenon:3')
  })

  it('derives ZENON_CHAIN as `zenon:${zenonChainId}`', async () => {
    const {config, ZENON_CHAIN} = await import('./config')
    expect(ZENON_CHAIN).toBe(`zenon:${config.zenonChainId}`)
  })
})
