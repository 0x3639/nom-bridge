import {beforeEach, describe, expect, it, vi} from 'vitest'
import {config} from '@/config'

const service = vi.hoisted(() => ({
  connect: vi.fn(),
  getBalance: vi.fn(),
}))

vi.mock('../evm-service', () => ({
  EvmService: {getInstance: () => service},
}))

const ADDRESS = '0x0000000000000000000000000000000000000001' as const
const TOKEN = '0x0000000000000000000000000000000000000002' as const

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
})

function ethereumWindow() {
  const handlers = new Map<string, (...args: never[]) => void>()
  vi.stubGlobal('window', {
    ethereum: {
      on: vi.fn((event: string, handler: (...args: never[]) => void) => handlers.set(event, handler)),
    },
  })
  return handlers
}

describe('useEvmWallet', () => {
  it('connects, tracks provider events, and disconnects local state', async () => {
    const handlers = ethereumWindow()
    service.connect.mockResolvedValue(ADDRESS)
    const {useEvmWallet} = await import('./useEvmWallet')
    const wallet = useEvmWallet()

    await wallet.connect()
    expect(wallet.account.value).toBe(ADDRESS)
    expect(wallet.chainId.value).toBe(config.evmChainId)
    expect(wallet.isConnecting.value).toBe(false)

    handlers.get('accountsChanged')?.([TOKEN] as never)
    expect(wallet.account.value).toBe(TOKEN)
    handlers.get('accountsChanged')?.(['invalid'] as never)
    expect(wallet.account.value).toBeNull()
    handlers.get('accountsChanged')?.([] as never)
    expect(wallet.account.value).toBeNull()

    handlers.get('chainChanged')?.('0x2a' as never)
    expect(wallet.chainId.value).toBe(42)
    handlers.get('chainChanged')?.('invalid' as never)
    expect(wallet.chainId.value).toBeNull()

    wallet.disconnect()
    expect(wallet.account.value).toBeNull()
    expect(wallet.chainId.value).toBeNull()
  })

  it('does not attach listeners when no injected provider exists', async () => {
    vi.stubGlobal('window', {})
    service.connect.mockResolvedValue(ADDRESS)
    const {useEvmWallet} = await import('./useEvmWallet')

    await expect(useEvmWallet().connect()).resolves.toBeUndefined()
  })

  it('surfaces wallet errors and always clears the connecting flag', async () => {
    ethereumWindow()
    service.connect.mockRejectedValue(new Error('user rejected'))
    const {useEvmWallet} = await import('./useEvmWallet')
    const wallet = useEvmWallet()

    await expect(wallet.connect()).rejects.toThrow('user rejected')
    expect(wallet.error.value).toBe('user rejected')
    expect(wallet.isConnecting.value).toBe(false)
  })

  it('uses a safe fallback for non-Error failures', async () => {
    ethereumWindow()
    service.connect.mockRejectedValue('rejected')
    const {useEvmWallet} = await import('./useEvmWallet')
    const wallet = useEvmWallet()

    await expect(wallet.connect()).rejects.toBe('rejected')
    expect(wallet.error.value).toBe('Failed to connect EVM wallet')
  })

  it('returns zero while disconnected and delegates balance reads when connected', async () => {
    ethereumWindow()
    service.connect.mockResolvedValue(ADDRESS)
    service.getBalance.mockResolvedValue(99n)
    const {useEvmWallet} = await import('./useEvmWallet')
    const wallet = useEvmWallet()

    await expect(wallet.getTokenBalance(TOKEN)).resolves.toBe(0n)
    await wallet.connect()
    await expect(wallet.getTokenBalance(TOKEN)).resolves.toBe(99n)
    expect(service.getBalance).toHaveBeenCalledWith(TOKEN, ADDRESS)
  })
})
