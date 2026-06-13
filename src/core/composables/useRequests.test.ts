import {describe, expect, it} from 'vitest'
import {deriveUnwrapStatus, deriveWrapStatus} from './useRequests'

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
