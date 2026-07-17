import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest'
import {createFakeSyrius, FAKE_SYRIUS_ADDRESS, type FakeSyrius} from '../testing/fake-syrius-core'

// End-to-end over the REAL WalletConnect relay: the actual ZenonWalletService
// (dApp role) against the fake-Syrius harness (wallet role) in one process.
// Regression guard for the namespace shape and the znn_send envelope — if
// either drifts from what Syrius accepts, approval or the round-trips break.
const projectId = process.env.VITE_WC_PROJECT_ID
const configured = Boolean(projectId) && projectId !== 'REPLACE_ME_WC_PROJECT_ID'

// A syntactically complete AccountBlockTemplate JSON (the wallet fills the
// chain-state fields in real life; the fake echoes them back untouched).
const WRAP_BLOCK_JSON = {
  version: 1,
  chainIdentifier: 1,
  blockType: 2,
  hash: '0000000000000000000000000000000000000000000000000000000000000000',
  previousHash: '0000000000000000000000000000000000000000000000000000000000000000',
  height: 0,
  momentumAcknowledged: {
    hash: '0000000000000000000000000000000000000000000000000000000000000000',
    height: 0,
  },
  address: FAKE_SYRIUS_ADDRESS,
  toAddress: 'z1qxemdeddedxdrydgexxxxxxxxxxxxxxxmqgr0d',
  amount: '100000000',
  tokenStandard: 'zts1znnxxxxxxxxxxxxx9z4ulx',
  fromBlockHash: '0000000000000000000000000000000000000000000000000000000000000000',
  data: '',
  fusedPlasma: 0,
  difficulty: 0,
  nonce: '0000000000000000',
  publicKey: '',
  signature: '',
}

describe.skipIf(!configured)('ZenonWalletService ↔ fake Syrius over the live relay', () => {
  let wallet: FakeSyrius

  beforeAll(async () => {
    vi.stubGlobal('window', {location: {origin: 'http://localhost:5173'}})
    wallet = await createFakeSyrius({projectId: projectId as string})
  })

  afterAll(async () => {
    await wallet?.close()
    vi.unstubAllGlobals()
  })

  it('pairs, approves our exact namespace, and round-trips znn_info + znn_send', async () => {
    const {ZenonWalletService} = await import('./zenon-wallet-service')
    const {AccountBlockTemplate} = await import('znn-typescript-sdk')
    const service = ZenonWalletService.getInstance()
    const onDisconnect = vi.fn()
    service.onDisconnect = onDisconnect
    service.onPairingUri = uri => {
      wallet.pair(uri).catch(e => console.error('[integration] pair failed:', e))
    }

    // Pairing + approval: only succeeds if the wallet can approve our
    // requiredNamespaces verbatim.
    const info = await service.connect()
    expect(info.address).toBe(FAKE_SYRIUS_ADDRESS)
    expect(info.chainId).toBe(1)

    // znn_send round-trip through the real SDK types.
    const block = AccountBlockTemplate.fromJson(WRAP_BLOCK_JSON as never)
    const published = await service.send(FAKE_SYRIUS_ADDRESS, block)
    expect(published.hash.toString()).toMatch(/^[0-9a-f]{64}$/i)

    // Rejection mapping: flag the fake to reject, expect the friendly message.
    wallet.setFlags({reject: true})
    await expect(service.send(FAKE_SYRIUS_ADDRESS, block)).rejects.toThrow(
      'Request rejected in the wallet',
    )
    wallet.setFlags({reject: false})

    // Wallet-side disconnect propagates as session_delete → local state clears.
    await wallet.disconnectAll()
    await vi.waitFor(() => expect(onDisconnect).toHaveBeenCalled(), {timeout: 30_000})
    await expect(service.getInfo()).rejects.toThrow('No active Zenon session')
  })
})
