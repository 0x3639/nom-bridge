import {describe, expect, it} from 'vitest'
import {
  computeFinalUnwrapHashes,
  deriveUnwrapStatus,
  deriveWrapStatus,
  findTrackedUnwrapByHash,
  matchesTrackedUnwrapEvent,
  normalizeEvmHash,
  orderUnwrapRequests,
  reconcileUnknownWrapOperations,
} from './useRequests'
import type {UnwrapStatus} from '@/types'

describe('normalizeEvmHash', () => {
  it('canonicalizes SDK and viem hash formats to the same key', () => {
    expect(normalizeEvmHash('ABCDEF')).toBe('0xabcdef')
    expect(normalizeEvmHash('0xAbCdEf')).toBe('0xabcdef')
  })

  it('finds prefixed tracked metadata for an unprefixed node hash', () => {
    const tracked = [{kind: 'unwrap', id: '0xABCDEF:-1', approvalCount: 3}] as never
    expect(findTrackedUnwrapByHash(tracked, 'abcdef')).toMatchObject({approvalCount: 3})
  })
})

describe('matchesTrackedUnwrapEvent', () => {
  const tracked = {zts: 'zts1znn', amount: '100', zenonToAddress: 'z1qrecipient'}
  const event = {
    transactionHash: `0x${'ab'.repeat(32)}`,
    logIndex: 3,
    token: '0xToKen',
    to: 'z1qrecipient',
    amount: 100n,
  }

  it('matches a replacement transaction that executed the identical unwrap', () => {
    expect(matchesTrackedUnwrapEvent(tracked, '0xtoken', event)).toBe(true)
  })

  it('rejects events for a different destination, amount, or token', () => {
    expect(matchesTrackedUnwrapEvent(tracked, '0xtoken', {...event, to: 'z1qother'})).toBe(false)
    expect(matchesTrackedUnwrapEvent(tracked, '0xtoken', {...event, amount: 99n})).toBe(false)
    expect(matchesTrackedUnwrapEvent(tracked, '0xother', event)).toBe(false)
  })

  it('fails closed when the token pair mapping is unknown', () => {
    // Without a pinned pair, the ERC-20 address cannot be verified.
    expect(matchesTrackedUnwrapEvent(tracked, undefined, event)).toBe(false)
  })

  it('matches a self-referral event by its beneficiary part', () => {
    const selfReferralEvent = {
      transactionHash: `0x${'ab'.repeat(32)}`,
      logIndex: 3,
      token: '0xToKen',
      to: 'z1qrecipient&z1qrecipient',
      amount: 100n,
    }
    expect(matchesTrackedUnwrapEvent(tracked, '0xtoken', selfReferralEvent)).toBe(true)
  })

  it('does not match when only the affiliate part equals the tracked address', () => {
    const affiliateOnlyEvent = {
      transactionHash: `0x${'ab'.repeat(32)}`,
      logIndex: 3,
      token: '0xToKen',
      to: 'z1qother&z1qrecipient',
      amount: 100n,
    }
    expect(matchesTrackedUnwrapEvent(tracked, '0xtoken', affiliateOnlyEvent)).toBe(false)
  })
})

describe('reconcileUnknownWrapOperations', () => {
  const operation = (overrides: Partial<Parameters<typeof reconcileUnknownWrapOperations>[0][0]> = {}) => ({
    id: 'op-1',
    evmToAddress: '0xRecipient',
    zenonFromAddress: 'z1qsender',
    frontierHeight: 41,
    zts: 'zts1znn',
    amount: '150000000',
    decimals: 8,
    symbol: 'ZNN',
    createdAt: 1,
    ...overrides,
  })
  const block = (overrides: Partial<{
    hash: string
    height: number
    zts: string
    amount: string
    evmToAddress: string | null
    networkClass: number | null
    chainId: number | null
  }> = {}) => ({
    hash: 'blockhash-1',
    height: 42,
    zts: 'zts1znn',
    amount: '150000000',
    evmToAddress: '0xrecipient',
    networkClass: 2,
    chainId: 1,
    ...overrides,
  })
  const expected = {networkClass: 2, evmChainId: 1}

  it('reconciles an operation against an account-chain wrap send above its frontier', () => {
    expect(reconcileUnknownWrapOperations([operation()], [block()], expected)).toEqual(['op-1'])
  })

  it('ignores blocks at or below the recorded frontier or with a different tuple', () => {
    expect(reconcileUnknownWrapOperations([operation()], [block({height: 41})], expected)).toEqual([])
    expect(reconcileUnknownWrapOperations([operation()], [block({zts: 'zts1other'})], expected)).toEqual([])
    expect(reconcileUnknownWrapOperations([operation()], [block({amount: '1'})], expected)).toEqual([])
  })

  it('requires the decoded EVM destination and chain to match the operation', () => {
    // An identical-amount wrap to ANOTHER destination must not clear this
    // operation's duplicate-submit protection.
    expect(reconcileUnknownWrapOperations([operation()], [block({evmToAddress: '0xOther'})], expected)).toEqual([])
    expect(reconcileUnknownWrapOperations([operation()], [block({evmToAddress: null})], expected)).toEqual([])
    expect(reconcileUnknownWrapOperations([operation()], [block({networkClass: 3})], expected)).toEqual([])
    expect(reconcileUnknownWrapOperations([operation()], [block({chainId: 5})], expected)).toEqual([])
  })

  it('never auto-reconciles when the pre-send frontier read failed', () => {
    expect(reconcileUnknownWrapOperations([operation({frontierHeight: null})], [block()], expected)).toEqual([])
  })

  it('consumes candidate blocks one-to-one, oldest operation first', () => {
    // One published block must not clear two ambiguous operations.
    const ops = [operation({id: 'op-newer', createdAt: 2}), operation({id: 'op-older', createdAt: 1})]
    expect(reconcileUnknownWrapOperations(ops, [block()], expected)).toEqual(['op-older'])
    expect(reconcileUnknownWrapOperations(ops, [block(), block({hash: 'blockhash-2', height: 43})], expected))
      .toEqual(['op-older', 'op-newer'])
  })
})

describe('deriveWrapStatus', () => {
  it('empty signature → signing (progress null)', () => {
    expect(deriveWrapStatus('', null)).toBe('signing')
  })

  it('empty signature wins over any progress (precedence)', () => {
    // Even if a stale/erroneous progress would say redeemed/redeemable, an empty
    // signature must still resolve to signing — the signature check is first.
    expect(deriveWrapStatus('', {kind: 'fully-redeemed'})).toBe('signing')
    expect(deriveWrapStatus('', {kind: 'unredeemed'})).toBe('signing')
    expect(deriveWrapStatus('', {kind: 'waiting-delay', remainingSeconds: 0})).toBe('signing')
  })

  it('fully-redeemed → redeemed', () => {
    expect(deriveWrapStatus('sig', {kind: 'fully-redeemed'})).toBe('redeemed')
  })

  it('unredeemed → redeemable', () => {
    expect(deriveWrapStatus('sig', {kind: 'unredeemed'})).toBe('redeemable')
  })

  it('waiting-delay remainingSeconds>0 → waiting-delay', () => {
    expect(deriveWrapStatus('sig', {kind: 'waiting-delay', remainingSeconds: 30})).toBe(
      'waiting-delay',
    )
  })

  it('waiting-delay remainingSeconds===0 → redeemable-2', () => {
    expect(deriveWrapStatus('sig', {kind: 'waiting-delay', remainingSeconds: 0})).toBe(
      'redeemable-2',
    )
  })
})

describe('deriveUnwrapStatus', () => {
  const base = {signature: 'sig', redeemed: 0, revoked: 0, redeemableIn: 0}

  it('isPendingOnly short-circuits to pending before all other checks', () => {
    expect(deriveUnwrapStatus({...base, revoked: 1, redeemed: 1}, true)).toBe('pending')
  })

  it('revoked === 1 → revoked', () => {
    expect(deriveUnwrapStatus({...base, revoked: 1}, false)).toBe('revoked')
  })

  it('redeemed === 1 → redeemed', () => {
    expect(deriveUnwrapStatus({...base, redeemed: 1}, false)).toBe('redeemed')
  })

  it('revoked/redeemed win over signature and redeemableIn', () => {
    expect(deriveUnwrapStatus({signature: '', redeemed: 0, revoked: 1, redeemableIn: -5}, false)).toBe(
      'revoked',
    )
    expect(deriveUnwrapStatus({signature: '', redeemed: 1, revoked: 0, redeemableIn: -5}, false)).toBe(
      'redeemed',
    )
  })

  it('empty signature → signing', () => {
    expect(deriveUnwrapStatus({...base, signature: ''}, false)).toBe('signing')
  })

  it('signing precedes broken: empty sig + redeemableIn < 0 → signing (not broken)', () => {
    expect(deriveUnwrapStatus({signature: '', redeemed: 0, revoked: 0, redeemableIn: -3}, false)).toBe(
      'signing',
    )
  })

  it('signed + redeemableIn < 0 → broken', () => {
    expect(deriveUnwrapStatus({...base, redeemableIn: -1}, false)).toBe('broken')
  })

  it('signed + redeemableIn > 0 → waiting', () => {
    expect(deriveUnwrapStatus({...base, redeemableIn: 5}, false)).toBe('waiting')
  })

  it('signed + redeemableIn === 0 → redeemable', () => {
    expect(deriveUnwrapStatus({...base, redeemableIn: 0}, false)).toBe('redeemable')
  })

  it('revoked wins over redeemed when BOTH are set (revoked checked first)', () => {
    // Spec order: revoked (step 2) precedes redeemed (step 3), so a request that
    // is both revoked and redeemed resolves to revoked.
    expect(deriveUnwrapStatus({...base, revoked: 1, redeemed: 1}, false)).toBe('revoked')
  })

  it('uses strict === 1, NOT truthiness, for revoked/redeemed', () => {
    // Any non-1 value (incl. other truthy numbers) must fall through to the
    // signature / redeemableIn branches rather than short-circuiting.
    expect(deriveUnwrapStatus({...base, revoked: 2}, false)).toBe('redeemable')
    expect(deriveUnwrapStatus({...base, redeemed: 2}, false)).toBe('redeemable')
    // negative values are also not "set"
    expect(deriveUnwrapStatus({...base, revoked: -1}, false)).toBe('redeemable')
  })
})

describe('computeFinalUnwrapHashes', () => {
  const HASH = '0x' + 'ab'.repeat(32)

  function view(status: UnwrapStatus, hash = HASH) {
    return {transactionHash: hash, status}
  }

  it('a hash with a single final view is final', () => {
    const result = computeFinalUnwrapHashes([view('redeemed')])
    expect(result.has(normalizeEvmHash(HASH))).toBe(true)
  })

  it('bonus row redeemed but sibling main row still redeemable → NOT final', () => {
    const result = computeFinalUnwrapHashes([view('redeemed'), view('redeemable')])
    expect(result.has(normalizeEvmHash(HASH))).toBe(false)
  })

  it('both same-hash rows final (redeemed + revoked) → final', () => {
    const result = computeFinalUnwrapHashes([view('redeemed'), view('revoked')])
    expect(result.has(normalizeEvmHash(HASH))).toBe(true)
  })

  it('normalizes hash casing/prefix before grouping', () => {
    const bare = HASH.slice(2).toUpperCase()
    const result = computeFinalUnwrapHashes([view('redeemed', HASH), view('redeemable', bare)])
    expect(result.has(normalizeEvmHash(HASH))).toBe(false)
  })

  it('an unrelated hash is unaffected by another hash still being live', () => {
    const OTHER = '0x' + 'cd'.repeat(32)
    const result = computeFinalUnwrapHashes([view('redeemed', OTHER), view('redeemable', HASH)])
    expect(result.has(normalizeEvmHash(OTHER))).toBe(true)
    expect(result.has(normalizeEvmHash(HASH))).toBe(false)
  })
})

describe('orderUnwrapRequests', () => {
  const view = (transactionHash: string, logIndex: number) =>
    ({id: `${transactionHash}:${logIndex}`, transactionHash, logIndex}) as never

  it('places each affiliate bonus row directly after its parent transfer', () => {
    const ordered = orderUnwrapRequests([
      view('0xaaa', 4_000_000_248),
      view('0xbbb', 7),
      view('0xaaa', 248),
    ])
    expect(ordered.map(v => v.id)).toEqual(['0xaaa:248', '0xaaa:4000000248', '0xbbb:7'])
  })

  it('keeps an orphaned bonus row (parent not listed) in place', () => {
    const ordered = orderUnwrapRequests([view('0xbbb', 7), view('0xccc', 4_000_000_001)])
    expect(ordered.map(v => v.id)).toEqual(['0xbbb:7', '0xccc:4000000001'])
  })
})
