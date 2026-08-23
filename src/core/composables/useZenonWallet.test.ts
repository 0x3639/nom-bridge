import {beforeEach, describe, expect, it, vi} from 'vitest'

const mocks = vi.hoisted(() => ({
  wallet: {
    restore: vi.fn(),
    connect: vi.fn(),
    send: vi.fn(),
    disconnect: vi.fn(),
    onDisconnect: undefined as undefined | (() => void),
    onInfoChange: undefined as undefined | ((info: {address: string}) => void),
    onPairingUri: undefined as undefined | ((uri: string) => void),
    onPairingClosed: undefined as undefined | (() => void),
    cancelPairing: vi.fn(),
  },
  getTokenBalance: vi.fn(),
}))

vi.mock('../zenon-wallet-service', async importOriginal => ({
  ...(await importOriginal<typeof import('../zenon-wallet-service')>()),
  ZenonWalletService: {getInstance: () => mocks.wallet},
}))

vi.mock('../bridge-service', () => ({
  BridgeService: {getInstance: () => ({getTokenBalance: mocks.getTokenBalance})},
}))

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  mocks.wallet.onDisconnect = undefined
  mocks.wallet.onInfoChange = undefined
  mocks.wallet.onPairingUri = undefined
  mocks.wallet.onPairingClosed = undefined
  mocks.wallet.restore.mockResolvedValue(null)
  mocks.wallet.disconnect.mockResolvedValue(undefined)
})

async function loadWallet() {
  const module = await import('./useZenonWallet')
  await Promise.resolve()
  return module.useZenonWallet()
}

describe('useZenonWallet', () => {
  it('adopts a restored session and reacts to service info changes', async () => {
    mocks.wallet.restore.mockResolvedValue({address: 'z1-restored'})
    const wallet = await loadWallet()

    expect(wallet.address.value).toBe('z1-restored')
    mocks.wallet.onInfoChange?.({address: 'z1-updated'})
    expect(wallet.address.value).toBe('z1-updated')
    mocks.wallet.onDisconnect?.()
    expect(wallet.address.value).toBeNull()
  })

  it('does not overwrite an address established while restore is pending', async () => {
    let finishRestore!: (info: {address: string}) => void
    mocks.wallet.restore.mockReturnValue(new Promise(resolve => {
      finishRestore = resolve
    }))
    mocks.wallet.connect.mockResolvedValue({address: 'z1-connected'})
    const wallet = await loadWallet()

    await wallet.connect()
    finishRestore({address: 'z1-stale'})
    await Promise.resolve()
    expect(wallet.address.value).toBe('z1-connected')
  })

  it('connects and surfaces Error failures', async () => {
    mocks.wallet.connect.mockResolvedValueOnce({address: 'z1-user'})
    const wallet = await loadWallet()

    await wallet.connect()
    expect(wallet.address.value).toBe('z1-user')
    expect(wallet.isConnecting.value).toBe(false)

    mocks.wallet.connect.mockRejectedValueOnce(new Error('pairing rejected'))
    await expect(wallet.connect()).rejects.toThrow('pairing rejected')
    expect(wallet.error.value).toBe('pairing rejected')
    expect(wallet.isConnecting.value).toBe(false)
  })

  it('uses a safe fallback for non-Error failures and ignored restore failures', async () => {
    mocks.wallet.restore.mockRejectedValue(new Error('relay unavailable'))
    mocks.wallet.connect.mockRejectedValue('rejected')
    const wallet = await loadWallet()

    await expect(wallet.connect()).rejects.toBe('rejected')
    expect(wallet.error.value).toBe('Failed to connect Zenon wallet')
  })

  it('requires a connection before sending and delegates connected sends', async () => {
    mocks.wallet.connect.mockResolvedValue({address: 'z1-user'})
    const block = {hash: 'block'}
    mocks.wallet.send.mockResolvedValue(block)
    const wallet = await loadWallet()

    await expect(wallet.send(block as never)).rejects.toThrow('Zenon wallet not connected')
    await wallet.connect()
    await expect(wallet.send(block as never)).resolves.toBe(block)
    expect(mocks.wallet.send).toHaveBeenCalledWith('z1-user', block)
  })

  it('disconnects and guards balance reads while disconnected', async () => {
    mocks.wallet.connect.mockResolvedValue({address: 'z1-user'})
    mocks.getTokenBalance.mockResolvedValue(88n)
    const wallet = await loadWallet()

    await expect(wallet.getTokenBalance('zts1')).resolves.toBe(0n)
    await wallet.connect()
    await expect(wallet.getTokenBalance('zts1')).resolves.toBe(88n)
    expect(mocks.getTokenBalance).toHaveBeenCalledWith('z1-user', 'zts1')

    await wallet.disconnect()
    expect(mocks.wallet.disconnect).toHaveBeenCalledOnce()
    expect(wallet.address.value).toBeNull()
  })
})

describe('useZenonWallet pairing UI state', () => {
  it('exposes the pairing uri while the service waits for approval and clears it on close', async () => {
    const {useZenonWallet} = await import('./useZenonWallet')
    const {pairingUri} = useZenonWallet()

    expect(pairingUri.value).toBeNull()
    mocks.wallet.onPairingUri?.('wc:abc@2?relay-protocol=irn&symKey=ff')
    expect(pairingUri.value).toBe('wc:abc@2?relay-protocol=irn&symKey=ff')
    mocks.wallet.onPairingClosed?.()
    expect(pairingUri.value).toBeNull()
  })

  it('treats a user-cancelled pairing as a quiet no-op, not an error', async () => {
    const {PairingCancelledError} = await import('../zenon-wallet-service')
    mocks.wallet.connect.mockRejectedValue(new PairingCancelledError())
    const {useZenonWallet} = await import('./useZenonWallet')
    const {connect, error, address, isConnecting} = useZenonWallet()

    await expect(connect()).resolves.toBeUndefined()

    expect(error.value).toBeNull()
    expect(address.value).toBeNull()
    expect(isConnecting.value).toBe(false)
  })

  it('cancelPairing forwards to the service', async () => {
    const {useZenonWallet} = await import('./useZenonWallet')
    useZenonWallet().cancelPairing()
    expect(mocks.wallet.cancelPairing).toHaveBeenCalledTimes(1)
  })
})
