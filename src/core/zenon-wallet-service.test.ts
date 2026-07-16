import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {ZENON_CHAIN} from '@/config'

// Fakes for the three external boundaries this service touches: the WC
// SignClient (init/on/session/connect/request/disconnect), the WC modal, and the
// SDK's AccountBlockTemplate.fromJson. We assert how the service DRIVES these —
// the request envelope, the session-reuse selection, the disconnect reason — not
// what the fakes return.
const h = vi.hoisted(() => {
  const onHandlers: Record<string, (...args: unknown[]) => void> = {}
  const client = {
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      onHandlers[event] = cb
    }),
    session: {getAll: vi.fn(() => [] as unknown[])},
    connect: vi.fn(),
    request: vi.fn(),
    disconnect: vi.fn().mockResolvedValue(undefined),
    core: {relayer: {connected: true, transportOpen: vi.fn().mockResolvedValue(undefined)}},
  }
  const modal = {openModal: vi.fn().mockResolvedValue(undefined), closeModal: vi.fn()}
  const modalCtor = vi.fn(() => modal)
  return {
    onHandlers,
    client,
    modal,
    modalCtor,
    initSpy: vi.fn(async () => client),
    fromJson: vi.fn((json: unknown) => ({fromJson: json})),
    addressParse: vi.fn((address: string) => address),
  }
})

vi.mock('@walletconnect/sign-client', () => ({SignClient: {init: h.initSpy}}))
vi.mock('@walletconnect/modal', () => ({WalletConnectModal: h.modalCtor}))
vi.mock('znn-typescript-sdk', () => ({
  AccountBlockTemplate: {fromJson: h.fromJson},
  Address: {parse: h.addressParse},
}))

const future = () => Math.floor(Date.now() / 1000) + 3600
const past = () => Math.floor(Date.now() / 1000) - 3600
const zenonSession = (topic: string, expiry: number) => ({
  topic,
  expiry,
  namespaces: {zenon: {}},
})

beforeEach(() => {
  vi.resetModules()
  Object.keys(h.onHandlers).forEach(k => delete h.onHandlers[k])
  h.client.on.mockClear()
  h.client.session.getAll.mockReset().mockReturnValue([])
  h.client.connect.mockReset()
  h.client.request.mockReset().mockResolvedValue({address: 'z1addr', chainId: 1})
  h.client.disconnect.mockClear()
  h.client.core.relayer.connected = true
  h.client.core.relayer.transportOpen.mockClear()
  h.modal.openModal.mockClear()
  h.modal.closeModal.mockClear()
  h.modalCtor.mockClear()
  h.fromJson.mockClear()
  h.addressParse.mockClear()
  vi.stubGlobal('window', {location: {origin: 'https://bridge.test'}})
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ZenonWalletService.connect — session reuse', () => {
  it('reuses the LAST non-expired zenon session and skips the modal', async () => {
    h.client.session.getAll.mockReturnValue([
      zenonSession('topic-A', future()),
      zenonSession('topic-B', future()),
    ])
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    await ZenonWalletService.getInstance().connect()

    // No new pairing was opened...
    expect(h.client.connect).not.toHaveBeenCalled()
    expect(h.modal.openModal).not.toHaveBeenCalled()
    // ...and the reused session is the LAST matching one (topic-B).
    expect(h.client.request).toHaveBeenCalledWith(
      expect.objectContaining({topic: 'topic-B'}),
    )
  })

  it('skips expired sessions when choosing one to reuse', async () => {
    h.client.session.getAll.mockReturnValue([
      zenonSession('topic-valid', future()),
      zenonSession('topic-expired', past()),
    ])
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    await ZenonWalletService.getInstance().connect()

    expect(h.client.request).toHaveBeenCalledWith(
      expect.objectContaining({topic: 'topic-valid'}),
    )
  })

  it('ignores sessions without a zenon namespace', async () => {
    h.client.session.getAll.mockReturnValue([
      zenonSession('topic-zenon', future()),
      {topic: 'topic-eip155', expiry: future(), namespaces: {eip155: {}}},
    ])
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    await ZenonWalletService.getInstance().connect()

    expect(h.client.request).toHaveBeenCalledWith(
      expect.objectContaining({topic: 'topic-zenon'}),
    )
  })
})

describe('ZenonWalletService.connect — fresh pairing', () => {
  it('opens the modal with the uri and stores the approved session when none to reuse', async () => {
    h.client.session.getAll.mockReturnValue([])
    h.client.connect.mockResolvedValue({
      uri: 'wc:deadbeef',
      approval: vi.fn().mockResolvedValue(zenonSession('topic-new', future())),
    })
    const {WC_TIMING} = await import('./wc-reliability')
    WC_TIMING.settleMs = 0
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    await ZenonWalletService.getInstance().connect()

    expect(h.client.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        requiredNamespaces: expect.objectContaining({
          zenon: expect.objectContaining({chains: [ZENON_CHAIN]}),
        }),
      }),
    )
    expect(h.modal.openModal).toHaveBeenCalledWith({uri: 'wc:deadbeef'})
    expect(h.modal.closeModal).toHaveBeenCalled()
    expect(h.client.request).toHaveBeenCalledWith(
      expect.objectContaining({topic: 'topic-new'}),
    )
  })

  it('closes the modal even when pairing approval rejects', async () => {
    h.client.session.getAll.mockReturnValue([])
    h.client.connect.mockResolvedValue({
      uri: 'wc:abc',
      approval: vi.fn().mockRejectedValue(Object.assign(new Error('rejected'), {code: 5000})),
    })
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    await expect(ZenonWalletService.getInstance().connect()).rejects.toThrow(
      'Request rejected in the wallet',
    )
    expect(h.modal.closeModal).toHaveBeenCalled()
  })

  it('configures the modal for Syrius: explorer off, syrius desktop deep-link', async () => {
    h.client.session.getAll.mockReturnValue([])
    h.client.connect.mockResolvedValue({
      uri: 'wc:deadbeef',
      approval: vi.fn().mockResolvedValue(zenonSession('topic-new', future())),
    })
    const {WC_TIMING} = await import('./wc-reliability')
    WC_TIMING.settleMs = 0
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    await ZenonWalletService.getInstance().connect()

    expect(h.modalCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        enableExplorer: false,
        mobileWallets: [],
        desktopWallets: [
          expect.objectContaining({id: 'syrius', name: 'Syrius', links: expect.objectContaining({native: 'syrius:'})}),
        ],
      }),
    )
  })

  it('hands the uri to onPairingUri and skips the modal entirely when the seam is set', async () => {
    h.client.session.getAll.mockReturnValue([])
    h.client.connect.mockResolvedValue({
      uri: 'wc:seam',
      approval: vi.fn().mockResolvedValue(zenonSession('topic-seam', future())),
    })
    const {WC_TIMING} = await import('./wc-reliability')
    WC_TIMING.settleMs = 0
    const {ZenonWalletService} = await import('./zenon-wallet-service')
    const service = ZenonWalletService.getInstance()
    const seen: string[] = []
    service.onPairingUri = uri => seen.push(uri)

    await service.connect()

    expect(seen).toEqual(['wc:seam'])
    expect(h.modalCtor).not.toHaveBeenCalled()
    expect(h.modal.openModal).not.toHaveBeenCalled()
  })
})

describe('ZenonWalletService wallet validation', () => {
  it('rejects a wallet connected to the wrong Zenon chain', async () => {
    h.client.session.getAll.mockReturnValue([zenonSession('topic-A', future())])
    h.client.request.mockResolvedValue({address: 'z1addr', chainId: 3})
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    await expect(ZenonWalletService.getInstance().connect()).rejects.toThrow(
      'expected 1',
    )
  })

  it('rejects an invalid Zenon address', async () => {
    h.client.session.getAll.mockReturnValue([zenonSession('topic-A', future())])
    h.addressParse.mockImplementationOnce(() => {
      throw new Error('invalid')
    })
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    await expect(ZenonWalletService.getInstance().connect()).rejects.toThrow(
      'invalid address',
    )
  })
})

describe('ZenonWalletService request envelope', () => {
  it('always sends topic + chainId + method/params on every request', async () => {
    h.client.session.getAll.mockReturnValue([zenonSession('topic-A', future())])
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    await ZenonWalletService.getInstance().connect() // triggers getInfo -> znn_info

    expect(h.client.request).toHaveBeenCalledWith({
      topic: 'topic-A',
      chainId: ZENON_CHAIN,
      request: {method: 'znn_info', params: undefined},
    })
  })

  it('throws "No active Zenon session" when requesting before connecting', async () => {
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    await expect(ZenonWalletService.getInstance().getInfo()).rejects.toThrow(
      'No active Zenon session',
    )
    expect(h.client.request).not.toHaveBeenCalled()
  })
})

describe('ZenonWalletService.send', () => {
  it('serializes the block, calls znn_send, and rehydrates the result', async () => {
    h.client.session.getAll.mockReturnValue([zenonSession('topic-A', future())])
    h.client.request.mockReset()
    h.client.request
      .mockResolvedValueOnce({address: 'z1addr', chainId: 1}) // connect -> znn_info
      .mockResolvedValueOnce({address: 'z1addr', chainId: 1}) // send safety re-check
      .mockResolvedValueOnce({published: true}) // znn_send result
    const {ZenonWalletService} = await import('./zenon-wallet-service')
    const service = ZenonWalletService.getInstance()
    await service.connect()

    const block = {toJson: vi.fn(() => ({cell: 'serialized'}))}
    const result = await service.send('z1addr', block as never)

    expect(block.toJson).toHaveBeenCalled()
    expect(h.client.request).toHaveBeenLastCalledWith({
      topic: 'topic-A',
      chainId: ZENON_CHAIN,
      request: {method: 'znn_send', params: {fromAddress: 'z1addr', accountBlock: {cell: 'serialized'}}},
    })
    expect(h.fromJson).toHaveBeenCalledWith({published: true})
    expect(result).toEqual({fromJson: {published: true}})
  })
})

describe('ZenonWalletService.disconnect', () => {
  it('disconnects with reason code 6000, clears the session, and fires onDisconnect', async () => {
    h.client.session.getAll.mockReturnValue([zenonSession('topic-A', future())])
    const {ZenonWalletService} = await import('./zenon-wallet-service')
    const service = ZenonWalletService.getInstance()
    const onDisconnect = vi.fn()
    service.onDisconnect = onDisconnect
    await service.connect()

    await service.disconnect()

    expect(h.client.disconnect).toHaveBeenCalledWith({
      topic: 'topic-A',
      reason: {code: 6000, message: 'User disconnected'},
    })
    expect(onDisconnect).toHaveBeenCalledTimes(1)
    // Session is cleared: a subsequent request has nothing to send on.
    await expect(service.getInfo()).rejects.toThrow('No active Zenon session')
  })
})

describe('ZenonWalletService session lifecycle events', () => {
  it('clears the session and fires onDisconnect on a session_delete event', async () => {
    h.client.session.getAll.mockReturnValue([zenonSession('topic-A', future())])
    const {ZenonWalletService} = await import('./zenon-wallet-service')
    const service = ZenonWalletService.getInstance()
    const onDisconnect = vi.fn()
    service.onDisconnect = onDisconnect
    await service.connect()

    h.onHandlers.session_delete()

    expect(onDisconnect).toHaveBeenCalledTimes(1)
    await expect(service.getInfo()).rejects.toThrow('No active Zenon session')
  })

  it('also clears on a session_expire event', async () => {
    h.client.session.getAll.mockReturnValue([zenonSession('topic-A', future())])
    const {ZenonWalletService} = await import('./zenon-wallet-service')
    const service = ZenonWalletService.getInstance()
    const onDisconnect = vi.fn()
    service.onDisconnect = onDisconnect
    await service.connect()

    h.onHandlers.session_expire()

    expect(onDisconnect).toHaveBeenCalledTimes(1)
  })

  it('refreshes authoritative wallet info on an addressChange session event', async () => {
    h.client.session.getAll.mockReturnValue([zenonSession('topic-A', future())])
    h.client.request
      .mockResolvedValueOnce({address: 'z1addr', chainId: 1})
      .mockResolvedValueOnce({address: 'z1new', chainId: 1})
    const {ZenonWalletService} = await import('./zenon-wallet-service')
    const service = ZenonWalletService.getInstance()
    const onInfoChange = vi.fn()
    service.onInfoChange = onInfoChange
    await service.connect()

    h.onHandlers.session_event({
      topic: 'topic-A',
      params: {event: {name: 'addressChange', data: 'z1new'}},
    })
    await vi.waitFor(() => expect(onInfoChange).toHaveBeenCalledWith({address: 'z1new', chainId: 1}))
  })
})

describe('ZenonWalletService.connect — post-approval settle', () => {
  it('re-scans the session store after approval and prefers the store copy', async () => {
    // First scan (reuse check): nothing. Post-approval scan: the store now has
    // the real session under a different topic than approval() returned.
    h.client.session.getAll
      .mockReturnValueOnce([])
      .mockReturnValue([zenonSession('topic-store', future())])
    h.client.connect.mockResolvedValue({
      uri: 'wc:settle',
      approval: vi.fn().mockResolvedValue(zenonSession('topic-approval', future())),
    })
    const {WC_TIMING} = await import('./wc-reliability')
    WC_TIMING.settleMs = 0
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    await ZenonWalletService.getInstance().connect()

    expect(h.client.request).toHaveBeenCalledWith(
      expect.objectContaining({topic: 'topic-store'}),
    )
  })

  it('falls back to the approval() session when the re-scan finds nothing', async () => {
    h.client.session.getAll.mockReturnValue([])
    h.client.connect.mockResolvedValue({
      uri: 'wc:settle2',
      approval: vi.fn().mockResolvedValue(zenonSession('topic-approval', future())),
    })
    const {WC_TIMING} = await import('./wc-reliability')
    WC_TIMING.settleMs = 0
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    await ZenonWalletService.getInstance().connect()

    expect(h.client.request).toHaveBeenCalledWith(
      expect.objectContaining({topic: 'topic-approval'}),
    )
  })
})

describe('ZenonWalletService relay guard and timeouts', () => {
  it('reopens the relay transport before a request when disconnected', async () => {
    h.client.session.getAll.mockReturnValue([zenonSession('topic-A', future())])
    h.client.core.relayer.connected = false
    const {WC_TIMING} = await import('./wc-reliability')
    WC_TIMING.relaySettleMs = 0
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    await ZenonWalletService.getInstance().connect()

    expect(h.client.core.relayer.transportOpen).toHaveBeenCalled()
    const openOrder = h.client.core.relayer.transportOpen.mock.invocationCallOrder[0]
    const requestOrder = h.client.request.mock.invocationCallOrder[0]
    expect(openOrder).toBeLessThan(requestOrder)
  })

  it('does not touch the transport when the relay is connected', async () => {
    h.client.session.getAll.mockReturnValue([zenonSession('topic-A', future())])
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    await ZenonWalletService.getInstance().connect()

    expect(h.client.core.relayer.transportOpen).not.toHaveBeenCalled()
  })

  it('times out a hanging request with a Syrius-flavored error', async () => {
    h.client.session.getAll.mockReturnValue([zenonSession('topic-A', future())])
    h.client.request.mockReturnValue(new Promise(() => {}))
    const {WC_TIMING} = await import('./wc-reliability')
    WC_TIMING.requestTimeoutMs = 10
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    await expect(ZenonWalletService.getInstance().connect()).rejects.toThrow(
      'timed out — check that Syrius is open and responsive',
    )
  })

  it('times out a never-approved pairing', async () => {
    h.client.session.getAll.mockReturnValue([])
    h.client.connect.mockResolvedValue({
      uri: 'wc:hang',
      approval: vi.fn().mockReturnValue(new Promise(() => {})),
    })
    const {WC_TIMING} = await import('./wc-reliability')
    WC_TIMING.approvalTimeoutMs = 10
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    await expect(ZenonWalletService.getInstance().connect()).rejects.toThrow('timed out')
    expect(h.modal.closeModal).toHaveBeenCalled()
  })
})

describe('ZenonWalletService retry + Syrius error map', () => {
  const wcError = (code: number, message: string) => Object.assign(new Error(message), {code})

  it('surfaces wallet-locked immediately without retrying', async () => {
    h.client.session.getAll.mockReturnValue([zenonSession('topic-A', future())])
    h.client.request.mockRejectedValue(wcError(9000, 'Wallet is locked'))
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    await expect(ZenonWalletService.getInstance().connect()).rejects.toThrow(
      'Your wallet is locked — please unlock Syrius',
    )
    expect(h.client.request).toHaveBeenCalledTimes(1)
  })

  it('surfaces rejection immediately without retrying', async () => {
    h.client.session.getAll.mockReturnValue([zenonSession('topic-A', future())])
    h.client.request.mockRejectedValue(wcError(5000, 'User rejected'))
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    await expect(ZenonWalletService.getInstance().connect()).rejects.toThrow(
      'Request rejected in the wallet',
    )
    expect(h.client.request).toHaveBeenCalledTimes(1)
  })

  it('retries after "No matching key" and succeeds', async () => {
    h.client.session.getAll.mockReturnValue([zenonSession('topic-A', future())])
    h.client.request
      .mockRejectedValueOnce(wcError(-32602, 'No matching key. session topic doesn\'t exist'))
      .mockResolvedValueOnce({address: 'z1addr', chainId: 1})
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    const info = await ZenonWalletService.getInstance().connect()

    expect(info.address).toBe('z1addr')
    expect(h.client.request).toHaveBeenCalledTimes(2)
  })

  it('re-acquires the session after "Bad state: No element" and retries', async () => {
    h.client.session.getAll.mockReturnValue([zenonSession('topic-A', future())])
    h.client.request
      .mockRejectedValueOnce(wcError(-32602, 'Bad state: No element'))
      .mockResolvedValueOnce({address: 'z1addr', chainId: 1})
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    const info = await ZenonWalletService.getInstance().connect()

    expect(info.address).toBe('z1addr')
    // reuse-scan on connect + re-acquire scan after the bad-state error
    expect(h.client.session.getAll.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(h.client.request).toHaveBeenCalledTimes(2)
  })

  it('gives up after maxAttempts retryable failures', async () => {
    h.client.session.getAll.mockReturnValue([zenonSession('topic-A', future())])
    h.client.request.mockRejectedValue(wcError(-32602, 'No matching key. nope'))
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    await expect(ZenonWalletService.getInstance().connect()).rejects.toThrow()
    expect(h.client.request).toHaveBeenCalledTimes(3)
  })
})
