import {beforeEach, describe, expect, it, vi} from 'vitest'

// Mock external boundaries: the services, the Zenon wallet send, the request
// store.
const h = vi.hoisted(() => ({
  getAllowance: vi.fn(),
  approveAllowance: vi.fn(),
  unwrap: vi.fn(),
  buildRedeemBlock: vi.fn(),
  send: vi.fn(),
  trackUnwrap: vi.fn(),
  prune: vi.fn(),
  setPendingZenonRedeem: vi.fn(),
  clearPendingZenonRedeem: vi.fn(),
  getTransactionOutcome: vi.fn(),
  getAuthoritativeOutcome: vi.fn(),
  getAccountBlockOutcome: vi.fn(),
  getUnwrapRequest: vi.fn(),
  getSnapshot: vi.fn(),
  withCrossContextLock: vi.fn(),
  withExclusiveSourceLock: vi.fn(),
  hasCrossContextLocks: vi.fn(),
}))

vi.mock('../bridge-service', () => ({
  BridgeService: {
    getInstance: () => ({
      buildRedeemBlock: h.buildRedeemBlock,
      getAccountBlockOutcome: h.getAccountBlockOutcome,
      getUnwrapRequest: h.getUnwrapRequest,
    }),
  },
}))

vi.mock('../evm-service', () => ({
  EvmSubmissionError: class EvmSubmissionError extends Error {
    constructor(public kind: string, public hash: string, message: string) { super(message) }
  },
  EvmService: {
    getInstance: () => ({
      getAllowance: h.getAllowance,
      approveAllowance: h.approveAllowance,
      unwrap: h.unwrap,
      getTransactionOutcome: h.getTransactionOutcome,
      getAuthoritativeOutcome: h.getAuthoritativeOutcome,
    }),
  },
}))

vi.mock('./useZenonWallet', () => ({
  useZenonWallet: () => ({send: h.send}),
}))

vi.mock('../request-store', () => ({
  requestStore: {
    trackUnwrap: h.trackUnwrap,
    prune: h.prune,
    setPendingZenonRedeem: h.setPendingZenonRedeem,
    clearPendingZenonRedeem: h.clearPendingZenonRedeem,
    getSnapshot: h.getSnapshot,
    withCrossContextLock: h.withCrossContextLock,
    withExclusiveSourceLock: h.withExclusiveSourceLock,
    hasCrossContextLocks: h.hasCrossContextLocks,
  },
}))

beforeEach(() => {
  vi.resetModules()
  Object.values(h).forEach(fn => fn.mockReset())
  h.setPendingZenonRedeem.mockResolvedValue(true)
  h.clearPendingZenonRedeem.mockResolvedValue(undefined)
  h.getSnapshot.mockResolvedValue({zenonRedeems: {}, requests: []})
  h.withCrossContextLock.mockImplementation(async (_key: string, action: () => Promise<unknown>) => action())
  h.withExclusiveSourceLock.mockImplementation(async (_key: string, action: () => Promise<unknown>) => action())
  h.hasCrossContextLocks.mockReturnValue(true)
})

describe('useUnwrap.unwrap', () => {
  it('skips approval when allowance is sufficient, unwraps, and records a two-approval path', async () => {
    h.getAllowance.mockResolvedValue(500n)
    h.unwrap.mockImplementation(async (...args: unknown[]) => {
      const submitted = args[4] as (hash: string) => void
      submitted('0xunwraptx')
      return {hash: '0xunwraptx', provisionalLogIndex: 3, eventMatched: true}
    })
    h.trackUnwrap.mockResolvedValue(undefined)
    const {useUnwrap} = await import('./useUnwrap')

    const token = '0xToken0000000000000000000000000000000001' as `0x${string}`
    const bridge = '0xBridge00000000000000000000000000000000' as `0x${string}`
    const result = await useUnwrap().unwrap(token, 500n, 'z1qrecipient', bridge, 'zts1znn', 8, 'ZNN', '0xFrom000000000000000000000000000000000009')

    expect(h.getAllowance).toHaveBeenCalledWith(token, bridge)
    expect(h.approveAllowance).not.toHaveBeenCalled()
    expect(h.unwrap).toHaveBeenCalledWith(
      bridge,
      token,
      500n,
      'z1qrecipient',
      expect.any(Function),
    )
    expect(h.trackUnwrap).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '0xunwraptx:-1',
        zts: 'zts1znn',
        amount: '500',
        decimals: 8,
        symbol: 'ZNN',
        zenonToAddress: 'z1qrecipient',
        approvalCount: 2,
      }),
    )
    expect(result).toEqual({
      kind: 'confirmed',
      hash: '0xunwraptx',
      provisionalLogIndex: 3,
      eventMatched: true,
      trackingFailed: false,
    })
  })

  it('approves an insufficient allowance before unwrap and records a three-approval path', async () => {
    const order: string[] = []
    h.getAllowance.mockImplementation(async () => {
      order.push('allowance')
      return 0n
    })
    h.approveAllowance.mockImplementation(async () => {
      order.push('approve')
      return '0xapprove'
    })
    h.unwrap.mockImplementation(async (...args: unknown[]) => {
      order.push('unwrap')
      const submitted = args[4] as (hash: string) => void
      submitted('0xtx')
      return {hash: '0xtx', provisionalLogIndex: 0, eventMatched: true}
    })
    h.trackUnwrap.mockResolvedValue(undefined)
    const {useUnwrap} = await import('./useUnwrap')

    await useUnwrap().unwrap(
      '0xToken0000000000000000000000000000000001' as `0x${string}`,
      1n,
      'z1q',
      '0xBridge00000000000000000000000000000000' as `0x${string}`,
      'zts1znn',
      8,
      'ZNN', '0xFrom000000000000000000000000000000000009'
    )

    expect(order).toEqual(['allowance', 'approve', 'unwrap'])
    expect(h.trackUnwrap).toHaveBeenCalledWith(expect.objectContaining({approvalCount: 3}))
  })

  it('does not submit unwrap when token approval is rejected', async () => {
    h.getAllowance.mockResolvedValue(0n)
    h.approveAllowance.mockRejectedValue(new Error('Request rejected in MetaMask'))
    const {useUnwrap} = await import('./useUnwrap')

    await expect(useUnwrap().unwrap(
      '0xToken0000000000000000000000000000000001' as `0x${string}`,
      1n,
      'z1q',
      '0xBridge00000000000000000000000000000000' as `0x${string}`,
      'zts1znn',
      8,
      'ZNN', '0xFrom000000000000000000000000000000000009'
    )).rejects.toThrow('Request rejected in MetaMask')

    expect(h.unwrap).not.toHaveBeenCalled()
    expect(useUnwrap().phase.value).toMatchObject({kind: 'failed', stage: 'token-approval'})
    useUnwrap().resetPhase()
    expect(useUnwrap().phase.value).toEqual({kind: 'idle'})
    expect(useUnwrap().error.value).toBeNull()
  })

  it('does not expose retry when receipt confirmation fails after broadcast', async () => {
    h.getAllowance.mockResolvedValue(500n)
    h.trackUnwrap.mockResolvedValue(undefined)
    h.unwrap.mockImplementation(async (...args: unknown[]) => {
      const submitted = args[4] as (hash: string) => void
      submitted('0xbroadcast')
      throw new Error('RPC connection dropped')
    })
    const {useUnwrap} = await import('./useUnwrap')

    await expect(useUnwrap().unwrap(
      '0xToken0000000000000000000000000000000001' as `0x${string}`,
      1n,
      'z1q',
      '0xBridge00000000000000000000000000000000' as `0x${string}`,
      'zts1znn',
      8,
      'ZNN', '0xFrom000000000000000000000000000000000009'
    )).resolves.toEqual({kind: 'submitted-unconfirmed', hash: '0xbroadcast', trackingFailed: false})
    expect(useUnwrap().phase.value).toMatchObject({
      kind: 'submitted-unconfirmed',
      hash: '0xbroadcast',
    })
  })

  it('reports tracking failure without failing a confirmed bridge transfer', async () => {
    h.getAllowance.mockResolvedValue(500n)
    h.trackUnwrap.mockRejectedValue(new Error('quota exceeded'))
    h.unwrap.mockImplementation(async (...args: unknown[]) => {
      const submitted = args[4] as (hash: string) => void
      submitted('0xconfirmed')
      return {hash: '0xconfirmed', provisionalLogIndex: 7, eventMatched: true}
    })
    const {useUnwrap} = await import('./useUnwrap')

    const result = await useUnwrap().unwrap(
      '0xToken0000000000000000000000000000000001' as `0x${string}`,
      1n,
      'z1q',
      '0xBridge00000000000000000000000000000000' as `0x${string}`,
      'zts1znn',
      8,
      'ZNN', '0xFrom000000000000000000000000000000000009'
    )

    expect(result).toMatchObject({kind: 'confirmed', hash: '0xconfirmed', trackingFailed: true})
    expect(useUnwrap().phase.value).toMatchObject({kind: 'submitted-untracked'})
  })

  it('removes provisional tracking and allows retry after a definitive revert', async () => {
    h.getAllowance.mockResolvedValue(500n)
    h.trackUnwrap.mockResolvedValue(undefined)
    h.prune.mockImplementation(async (predicate: (request: {kind: string; id: string}) => boolean) => {
      expect(predicate({kind: 'unwrap', id: '0xreverted:-1'})).toBe(true)
    })
    const {EvmSubmissionError} = await import('../evm-service')
    h.unwrap.mockImplementation(async (...args: unknown[]) => {
      const submitted = args[4] as (hash: string) => void
      submitted('0xreverted')
      throw new EvmSubmissionError('reverted', '0xreverted', 'Unwrap transaction reverted')
    })
    const {useUnwrap} = await import('./useUnwrap')

    await expect(useUnwrap().unwrap(
      '0xToken0000000000000000000000000000000001' as `0x${string}`,
      1n,
      'z1q',
      '0xBridge00000000000000000000000000000000' as `0x${string}`,
      'zts1znn',
      8,
      'ZNN', '0xFrom000000000000000000000000000000000009'
    )).rejects.toThrow('Unwrap transaction reverted')
    expect(h.prune).toHaveBeenCalled()
    expect(useUnwrap().phase.value).toMatchObject({kind: 'failed', stage: 'bridge-transfer'})
  })
})

describe('useUnwrap.unwrap cross-context exclusion', () => {
  const token = '0xToken0000000000000000000000000000000001' as `0x${string}`
  const bridgeAddress = '0xBridge00000000000000000000000000000000' as `0x${string}`
  const evmFrom = '0xFrom000000000000000000000000000000000009'

  it('submits under a NON-QUEUING account-scoped exclusive lock', async () => {
    h.getAllowance.mockResolvedValue(500n)
    h.trackUnwrap.mockResolvedValue(undefined)
    h.unwrap.mockImplementation(async (...args: unknown[]) => {
      const submitted = args[4] as (hash: string) => void
      submitted('0xtx')
      return {hash: '0xtx', provisionalLogIndex: 0, eventMatched: true}
    })
    const {useUnwrap} = await import('./useUnwrap')

    await useUnwrap().unwrap(token, 1n, 'z1q', bridgeAddress, 'zts1znn', 8, 'ZNN', evmFrom)

    expect(h.withExclusiveSourceLock).toHaveBeenCalledWith(
      `unwrap-submit:${evmFrom.toLowerCase()}`,
      expect.any(Function),
    )
  })

  it('surfaces an occupied source lock as a failure without opening the wallet', async () => {
    h.withExclusiveSourceLock.mockRejectedValue(
      new Error('A submission for this account is already in progress in another tab or window'),
    )
    const {useUnwrap} = await import('./useUnwrap')

    await expect(
      useUnwrap().unwrap(token, 1n, 'z1q', bridgeAddress, 'zts1znn', 8, 'ZNN', evmFrom),
    ).rejects.toThrow('another tab')
    expect(h.unwrap).not.toHaveBeenCalled()
    expect(useUnwrap().isUnwrapping.value).toBe(false)
  })

  it('refuses a queued submission when an unwrap was recorded after this click', async () => {
    h.getSnapshot.mockResolvedValue({
      zenonRedeems: {},
      requests: [{kind: 'unwrap', id: '0xfresh:-1', createdAt: Date.now() + 60_000}],
    })
    const {useUnwrap} = await import('./useUnwrap')

    await expect(
      useUnwrap().unwrap(token, 1n, 'z1q', bridgeAddress, 'zts1znn', 8, 'ZNN', evmFrom),
    ).rejects.toThrow('another context')
    expect(h.unwrap).not.toHaveBeenCalled()
  })
})

describe('useUnwrap.unwrap reentrancy', () => {
  it('synchronously refuses a second unwrap while one is in flight', async () => {
    let finishAllowance: (value: bigint) => void = () => undefined
    h.getAllowance.mockReturnValue(new Promise<bigint>(resolve => {
      finishAllowance = resolve
    }))
    h.trackUnwrap.mockResolvedValue(undefined)
    h.unwrap.mockImplementation(async (...args: unknown[]) => {
      const submitted = args[4] as (hash: string) => void
      submitted('0xtx')
      return {hash: '0xtx', provisionalLogIndex: 0, eventMatched: true}
    })
    const {useUnwrap} = await import('./useUnwrap')
    const token = '0xToken0000000000000000000000000000000001' as `0x${string}`
    const bridgeAddress = '0xBridge00000000000000000000000000000000' as `0x${string}`

    const first = useUnwrap().unwrap(token, 1n, 'z1q', bridgeAddress, 'zts1znn', 8, 'ZNN', '0xFrom000000000000000000000000000000000009')
    await expect(
      useUnwrap().unwrap(token, 1n, 'z1q', bridgeAddress, 'zts1znn', 8, 'ZNN', '0xFrom000000000000000000000000000000000009'),
    ).rejects.toThrow('already in progress')
    finishAllowance(500n)
    await expect(first).resolves.toMatchObject({kind: 'confirmed'})
    expect(h.unwrap).toHaveBeenCalledTimes(1)
  })
})

describe('useUnwrap.recheckZenonRedeem', () => {
  const transactionHash = `0x${'aa'.repeat(32)}`
  const view = {
    id: `${transactionHash}:4`,
    transactionHash,
    logIndex: 4,
    zts: 'zts1znn',
    amount: 100n,
    decimals: 8,
    symbol: 'ZNN',
    toAddress: 'z1qrecipient',
    status: 'redeemable' as const,
  }

  it('releases the lock when the published block processed but the request is still redeemable', async () => {
    // The receive block exists (the embedded call ran) yet the node still
    // reports the request redeemable — the redeem failed on-chain.
    h.getSnapshot.mockResolvedValue({
      requests: [],
      zenonRedeems: {[transactionHash]: {hash: 'zenonblockhash', updatedAt: 1}},
    })
    h.getAccountBlockOutcome.mockResolvedValue('processed')
    h.getUnwrapRequest.mockResolvedValue({redeemed: 0, revoked: 0})
    const {useUnwrap} = await import('./useUnwrap')

    await expect(useUnwrap().recheckZenonRedeem(view)).resolves.toBe('released-failed')
    expect(h.getAccountBlockOutcome).toHaveBeenCalledWith('zenonblockhash')
    expect(h.clearPendingZenonRedeem).toHaveBeenCalled()
  })

  it('keeps the lock while the block is pending or the redeem already took effect', async () => {
    h.getSnapshot.mockResolvedValue({
      requests: [],
      zenonRedeems: {[transactionHash]: {hash: 'zenonblockhash', updatedAt: 1}},
    })
    h.getAccountBlockOutcome.mockResolvedValue('pending')
    const {useUnwrap} = await import('./useUnwrap')
    await expect(useUnwrap().recheckZenonRedeem(view)).resolves.toBe('kept')

    h.getAccountBlockOutcome.mockResolvedValue('processed')
    h.getUnwrapRequest.mockResolvedValue({redeemed: 1, revoked: 0})
    await expect(useUnwrap().recheckZenonRedeem(view)).resolves.toBe('kept')
    expect(h.clearPendingZenonRedeem).not.toHaveBeenCalled()
  })

  it('releases a stale orphaned placeholder and keeps a fresh or ambiguous one', async () => {
    const {PLACEHOLDER_LOCK_STALE_MS} = await import('../approval-ux')
    h.getSnapshot.mockResolvedValue({
      requests: [],
      zenonRedeems: {
        [transactionHash]: {
          hash: 'awaiting-wallet-result',
          updatedAt: Date.now() - PLACEHOLDER_LOCK_STALE_MS - 1,
        },
      },
    })
    const {useUnwrap} = await import('./useUnwrap')
    await expect(useUnwrap().recheckZenonRedeem(view)).resolves.toBe('released-orphan')
    expect(h.clearPendingZenonRedeem).toHaveBeenCalledTimes(1)

    h.getSnapshot.mockResolvedValue({
      requests: [],
      zenonRedeems: {[transactionHash]: {hash: 'ambiguous-wallet-result', updatedAt: 1}},
    })
    await expect(useUnwrap().recheckZenonRedeem(view)).resolves.toBe('kept')
    expect(h.clearPendingZenonRedeem).toHaveBeenCalledTimes(1)
  })

  it('never reclaims an orphaned placeholder without real cross-context exclusion', async () => {
    const {PLACEHOLDER_LOCK_STALE_MS} = await import('../approval-ux')
    h.hasCrossContextLocks.mockReturnValue(false)
    h.getSnapshot.mockResolvedValue({
      requests: [],
      zenonRedeems: {
        [transactionHash]: {
          hash: 'awaiting-wallet-result',
          updatedAt: Date.now() - PLACEHOLDER_LOCK_STALE_MS - 1,
        },
      },
    })
    const {useUnwrap} = await import('./useUnwrap')

    await expect(useUnwrap().recheckZenonRedeem(view)).resolves.toBe('kept')
    await expect(useUnwrap().redeemZenon(view)).rejects.toThrow('already in progress')
    expect(h.clearPendingZenonRedeem).not.toHaveBeenCalled()
  })
})

describe('useUnwrap.redeemZenon', () => {
  it('builds the redeem block with the NODE logIndex then sends it', async () => {
    h.buildRedeemBlock.mockReturnValue({__block: true})
    h.send.mockResolvedValue({hash: {toString: () => 'zenonhash'}})
    const {useUnwrap} = await import('./useUnwrap')

    const transactionHash = `0x${'ab'.repeat(32)}`
    const view = {
      id: `${transactionHash}:9`,
      transactionHash,
      logIndex: 9,
      zts: 'zts1znn',
      amount: 100n,
      decimals: 8,
      symbol: 'ZNN',
      toAddress: 'z1qrecipient',
      status: 'redeemable' as const,
    }

    await expect(useUnwrap().redeemZenon(view)).resolves.toBe('zenonhash')

    expect(h.buildRedeemBlock).toHaveBeenCalledWith('ab'.repeat(32), 9)
    expect(h.send).toHaveBeenCalledWith({__block: true})
    expect(h.setPendingZenonRedeem).toHaveBeenCalledWith(view.id, 'zenonhash')
    expect(useUnwrap().pendingRedeems.value[view.id]).toBe('confirming')
    await expect(useUnwrap().redeemZenon(view)).rejects.toThrow('already in progress')
  })

  it('keeps the durable and local locks after an ambiguous znn_send timeout', async () => {
    h.buildRedeemBlock.mockReturnValue({__block: true})
    const {ZenonSubmissionError} = await import('../zenon-wallet-service')
    h.send.mockRejectedValue(new ZenonSubmissionError('ambiguous', 'result unavailable'))
    const {useUnwrap} = await import('./useUnwrap')
    const transactionHash = `0x${'cd'.repeat(32)}`
    const view = {
      id: `${transactionHash}:4`,
      transactionHash,
      logIndex: 4,
      zts: 'zts1znn',
      amount: 100n,
      decimals: 8,
      symbol: 'ZNN',
      toAddress: 'z1qrecipient',
      status: 'redeemable' as const,
    }

    await expect(useUnwrap().redeemZenon(view)).rejects.toMatchObject({kind: 'ambiguous'})
    expect(h.setPendingZenonRedeem).toHaveBeenCalledWith(view.id, 'awaiting-wallet-result')
    expect(h.clearPendingZenonRedeem).not.toHaveBeenCalled()
    expect(useUnwrap().pendingRedeems.value[view.id]).toBe('confirming')
    // The durable lock is upgraded from the reclaimable pre-prompt placeholder
    // to the never-reclaimed ambiguous marker: Syrius may still broadcast.
    expect(h.setPendingZenonRedeem).toHaveBeenLastCalledWith(view.id, 'ambiguous-wallet-result')
  })

  it('reclaims only a stale orphaned placeholder, never a fresh or ambiguous lock', async () => {
    // Syrius runs outside the browser: its prompt can outlive a crashed dApp
    // context, so an orphaned placeholder is reclaimable only after the
    // staleness window has passed.
    const {PLACEHOLDER_LOCK_STALE_MS} = await import('../approval-ux')
    h.buildRedeemBlock.mockReturnValue({__block: true})
    h.send.mockResolvedValue({hash: {toString: () => 'zenonhash'}})
    const transactionHash = `0x${'dd'.repeat(32)}`
    const view = {
      id: `${transactionHash}:5`,
      transactionHash,
      logIndex: 5,
      zts: 'zts1znn',
      amount: 100n,
      decimals: 8,
      symbol: 'ZNN',
      toAddress: 'z1qrecipient',
      status: 'redeemable' as const,
    }

    const {useUnwrap} = await import('./useUnwrap')
    // Fresh placeholder → refuse.
    h.getSnapshot.mockResolvedValue({
      zenonRedeems: {[transactionHash]: {hash: 'awaiting-wallet-result', updatedAt: Date.now()}},
    })
    await expect(useUnwrap().redeemZenon(view)).rejects.toThrow('already in progress')
    // Ambiguous marker → refuse regardless of age.
    h.getSnapshot.mockResolvedValue({
      zenonRedeems: {[transactionHash]: {hash: 'ambiguous-wallet-result', updatedAt: 1}},
    })
    await expect(useUnwrap().redeemZenon(view)).rejects.toThrow('already in progress')
    expect(h.send).not.toHaveBeenCalled()
    // Stale orphaned placeholder → reclaim.
    h.getSnapshot.mockResolvedValue({
      zenonRedeems: {
        [transactionHash]: {
          hash: 'awaiting-wallet-result',
          updatedAt: Date.now() - PLACEHOLDER_LOCK_STALE_MS - 1,
        },
      },
    })
    await expect(useUnwrap().redeemZenon(view)).resolves.toBe('zenonhash')
  })

  it('falls back to the ambiguous marker when persisting the published block hash fails', async () => {
    // The block IS published. Leaving the durable lock as the reclaimable
    // pre-prompt placeholder would let a new flow overwrite it after reload +
    // staleness, resubmitting a live redemption.
    h.buildRedeemBlock.mockReturnValue({__block: true})
    h.send.mockResolvedValue({hash: {toString: () => 'zenonhash'}})
    h.setPendingZenonRedeem.mockReset()
      .mockResolvedValueOnce(true) // pre-prompt placeholder
      .mockRejectedValueOnce(new Error('storage quota exceeded')) // real hash
      .mockResolvedValue(true) // ambiguous fallback
    const {useUnwrap} = await import('./useUnwrap')
    const transactionHash = `0x${'ee'.repeat(32)}`
    const view = {
      id: `${transactionHash}:2`,
      transactionHash,
      logIndex: 2,
      zts: 'zts1znn',
      amount: 100n,
      decimals: 8,
      symbol: 'ZNN',
      toAddress: 'z1qrecipient',
      status: 'redeemable' as const,
    }

    await expect(useUnwrap().redeemZenon(view)).resolves.toBe('zenonhash')
    expect(useUnwrap().pendingRedeems.value[view.id]).toBe('confirming')
    expect(h.setPendingZenonRedeem).toHaveBeenLastCalledWith(view.id, 'ambiguous-wallet-result')
  })

  it('locks the redemption locally before waiting on another context\'s cross-context lock', async () => {
    h.buildRedeemBlock.mockReturnValue({__block: true})
    h.send.mockResolvedValue({hash: {toString: () => 'zenonhash'}})
    let releaseLock: () => void = () => undefined
    h.withCrossContextLock.mockImplementation(async (_key: string, action: () => Promise<unknown>) => {
      await new Promise<void>(resolve => {
        releaseLock = resolve
      })
      return action()
    })
    const {useUnwrap} = await import('./useUnwrap')
    const transactionHash = `0x${'aa'.repeat(32)}`
    const view = {
      id: `${transactionHash}:1`,
      transactionHash,
      logIndex: 1,
      zts: 'zts1znn',
      amount: 100n,
      decimals: 8,
      symbol: 'ZNN',
      toAddress: 'z1qrecipient',
      status: 'redeemable' as const,
    }

    const first = useUnwrap().redeemZenon(view)
    // Feedback exists while blocked on the Web Lock, and a second click must
    // refuse instead of queuing a duplicate Syrius prompt behind the lock.
    expect(useUnwrap().pendingRedeems.value[view.id]).toBeTruthy()
    await expect(useUnwrap().redeemZenon(view)).rejects.toThrow('already in progress')
    releaseLock()
    await expect(first).resolves.toBe('zenonhash')
    expect(h.send).toHaveBeenCalledTimes(1)
  })

  it('clears the local marker when the flow fails before any wallet prompt', async () => {
    const transactionHash = `0x${'bb'.repeat(32)}`
    h.getSnapshot.mockResolvedValue({
      zenonRedeems: {[transactionHash]: {hash: 'other-tab'}},
    })
    const {useUnwrap} = await import('./useUnwrap')
    const view = {
      id: `${transactionHash}:3`,
      transactionHash,
      logIndex: 3,
      zts: 'zts1znn',
      amount: 100n,
      decimals: 8,
      symbol: 'ZNN',
      toAddress: 'z1qrecipient',
      status: 'redeemable' as const,
    }

    await expect(useUnwrap().redeemZenon(view)).rejects.toThrow('already in progress')
    expect(useUnwrap().pendingRedeems.value[view.id]).toBeUndefined()
  })

  it('refuses a Zenon redemption when another context already persisted its lock', async () => {
    const transactionHash = `0x${'ef'.repeat(32)}`
    h.getSnapshot.mockResolvedValue({
      zenonRedeems: {[transactionHash]: {hash: 'other-tab'}},
    })
    const {useUnwrap} = await import('./useUnwrap')
    const view = {
      id: `${transactionHash}:2`,
      transactionHash,
      logIndex: 2,
      zts: 'zts1znn',
      amount: 100n,
      decimals: 8,
      symbol: 'ZNN',
      toAddress: 'z1qrecipient',
      status: 'redeemable' as const,
    }

    await expect(useUnwrap().redeemZenon(view)).rejects.toThrow('already in progress')
    expect(h.send).not.toHaveBeenCalled()
    expect(h.clearPendingZenonRedeem).not.toHaveBeenCalled()
  })
})
