import {ref} from 'vue'
import {BridgeService} from '../bridge-service'
import {EvmService, EvmSubmissionError} from '../evm-service'
import type {AuthoritativeEvmOutcome} from '../evm-service'
import {requestStore, zenonRedeemLockFor} from '../request-store'
import {useZenonWallet} from './useZenonWallet'
import type {UnwrapRequestView} from '@/types'
import type {Address, Hex} from 'viem'
import {
  AMBIGUOUS_WALLET_RESULT,
  AWAITING_WALLET_RESULT,
  canReclaimPlaceholderLock,
  PLACEHOLDER_LOCK_STALE_MS,
  type PendingRedeemPhase,
} from '../approval-ux'
import {normalizeEvmHash, stripEvmHashPrefix} from '../evm-hash'
import {ZenonSubmissionError} from '../zenon-wallet-service'

export type UnwrapPhase =
  | {kind: 'idle'}
  | {kind: 'checking-allowance'}
  | {kind: 'approving-token'; total: 3}
  | {kind: 'confirming-approval'; total: 3; hash: Hex}
  | {kind: 'submitting-unwrap'; step: 1 | 2; total: 2 | 3}
  | {kind: 'confirming-unwrap'; step: 1 | 2; total: 2 | 3; hash: Hex}
  | {kind: 'submitted-unconfirmed'; total: 2 | 3; hash: Hex; trackingFailed: boolean; message: string}
  | {kind: 'submitted-untracked'; total: 2 | 3; hash: Hex; message: string}
  | {kind: 'failed'; stage: 'allowance' | 'token-approval' | 'bridge-transfer'; message: string}

export type UnwrapSubmissionResult =
  | {kind: 'confirmed'; hash: Hex; provisionalLogIndex: number; eventMatched: boolean; trackingFailed: boolean}
  | {kind: 'submitted-unconfirmed'; hash: Hex; trackingFailed: boolean}

const isUnwrapping = ref(false)
const error = ref<string | null>(null)
const phase = ref<UnwrapPhase>({kind: 'idle'})
const pendingRedeems = ref<Record<string, PendingRedeemPhase | undefined>>({})

function setPendingRedeem(id: string, pending?: PendingRedeemPhase): void {
  if (pending) pendingRedeems.value = {...pendingRedeems.value, [id]: pending}
  else {
    const {[id]: _finished, ...remaining} = pendingRedeems.value
    pendingRedeems.value = remaining
  }
}

function resetPhase(): void {
  if (!isUnwrapping.value && phase.value.kind === 'failed') {
    phase.value = {kind: 'idle'}
    error.value = null
  }
}

function clearPhase(): void {
  if (!isUnwrapping.value) {
    phase.value = {kind: 'idle'}
    error.value = null
  }
}

async function unwrap(
  token: Address,
  amount: bigint,
  zenonAddress: string,
  bridge: Address,
  zts: string,
  decimals: number,
  symbol: string,
  evmFromAddress: string,
): Promise<UnwrapSubmissionResult> {
  // Synchronous reentrancy guard: rapid double-submission races the UI's
  // awaited pre-checks, so the composable itself must refuse before any await.
  if (isUnwrapping.value) throw new Error('An unwrap is already in progress')
  const clickedAt = Date.now()
  isUnwrapping.value = true
  error.value = null
  phase.value = {kind: 'checking-allowance'}
  let lockedFlowRan = false
  try {
    // Account-scoped NON-QUEUING exclusive lock: two tabs can otherwise both
    // pass their UI gates and open two MetaMask prompts for the same transfer,
    // and a QUEUED click would run after the other tab's completed submission
    // against state the user never saw. Fails closed without Web Locks.
    return await requestStore.withExclusiveSourceLock(
      `unwrap-submit:${evmFromAddress.toLowerCase()}`,
      () => {
        lockedFlowRan = true
        return unwrapLocked(token, amount, zenonAddress, bridge, zts, decimals, symbol, clickedAt)
      },
    )
  } catch (e) {
    if (!lockedFlowRan) {
      isUnwrapping.value = false
      error.value = e instanceof Error ? e.message : 'Failed to submit unwrap'
      phase.value = {kind: 'failed', stage: 'allowance', message: error.value}
    }
    throw e
  }
}

async function unwrapLocked(
  token: Address,
  amount: bigint,
  zenonAddress: string,
  bridge: Address,
  zts: string,
  decimals: number,
  symbol: string,
  clickedAt: number,
): Promise<UnwrapSubmissionResult> {
  let failureStage: 'allowance' | 'token-approval' | 'bridge-transfer' = 'allowance'
  let broadcastHash: Hex | null = null
  let totalApprovals: 2 | 3 = 2
  let trackingResult: Promise<boolean> | null = null
  try {
    // Atomic in-lock check: a submission that queued behind another context's
    // in-flight transfer must not re-submit once that transfer is recorded.
    const snapshot = await requestStore.getSnapshot()
    if (snapshot.requests.some(request => request.kind === 'unwrap' && request.createdAt >= clickedAt)) {
      throw new Error('A bridge transfer was just submitted in another context; review History before submitting again')
    }
    const evm = EvmService.getInstance()
    const allowance = await evm.getAllowance(token, bridge)
    const approvalRequired = allowance < amount
    const total = approvalRequired ? 3 : 2
    totalApprovals = total
    if (approvalRequired) {
      failureStage = 'token-approval'
      phase.value = {kind: 'approving-token', total: 3}
      await evm.approveAllowance(token, bridge, amount, hash => {
        phase.value = {kind: 'confirming-approval', total: 3, hash}
      })
    }

    const unwrapStep = approvalRequired ? 2 : 1
    failureStage = 'bridge-transfer'
    phase.value = {kind: 'submitting-unwrap', step: unwrapStep, total}
    const {hash, provisionalLogIndex, eventMatched} = await evm.unwrap(
      bridge,
      token,
      amount,
      zenonAddress,
      submittedHash => {
        broadcastHash = submittedHash
        phase.value = {
          kind: 'confirming-unwrap',
          step: unwrapStep,
          total,
          hash: submittedHash,
        }
        trackingResult = requestStore.trackUnwrap({
          id: `${submittedHash}:-1`,
          zts,
          amount: amount.toString(),
          decimals,
          symbol,
          zenonToAddress: zenonAddress,
          approvalCount: total,
          createdAt: Date.now(),
        }).then(() => true, () => false)
      },
    )
    const tracked = trackingResult ? await trackingResult : false
    if (!tracked) {
      phase.value = {
        kind: 'submitted-untracked',
        total,
        hash,
        message: 'Bridge transfer confirmed, but local request tracking failed. Do not submit it again; check History or the Ethereum explorer.',
      }
      return {kind: 'confirmed', hash, provisionalLogIndex, eventMatched, trackingFailed: true}
    }
    phase.value = {kind: 'idle'}
    return {kind: 'confirmed', hash, provisionalLogIndex, eventMatched, trackingFailed: false}
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to submit unwrap'
    const definitivelyReverted = e instanceof EvmSubmissionError && e.kind === 'reverted'
    const submittedHash = e instanceof EvmSubmissionError ? e.hash : broadcastHash as Hex | null
    if (submittedHash && !definitivelyReverted) {
      const tracked = trackingResult ? await trackingResult : false
      const message = 'Bridge transfer was submitted, but confirmation could not be verified. Do not submit it again; check the Ethereum transaction and History.'
      phase.value = {
        kind: 'submitted-unconfirmed',
        total: totalApprovals,
        hash: submittedHash,
        trackingFailed: !tracked,
        message,
      }
      error.value = null
      return {kind: 'submitted-unconfirmed', hash: submittedHash, trackingFailed: !tracked}
    }
    if (submittedHash && definitivelyReverted) {
      const normalized = normalizeEvmHash(submittedHash)
      await requestStore.prune(request =>
        request.kind === 'unwrap' &&
        normalizeEvmHash(request.id.split(':')[0]) === normalized,
      ).catch(() => undefined)
    }
    phase.value = {kind: 'failed', stage: failureStage, message: error.value}
    throw e
  } finally {
    isUnwrapping.value = false
  }
}

async function redeemZenonLocked(request: UnwrapRequestView): Promise<string> {
  error.value = null
  let ownsLock = false
  try {
    const block = BridgeService.getInstance().buildRedeemBlock(
      stripEvmHashPrefix(request.transactionHash),
      request.logIndex,
    )
    const snapshot = await requestStore.getSnapshot()
    // Reclaim only a STALE orphaned pre-prompt placeholder: Syrius runs
    // outside the browser, so its prompt can outlive a crashed dApp context —
    // the placeholder must be older than any plausible prompt lifetime before
    // a new flow may overwrite it. Real-hash and ambiguous locks always refuse.
    // Keyed by the full request id: a lock on the affiliate bonus row (or the
    // main row) sharing this tx hash must never be visible here.
    const existingLock = zenonRedeemLockFor(snapshot.zenonRedeems, request.id)
    const reclaimable =
      requestStore.hasCrossContextLocks() &&
      existingLock !== undefined &&
      canReclaimPlaceholderLock(
        existingLock.hash,
        existingLock.updatedAt,
        Date.now(),
        PLACEHOLDER_LOCK_STALE_MS,
      )
    if (existingLock && !reclaimable) {
      throw new Error('A Zenon redemption for this request is already in progress')
    }
    // Fresh in-lock revalidation (the Zenon analog of the EVM path's
    // redeemsInfo re-read): a queued flow can acquire the lock after polling
    // observed the redemption and cleared the previous holder's persisted
    // lock, while this flow's view still says redeemable. Refuse — fail
    // closed on a failed read — before opening Syrius.
    const fresh = await BridgeService.getInstance()
      .getUnwrapRequest(stripEvmHashPrefix(request.transactionHash), request.logIndex)
      .catch(() => null)
    if (!fresh || fresh.redeemed !== 0 || fresh.revoked !== 0) {
      throw new Error('This redemption is no longer available; refresh and check History')
    }
    ownsLock = true
    await requestStore.setPendingZenonRedeem(request.id, AWAITING_WALLET_RESULT)
    const published = await useZenonWallet().send(block)
    const publishedHash = published.hash.toString()
    setPendingRedeem(request.id, 'confirming')
    try {
      await requestStore.setPendingZenonRedeem(request.id, publishedHash)
    } catch {
      // The block is already published; a failed persist must not surface as a
      // retry CTA. The durable lock must also not remain the reclaimable
      // pre-prompt placeholder (after reload + staleness a new flow could
      // overwrite it while this redemption is live), so best-effort upgrade it
      // to the never-reclaimed ambiguous marker.
      await requestStore.setPendingZenonRedeem(request.id, AMBIGUOUS_WALLET_RESULT).catch(() => undefined)
    }
    return publishedHash
  } catch (e) {
    if (e instanceof ZenonSubmissionError && e.kind === 'ambiguous' && ownsLock) {
      // Syrius may still sign and broadcast. Upgrade the durable lock from the
      // reclaimable pre-prompt placeholder to the never-reclaimed ambiguous
      // marker so no later flow can overwrite it while the block may be live.
      await requestStore.setPendingZenonRedeem(request.id, AMBIGUOUS_WALLET_RESULT).catch(() => undefined)
      setPendingRedeem(request.id, 'confirming')
      error.value = null
      throw e
    }
    if (ownsLock) await requestStore.clearPendingZenonRedeem(request.id).catch(() => undefined)
    setPendingRedeem(request.id)
    error.value = e instanceof Error ? e.message : 'Failed to redeem'
    throw e
  }
}

async function redeemZenon(request: UnwrapRequestView): Promise<string> {
  // Guard and mark BEFORE waiting on the cross-context Web Lock: a click while
  // another context holds the lock gets immediate feedback instead of silently
  // queuing a duplicate Syrius prompt behind it.
  if (pendingRedeems.value[request.id]) throw new Error('A Zenon redemption for this request is already in progress')
  setPendingRedeem(request.id, 'wallet')
  let lockedFlowRan = false
  try {
    // Wallet-action lock: queues behind other contexts (in-lock guards
    // re-validate persisted state) but fails closed without Web Locks —
    // running unlocked would allow duplicate Syrius prompts across tabs.
    return await requestStore.withWalletActionLock(
      `zenon-redeem:${normalizeEvmHash(request.transactionHash)}`,
      () => {
        lockedFlowRan = true
        return redeemZenonLocked(request)
      },
    )
  } catch (e) {
    if (!lockedFlowRan) setPendingRedeem(request.id)
    throw e
  }
}

async function dismissPendingZenonRedeem(id: string): Promise<void> {
  await requestStore.clearPendingZenonRedeem(id).catch(() => undefined)
  setPendingRedeem(id)
}

export type ZenonRedeemRecheckResult = 'released-failed' | 'released-orphan' | 'kept' | 'no-lock'

// Evidence-based resolution of a persisted Zenon redeem lock, runnable from
// the UI's Recheck action. A real block hash is probed on the account chain:
// receive-block processed + the request STILL redeemable (re-read fresh from
// the node) proves the embedded call failed — safe to retry. An orphaned
// pre-prompt placeholder is releasable only after the staleness window
// (Syrius's prompt can outlive the dApp). Ambiguous markers are never released
// here — only protocol advance clears them.
async function recheckZenonRedeem(request: UnwrapRequestView): Promise<ZenonRedeemRecheckResult> {
  const transactionHash = normalizeEvmHash(request.transactionHash)
  // Cross-context lock name intentionally stays coarse (per tx hash, not per
  // row): it just serializes concurrent recheck/redeem UI actions across
  // tabs for the main and bonus rows of one unwrap event.
  return requestStore.withCrossContextLock(`zenon-redeem:${transactionHash}`, async () => {
    const snapshot = await requestStore.getSnapshot()
    // Keyed by the full request id: a lock belonging to the bonus (or main)
    // row sharing this tx hash must be invisible to this row's recheck.
    const lock = zenonRedeemLockFor(snapshot.zenonRedeems, request.id)
    if (!lock) return 'no-lock'
    if (lock.hash === AWAITING_WALLET_RESULT) {
      // The orphan proof requires real Web Lock exclusion to exist at all.
      if (
        requestStore.hasCrossContextLocks() &&
        canReclaimPlaceholderLock(lock.hash, lock.updatedAt, Date.now(), PLACEHOLDER_LOCK_STALE_MS)
      ) {
        await requestStore.clearPendingZenonRedeem(request.id)
        setPendingRedeem(request.id)
        return 'released-orphan'
      }
      return 'kept'
    }
    if (lock.hash === AMBIGUOUS_WALLET_RESULT) return 'kept'
    const outcome = await BridgeService.getInstance()
      .getAccountBlockOutcome(lock.hash)
      .catch(() => null)
    if (outcome !== 'processed') return 'kept'
    const fresh = await BridgeService.getInstance()
      .getUnwrapRequest(stripEvmHashPrefix(request.transactionHash), request.logIndex)
      .catch(() => null)
    if (!fresh || fresh.redeemed !== 0 || fresh.revoked !== 0) return 'kept'
    await requestStore.clearPendingZenonRedeem(request.id)
    setPendingRedeem(request.id)
    return 'released-failed'
  })
}


async function recheckSubmittedUnwrap(): Promise<AuthoritativeEvmOutcome | null> {
  if (phase.value.kind !== 'submitted-unconfirmed') return null
  const {hash} = phase.value
  const outcome = await EvmService.getInstance().getAuthoritativeOutcome(hash)
  if (outcome === 'confirmed') clearPhase()
  if (outcome === 'reverted') {
    const normalized = normalizeEvmHash(hash)
    await requestStore.prune(request =>
      request.kind === 'unwrap' &&
      normalizeEvmHash(request.id.split(':')[0]) === normalized,
    ).catch(() => undefined)
    clearPhase()
  }
  return outcome
}

export function useUnwrap() {
  return {
    isUnwrapping,
    error,
    phase,
    pendingRedeems,
    unwrap,
    redeemZenon,
    clearPendingRedeem: dismissPendingZenonRedeem,
    clearLocalPendingRedeem: (id: string) => {
      setPendingRedeem(id)
    },
    recheckZenonRedeem,
    recheckSubmittedUnwrap,
    resetPhase,
    clearPhase,
  }
}
