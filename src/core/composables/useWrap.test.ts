import {beforeEach, describe, expect, it, vi} from 'vitest'

// Mock external boundaries: the services, the Zenon wallet send, the request
// store, and the SDK helpers. tssSignatureToHex is exercised for real via the
// real evm-service export — but here we mock evm-service to drive redeem.
const h = vi.hoisted(() => ({
  buildWrapBlock: vi.fn(),
  getAccountFrontierHeight: vi.fn(),
  getWrapRedeemProgress: vi.fn(),
  redeem: vi.fn(),
  tssSignatureToHex: vi.fn(),
  send: vi.fn(),
  trackWrap: vi.fn(),
  setPendingEvmClaim: vi.fn(),
  clearPendingEvmClaim: vi.fn(),
  setUnknownWrap: vi.fn(),
  clearUnknownWrap: vi.fn(),
  getTransactionOutcome: vi.fn(),
  getAuthoritativeOutcome: vi.fn(),
  getSnapshot: vi.fn(),
  withCrossContextLock: vi.fn(),
  withExclusiveSourceLock: vi.fn(),
  hasCrossContextLocks: vi.fn(),
  extractNumberDecimals: vi.fn(),
}))

vi.mock('../bridge-service', () => ({
  BridgeService: {
    getInstance: () => ({
      buildWrapBlock: h.buildWrapBlock,
      getAccountFrontierHeight: h.getAccountFrontierHeight,
    }),
  },
}))

vi.mock('../evm-service', () => ({
  EvmSubmissionError: class EvmSubmissionError extends Error {
    constructor(public kind: string, public hash: string, message: string) { super(message) }
  },
  EvmService: {getInstance: () => ({
    getWrapRedeemProgress: h.getWrapRedeemProgress,
    getTransactionOutcome: h.getTransactionOutcome,
    getAuthoritativeOutcome: h.getAuthoritativeOutcome,
    redeem: h.redeem,
  })},
  tssSignatureToHex: h.tssSignatureToHex,
}))

vi.mock('./useZenonWallet', () => ({
  useZenonWallet: () => ({send: h.send}),
}))

vi.mock('../request-store', () => ({
  requestStore: {
    trackWrap: h.trackWrap,
    setPendingEvmClaim: h.setPendingEvmClaim,
    clearPendingEvmClaim: h.clearPendingEvmClaim,
    setUnknownWrap: h.setUnknownWrap,
    clearUnknownWrap: h.clearUnknownWrap,
    getSnapshot: h.getSnapshot,
    withCrossContextLock: h.withCrossContextLock,
    withExclusiveSourceLock: h.withExclusiveSourceLock,
    hasCrossContextLocks: h.hasCrossContextLocks,
  },
}))

vi.mock('znn-typescript-sdk', () => ({
  extractNumberDecimals: h.extractNumberDecimals,
}))

beforeEach(() => {
  vi.resetModules()
  Object.values(h).forEach(fn => fn.mockReset())
  h.trackWrap.mockResolvedValue(undefined)
  h.setPendingEvmClaim.mockResolvedValue(true)
  h.clearPendingEvmClaim.mockResolvedValue(undefined)
  h.setUnknownWrap.mockResolvedValue(undefined)
  h.clearUnknownWrap.mockResolvedValue(undefined)
  h.getAccountFrontierHeight.mockResolvedValue(0)
  h.getSnapshot.mockResolvedValue({evmClaims: {}, unknownWraps: {}, requests: []})
  h.withCrossContextLock.mockImplementation(async (_key: string, action: () => Promise<unknown>) => action())
  h.withExclusiveSourceLock.mockImplementation(async (_key: string, action: () => Promise<unknown>) => action())
  h.hasCrossContextLocks.mockReturnValue(true)
})

describe('useWrap.wrap', () => {
  it('builds the block, sends it, tracks the published hash, returns it', async () => {
    h.buildWrapBlock.mockReturnValue({__block: true})
    h.send.mockResolvedValue({hash: {toString: () => 'wraphash'}})
    h.extractNumberDecimals.mockReturnValue({toString: () => '150000000'})
    h.trackWrap.mockResolvedValue(undefined)
    const {useWrap} = await import('./useWrap')

    const result = await useWrap().wrap('0xRecipient', '1.5', 8, 'zts1znn', 'ZNN', 'z1qsender')

    expect(h.buildWrapBlock).toHaveBeenCalledWith('0xRecipient', '1.5', 8, 'zts1znn')
    expect(h.send).toHaveBeenCalledWith({__block: true})
    expect(h.trackWrap).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'wraphash',
        evmToAddress: '0xRecipient',
        amount: '150000000',
        decimals: 8,
        symbol: 'ZNN',
      }),
    )
    expect(result).toEqual({id: 'wraphash', trackingFailed: false})
  })

  it('does not expose a retry when tracking fails after the wrap was published', async () => {
    h.buildWrapBlock.mockReturnValue({__block: true})
    h.extractNumberDecimals.mockReturnValue({toString: () => '100000000'})
    h.send.mockResolvedValue({hash: {toString: () => 'publishedhash'}})
    h.trackWrap.mockRejectedValue(new Error('quota exceeded'))
    const {useWrap} = await import('./useWrap')

    await expect(
      useWrap().wrap('0xRecipient', '1', 8, 'zts1znn', 'ZNN', 'z1qsender'),
    ).resolves.toEqual({id: 'publishedhash', trackingFailed: true})
    expect(useWrap().phase.value).toMatchObject({kind: 'submitted-untracked', id: 'publishedhash'})
  })

  it('does not expose a retry when the Zenon send result is ambiguous', async () => {
    // Syrius may have received — and may still sign and broadcast — the wrap
    // block. A 'failed' phase would enable "Retry wrap submission" and invite a
    // duplicate transfer of the same amount.
    h.buildWrapBlock.mockReturnValue({__block: true})
    h.extractNumberDecimals.mockReturnValue({toString: () => '100000000'})
    const {ZenonSubmissionError} = await import('../zenon-wallet-service')
    h.send.mockRejectedValue(new ZenonSubmissionError('ambiguous', 'result unavailable'))
    const {useWrap} = await import('./useWrap')

    await expect(useWrap().wrap('0xRecipient', '1', 8, 'zts1znn', 'ZNN', 'z1qsender')).rejects.toMatchObject({
      kind: 'ambiguous',
    })
    expect(useWrap().phase.value).toMatchObject({kind: 'submitted-unknown'})
    // A definite rejection still resets to a retryable failure.
    h.send.mockRejectedValue(new ZenonSubmissionError('rejected', 'Request rejected in the wallet'))
    await expect(useWrap().wrap('0xRecipient', '1', 8, 'zts1znn', 'ZNN', 'z1qsender')).rejects.toMatchObject({
      kind: 'rejected',
    })
    expect(useWrap().phase.value).toMatchObject({kind: 'failed'})
  })

  it('submits under a NON-QUEUING account-scoped exclusive lock', async () => {
    // Queuing is unsafe for source transfers: a queued click would execute
    // after another tab's completed submission, against state the user never
    // saw, and could transfer twice.
    h.buildWrapBlock.mockReturnValue({__block: true})
    h.extractNumberDecimals.mockReturnValue({toString: () => '100000000'})
    h.send.mockResolvedValue({hash: {toString: () => 'wraphash'}})
    const {useWrap} = await import('./useWrap')

    await useWrap().wrap('0xRecipient', '1', 8, 'zts1znn', 'ZNN', 'z1qsender')

    expect(h.withExclusiveSourceLock).toHaveBeenCalledWith(
      'wrap-submit:z1qsender',
      expect.any(Function),
    )
  })

  it('surfaces an occupied source lock as a failure without opening the wallet', async () => {
    h.buildWrapBlock.mockReturnValue({__block: true})
    h.extractNumberDecimals.mockReturnValue({toString: () => '100000000'})
    h.withExclusiveSourceLock.mockRejectedValue(
      new Error('A submission for this account is already in progress in another tab or window'),
    )
    const {useWrap} = await import('./useWrap')

    await expect(
      useWrap().wrap('0xRecipient', '1', 8, 'zts1znn', 'ZNN', 'z1qsender'),
    ).rejects.toThrow('another tab')
    expect(h.send).not.toHaveBeenCalled()
    expect(useWrap().phase.value).toMatchObject({kind: 'failed'})
    expect(useWrap().isWrapping.value).toBe(false)
  })

  it('refuses inside the lock when another context holds an unknown-wrap intent for the account', async () => {
    h.buildWrapBlock.mockReturnValue({__block: true})
    h.extractNumberDecimals.mockReturnValue({toString: () => '100000000'})
    h.getSnapshot.mockResolvedValue({
      evmClaims: {},
      requests: [],
      unknownWraps: {
        'other-tab-op': {
          evmToAddress: '0xRecipient',
          zenonFromAddress: 'z1qsender',
          frontierHeight: 1,
          zts: 'zts1znn',
          amount: '100000000',
          decimals: 8,
          symbol: 'ZNN',
          createdAt: 1,
        },
      },
    })
    const {useWrap} = await import('./useWrap')

    await expect(
      useWrap().wrap('0xRecipient', '1', 8, 'zts1znn', 'ZNN', 'z1qsender'),
    ).rejects.toThrow('in progress')
    expect(h.send).not.toHaveBeenCalled()
    expect(h.setUnknownWrap).not.toHaveBeenCalled()
  })

  it('refuses a queued submission when a wrap was recorded after this click', async () => {
    // Tab B clicked while tab A was submitting; B queued on the Web Lock and
    // must not re-submit once A's transfer is durably recorded.
    h.buildWrapBlock.mockReturnValue({__block: true})
    h.extractNumberDecimals.mockReturnValue({toString: () => '100000000'})
    h.getSnapshot.mockResolvedValue({
      evmClaims: {},
      unknownWraps: {},
      requests: [{kind: 'wrap', id: 'a-just-submitted', createdAt: Date.now() + 60_000}],
    })
    const {useWrap} = await import('./useWrap')

    await expect(
      useWrap().wrap('0xRecipient', '1', 8, 'zts1znn', 'ZNN', 'z1qsender'),
    ).rejects.toThrow('another context')
    expect(h.send).not.toHaveBeenCalled()
  })

  it('synchronously refuses a second wrap while one is in flight', async () => {
    // The duplicate check must not depend on any awaited work: two rapid
    // submissions racing a network request must never both reach the wallet.
    h.buildWrapBlock.mockReturnValue({__block: true})
    h.extractNumberDecimals.mockReturnValue({toString: () => '100000000'})
    let finishSend: (value: unknown) => void = () => undefined
    h.send.mockReturnValue(new Promise(resolve => {
      finishSend = resolve
    }))
    const {useWrap} = await import('./useWrap')

    const first = useWrap().wrap('0xRecipient', '1', 8, 'zts1znn', 'ZNN', 'z1qsender')
    await expect(
      useWrap().wrap('0xRecipient', '1', 8, 'zts1znn', 'ZNN', 'z1qsender'),
    ).rejects.toThrow('already in progress')
    finishSend({hash: {toString: () => 'wraphash'}})
    await expect(first).resolves.toEqual({id: 'wraphash', trackingFailed: false})
    expect(h.send).toHaveBeenCalledTimes(1)
  })

  it('persists the safety intent BEFORE the wallet call and keeps it on ambiguity', async () => {
    // A crash while Syrius holds the prompt must leave a durable record, so
    // the intent has to exist before znn_send is dispatched.
    const order: string[] = []
    h.buildWrapBlock.mockReturnValue({__block: true})
    h.extractNumberDecimals.mockReturnValue({toString: () => '150000000'})
    h.getAccountFrontierHeight.mockResolvedValue(41)
    h.setUnknownWrap.mockImplementation(async () => {
      order.push('persist-intent')
    })
    const {ZenonSubmissionError} = await import('../zenon-wallet-service')
    h.send.mockImplementation(async () => {
      order.push('send')
      throw new ZenonSubmissionError('ambiguous', 'result unavailable')
    })
    const {useWrap} = await import('./useWrap')

    await expect(
      useWrap().wrap('0xRecipient', '1.5', 8, 'zts1znn', 'ZNN', 'z1qsender'),
    ).rejects.toMatchObject({kind: 'ambiguous'})
    expect(order).toEqual(['persist-intent', 'send'])
    expect(h.setUnknownWrap).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        evmToAddress: '0xRecipient',
        zenonFromAddress: 'z1qsender',
        frontierHeight: 41,
        zts: 'zts1znn',
        amount: '150000000',
        decimals: 8,
        symbol: 'ZNN',
      }),
    )
    expect(h.clearUnknownWrap).not.toHaveBeenCalled()
  })

  it('aborts the submission when the safety intent cannot be persisted', async () => {
    h.buildWrapBlock.mockReturnValue({__block: true})
    h.extractNumberDecimals.mockReturnValue({toString: () => '100000000'})
    h.getAccountFrontierHeight.mockResolvedValue(41)
    h.setUnknownWrap.mockRejectedValue(new Error('storage write failed'))
    const {useWrap} = await import('./useWrap')

    await expect(
      useWrap().wrap('0xRecipient', '1', 8, 'zts1znn', 'ZNN', 'z1qsender'),
    ).rejects.toThrow(/safety lock/)
    expect(h.send).not.toHaveBeenCalled()
    expect(useWrap().phase.value).toMatchObject({kind: 'failed'})
  })

  it('releases the intent on a definite rejection and after durable tracking on success', async () => {
    h.buildWrapBlock.mockReturnValue({__block: true})
    h.extractNumberDecimals.mockReturnValue({toString: () => '100000000'})
    h.getAccountFrontierHeight.mockResolvedValue(41)
    const {ZenonSubmissionError} = await import('../zenon-wallet-service')
    h.send.mockRejectedValueOnce(new ZenonSubmissionError('rejected', 'Request rejected in the wallet'))
    const {useWrap} = await import('./useWrap')

    await expect(
      useWrap().wrap('0xRecipient', '1', 8, 'zts1znn', 'ZNN', 'z1qsender'),
    ).rejects.toMatchObject({kind: 'rejected'})
    expect(h.clearUnknownWrap).toHaveBeenCalledTimes(1)

    h.send.mockResolvedValueOnce({hash: {toString: () => 'wraphash'}})
    await expect(
      useWrap().wrap('0xRecipient', '1', 8, 'zts1znn', 'ZNN', 'z1qsender'),
    ).resolves.toEqual({id: 'wraphash', trackingFailed: false})
    expect(h.clearUnknownWrap).toHaveBeenCalledTimes(2)
  })

  it('keeps the intent when tracking fails after a successful publish', async () => {
    // Without durable known-hash tracking, the intent is the only reload-safe
    // record; account-chain reconciliation clears it once the node indexes.
    h.buildWrapBlock.mockReturnValue({__block: true})
    h.extractNumberDecimals.mockReturnValue({toString: () => '100000000'})
    h.getAccountFrontierHeight.mockResolvedValue(41)
    h.send.mockResolvedValue({hash: {toString: () => 'wraphash'}})
    h.trackWrap.mockRejectedValue(new Error('quota exceeded'))
    const {useWrap} = await import('./useWrap')

    await expect(
      useWrap().wrap('0xRecipient', '1', 8, 'zts1znn', 'ZNN', 'z1qsender'),
    ).resolves.toEqual({id: 'wraphash', trackingFailed: true})
    expect(h.clearUnknownWrap).not.toHaveBeenCalled()
  })
})

describe('useWrap.recoverClaimPlaceholder', () => {
  it('releases an orphaned pre-prompt placeholder through the recovery action', async () => {
    h.getSnapshot.mockResolvedValue({
      requests: [],
      unknownWraps: {},
      evmClaims: {'1a2b': {hash: 'awaiting-wallet-result', stage: 1, updatedAt: 1}},
    })
    const {useWrap} = await import('./useWrap')

    await expect(useWrap().recoverClaimPlaceholder('1a2b')).resolves.toBe('released')
    expect(h.clearPendingEvmClaim).toHaveBeenCalledWith('1a2b')
  })

  it('keeps ambiguous and real-hash locks', async () => {
    h.getSnapshot.mockResolvedValue({
      requests: [],
      unknownWraps: {},
      evmClaims: {'1a2b': {hash: 'ambiguous-wallet-result', stage: 1, updatedAt: 1}},
    })
    const {useWrap} = await import('./useWrap')
    await expect(useWrap().recoverClaimPlaceholder('1a2b')).resolves.toBe('kept')

    h.getSnapshot.mockResolvedValue({
      requests: [],
      unknownWraps: {},
      evmClaims: {'1a2b': {hash: '0xrealhash', stage: 1, updatedAt: 1}},
    })
    await expect(useWrap().recoverClaimPlaceholder('1a2b')).resolves.toBe('kept')
    expect(h.clearPendingEvmClaim).not.toHaveBeenCalled()
  })

  it('never reclaims a placeholder without real cross-context exclusion', async () => {
    // Reclaim's proof is "we hold the Web Lock, so the writer is dead" — with
    // no Web Locks API that proof does not exist and the writer may be live.
    h.hasCrossContextLocks.mockReturnValue(false)
    h.getSnapshot.mockResolvedValue({
      requests: [],
      unknownWraps: {},
      evmClaims: {'1a2b': {hash: 'awaiting-wallet-result', stage: 1, updatedAt: 1}},
    })
    const {useWrap} = await import('./useWrap')

    await expect(useWrap().recoverClaimPlaceholder('1a2b')).resolves.toBe('kept')
    const request = {
      id: {toString: () => '1a2b'},
      toAddress: '0xTo00000000000000000000000000000000000001',
      tokenAddress: '0xToken00000000000000000000000000000000002',
      amount: {toString: () => '100000000'},
      fee: {toString: () => '250000'},
      signature: 'c2lnbmF0dXJl',
      tokenStandard: {toString: () => 'zts1znn'},
    }
    await expect(useWrap().redeemEvm(
      request as never,
      '0xBridge00000000000000000000000000000000',
    )).rejects.toThrow('already in progress')
    expect(h.clearPendingEvmClaim).not.toHaveBeenCalled()
  })
})

describe('useWrap.redeemEvm', () => {
  function requestFixture() {
    return {
      id: {toString: () => '1a2b'},
      toAddress: '0xTo00000000000000000000000000000000000001',
      tokenAddress: '0xToken00000000000000000000000000000000002',
      amount: {toString: () => '100000000'},
      fee: {toString: () => '250000'},
      signature: 'c2lnbmF0dXJl',
      tokenStandard: {toString: () => 'zts1znn'},
    }
  }

  it('sources the five redeem args from the WrapTokenRequest', async () => {
    h.getWrapRedeemProgress.mockResolvedValue({kind: 'unredeemed'})
    h.tssSignatureToHex.mockReturnValue('0xsig')
    h.redeem.mockResolvedValue('0xtxhash')
    const {useWrap} = await import('./useWrap')
    const bridge = '0xBridge00000000000000000000000000000000' as `0x${string}`

    const tx = await useWrap().redeemEvm(requestFixture() as never, bridge)

    expect(h.tssSignatureToHex).toHaveBeenCalledWith('c2lnbmF0dXJl')
    expect(h.redeem).toHaveBeenCalledWith(
      bridge,
      '0xTo00000000000000000000000000000000000001', // to
      '0xToken00000000000000000000000000000000002', // token
      100000000n - 250000n, // netAmount = amount - fee
      BigInt('0x1a2b'), // nonce
      '0xsig', // signature
      expect.any(Function),
    )
    expect(tx).toEqual({kind: 'confirmed', hash: '0xtxhash', claimStage: 1})
  })

  it('no-ops when already fully-redeemed', async () => {
    h.getWrapRedeemProgress.mockResolvedValue({kind: 'fully-redeemed'})
    const {useWrap} = await import('./useWrap')
    const bridge = '0xBridge00000000000000000000000000000000' as `0x${string}`

    await expect(useWrap().redeemEvm(requestFixture() as never, bridge)).resolves.toEqual({
      kind: 'already-redeemed',
    })

    expect(h.redeem).not.toHaveBeenCalled()
  })

  it('refuses a claim when another context already persisted its lock', async () => {
    h.getSnapshot.mockResolvedValue({
      evmClaims: {'1a2b': {hash: '0xother-tab', stage: 1}},
    })
    const {useWrap} = await import('./useWrap')

    await expect(useWrap().redeemEvm(
      requestFixture() as never,
      '0xBridge00000000000000000000000000000000',
    )).rejects.toThrow('already in progress')
    expect(h.redeem).not.toHaveBeenCalled()
  })

  it('reclaims an orphaned pre-prompt placeholder under the exclusive Web Lock', async () => {
    // Holding the Web Lock proves the flow that wrote the placeholder died
    // mid-prompt (a completed flow would have cleared or upgraded it), and the
    // dead flow's MetaMask popup died with its browser context.
    h.getSnapshot.mockResolvedValue({
      evmClaims: {'1a2b': {hash: 'awaiting-wallet-result', stage: 1, updatedAt: 1}},
    })
    h.getWrapRedeemProgress.mockResolvedValue({kind: 'unredeemed'})
    h.tssSignatureToHex.mockReturnValue('0xsig')
    h.redeem.mockResolvedValue('0xtxhash')
    const {useWrap} = await import('./useWrap')

    await expect(useWrap().redeemEvm(
      requestFixture() as never,
      '0xBridge00000000000000000000000000000000',
    )).resolves.toEqual({kind: 'confirmed', hash: '0xtxhash', claimStage: 1})
  })

  it('refuses to reclaim an ambiguous lock — the previous claim may still confirm', async () => {
    h.getSnapshot.mockResolvedValue({
      evmClaims: {'1a2b': {hash: 'ambiguous-wallet-result', stage: 1, updatedAt: 1}},
    })
    const {useWrap} = await import('./useWrap')

    await expect(useWrap().redeemEvm(
      requestFixture() as never,
      '0xBridge00000000000000000000000000000000',
    )).rejects.toThrow('already in progress')
    expect(h.redeem).not.toHaveBeenCalled()
  })

  it('classifies a delay-complete redemption from fresh protocol progress as the final claim', async () => {
    h.getWrapRedeemProgress.mockResolvedValue({kind: 'waiting-delay', remainingSeconds: 0})
    h.tssSignatureToHex.mockReturnValue('0xsig')
    h.redeem.mockResolvedValue('0xfinal')
    const {useWrap} = await import('./useWrap')

    await expect(useWrap().redeemEvm(
      requestFixture() as never,
      '0xBridge00000000000000000000000000000000',
    )).resolves.toEqual({kind: 'confirmed', hash: '0xfinal', claimStage: 2})
    expect(h.setPendingEvmClaim).toHaveBeenCalledWith('1a2b', 'awaiting-wallet-result', 2)
  })

  it('keeps the duplicate guard in shared composable state while a claim is pending', async () => {
    h.getWrapRedeemProgress.mockResolvedValue({kind: 'unredeemed'})
    h.tssSignatureToHex.mockReturnValue('0xsig')
    let finish!: (hash: string) => void
    h.redeem.mockImplementation(async (...args: unknown[]) => {
      const submitted = args[6] as ((hash: string) => void) | undefined
      await submitted?.('0xpending')
      return new Promise<string>(resolve => { finish = resolve })
    })
    const {useWrap} = await import('./useWrap')
    const bridge = '0xBridge00000000000000000000000000000000' as `0x${string}`

    const first = useWrap().redeemEvm(requestFixture() as never, bridge)
    await vi.waitFor(() => expect(useWrap().pendingRedeems.value['1a2b']).toBe('confirming'))
    expect(h.setPendingEvmClaim).toHaveBeenCalledWith('1a2b', '0xpending', 1)
    await expect(useWrap().redeemEvm(requestFixture() as never, bridge)).rejects.toThrow(
      'already in progress',
    )
    finish('0xconfirmed')
    await expect(first).resolves.toEqual({kind: 'confirmed', hash: '0xconfirmed', claimStage: 1})
    expect(useWrap().pendingRedeems.value['1a2b']).toBe('confirming')
    await useWrap().clearPendingRedeem('1a2b')
    expect(useWrap().pendingRedeems.value['1a2b']).toBeUndefined()
  })

  it('keeps an ambiguous post-broadcast claim locked', async () => {
    h.getWrapRedeemProgress.mockResolvedValue({kind: 'unredeemed'})
    h.tssSignatureToHex.mockReturnValue('0xsig')
    h.redeem.mockImplementation(async (...args: unknown[]) => {
      const submitted = args[6] as (hash: string) => void
      await submitted('0xsubmitted')
      throw new Error('RPC connection dropped')
    })
    const {useWrap} = await import('./useWrap')
    const bridge = '0xBridge00000000000000000000000000000000' as `0x${string}`

    await expect(useWrap().redeemEvm(requestFixture() as never, bridge)).rejects.toThrow(
      'RPC connection dropped',
    )
    expect(useWrap().pendingRedeems.value['1a2b']).toBe('confirming')
  })

  it('keeps the real broadcast hash in memory when persisting it fails', async () => {
    // The placeholder persist succeeds; the post-broadcast persist of the real
    // hash fails. That storage failure must not surface as a submission error,
    // and the real hash must survive in memory so a recheck can query it.
    h.getWrapRedeemProgress.mockResolvedValue({kind: 'unredeemed'})
    h.tssSignatureToHex.mockReturnValue('0xsig')
    h.setPendingEvmClaim.mockReset()
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error('storage quota exceeded'))
      .mockResolvedValue(true)
    const {EvmSubmissionError} = await import('../evm-service')
    h.redeem.mockImplementation(async (...args: unknown[]) => {
      const submitted = args[6] as (hash: string) => Promise<void>
      await submitted('0xrealhash')
      throw new EvmSubmissionError('confirmation-unknown', '0xrealhash', 'Redeem transaction was submitted, but confirmation could not be verified')
    })
    const {useWrap} = await import('./useWrap')
    const bridge = '0xBridge00000000000000000000000000000000' as `0x${string}`

    await expect(useWrap().redeemEvm(requestFixture() as never, bridge)).rejects.toMatchObject({
      kind: 'confirmation-unknown',
    })
    expect(useWrap().pendingRedeems.value['1a2b']).toBe('confirming')
    expect(useWrap().pendingRedeemHashes.value['1a2b']).toBe('0xrealhash')
    // The durable lock must not be left as a reclaimable pre-prompt
    // placeholder: a reload would lose the in-memory hash and a new flow could
    // reclaim the lock while the broadcast claim is still live. Best-effort
    // upgrade to the never-reclaimed ambiguous marker.
    expect(h.setPendingEvmClaim).toHaveBeenLastCalledWith('1a2b', 'ambiguous-wallet-result', 1)
  })

  it('locks the claim locally before waiting on another context\'s cross-context lock', async () => {
    h.getWrapRedeemProgress.mockResolvedValue({kind: 'unredeemed'})
    h.tssSignatureToHex.mockReturnValue('0xsig')
    h.redeem.mockResolvedValue('0xtxhash')
    let releaseLock: () => void = () => undefined
    h.withCrossContextLock.mockImplementation(async (_key: string, action: () => Promise<unknown>) => {
      await new Promise<void>(resolve => {
        releaseLock = resolve
      })
      return action()
    })
    const {useWrap} = await import('./useWrap')
    const bridge = '0xBridge00000000000000000000000000000000' as `0x${string}`

    const first = useWrap().redeemEvm(requestFixture() as never, bridge)
    // Feedback exists while blocked on the Web Lock, and a second click must
    // refuse instead of queuing another full redeem flow behind the lock.
    expect(useWrap().pendingRedeems.value['1a2b']).toBeTruthy()
    await expect(useWrap().redeemEvm(requestFixture() as never, bridge)).rejects.toThrow(
      'already in progress',
    )
    releaseLock()
    await expect(first).resolves.toEqual({kind: 'confirmed', hash: '0xtxhash', claimStage: 1})
    expect(h.redeem).toHaveBeenCalledTimes(1)
  })
})
