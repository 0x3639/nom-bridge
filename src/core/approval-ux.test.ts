import {describe, expect, it} from 'vitest'
import {
  approvalPlan,
  AMBIGUOUS_WALLET_RESULT,
  AWAITING_WALLET_RESULT,
  canReclaimPlaceholderLock,
  hasUnwrapProtocolAdvanced,
  hasWrapProtocolAdvanced,
  isAuthoritativeLockHash,
  isUnwrapSourceConfirmed,
  PLACEHOLDER_LOCK_STALE_MS,
  shouldHandoffLocalUnwrapLock,
  shouldHandoffLocalWrapLock,
  unwrapRequestProgress,
  wrapRequestProgress,
  describeAffiliateBonusRow,
} from './approval-ux'

describe('isUnwrapSourceConfirmed', () => {
  it('keeps unverified transactions locked', () => {
    expect(isUnwrapSourceConfirmed('submitted')).toBe(false)
  })

  it('recognizes a successful receipt awaiting node indexing as confirmed', () => {
    expect(isUnwrapSourceConfirmed('pending')).toBe(true)
    expect(isUnwrapSourceConfirmed('signing')).toBe(true)
  })
})

describe('durable lock handoff', () => {
  it('does not clear a local lock merely because an actionable row exists', () => {
    expect(shouldHandoffLocalWrapLock(1, 'redeemable', false)).toBe(false)
    expect(shouldHandoffLocalUnwrapLock('redeemable', false)).toBe(false)
  })

  it('does not treat a temporary signing regression as protocol advancement', () => {
    expect(hasWrapProtocolAdvanced(1, 'signing')).toBe(false)
  })

  it('hands off only to persisted evidence or an actually advanced protocol state', () => {
    expect(shouldHandoffLocalWrapLock(1, 'redeemable', true)).toBe(true)
    expect(shouldHandoffLocalWrapLock(1, 'waiting-delay', false)).toBe(true)
    expect(shouldHandoffLocalWrapLock(2, 'redeemable-2', false)).toBe(false)
    expect(shouldHandoffLocalUnwrapLock('redeemed', false)).toBe(true)
  })
})

describe('hasUnwrapProtocolAdvanced', () => {
  it('advances only on the terminal redeemed/revoked states', () => {
    expect(hasUnwrapProtocolAdvanced('redeemed')).toBe(true)
    expect(hasUnwrapProtocolAdvanced('revoked')).toBe(true)
  })

  it('does not treat backward status regressions as advancement', () => {
    // TSS key rotation can momentarily regress a redeemable request to
    // signing/waiting; that must never release the Zenon redeem lock.
    expect(hasUnwrapProtocolAdvanced('signing')).toBe(false)
    expect(hasUnwrapProtocolAdvanced('waiting')).toBe(false)
    expect(hasUnwrapProtocolAdvanced('pending')).toBe(false)
    expect(hasUnwrapProtocolAdvanced('redeemable')).toBe(false)
    expect(hasUnwrapProtocolAdvanced('submitted')).toBe(false)
    expect(hasUnwrapProtocolAdvanced('broken')).toBe(false)
  })
})

describe('placeholder lock semantics', () => {
  it('recognizes only a real transaction hash as authoritative', () => {
    expect(isAuthoritativeLockHash(`0x${'ab'.repeat(32)}`)).toBe(true)
    expect(isAuthoritativeLockHash(AWAITING_WALLET_RESULT)).toBe(false)
    expect(isAuthoritativeLockHash(AMBIGUOUS_WALLET_RESULT)).toBe(false)
    expect(isAuthoritativeLockHash(undefined)).toBe(false)
    expect(isAuthoritativeLockHash('')).toBe(false)
  })

  // Reclaim happens only INSIDE a new flow that already holds the exclusive
  // cross-context Web Lock — never from background polling. Holding the lock
  // proves the flow that wrote the placeholder has terminated.
  it('allows reclaiming an orphaned pre-prompt placeholder under the Web Lock', () => {
    expect(canReclaimPlaceholderLock(AWAITING_WALLET_RESULT, 1_000, 1_001, 0)).toBe(true)
  })

  it('never reclaims an ambiguous marker — the wallet may still broadcast', () => {
    expect(canReclaimPlaceholderLock(AMBIGUOUS_WALLET_RESULT, 0, 1_000_000_000, 0)).toBe(false)
  })

  it('never reclaims a real-hash lock through the placeholder path', () => {
    expect(canReclaimPlaceholderLock(`0x${'ab'.repeat(32)}`, 0, 1_000_000_000, 0)).toBe(false)
  })

  it('honors a minimum age for wallets whose prompt outlives the dApp context', () => {
    // Syrius runs outside the browser: its prompt can survive a dApp crash, so
    // the Zenon reclaim path additionally requires the placeholder to be older
    // than any plausible prompt lifetime.
    expect(
      canReclaimPlaceholderLock(AWAITING_WALLET_RESULT, 1_000, 1_000 + PLACEHOLDER_LOCK_STALE_MS, PLACEHOLDER_LOCK_STALE_MS),
    ).toBe(true)
    expect(
      canReclaimPlaceholderLock(AWAITING_WALLET_RESULT, 1_000, 1_000 + PLACEHOLDER_LOCK_STALE_MS - 1, PLACEHOLDER_LOCK_STALE_MS),
    ).toBe(false)
    // No timestamp on the entry (legacy shape) → fail closed when age matters.
    expect(
      canReclaimPlaceholderLock(AWAITING_WALLET_RESULT, undefined, 1_000_000_000, PLACEHOLDER_LOCK_STALE_MS),
    ).toBe(false)
  })
})

describe('approvalPlan', () => {
  it('discloses all three wrap approvals before submission', () => {
    expect(approvalPlan('wrap')).toContain('3 wallet approvals')
    expect(approvalPlan('wrap')).toContain('complete the claim')
  })

  it('describes unwrap approval as conditional', () => {
    expect(approvalPlan('unwrap')).toContain('Up to 3 wallet approvals')
    expect(approvalPlan('unwrap')).toContain('if needed')
  })
})

describe('wrapRequestProgress', () => {
  it('labels the two Ethereum claims as steps 2 and 3', () => {
    expect(wrapRequestProgress('redeemable')).toMatchObject({
      action: 'Claim on Ethereum · Step 2/3',
      actionable: true,
    })
    expect(wrapRequestProgress('redeemable-2')).toMatchObject({
      action: 'Complete claim · Step 3/3',
      actionable: true,
    })
  })

  it('locks the action while a wallet prompt or receipt is pending', () => {
    expect(wrapRequestProgress('redeemable', 'wallet')).toMatchObject({
      action: 'Waiting for MetaMask…',
      actionable: false,
    })
    expect(wrapRequestProgress('redeemable', 'confirming')).toMatchObject({
      action: 'Confirming on Ethereum…',
      actionable: false,
    })
  })

  it.each([
    ['signing', 'Waiting for bridge signatures', 1],
    ['waiting-delay', 'Security delay', 2],
    ['redeemed', 'Bridge complete', 3],
  ] as const)('describes the %s state', (status, title, completedApprovals) => {
    expect(wrapRequestProgress(status)).toMatchObject({
      title,
      completedApprovals,
      totalApprovals: 3,
      actionable: false,
    })
  })

  it('labels a pending final claim as step 3', () => {
    expect(wrapRequestProgress('redeemable-2', 'wallet')).toMatchObject({
      badge: 'Step 3 of 3',
      completedApprovals: 2,
    })
    expect(wrapRequestProgress('redeemable-2', 'confirming')).toMatchObject({
      title: 'Confirming final claim',
      completedApprovals: 2,
    })
  })
})

describe('describeAffiliateBonusRow', () => {
  it('explains why the bonus has its own countdown and redeem', () => {
    expect(describeAffiliateBonusRow()).toBe(
      '2% affiliate bonus for this bridge transfer. The bridge registers it as a separate request shortly after the main one, so its security delay ends a little later and it needs its own Syrius redeem.',
    )
  })
})

describe('unwrapRequestProgress finality countdown', () => {
  it('shows confirmations and an estimate while finality is pending', () => {
    expect(
      unwrapRequestProgress('pending', undefined, 3, {confirmations: 81, required: 90, remainingSeconds: 108}),
    ).toMatchObject({
      title: 'Waiting for Ethereum event indexing',
      description: '81 / 90 Ethereum confirmations · ~2 min to finality. The Zenon node registers the event after the orchestrators see it finalized.',
    })
  })

  it('keeps required/required visible while the orchestrators register the event', () => {
    expect(
      unwrapRequestProgress('pending', undefined, 3, {confirmations: 90, required: 90, remainingSeconds: 0}),
    ).toMatchObject({
      description: '90 / 90 Ethereum confirmations · finalized. Waiting for the orchestrators to register the event on Zenon (usually a few minutes).',
    })
  })

  it('falls back to the generic copy without finality data', () => {
    expect(unwrapRequestProgress('pending', undefined, 3).description).toBe(
      'The bridge transfer is confirmed. The Zenon node is locating the event.',
    )
  })
})

describe('unwrapRequestProgress', () => {
  it('preserves whether the final redemption is step 2 or 3', () => {
    expect(unwrapRequestProgress('redeemable', undefined, 2)).toMatchObject({
      completedApprovals: 1,
      totalApprovals: 2,
    })
    expect(unwrapRequestProgress('redeemable', undefined, 3)).toMatchObject({
      completedApprovals: 2,
      totalApprovals: 3,
    })
  })

  it('identifies the final Zenon action without calling it a generic redeem', () => {
    expect(unwrapRequestProgress('redeemable', undefined, 3)).toMatchObject({
      title: 'Redeem on Zenon',
      action: 'Redeem on Zenon · Final step',
      actionable: true,
    })
  })

  it.each([
    ['submitted', 'Verifying Ethereum transaction', 0],
    ['pending', 'Waiting for Ethereum event indexing', 1],
    ['signing', 'Waiting for bridge signatures', 1],
    ['waiting', 'Security delay', 1],
    ['redeemed', 'Bridge complete', 2],
    ['revoked', 'Request revoked', 1],
    ['broken', 'Bridge request needs support', 1],
  ] as const)('describes the %s state', (status, title, completedApprovals) => {
    expect(unwrapRequestProgress(status, undefined, 2)).toMatchObject({
      title,
      completedApprovals,
      totalApprovals: 2,
      actionable: false,
    })
  })

  it('uses safe generic copy when the approval count is unknown', () => {
    expect(unwrapRequestProgress('redeemable')).toMatchObject({
      description: 'Syrius will request the final wallet approval.',
      completedApprovals: 1,
      totalApprovals: 2,
    })
  })

  it('locks the final action during wallet and confirmation phases', () => {
    expect(unwrapRequestProgress('redeemable', 'wallet', 3)).toMatchObject({
      action: 'Waiting for Syrius…',
      completedApprovals: 2,
      actionable: false,
    })
    expect(unwrapRequestProgress('redeemable', 'confirming', 3)).toMatchObject({
      action: 'Confirming on Zenon…',
      completedApprovals: 2,
      actionable: false,
    })
  })
})
