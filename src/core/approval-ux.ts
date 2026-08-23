import type {UnwrapStatus, WrapStatus} from '@/types'
import type {FinalityProgress} from './evm-service'

export type PendingRedeemPhase = 'wallet' | 'confirming'

export interface RequestProgressCopy {
  badge: string
  title: string
  description: string
  action?: string
  actionable: boolean
  completedApprovals: number
  totalApprovals: number
}

export function isUnwrapSourceConfirmed(status: UnwrapStatus): boolean {
  // `pending` is intentionally confirmed: it is used only after a successful
  // Ethereum receipt while the Zenon node is still indexing the event.
  return status !== 'submitted'
}

export function hasWrapProtocolAdvanced(stage: 1 | 2, status: WrapStatus): boolean {
  return stage === 1
    ? status === 'waiting-delay' || status === 'redeemable-2' || status === 'redeemed'
    : status === 'redeemed'
}

// Forward-only progress for the Zenon redemption leg. TSS key rotation can
// momentarily regress a redeemable request to signing/waiting; only the
// terminal states may release the redeem lock.
export function hasUnwrapProtocolAdvanced(status: UnwrapStatus): boolean {
  return status === 'redeemed' || status === 'revoked'
}

// Persisted-lock hash written before the wallet prompt, replaced with the real
// transaction/block hash once the wallet reports a broadcast — or with the
// ambiguous marker when the flow ended without learning the outcome (relay
// timeout after the wallet received the request, or a failed persist of the
// real hash). The ambiguous marker is never auto-released: the wallet may
// still sign and broadcast, so only protocol advance or authoritative chain
// evidence clears it.
export const AWAITING_WALLET_RESULT = 'awaiting-wallet-result'
export const AMBIGUOUS_WALLET_RESULT = 'ambiguous-wallet-result'

export function isAuthoritativeLockHash(hash: string | undefined): boolean {
  return Boolean(hash) && hash !== AWAITING_WALLET_RESULT && hash !== AMBIGUOUS_WALLET_RESULT
}

export const PLACEHOLDER_LOCK_STALE_MS = 15 * 60_000

// Whether a NEW redeem/claim flow — which already holds the exclusive
// cross-context Web Lock — may overwrite a leftover pre-prompt placeholder.
// Holding the Web Lock proves the flow that wrote the placeholder terminated;
// since every terminating path either clears the placeholder (provable
// pre-broadcast failure) or upgrades it (real hash / ambiguous marker), a
// surviving AWAITING placeholder means the flow died mid-prompt. minAgeMs > 0
// additionally guards wallets whose prompt lives outside the browser (Syrius)
// and can outlive the dApp context; a legacy entry with no timestamp fails
// closed whenever age matters. Background polling must NEVER call this — a
// free Web Lock alone does not prove no broadcast occurred.
export function canReclaimPlaceholderLock(
  hash: string,
  updatedAt: number | undefined,
  now: number,
  minAgeMs: number,
): boolean {
  if (hash !== AWAITING_WALLET_RESULT) return false
  if (minAgeMs <= 0) return true
  return updatedAt !== undefined && now - updatedAt >= minAgeMs
}

export function shouldHandoffLocalWrapLock(
  stage: 1 | 2 | undefined,
  status: WrapStatus,
  hasPersistedHash: boolean,
): boolean {
  return hasPersistedHash || (stage !== undefined && hasWrapProtocolAdvanced(stage, status))
}

export function shouldHandoffLocalUnwrapLock(
  status: UnwrapStatus,
  hasPersistedHash: boolean,
): boolean {
  return hasPersistedHash || status === 'redeemed' || status === 'revoked'
}

export function approvalPlan(direction: 'wrap' | 'unwrap'): string {
  return direction === 'wrap'
    ? '3 wallet approvals: submit on Zenon, claim on Ethereum, then complete the claim after the security delay.'
    : 'Up to 3 wallet approvals: token approval if needed, bridge transfer on Ethereum, then redeem on Zenon.'
}

export function wrapRequestProgress(
  status: WrapStatus,
  pending?: PendingRedeemPhase,
): RequestProgressCopy {
  if (pending === 'wallet') {
    const final = status === 'redeemable-2'
    return {
      badge: final ? 'Step 3 of 3' : 'Step 2 of 3',
      title: final ? 'Complete claim in MetaMask' : 'Claim on Ethereum in MetaMask',
      description: 'Waiting for MetaMask approval. The action is locked to prevent duplicate prompts.',
      action: 'Waiting for MetaMask…',
      actionable: false,
      completedApprovals: final ? 2 : 1,
      totalApprovals: 3,
    }
  }
  if (pending === 'confirming') {
    const final = status === 'redeemable-2'
    return {
      badge: final ? 'Step 3 of 3' : 'Step 2 of 3',
      title: final ? 'Confirming final claim' : 'Confirming first claim',
      description: 'The Ethereum transaction was submitted and is waiting for confirmation.',
      action: 'Confirming on Ethereum…',
      actionable: false,
      completedApprovals: final ? 2 : 1,
      totalApprovals: 3,
    }
  }

  switch (status) {
    case 'signing':
      return {
        badge: '1 of 3 confirmed',
        title: 'Waiting for bridge signatures',
        description: 'The Zenon submission is confirmed. No wallet action is required yet.',
        actionable: false,
        completedApprovals: 1,
        totalApprovals: 3,
      }
    case 'redeemable':
      return {
        badge: 'Claim 1 of 2 ready',
        title: 'Claim on Ethereum',
        description: 'MetaMask will request wallet approval 2 of 3.',
        action: 'Claim on Ethereum · Step 2/3',
        actionable: true,
        completedApprovals: 1,
        totalApprovals: 3,
      }
    case 'waiting-delay':
      return {
        badge: '2 of 3 confirmed',
        title: 'Security delay',
        description: 'The first claim is confirmed. The final claim becomes available after the protocol delay.',
        actionable: false,
        completedApprovals: 2,
        totalApprovals: 3,
      }
    case 'redeemable-2':
      return {
        badge: 'Final claim ready',
        title: 'Complete claim on Ethereum',
        description: 'MetaMask will request the final wallet approval, step 3 of 3.',
        action: 'Complete claim · Step 3/3',
        actionable: true,
        completedApprovals: 2,
        totalApprovals: 3,
      }
    case 'redeemed':
      return {
        badge: '3 of 3 confirmed',
        title: 'Bridge complete',
        description: 'The final Ethereum claim is confirmed.',
        actionable: false,
        completedApprovals: 3,
        totalApprovals: 3,
      }
  }
}

function formatMinutes(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60))
  return `~${minutes} min`
}

export function describeFinality(finality: FinalityProgress): string {
  const count = `${finality.confirmations} / ${finality.required} Ethereum confirmations`
  if (finality.confirmations >= finality.required) {
    return `${count} · finalized. Waiting for the orchestrators to register the event on Zenon (usually a few minutes).`
  }
  return `${count} · ${formatMinutes(finality.remainingSeconds)} to finality. The Zenon node registers the event after the orchestrators see it finalized.`
}

export function unwrapRequestProgress(
  status: UnwrapStatus,
  pending?: PendingRedeemPhase,
  knownTotalApprovals?: 2 | 3,
  finality?: FinalityProgress,
): RequestProgressCopy {
  const totalApprovals = knownTotalApprovals ?? 2
  const completedBeforeRedeem = totalApprovals - 1
  if (pending === 'wallet') {
    return {
      badge: 'Final approval',
      title: 'Redeem on Zenon in Syrius',
      description: 'Waiting for Syrius approval. The action is locked to prevent duplicate prompts.',
      action: 'Waiting for Syrius…',
      actionable: false,
      completedApprovals: completedBeforeRedeem,
      totalApprovals,
    }
  }
  if (pending === 'confirming') {
    return {
      badge: 'Final approval',
      title: 'Confirming on Zenon',
      description: 'The redemption was submitted and is waiting for confirmation.',
      action: 'Confirming on Zenon…',
      actionable: false,
      completedApprovals: completedBeforeRedeem,
      totalApprovals,
    }
  }

  switch (status) {
    case 'submitted':
      return {
        badge: 'Submitted',
        title: 'Verifying Ethereum transaction',
        description: 'The transaction is pending or its receipt is temporarily unavailable. Do not submit it again.',
        actionable: false,
        completedApprovals: Math.max(0, completedBeforeRedeem - 1),
        totalApprovals,
      }
    case 'pending':
      return {
        badge: 'Source confirmed',
        title: 'Waiting for Ethereum event indexing',
        description: finality
          ? describeFinality(finality)
          : 'The bridge transfer is confirmed. The Zenon node is locating the event.',
        actionable: false,
        completedApprovals: completedBeforeRedeem,
        totalApprovals,
      }
    case 'signing':
      return {
        badge: 'Source confirmed',
        title: 'Waiting for bridge signatures',
        description: 'No wallet action is required while bridge participants sign the request.',
        actionable: false,
        completedApprovals: completedBeforeRedeem,
        totalApprovals,
      }
    case 'waiting':
      return {
        badge: 'Source confirmed',
        title: 'Security delay',
        description: 'The final Zenon redemption becomes available after the protocol delay.',
        actionable: false,
        completedApprovals: completedBeforeRedeem,
        totalApprovals,
      }
    case 'redeemable':
      return {
        badge: 'Final redemption ready',
        title: 'Redeem on Zenon',
        description: knownTotalApprovals
          ? `Syrius will request wallet approval ${totalApprovals} of ${totalApprovals}.`
          : 'Syrius will request the final wallet approval.',
        action: 'Redeem on Zenon · Final step',
        actionable: true,
        completedApprovals: completedBeforeRedeem,
        totalApprovals,
      }
    case 'redeemed':
      return {
        badge: 'Complete',
        title: 'Bridge complete',
        description: 'The Zenon redemption is confirmed.',
        actionable: false,
        completedApprovals: totalApprovals,
        totalApprovals,
      }
    case 'revoked':
      return {
        badge: 'Revoked',
        title: 'Request revoked',
        description: 'This request can no longer be redeemed.',
        actionable: false,
        completedApprovals: completedBeforeRedeem,
        totalApprovals,
      }
    case 'broken':
      return {
        badge: 'Support required',
        title: 'Bridge request needs support',
        description: 'The node reported an invalid redemption delay. Do not resubmit the transfer.',
        actionable: false,
        completedApprovals: completedBeforeRedeem,
        totalApprovals,
      }
  }
}
