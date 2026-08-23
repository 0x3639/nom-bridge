import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// Partial-mock viem: keep the real parseAbi / UserRejectedRequestError / custom /
// http (so CHAIN selection and mapEvmError's instanceof check stay genuine), but
// swap the client factories for fakes we can drive.
const h = vi.hoisted(() => ({
  publicClient: {
    readContract: vi.fn(),
    getBlockNumber: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
    simulateContract: vi.fn(),
    getTransactionReceipt: vi.fn(),
    getTransaction: vi.fn(),
    getTransactionCount: vi.fn(),
    getLogs: vi.fn(),
  },
  walletClient: {
    requestAddresses: vi.fn(),
    switchChain: vi.fn(),
    writeContract: vi.fn(),
    getChainId: vi.fn(),
  },
}))

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>()
  return {
    ...actual,
    http: vi.fn(actual.http),
    fallback: vi.fn(actual.fallback),
    createPublicClient: vi.fn(() => h.publicClient),
    createWalletClient: vi.fn(() => h.walletClient),
  }
})

beforeEach(() => {
  vi.resetModules()
  h.publicClient.readContract.mockReset()
  h.publicClient.getBlockNumber.mockReset()
  h.publicClient.waitForTransactionReceipt.mockReset()
  h.publicClient.simulateContract.mockReset().mockResolvedValue({request: {}})
  h.publicClient.getTransactionReceipt.mockReset()
  h.publicClient.getTransaction.mockReset()
  h.publicClient.getTransactionCount.mockReset()
  h.publicClient.getLogs.mockReset()
  h.walletClient.requestAddresses.mockReset()
  h.walletClient.switchChain.mockReset()
  h.walletClient.writeContract.mockReset()
  h.walletClient.getChainId.mockReset().mockResolvedValue(1)
  // A present, minimal EIP-1193 provider for the wallet path.
  vi.stubGlobal('window', {ethereum: {request: vi.fn()}})
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('EvmService RPC transports', () => {
  it('never sleeps on a rate-limited RPC: per-RPC transports use retryCount 0 and a bounded timeout', async () => {
    const viem = await import('viem')
    const {config} = await import('@/config')
    const {EvmService} = await import('./evm-service')
    EvmService.getInstance()

    // A 429 with `Retry-After: 270` would otherwise make viem sleep 270 s per
    // retry inside the quorum Promise.all, stalling every Requests poll.
    for (const url of config.evmRpcUrls) {
      expect(viem.http).toHaveBeenCalledWith(url, expect.objectContaining({retryCount: 0}))
      const calls = vi.mocked(viem.http).mock.calls.filter(([u]) => u === url)
      for (const [, opts] of calls) {
        expect(opts?.timeout).toBe(15_000)
      }
    }
    expect(viem.fallback).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({retryCount: 0}))
  })
})

describe('EvmService singleton', () => {
  it('getInstance returns the same instance', async () => {
    const {EvmService} = await import('./evm-service')
    expect(EvmService.getInstance()).toBe(EvmService.getInstance())
  })
})

describe('EvmService.connect', () => {
  it('returns the first account after requesting addresses and switching chain', async () => {
    h.walletClient.requestAddresses.mockResolvedValue(['0xAbC0000000000000000000000000000000000001'])
    h.walletClient.switchChain.mockResolvedValue(undefined)
    const {EvmService, CHAIN} = await import('./evm-service')

    const account = await EvmService.getInstance().connect()

    expect(account).toBe('0xAbC0000000000000000000000000000000000001')
    expect(h.walletClient.switchChain).toHaveBeenCalledWith({id: CHAIN.id})
  })

  it('throws a friendly "switch network" error when switchChain fails', async () => {
    h.walletClient.requestAddresses.mockResolvedValue(['0xabc'])
    h.walletClient.switchChain.mockRejectedValue(new Error('chain not added'))
    const {EvmService, CHAIN} = await import('./evm-service')

    await expect(EvmService.getInstance().connect()).rejects.toThrow(
      `Please switch MetaMask to ${CHAIN.name}`,
    )
  })

  it('throws "no wallet" when window.ethereum is absent', async () => {
    vi.stubGlobal('window', {})
    const {EvmService} = await import('./evm-service')

    await expect(EvmService.getInstance().connect()).rejects.toThrow(
      'No EVM wallet detected. Please install MetaMask.',
    )
  })
})

describe('EvmService.getBalance', () => {
  it('reads balanceOf(owner) on the token contract and returns the bigint', async () => {
    h.publicClient.readContract.mockResolvedValue(123456789n)
    const {EvmService} = await import('./evm-service')

    const token = '0xToken0000000000000000000000000000000001'
    const owner = '0xOwner0000000000000000000000000000000002'
    const balance = await EvmService.getInstance().getBalance(token, owner)

    expect(balance).toBe(123456789n)
    expect(h.publicClient.readContract).toHaveBeenCalledWith(
      expect.objectContaining({address: token, functionName: 'balanceOf', args: [owner]}),
    )
  })
})

describe('EvmService.getTransactionOutcome', () => {
  const hash = `0x${'ab'.repeat(32)}` as const

  it('classifies successful and reverted receipts authoritatively', async () => {
    const {EvmService} = await import('./evm-service')
    h.publicClient.getTransactionReceipt.mockResolvedValueOnce({status: 'success'})
    await expect(EvmService.getInstance().getTransactionOutcome(hash)).resolves.toBe('success')
    h.publicClient.getTransactionReceipt.mockResolvedValueOnce({status: 'reverted'})
    await expect(EvmService.getInstance().getTransactionOutcome(hash)).resolves.toBe('reverted')
  })

  it('distinguishes a pending transaction from one not found', async () => {
    const {EvmService} = await import('./evm-service')
    const {TransactionNotFoundError, TransactionReceiptNotFoundError} = await import('viem')
    h.publicClient.getTransactionReceipt.mockRejectedValue(new TransactionReceiptNotFoundError({hash}))
    h.publicClient.getTransaction.mockResolvedValueOnce({hash})
    await expect(EvmService.getInstance().getTransactionOutcome(hash)).resolves.toBe('pending')
    h.publicClient.getTransaction.mockRejectedValueOnce(new TransactionNotFoundError({hash}))
    await expect(EvmService.getInstance().getTransactionOutcome(hash)).resolves.toBe('not-found')
  })
})

describe('collapseAuthoritativeOutcomes', () => {
  it('never treats negative RPC evidence as proof of failure', async () => {
    const {collapseAuthoritativeOutcomes} = await import('./evm-service')
    expect(collapseAuthoritativeOutcomes(['not-found', 'pending', 'unavailable'])).toBe('unknown')
  })

  it('accepts a success receipt from any configured RPC as authoritative', async () => {
    const {collapseAuthoritativeOutcomes} = await import('./evm-service')
    expect(collapseAuthoritativeOutcomes(['not-found', 'success', 'unavailable'])).toBe('confirmed')
  })

  it('fails closed if RPCs return conflicting receipts', async () => {
    const {collapseAuthoritativeOutcomes} = await import('./evm-service')
    expect(collapseAuthoritativeOutcomes(['success', 'reverted'])).toBe('unknown')
  })

  it('does not let a single RPC fabricate a revert while others disagree', async () => {
    const {collapseAuthoritativeOutcomes} = await import('./evm-service')
    // One node serving a reverted receipt from an orphaned block must not beat
    // peers that still see the transaction live or unknown.
    expect(collapseAuthoritativeOutcomes(['reverted', 'pending', 'not-found'])).toBe('unknown')
    expect(collapseAuthoritativeOutcomes(['reverted', 'not-found', 'not-found'])).toBe('unknown')
    expect(collapseAuthoritativeOutcomes(['reverted', 'unavailable'])).toBe('unknown')
  })

  it('accepts a revert only as the consensus of responsive RPCs', async () => {
    const {collapseAuthoritativeOutcomes} = await import('./evm-service')
    expect(collapseAuthoritativeOutcomes(['reverted', 'reverted'])).toBe('reverted')
    expect(collapseAuthoritativeOutcomes(['reverted', 'reverted', 'unavailable'])).toBe('reverted')
    // A single-RPC deployment has no peer to corroborate with.
    expect(collapseAuthoritativeOutcomes(['reverted'])).toBe('reverted')
  })

  it('reports universal not-found as absent, never as reverted or unknown', async () => {
    const {collapseAuthoritativeOutcomes} = await import('./evm-service')
    expect(collapseAuthoritativeOutcomes(['not-found', 'not-found'])).toBe('absent')
    expect(collapseAuthoritativeOutcomes(['not-found'])).toBe('absent')
  })

  it('does not report absent unless every RPC answered not-found', async () => {
    const {collapseAuthoritativeOutcomes} = await import('./evm-service')
    expect(collapseAuthoritativeOutcomes(['not-found', 'unavailable'])).toBe('unknown')
    expect(collapseAuthoritativeOutcomes(['not-found', 'pending'])).toBe('unknown')
    expect(collapseAuthoritativeOutcomes([])).toBe('unknown')
  })
})

describe('dropped-transaction evidence', () => {
  it('treats a nonce as consumed only when the confirmed count has passed it', async () => {
    // getTransactionCount('latest') is the next unused nonce, so count > nonce
    // means the nonce was consumed on-chain — by this tx (then it would not be
    // absent) or by a replacement. Absence alone is never proof of death.
    const {isNonceConsumed} = await import('./evm-service')
    expect(isNonceConsumed(7, 8)).toBe(true)
    expect(isNonceConsumed(7, 7)).toBe(false)
    expect(isNonceConsumed(7, 6)).toBe(false)
  })

  it('accepts sender/nonce facts only when corroborated by a second RPC', async () => {
    const {corroborateTxFacts} = await import('./evm-service')
    // Two RPCs agreeing on identical facts → corroborated.
    expect(corroborateTxFacts(
      [{from: '0xA', nonce: 7}, {from: '0xA', nonce: 7}, {}],
      3,
    )).toEqual({from: '0xA', nonce: 7})
    // A single RPC's claim — or disagreeing RPCs — is not release evidence.
    expect(corroborateTxFacts([{from: '0xA', nonce: 7}, {}, {}], 3)).toBeUndefined()
    expect(corroborateTxFacts([{from: '0xA', nonce: 7}, {from: '0xB', nonce: 7}], 2)).toBeUndefined()
    // A single-RPC deployment has no peer to corroborate with.
    expect(corroborateTxFacts([{from: '0xA', nonce: 7}], 1)).toEqual({from: '0xA', nonce: 7})
  })

  it('accepts a redeem state as release evidence only on unanimous responsive quorum', async () => {
    const {collapseRedeemStates} = await import('./evm-service')
    expect(collapseRedeemStates(['unredeemed', 'unredeemed', null], 3)).toBe('unredeemed')
    expect(collapseRedeemStates(['partial', 'partial'], 2)).toBe('partial')
    // Disagreement or a lone answer in a multi-RPC config is not evidence: a
    // single stale RPC must not authorize releasing a claim lock.
    expect(collapseRedeemStates(['unredeemed', 'partial'], 2)).toBeNull()
    expect(collapseRedeemStates(['unredeemed', null, null], 3)).toBeNull()
    expect(collapseRedeemStates([null, null], 2)).toBeNull()
    // Single-RPC deployment: its answer stands.
    expect(collapseRedeemStates(['fully-redeemed'], 1)).toBe('fully-redeemed')
  })

  it('maps corroborated redeem states to per-stage advancement and unclaimed evidence', async () => {
    const {isRedeemStateAdvancedForStage, isRedeemStateUnclaimedForStage} = await import('./evm-service')
    // Stage 1 advanced once ANY claim landed; stage 2 only when fully redeemed.
    expect(isRedeemStateAdvancedForStage(1, 'partial')).toBe(true)
    expect(isRedeemStateAdvancedForStage(1, 'fully-redeemed')).toBe(true)
    expect(isRedeemStateAdvancedForStage(1, 'unredeemed')).toBe(false)
    expect(isRedeemStateAdvancedForStage(2, 'fully-redeemed')).toBe(true)
    expect(isRedeemStateAdvancedForStage(2, 'partial')).toBe(false)
    expect(isRedeemStateAdvancedForStage(1, null)).toBe(false)
    // Unclaimed: the stage's own claim provably never landed.
    expect(isRedeemStateUnclaimedForStage(1, 'unredeemed')).toBe(true)
    expect(isRedeemStateUnclaimedForStage(1, 'partial')).toBe(false)
    expect(isRedeemStateUnclaimedForStage(2, 'partial')).toBe(true)
    expect(isRedeemStateUnclaimedForStage(2, 'fully-redeemed')).toBe(false)
    expect(isRedeemStateUnclaimedForStage(2, null)).toBe(false)
  })

  it('takes the MINIMUM confirmed count across at least two responsive RPCs', async () => {
    const {collapseConfirmedCounts} = await import('./evm-service')
    // Minimum defeats a single RPC inflating the count to force a release; a
    // lagging honest RPC only fails closed.
    expect(collapseConfirmedCounts([9, 8, null], 3)).toBe(8)
    // Fewer than two responsive RPCs (multi-RPC config) → no evidence.
    expect(collapseConfirmedCounts([9, null, null], 3)).toBeNull()
    expect(collapseConfirmedCounts([null, null], 2)).toBeNull()
    // Single-RPC deployment: its answer stands.
    expect(collapseConfirmedCounts([9], 1)).toBe(9)
    expect(collapseConfirmedCounts([null], 1)).toBeNull()
  })
})

describe('EvmService receipt-path revert quorum', () => {
  const account = '0xAbC0000000000000000000000000000000000001'

  function armUnwrapFlow() {
    h.walletClient.requestAddresses.mockResolvedValue([account])
    h.publicClient.simulateContract.mockResolvedValue({request: {}})
    h.walletClient.writeContract.mockResolvedValue(`0x${'aa'.repeat(32)}`)
    h.publicClient.waitForTransactionReceipt.mockResolvedValue({status: 'reverted', logs: []})
  }

  it('classifies a receipt revert as reverted only when the RPC quorum corroborates it', async () => {
    armUnwrapFlow()
    // Every outcome client sees the reverted receipt → consensus revert.
    h.publicClient.getTransactionReceipt.mockResolvedValue({status: 'reverted'})
    const {EvmService} = await import('./evm-service')

    await expect(EvmService.getInstance().unwrap(
      '0xB000000000000000000000000000000000000002',
      '0xC000000000000000000000000000000000000003',
      1n,
      'z1qrecipient',
    )).rejects.toMatchObject({name: 'EvmSubmissionError', kind: 'reverted'})
  })

  it('downgrades an uncorroborated receipt revert to confirmation-unknown', async () => {
    // The fallback transport's first responder said reverted, but the quorum
    // still sees the transaction pending — a stale/forked RPC must not be able
    // to release safety locks and authorize a retry.
    armUnwrapFlow()
    const {TransactionReceiptNotFoundError} = await import('viem')
    h.publicClient.getTransactionReceipt.mockRejectedValue(
      new TransactionReceiptNotFoundError({hash: `0x${'aa'.repeat(32)}`}),
    )
    h.publicClient.getTransaction.mockResolvedValue({from: account, nonce: 1})
    const {EvmService} = await import('./evm-service')

    await expect(EvmService.getInstance().unwrap(
      '0xB000000000000000000000000000000000000002',
      '0xC000000000000000000000000000000000000003',
      1n,
      'z1qrecipient',
    )).rejects.toMatchObject({name: 'EvmSubmissionError', kind: 'confirmation-unknown'})
  })
})

describe('EvmService.findUnwrappedEvents', () => {
  it('unions events across RPCs and reports how many responded', async () => {
    h.publicClient.getLogs.mockResolvedValue([
      {
        transactionHash: `0x${'ab'.repeat(32)}`,
        logIndex: 3,
        args: {from: '0xSender', token: '0xToken', to: 'z1qrecipient', amount: 100n},
      },
    ])
    const {EvmService} = await import('./evm-service')
    const {config} = await import('@/config')

    const result = await EvmService.getInstance().findUnwrappedEvents(
      '0xB000000000000000000000000000000000000002',
      '0xSender' as never,
      1n,
    )
    expect(result.responsiveClients).toBe(config.evmRpcUrls.length)
    expect(result.events).toEqual([
      {
        transactionHash: `0x${'ab'.repeat(32)}`,
        logIndex: 3,
        token: '0xToken',
        to: 'z1qrecipient',
        amount: 100n,
      },
    ])
  })

  it('reports zero responsive clients when every RPC fails', async () => {
    h.publicClient.getLogs.mockRejectedValue(new Error('rpc down'))
    const {EvmService} = await import('./evm-service')

    const result = await EvmService.getInstance().findUnwrappedEvents(
      '0xB000000000000000000000000000000000000002',
      '0xSender' as never,
      1n,
    )
    expect(result).toEqual({events: [], responsiveClients: 0})
  })
})

describe('EvmService.getAuthoritativeOutcomeWithFacts', () => {
  const hash = `0x${'ad'.repeat(32)}` as const

  it('captures the sender and nonce while any RPC can still see the transaction', async () => {
    const {TransactionReceiptNotFoundError} = await import('viem')
    h.publicClient.getTransactionReceipt.mockRejectedValue(new TransactionReceiptNotFoundError({hash}))
    h.publicClient.getTransaction.mockResolvedValue({hash, from: '0xSender', nonce: 7})
    const {EvmService} = await import('./evm-service')

    await expect(EvmService.getInstance().getAuthoritativeOutcomeWithFacts(hash)).resolves.toEqual({
      outcome: 'unknown',
      from: '0xSender',
      nonce: 7,
    })
  })

  it('returns no facts when the transaction is nowhere to be seen', async () => {
    const {TransactionNotFoundError, TransactionReceiptNotFoundError} = await import('viem')
    h.publicClient.getTransactionReceipt.mockRejectedValue(new TransactionReceiptNotFoundError({hash}))
    h.publicClient.getTransaction.mockRejectedValue(new TransactionNotFoundError({hash}))
    const {EvmService} = await import('./evm-service')

    await expect(EvmService.getInstance().getAuthoritativeOutcomeWithFacts(hash)).resolves.toEqual({
      outcome: 'absent',
    })
  })
})

describe('EvmService.getAuthoritativeOutcome', () => {
  const hash = `0x${'ac'.repeat(32)}` as const

  it('consults every configured RPC and accepts a confirmed receipt', async () => {
    h.publicClient.getTransactionReceipt.mockResolvedValue({status: 'success'})
    const {EvmService} = await import('./evm-service')
    const {config} = await import('@/config')

    await expect(EvmService.getInstance().getAuthoritativeOutcome(hash)).resolves.toBe('confirmed')
    expect(h.publicClient.getTransactionReceipt).toHaveBeenCalledTimes(config.evmRpcUrls.length)
  })
})

describe('EvmService token and bridge metadata', () => {
  it('reads ERC-20 decimals and symbol', async () => {
    h.publicClient.readContract
      .mockResolvedValueOnce(18)
      .mockResolvedValueOnce('UNI-V2')
    const {EvmService} = await import('./evm-service')

    await expect(
      EvmService.getInstance().getTokenMetadata(
        '0xdac866a3796f85cb84a914d98faec052e3b5596d',
      ),
    ).resolves.toEqual({decimals: 18, symbol: 'UNI-V2'})
  })

  it('decodes all five deployed tokensInfo fields', async () => {
    h.publicClient.readContract.mockResolvedValue([100n, 90n, true, false, true])
    const {EvmService} = await import('./evm-service')

    await expect(
      EvmService.getInstance().getTokenInfo(
        '0xa98706106f7710d743186031be2245f33acea106',
        '0xdac866a3796f85cb84a914d98faec052e3b5596d',
      ),
    ).resolves.toEqual({
      minAmount: 100n,
      redeemDelay: 90,
      bridgeable: true,
      redeemable: false,
      owned: true,
    })
  })
})

describe('tssSignatureToHex', () => {
  it('converts a 65-byte base64 sig with final byte 0x00 → 0x…1b', async () => {
    const {tssSignatureToHex} = await import('./evm-service')
    const bytes = new Uint8Array(65)
    bytes.fill(0xab, 0, 64)
    bytes[64] = 0x00
    const b64 = Buffer.from(bytes).toString('base64')
    const hex = tssSignatureToHex(b64)
    expect(hex.startsWith('0x')).toBe(true)
    expect(hex.length).toBe(132)
    expect(hex.endsWith('1b')).toBe(true)
  })

  it('final byte 0x01 → 0x…1c (with 0x prefix and 132-char length)', async () => {
    const {tssSignatureToHex} = await import('./evm-service')
    const bytes = new Uint8Array(65)
    bytes[64] = 0x01
    const b64 = Buffer.from(bytes).toString('base64')
    const hex = tssSignatureToHex(b64)
    expect(hex.startsWith('0x')).toBe(true)
    expect(hex.length).toBe(132)
    expect(hex.endsWith('1c')).toBe(true)
  })

  it('matches a known exact-hex fixture (r/s preserved, v=0 → 0x1b)', async () => {
    const {tssSignatureToHex} = await import('./evm-service')
    // r = 0x01..(32 bytes), s = 0x02..(32 bytes), v byte = 0x00 → 0x1b
    const bytes = new Uint8Array(65)
    bytes.fill(0x01, 0, 32)
    bytes.fill(0x02, 32, 64)
    bytes[64] = 0x00
    const b64 = Buffer.from(bytes).toString('base64')
    const expected =
      '0x' + '01'.repeat(32) + '02'.repeat(32) + '1b'
    expect(tssSignatureToHex(b64)).toBe(expected)
  })

  it('rejects malformed length and recovery bytes', async () => {
    const {tssSignatureToHex} = await import('./evm-service')
    expect(() => tssSignatureToHex(Buffer.from(new Uint8Array(64)).toString('base64'))).toThrow(
      'signature length',
    )
    const bytes = new Uint8Array(65)
    bytes[64] = 2
    expect(() => tssSignatureToHex(Buffer.from(bytes).toString('base64'))).toThrow(
      'recovery byte',
    )
  })
})

describe('computeRemainingSeconds', () => {
  it('delay not elapsed → positive seconds including the +1 safety block', async () => {
    const {computeRemainingSeconds} = await import('./evm-service')
    // redeemDelay=10, elapsed=2 → remainingBlocks = 10-2+1 = 9; *3s = 27
    expect(computeRemainingSeconds(100n, 102n, 10, 3n)).toBe(27)
  })

  it('exactly at delay still has the +1 block remaining', async () => {
    const {computeRemainingSeconds} = await import('./evm-service')
    // elapsed=10 → 10-10+1 = 1; *3 = 3
    expect(computeRemainingSeconds(100n, 110n, 10, 3n)).toBe(3)
  })

  it('exactly at the zero-crossing (elapsed == delay+1) → 0', async () => {
    const {computeRemainingSeconds} = await import('./evm-service')
    // elapsed=11 → 10-11+1 = 0; *3 = 0 (the boundary where the +1 block is consumed)
    expect(computeRemainingSeconds(100n, 111n, 10, 3n)).toBe(0)
  })

  it('one block before the zero-crossing (elapsed == delay) → blockTime seconds', async () => {
    const {computeRemainingSeconds} = await import('./evm-service')
    // elapsed=10 → 10-10+1 = 1; *3 = 3 (last non-zero step before redeemable-2)
    expect(computeRemainingSeconds(100n, 110n, 10, 3n)).toBe(3)
  })

  it('elapsed past delay floors to 0 via max(0,…)', async () => {
    const {computeRemainingSeconds} = await import('./evm-service')
    // elapsed=20 → 10-20+1 = -9 → 0
    expect(computeRemainingSeconds(100n, 120n, 10, 3n)).toBe(0)
  })

  it('scales remaining blocks by estimatedBlockTime', async () => {
    const {computeRemainingSeconds} = await import('./evm-service')
    // remainingBlocks = 5-0+1 = 6; *12 = 72
    expect(computeRemainingSeconds(100n, 100n, 5, 12n)).toBe(72)
  })
})

describe('EvmService.getWrapRedeemProgress', () => {
  const bridge = '0xBridge00000000000000000000000000000000' as const
  const token = '0xToken000000000000000000000000000000001' as const
  const id = '0x00' as const

  it('UINT256_MAX blockNumber → fully-redeemed with a single read', async () => {
    const {EvmService, UINT256_MAX} = await import('./evm-service')
    h.publicClient.readContract.mockResolvedValueOnce([UINT256_MAX, '0x0'])
    const progress = await EvmService.getInstance().getWrapRedeemProgress(bridge, token, id)
    expect(progress).toEqual({kind: 'fully-redeemed'})
    expect(h.publicClient.readContract).toHaveBeenCalledTimes(1)
  })

  it('blockNumber 0 → unredeemed with a single read', async () => {
    const {EvmService} = await import('./evm-service')
    h.publicClient.readContract.mockResolvedValueOnce([0n, '0x0'])
    const progress = await EvmService.getInstance().getWrapRedeemProgress(bridge, token, id)
    expect(progress).toEqual({kind: 'unredeemed'})
    expect(h.publicClient.readContract).toHaveBeenCalledTimes(1)
  })

  it('0 < blockNumber < max → waiting-delay with computed remainingSeconds', async () => {
    const {EvmService} = await import('./evm-service')
    h.publicClient.readContract
      .mockResolvedValueOnce([100n, '0x0']) // redeemsInfo.blockNumber
      .mockResolvedValueOnce(3n) // estimatedBlockTime
      .mockResolvedValueOnce([0n, 10n, true, true, false]) // tokensInfo → redeemDelay=10
    h.publicClient.getBlockNumber.mockResolvedValue(102n)
    const progress = await EvmService.getInstance().getWrapRedeemProgress(bridge, token, id)
    // remainingBlocks = 10-2+1 = 9; *3 = 27
    expect(progress).toEqual({kind: 'waiting-delay', remainingSeconds: 27})
  })
})

describe('selectProvisionalLogIndex', () => {
  const account = '0x52908400098527886E0F7030069857D2E4169EE7'
  const zenon = 'z1qztestrecipient'

  it('empty logs → null', async () => {
    const {selectProvisionalLogIndex} = await import('./evm-service')
    expect(selectProvisionalLogIndex([], account, zenon)).toBeNull()
  })

  it('matches from (checksum-insensitive) + exact to, returns that logIndex', async () => {
    const {selectProvisionalLogIndex} = await import('./evm-service')
    const logs = [
      {logIndex: 7, args: {from: account.toLowerCase(), to: zenon}},
    ]
    expect(selectProvisionalLogIndex(logs, account, zenon)).toBe(7)
  })

  it('multiple logs picks the matching one', async () => {
    const {selectProvisionalLogIndex} = await import('./evm-service')
    const logs = [
      {logIndex: 1, args: {from: '0x0000000000000000000000000000000000000099', to: zenon}},
      {logIndex: 2, args: {from: account, to: 'z1qother'}},
      {logIndex: 3, args: {from: account, to: zenon}},
    ]
    expect(selectProvisionalLogIndex(logs, account, zenon)).toBe(3)
  })

  it('no match → null', async () => {
    const {selectProvisionalLogIndex} = await import('./evm-service')
    const logs = [
      {logIndex: 5, args: {from: account, to: 'z1qsomeoneelse'}},
      {logIndex: 6, args: {from: '0x0000000000000000000000000000000000000099', to: zenon}},
    ]
    expect(selectProvisionalLogIndex(logs, account, zenon)).toBeNull()
  })

  it('malformed from does not throw, treated as no-match', async () => {
    const {selectProvisionalLogIndex} = await import('./evm-service')
    const logs = [{logIndex: 9, args: {from: 'not-an-address', to: zenon}}]
    expect(() => selectProvisionalLogIndex(logs, account, zenon)).not.toThrow()
    expect(selectProvisionalLogIndex(logs, account, zenon)).toBeNull()
  })

  it('missing from is guarded (no throw), treated as no-match → null', async () => {
    const {selectProvisionalLogIndex} = await import('./evm-service')
    const logs = [{logIndex: 4, args: {to: zenon}}]
    expect(() => selectProvisionalLogIndex(logs, account, zenon)).not.toThrow()
    expect(selectProvisionalLogIndex(logs, account, zenon)).toBeNull()
  })

  it('matching from but non-matching to is rejected (both must match)', async () => {
    // Same account, but the `to` is a different Zenon recipient than the one we
    // unwrapped to → must NOT match.
    const {selectProvisionalLogIndex} = await import('./evm-service')
    const logs = [
      {logIndex: 2, args: {from: account, to: 'z1qdifferentrecipient'}},
    ]
    expect(selectProvisionalLogIndex(logs, account, zenon)).toBeNull()
  })

  it('matches the exact concatenated self-referral receiver', async () => {
    const {selectProvisionalLogIndex} = await import('./evm-service')
    const receiver = 'z1qaddr&z1qaddr'
    const token = '0xb2e96a63479c2edd2fd62b382c89d5ca79f572d3'
    const logs = [
      {logIndex: 3, args: {from: account, to: 'z1qaddr', token, amount: 5n}},
      {logIndex: 4, args: {from: account, to: receiver, token, amount: 5n}},
    ]
    expect(selectProvisionalLogIndex(logs, account, receiver, token, 5n)).toBe(4)
  })
})

describe('EvmService allowance stages', () => {
  const token = '0xToken0000000000000000000000000000000001' as const
  const bridge = '0xBridge00000000000000000000000000000000' as const

  it('reads the current allowance without writing', async () => {
    h.walletClient.requestAddresses.mockResolvedValue(['0xOwner000000000000000000000000000000001'])
    h.publicClient.readContract.mockResolvedValue(1000n)
    const {EvmService} = await import('./evm-service')

    await expect(EvmService.getInstance().getAllowance(token, bridge)).resolves.toBe(1000n)

    expect(h.walletClient.writeContract).not.toHaveBeenCalled()
    expect(h.publicClient.waitForTransactionReceipt).not.toHaveBeenCalled()
  })

  it('approves the exact amount, reports the hash, and awaits the receipt', async () => {
    h.walletClient.requestAddresses.mockResolvedValue(['0xOwner000000000000000000000000000000001'])
    h.publicClient.readContract.mockResolvedValue(100n)
    h.publicClient.simulateContract.mockResolvedValue({request: {simulated: 'approve'}})
    h.walletClient.writeContract.mockResolvedValue('0xapprovetx')
    h.publicClient.waitForTransactionReceipt.mockResolvedValue({status: 'success'})
    const {EvmService} = await import('./evm-service')
    const submitted = vi.fn()

    await expect(
      EvmService.getInstance().approveAllowance(token, bridge, 500n, submitted),
    ).resolves.toBe('0xapprovetx')

    expect(h.publicClient.simulateContract).toHaveBeenCalledWith(
      expect.objectContaining({address: token, functionName: 'approve', args: [bridge, 500n]}),
    )
    expect(h.walletClient.writeContract).toHaveBeenCalledWith({simulated: 'approve'})
    expect(submitted).toHaveBeenCalledWith('0xapprovetx')
    expect(h.publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({hash: '0xapprovetx'})
  })

  it('rejects writes when the wallet changed to another chain', async () => {
    h.walletClient.requestAddresses.mockResolvedValue(['0xOwner000000000000000000000000000000001'])
    h.walletClient.getChainId.mockResolvedValue(10)
    const {EvmService} = await import('./evm-service')

    await expect(EvmService.getInstance().getAllowance(token, bridge)).rejects.toThrow(
      'Please switch MetaMask',
    )
    expect(h.publicClient.readContract).not.toHaveBeenCalled()
  })
})

describe('EvmService write verification', () => {
  const bridge = '0xa98706106f7710d743186031be2245f33acea106' as const
  const token = '0xb2e96a63479c2edd2fd62b382c89d5ca79f572d3' as const
  const account = '0x52908400098527886E0F7030069857D2E4169EE7' as const

  it('simulates unwrap and preserves a confirmed hash when event recovery is needed', async () => {
    h.walletClient.requestAddresses.mockResolvedValue([account])
    h.publicClient.simulateContract.mockResolvedValue({request: {simulated: 'unwrap'}})
    h.walletClient.writeContract.mockResolvedValue('0xunwraptx')
    h.publicClient.waitForTransactionReceipt.mockResolvedValue({status: 'success', logs: []})
    const {EvmService} = await import('./evm-service')

    await expect(
      EvmService.getInstance().unwrap(bridge, token, 100n, 'z1recipient'),
    ).resolves.toEqual({hash: '0xunwraptx', provisionalLogIndex: -1, eventMatched: false})
    expect(h.walletClient.writeContract).toHaveBeenCalledWith({simulated: 'unwrap'})
  })

  it('rejects a reverted unwrap receipt once the quorum corroborates the revert', async () => {
    h.walletClient.requestAddresses.mockResolvedValue([account])
    h.publicClient.simulateContract.mockResolvedValue({request: {simulated: 'unwrap'}})
    h.walletClient.writeContract.mockResolvedValue('0xunwraptx')
    h.publicClient.waitForTransactionReceipt.mockResolvedValue({status: 'reverted', logs: []})
    h.publicClient.getTransactionReceipt.mockResolvedValue({status: 'reverted'})
    const {EvmService} = await import('./evm-service')

    await expect(
      EvmService.getInstance().unwrap(bridge, token, 100n, 'z1recipient'),
    ).rejects.toThrow('Unwrap transaction reverted')
  })

  it('simulates redeem and returns only after a successful receipt', async () => {
    h.walletClient.requestAddresses.mockResolvedValue([account])
    h.publicClient.simulateContract.mockResolvedValue({request: {simulated: 'redeem'}})
    h.walletClient.writeContract.mockResolvedValue('0xredeemtx')
    h.publicClient.waitForTransactionReceipt.mockResolvedValue({status: 'success'})
    const {EvmService} = await import('./evm-service')

    await expect(
      EvmService.getInstance().redeem(bridge, account, token, 100n, 1n, '0x1234'),
    ).resolves.toBe('0xredeemtx')
    expect(h.walletClient.writeContract).toHaveBeenCalledWith({simulated: 'redeem'})
  })
})
