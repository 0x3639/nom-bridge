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
    session: {getAll: vi.fn(() => [] as unknown[]), delete: vi.fn().mockResolvedValue(undefined)},
    connect: vi.fn(),
    request: vi.fn(),
    disconnect: vi.fn().mockResolvedValue(undefined),
    core: {
      relayer: {
        connected: true,
        transportOpen: vi.fn().mockResolvedValue(undefined),
        restartTransport: vi.fn().mockResolvedValue(undefined),
      },
      pairing: {disconnect: vi.fn().mockResolvedValue(undefined)},
    },
  }
  const pairing = {uri: vi.fn(), closed: vi.fn()}
  return {
    onHandlers,
    client,
    pairing,
    initSpy: vi.fn(async () => client),
    fromJson: vi.fn((json: unknown) => ({fromJson: json})),
    addressParse: vi.fn((address: string) => address),
  }
})

vi.mock('@walletconnect/sign-client', () => ({SignClient: {init: h.initSpy}}))
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
  vi.stubEnv('VITE_WC_PROJECT_ID', 'a'.repeat(32))
  vi.resetModules()
  Object.keys(h.onHandlers).forEach(k => delete h.onHandlers[k])
  h.client.on.mockClear()
  h.client.session.getAll.mockReset().mockReturnValue([])
  h.client.session.delete.mockClear()
  h.client.connect.mockReset()
  h.client.request.mockReset().mockResolvedValue({address: 'z1addr', chainId: 1})
  h.client.disconnect.mockClear()
  h.client.core.relayer.connected = true
  h.client.core.relayer.transportOpen.mockClear()
  h.client.core.pairing.disconnect.mockClear()
  h.client.core.relayer.restartTransport.mockClear()
  h.pairing.uri.mockClear()
  h.pairing.closed.mockClear()
  h.fromJson.mockClear()
  h.addressParse.mockClear()
  h.initSpy.mockClear()
  const memory = new Map<string, string>()
  const sessionStorage = {
    get length() {
      return memory.size
    },
    key: (i: number) => Array.from(memory.keys())[i] ?? null,
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => void memory.set(k, v),
    removeItem: (k: string) => void memory.delete(k),
    clear: () => memory.clear(),
  }
  vi.stubGlobal('window', {location: {origin: 'https://bridge.test'}, sessionStorage, localStorage: sessionStorage})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
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

describe('ZenonWalletService storage', () => {
  it('backs the SignClient with tab-scoped session storage so pairings end with the tab', async () => {
    const {SessionKeyValueStorage} = await import('./wc-session-storage')
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    await ZenonWalletService.getInstance().connect().catch(() => undefined)

    expect(h.initSpy).toHaveBeenCalledWith(
      expect.objectContaining({storage: expect.any(SessionKeyValueStorage)}),
    )
  })
})

describe('ZenonWalletService.connect — stale stored session', () => {
  it('drops a stored session whose handshake fails and pairs afresh', async () => {
    h.client.session.getAll
      .mockReturnValueOnce([zenonSession('topic-stale', future())])
      .mockReturnValue([])
    const {WalletTimeoutError} = await import('./wc-reliability')
    h.client.request
      .mockRejectedValueOnce(new WalletTimeoutError('Syrius request (znn_info)'))
      .mockRejectedValueOnce(new WalletTimeoutError('Syrius request (znn_info)'))
      .mockRejectedValueOnce(new WalletTimeoutError('Syrius request (znn_info)'))
      .mockResolvedValue({address: 'z1addr', chainId: 1})
    h.client.connect.mockResolvedValue({
      uri: 'wc:fresh',
      approval: vi.fn().mockResolvedValue(zenonSession('topic-new', future())),
    })
    const {WC_TIMING} = await import('./wc-reliability')
    WC_TIMING.settleMs = 0
    const {ZenonWalletService} = await import('./zenon-wallet-service')
    const service = ZenonWalletService.getInstance()
    service.onPairingUri = h.pairing.uri

    const info = await service.connect()

    expect(info.address).toBe('z1addr')
    expect(h.client.session.delete).toHaveBeenCalledWith('topic-stale', expect.anything())
    expect(h.pairing.uri).toHaveBeenCalledWith('wc:fresh')
    expect(h.client.request).toHaveBeenLastCalledWith(expect.objectContaining({topic: 'topic-new'}))
  })

  it('does not discard a stored session when the wallet merely rejects the handshake', async () => {
    h.client.session.getAll.mockReturnValue([zenonSession('topic-live', future())])
    h.client.request.mockRejectedValue(Object.assign(new Error('rejected'), {code: 5000}))
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    await expect(ZenonWalletService.getInstance().connect()).rejects.toThrow('Request rejected in the wallet')
    expect(h.client.session.delete).not.toHaveBeenCalled()
    expect(h.client.connect).not.toHaveBeenCalled()
  })
})

describe('ZenonWalletService.connect — fresh pairing', () => {
  it('hands the pairing uri to the UI, then signals close and stores the approved session', async () => {
    h.client.session.getAll.mockReturnValue([])
    h.client.connect.mockResolvedValue({
      uri: 'wc:deadbeef',
      approval: vi.fn().mockResolvedValue(zenonSession('topic-new', future())),
    })
    const {WC_TIMING} = await import('./wc-reliability')
    WC_TIMING.settleMs = 0
    const {ZenonWalletService} = await import('./zenon-wallet-service')
    const service = ZenonWalletService.getInstance()
    service.onPairingUri = h.pairing.uri
    service.onPairingClosed = h.pairing.closed

    await service.connect()

    expect(h.client.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        requiredNamespaces: expect.objectContaining({
          zenon: expect.objectContaining({chains: [ZENON_CHAIN]}),
        }),
      }),
    )
    expect(h.pairing.uri).toHaveBeenCalledWith('wc:deadbeef')
    expect(h.pairing.closed).toHaveBeenCalledTimes(1)
    expect(h.client.request).toHaveBeenCalledWith(
      expect.objectContaining({topic: 'topic-new'}),
    )
  })

  it('signals close even when pairing approval rejects', async () => {
    h.client.session.getAll.mockReturnValue([])
    h.client.connect.mockResolvedValue({
      uri: 'wc:abc',
      approval: vi.fn().mockRejectedValue(Object.assign(new Error('rejected'), {code: 5000})),
    })
    const {ZenonWalletService} = await import('./zenon-wallet-service')
    const service = ZenonWalletService.getInstance()
    service.onPairingClosed = h.pairing.closed

    await expect(service.connect()).rejects.toThrow('Request rejected in the wallet')
    expect(h.pairing.closed).toHaveBeenCalledTimes(1)
  })

  it('cancelPairing() aborts a pending approval as a wallet rejection and closes the UI', async () => {
    h.client.session.getAll.mockReturnValue([])
    h.client.connect.mockResolvedValue({
      uri: 'wc:hang',
      approval: vi.fn().mockReturnValue(new Promise(() => {})),
    })
    const {ZenonWalletService} = await import('./zenon-wallet-service')
    const service = ZenonWalletService.getInstance()
    service.onPairingUri = uri => {
      h.pairing.uri(uri)
      service.cancelPairing()
    }
    service.onPairingClosed = h.pairing.closed

    const {PairingCancelledError} = await import('./zenon-wallet-service')
    await expect(service.connect()).rejects.toBeInstanceOf(PairingCancelledError)
    expect(h.pairing.closed).toHaveBeenCalledTimes(1)
  })

  it('cancelPairing() tears down the pairing topic, and a late approval is disconnected rather than kept', async () => {
    h.client.session.getAll.mockReturnValue([])
    let approveLate: (session: unknown) => void = () => {}
    h.client.connect.mockResolvedValue({
      uri: `wc:${'ab'.repeat(32)}@2?relay-protocol=irn&symKey=ff`,
      approval: vi.fn().mockReturnValue(new Promise(resolve => {
        approveLate = resolve
      })),
    })
    const {ZenonWalletService, PairingCancelledError} = await import('./zenon-wallet-service')
    const service = ZenonWalletService.getInstance()
    service.onPairingUri = () => service.cancelPairing()

    await expect(service.connect()).rejects.toBeInstanceOf(PairingCancelledError)
    expect(h.client.core.pairing.disconnect).toHaveBeenCalledWith({topic: 'ab'.repeat(32)})

    approveLate(zenonSession('session-late', future()))
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(h.client.disconnect).toHaveBeenCalledWith(
      expect.objectContaining({topic: 'session-late', reason: expect.objectContaining({code: 6000})}),
    )
  })

  it('a timed-out pairing is torn down too, and a late approval is disconnected', async () => {
    h.client.session.getAll.mockReturnValue([])
    let approveLate: (session: unknown) => void = () => {}
    h.client.connect.mockResolvedValue({
      uri: `wc:${'cd'.repeat(32)}@2?relay-protocol=irn&symKey=ff`,
      approval: vi.fn().mockReturnValue(new Promise(resolve => {
        approveLate = resolve
      })),
    })
    const {WC_TIMING} = await import('./wc-reliability')
    WC_TIMING.approvalTimeoutMs = 10
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    await expect(ZenonWalletService.getInstance().connect()).rejects.toThrow('timed out')
    expect(h.client.core.pairing.disconnect).toHaveBeenCalledWith({topic: 'cd'.repeat(32)})

    approveLate(zenonSession('session-after-timeout', future()))
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(h.client.disconnect).toHaveBeenCalledWith(
      expect.objectContaining({topic: 'session-after-timeout', reason: expect.objectContaining({code: 6000})}),
    )
  })

  it('a wallet-side rejection does not tear down anything (the wallet already declined)', async () => {
    h.client.session.getAll.mockReturnValue([])
    h.client.connect.mockResolvedValue({
      uri: `wc:${'ef'.repeat(32)}@2?relay-protocol=irn&symKey=ff`,
      approval: vi.fn().mockRejectedValue(Object.assign(new Error('rejected'), {code: 5000})),
    })
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    await expect(ZenonWalletService.getInstance().connect()).rejects.toThrow('Request rejected in the wallet')
    expect(h.client.core.pairing.disconnect).not.toHaveBeenCalled()
    expect(h.client.disconnect).not.toHaveBeenCalled()
  })

  it('cancelPairing() is a no-op when no pairing is pending', async () => {
    const {ZenonWalletService} = await import('./zenon-wallet-service')
    expect(() => ZenonWalletService.getInstance().cancelPairing()).not.toThrow()
  })

  it('does not signal close when a stored session was reused', async () => {
    h.client.session.getAll.mockReturnValue([zenonSession('topic-A', future())])
    const {ZenonWalletService} = await import('./zenon-wallet-service')
    const service = ZenonWalletService.getInstance()
    service.onPairingUri = h.pairing.uri
    service.onPairingClosed = h.pairing.closed

    await service.connect()

    expect(h.pairing.uri).not.toHaveBeenCalled()
    expect(h.pairing.closed).not.toHaveBeenCalled()
  })
})

describe('pairingTopicOf', () => {
  it('extracts the pairing topic from a v2 uri and rejects anything else', async () => {
    const {pairingTopicOf} = await import('./zenon-wallet-service')
    expect(pairingTopicOf(`wc:${'0f'.repeat(32)}@2?relay-protocol=irn&symKey=aa`)).toBe('0f'.repeat(32))
    expect(pairingTopicOf('wc:not-hex@2?x=1')).toBeNull()
    expect(pairingTopicOf('https://example.com')).toBeNull()
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

  it('races znn_send against the longer sendTimeoutMs, not requestTimeoutMs', async () => {
    h.client.session.getAll.mockReturnValue([zenonSession('topic-A', future())])
    h.client.request.mockReset()
    h.client.request
      .mockResolvedValueOnce({address: 'z1addr', chainId: 1}) // connect -> znn_info
      .mockResolvedValueOnce({address: 'z1addr', chainId: 1}) // send safety re-check
      .mockReturnValueOnce(new Promise(() => {})) // znn_send hangs
    const {WC_TIMING} = await import('./wc-reliability')
    WC_TIMING.sendTimeoutMs = 10
    WC_TIMING.requestTimeoutMs = 10_000
    const {ZenonWalletService} = await import('./zenon-wallet-service')
    const service = ZenonWalletService.getInstance()
    await service.connect()

    const block = {toJson: vi.fn(() => ({cell: 'serialized'}))}
    await expect(service.send('z1addr', block as never)).rejects.toMatchObject({
      name: 'ZenonSubmissionError',
      kind: 'ambiguous',
    })
  })

  it('classifies a post-send result-decoding failure as ambiguous, never as a plain failure', async () => {
    // znn_send already returned: the block was signed and broadcast. A
    // version-skewed result that fromJson cannot parse must not become a
    // retryable failure — callers would clear safety locks and resubmit.
    h.client.session.getAll.mockReturnValue([zenonSession('topic-A', future())])
    h.client.request.mockReset()
    h.client.request
      .mockResolvedValueOnce({address: 'z1addr', chainId: 1}) // connect -> znn_info
      .mockResolvedValueOnce({address: 'z1addr', chainId: 1}) // send safety re-check
      .mockResolvedValueOnce({unexpected: 'shape'}) // znn_send result
    h.fromJson.mockImplementationOnce(() => {
      throw new Error('unexpected block shape')
    })
    const {ZenonWalletService} = await import('./zenon-wallet-service')
    const service = ZenonWalletService.getInstance()
    await service.connect()

    const block = {toJson: vi.fn(() => ({cell: 'serialized'}))}
    await expect(service.send('z1addr', block as never)).rejects.toMatchObject({
      name: 'ZenonSubmissionError',
      kind: 'ambiguous',
    })
  })

  // A rejection must be recognized structurally (by wallet error code), never by
  // matching a message string: misclassifying a plain rejection as ambiguous
  // permanently latches the redemption safety lock.
  it('classifies a wallet-locked znn_send failure as a definite non-submission, not ambiguous', async () => {
    // Syrius answering "wallet is locked" proves it did not sign or broadcast;
    // treating it as ambiguous would permanently latch pre-send safety records.
    h.client.session.getAll.mockReturnValue([zenonSession('topic-A', future())])
    h.client.request.mockReset()
    h.client.request
      .mockResolvedValueOnce({address: 'z1addr', chainId: 1}) // connect -> znn_info
      .mockResolvedValueOnce({address: 'z1addr', chainId: 1}) // send safety re-check
      .mockRejectedValueOnce(Object.assign(new Error('Wallet is locked'), {code: 9000}))
    const {ZenonWalletService} = await import('./zenon-wallet-service')
    const service = ZenonWalletService.getInstance()
    await service.connect()

    const block = {toJson: vi.fn(() => ({cell: 'serialized'}))}
    await expect(service.send('z1addr', block as never)).rejects.toMatchObject({
      name: 'ZenonSubmissionError',
      kind: 'rejected',
      message: 'Your wallet is locked — please unlock Syrius',
    })
  })

  it.each([4001, 5000, 5999])('classifies a wallet rejection with code %i as rejected, not ambiguous', async code => {
    h.client.session.getAll.mockReturnValue([zenonSession('topic-A', future())])
    h.client.request.mockReset()
    h.client.request
      .mockResolvedValueOnce({address: 'z1addr', chainId: 1}) // connect -> znn_info
      .mockResolvedValueOnce({address: 'z1addr', chainId: 1}) // send safety re-check
      .mockRejectedValueOnce(Object.assign(new Error('User rejected the request'), {code}))
    const {ZenonWalletService} = await import('./zenon-wallet-service')
    const service = ZenonWalletService.getInstance()
    await service.connect()

    const block = {toJson: vi.fn(() => ({cell: 'serialized'}))}
    await expect(service.send('z1addr', block as never)).rejects.toMatchObject({
      name: 'ZenonSubmissionError',
      kind: 'rejected',
    })
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

    const service = ZenonWalletService.getInstance()
    service.onPairingClosed = h.pairing.closed

    await expect(service.connect()).rejects.toThrow('timed out')
    expect(h.pairing.closed).toHaveBeenCalledTimes(1)
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

  it('does not re-acquire a session after the final retry attempt', async () => {
    h.client.session.getAll.mockReturnValue([zenonSession('topic-A', future())])
    const {ZenonWalletService} = await import('./zenon-wallet-service')
    const service = ZenonWalletService.getInstance()
    await service.connect()

    h.client.session.getAll.mockClear()
    h.client.connect.mockClear()
    h.client.request.mockReset()
    h.client.request.mockRejectedValue(wcError(-32602, 'Bad state: No element'))

    await expect(service.getInfo()).rejects.toThrow('Bad state: No element')

    // 3 attempts total; reconnect (session=null + re-scan) only happens
    // ahead of attempts 2 and 3 — never after the final (3rd) failure.
    expect(h.client.request).toHaveBeenCalledTimes(3)
    expect(h.client.connect).not.toHaveBeenCalled()
    expect(h.client.session.getAll).toHaveBeenCalledTimes(2)
  })
})

describe('ZenonWalletService placeholder guard and restore', () => {
  it('connect() fails fast with setup instructions when the project id is the placeholder', async () => {
    vi.stubEnv('VITE_WC_PROJECT_ID', 'REPLACE_ME_WC_PROJECT_ID')
    vi.resetModules()
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    await expect(ZenonWalletService.getInstance().connect()).rejects.toThrow(
      'set VITE_WC_PROJECT_ID in .env',
    )
    expect(h.initSpy).not.toHaveBeenCalled()
  })

  it('restore() returns null when unconfigured, without initializing the client', async () => {
    vi.stubEnv('VITE_WC_PROJECT_ID', 'REPLACE_ME_WC_PROJECT_ID')
    vi.resetModules()
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    await expect(ZenonWalletService.getInstance().restore()).resolves.toBeNull()
    expect(h.initSpy).not.toHaveBeenCalled()
  })

  it('restore() returns null when there is no live session', async () => {
    h.client.session.getAll.mockReturnValue([])
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    await expect(ZenonWalletService.getInstance().restore()).resolves.toBeNull()
    expect(h.client.connect).not.toHaveBeenCalled()
  })

  it('restore() adopts a live session and returns wallet info', async () => {
    h.client.session.getAll.mockReturnValue([zenonSession('topic-A', future())])
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    const info = await ZenonWalletService.getInstance().restore()

    expect(info).toEqual({address: 'z1addr', chainId: 1})
    expect(h.client.connect).not.toHaveBeenCalled()
  })

  it('restore() swallows znn_info failures and returns null', async () => {
    h.client.session.getAll.mockReturnValue([zenonSession('topic-A', future())])
    h.client.request.mockRejectedValue(new Error('node unreachable'))
    const {WC_TIMING} = await import('./wc-reliability')
    WC_TIMING.maxAttempts = 1
    const {ZenonWalletService} = await import('./zenon-wallet-service')
    const service = ZenonWalletService.getInstance()

    await expect(service.restore()).resolves.toBeNull()
    // the dead session was dropped: nothing to request on afterwards
    await expect(service.getInfo()).rejects.toThrow('No active Zenon session')
  })

  it('does not clobber a session established concurrently by connect() when restore() fails', async () => {
    let rejectRestoreRequest: (e: unknown) => void = () => {}
    const pendingRestoreRequest = new Promise((_resolve, reject) => {
      rejectRestoreRequest = reject
    })
    h.client.session.getAll
      .mockReturnValueOnce([zenonSession('topic-restore', future())]) // restore's scan
      .mockReturnValue([zenonSession('topic-connect', future())]) // connect's scan
    h.client.request
      .mockReturnValueOnce(pendingRestoreRequest) // restore's znn_info: hangs, rejected later
      .mockResolvedValueOnce({address: 'z1addr', chainId: 1}) // connect's znn_info
    const {WC_TIMING} = await import('./wc-reliability')
    WC_TIMING.maxAttempts = 1
    const {ZenonWalletService} = await import('./zenon-wallet-service')
    const service = ZenonWalletService.getInstance()

    const restorePromise = service.restore()
    // Let restore() reach its in-flight znn_info request before racing connect().
    await vi.waitFor(() => expect(h.client.request).toHaveBeenCalledTimes(1))

    await service.connect()

    // Now fail restore()'s stale request — it must not tear down the session
    // connect() just established on a different topic.
    rejectRestoreRequest(new Error('node unreachable'))
    await expect(restorePromise).resolves.toBeNull()

    h.client.request.mockClear()
    h.client.request.mockResolvedValue({address: 'z1addr', chainId: 1})
    await service.getInfo()
    expect(h.client.request).toHaveBeenCalledWith(
      expect.objectContaining({topic: 'topic-connect'}),
    )
  })
})

describe('ZenonWalletService.getClient concurrency', () => {
  it('memoizes SignClient initialization across concurrent restore() and connect() calls', async () => {
    h.client.session.getAll.mockReturnValue([zenonSession('topic-A', future())])
    const {ZenonWalletService} = await import('./zenon-wallet-service')
    const service = ZenonWalletService.getInstance()

    await Promise.all([service.restore(), service.connect()])

    expect(h.initSpy).toHaveBeenCalledTimes(1)
    expect(h.client.connect).not.toHaveBeenCalled()
  })
})

describe('ZenonWalletService.getClient retry after failure', () => {
  it('retries SignClient.init after a failed attempt instead of caching the rejection', async () => {
    h.initSpy.mockRejectedValueOnce(new Error('relay unreachable'))
    h.client.session.getAll.mockReturnValue([zenonSession('topic-A', future())])
    const {ZenonWalletService} = await import('./zenon-wallet-service')
    const service = ZenonWalletService.getInstance()

    await expect(service.connect()).rejects.toThrow('relay unreachable')
    const info = await service.connect()

    expect(info.address).toBe('z1addr')
    expect(h.initSpy).toHaveBeenCalledTimes(2)
  })
})

describe('ZenonWalletService relay transport recovery', () => {
  it('restarts the relay transport and retries when znn_info times out (dead socket after network drop)', async () => {
    h.client.session.getAll.mockReturnValue([zenonSession('topic-A', future())])
    const {WalletTimeoutError} = await import('./wc-reliability')
    h.client.request
      .mockRejectedValueOnce(new WalletTimeoutError('Syrius request (znn_info)'))
      .mockResolvedValue({address: 'z1addr', chainId: 1})
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    const info = await ZenonWalletService.getInstance().connect()

    expect(info.address).toBe('z1addr')
    expect(h.client.core.relayer.restartTransport).toHaveBeenCalledTimes(1)
    expect(h.client.request).toHaveBeenCalledTimes(2)
  })

  it('never retries a timed-out znn_send: the wallet may already hold the prompt', async () => {
    h.client.session.getAll.mockReturnValue([zenonSession('topic-A', future())])
    const {WalletTimeoutError} = await import('./wc-reliability')
    h.client.request
      .mockResolvedValueOnce({address: 'z1addr', chainId: 1}) // connect() handshake
      .mockResolvedValueOnce({address: 'z1addr', chainId: 1}) // send() znn_info pre-check
      .mockRejectedValue(new WalletTimeoutError('Syrius request (znn_send)'))
    const {ZenonWalletService, ZenonSubmissionError} = await import('./zenon-wallet-service')
    const service = ZenonWalletService.getInstance()
    await service.connect()

    const failure = await service.send('z1addr', {toJson: () => ({})} as never).catch(e => e)

    expect(failure).toBeInstanceOf(ZenonSubmissionError)
    expect((failure as InstanceType<typeof ZenonSubmissionError>).kind).toBe('ambiguous')
    expect(h.client.request).toHaveBeenCalledTimes(3)
    expect(h.client.core.relayer.restartTransport).not.toHaveBeenCalled()
  })
})

describe('ZenonWalletService.send — unresponsive session self-heal', () => {
  it('drops the session and reports a typed rejection when the znn_info pre-check only ever times out', async () => {
    h.client.session.getAll.mockReturnValue([zenonSession('topic-dead', future())])
    const {WalletTimeoutError} = await import('./wc-reliability')
    h.client.request
      .mockResolvedValueOnce({address: 'z1addr', chainId: 1}) // connect() handshake
      .mockRejectedValue(new WalletTimeoutError('Syrius request (znn_info)'))
    const {ZenonWalletService, ZenonSubmissionError} = await import('./zenon-wallet-service')
    const service = ZenonWalletService.getInstance()
    await service.connect()
    const disconnected = vi.fn()
    service.onDisconnect = disconnected

    const failure = await service.send('z1addr', {toJson: () => ({})} as never).catch(e => e)

    expect(failure).toBeInstanceOf(ZenonSubmissionError)
    expect((failure as InstanceType<typeof ZenonSubmissionError>).kind).toBe('rejected')
    expect((failure as Error).message).toContain('Reconnect the Zenon wallet')
    expect(h.client.session.delete).toHaveBeenCalledWith('topic-dead', expect.anything())
    expect(disconnected).toHaveBeenCalled()
  })

  it('spares a session re-paired concurrently: only the session the send started with is condemned', async () => {
    h.client.session.getAll
      .mockReturnValueOnce([zenonSession('topic-stale', future())]) // connect #1 adopts
      .mockReturnValue([]) // connect #2 must pair afresh
    const {WalletTimeoutError} = await import('./wc-reliability')
    h.client.request
      .mockResolvedValueOnce({address: 'z1addr', chainId: 1}) // connect #1 handshake
      .mockRejectedValueOnce(new WalletTimeoutError('Syrius request (znn_info)')) // send attempt 1
      .mockResolvedValueOnce({address: 'z1addr', chainId: 1}) // connect #2 handshake
      .mockRejectedValue(new WalletTimeoutError('Syrius request (znn_info)')) // send attempts 2..n
    h.client.connect.mockResolvedValue({
      uri: `wc:${'aa'.repeat(32)}@2?relay-protocol=irn&symKey=ff`,
      approval: vi.fn().mockResolvedValue(zenonSession('topic-new', future())),
    })
    const {WC_TIMING} = await import('./wc-reliability')
    WC_TIMING.settleMs = 0
    const {ZenonWalletService, ZenonSubmissionError} = await import('./zenon-wallet-service')
    const service = ZenonWalletService.getInstance()
    await service.connect()
    const disconnected = vi.fn()
    service.onDisconnect = disconnected
    // A concurrent connect() replaces the session while send's pre-check is
    // mid-retry (driven from the transport-restart hook for determinism).
    h.client.core.relayer.restartTransport.mockImplementationOnce(async () => {
      await service.connect()
    })

    const failure = await service.send('z1addr', {toJson: () => ({})} as never).catch(e => e)

    expect(failure).toBeInstanceOf(ZenonSubmissionError)
    expect(h.client.session.delete).toHaveBeenCalledWith('topic-stale', expect.anything())
    expect(h.client.session.delete).not.toHaveBeenCalledWith('topic-new', expect.anything())
    // The re-paired session stays active: no disconnect signalled to the UI.
    expect(disconnected).not.toHaveBeenCalled()
  })

  it('a non-timeout znn_info failure does not tear down the session', async () => {
    h.client.session.getAll.mockReturnValue([zenonSession('topic-A', future())])
    h.client.request
      .mockResolvedValueOnce({address: 'z1addr', chainId: 1}) // connect() handshake
      .mockRejectedValue(Object.assign(new Error('rejected'), {code: 5000}))
    const {ZenonWalletService} = await import('./zenon-wallet-service')
    const service = ZenonWalletService.getInstance()
    await service.connect()
    const disconnected = vi.fn()
    service.onDisconnect = disconnected

    await expect(service.send('z1addr', {toJson: () => ({})} as never)).rejects.toThrow('Request rejected in the wallet')
    expect(h.client.session.delete).not.toHaveBeenCalled()
    expect(disconnected).not.toHaveBeenCalled()
  })
})
