import {ref} from 'vue'
import {parseAmount} from '../amount'
import {BridgeService} from '../bridge-service'
import {EvmService, EvmSubmissionError, tssSignatureToHex} from '../evm-service'
import type {AuthoritativeEvmOutcome} from '../evm-service'
import {requestStore} from '../request-store'
import {useZenonWallet} from './useZenonWallet'
import type {WrapTokenRequest} from 'znn-typescript-sdk'
import type {Address, Hex} from 'viem'
import {
  AMBIGUOUS_WALLET_RESULT,
  AWAITING_WALLET_RESULT,
  canReclaimPlaceholderLock,
  type PendingRedeemPhase,
} from '../approval-ux'
import {ZenonSubmissionError} from '../zenon-wallet-service'

export type WrapPhase =
  | {kind: 'idle'}
  | {kind: 'submitting-wrap'}
  | {kind: 'submitted-untracked'; id: string; message: string}
  // znn_send ended without a result (e.g. relay timeout): Syrius may still
  // sign and broadcast the wrap block, so retrying could transfer twice. The
  // block hash is unknown — reconciliation is a new wrap request appearing on
  // the node for this account.
  | {kind: 'submitted-unknown'; message: string}
  | {kind: 'failed'; message: string}

export type WrapSubmissionResult = {id: string; trackingFailed: boolean}
export type WrapRedeemResult =
  | {kind: 'confirmed'; hash: Hex; claimStage: 1 | 2}
  | {kind: 'already-redeemed'}

const isWrapping = ref(false)
const error = ref<string | null>(null)
const phase = ref<WrapPhase>({kind: 'idle'})
const pendingRedeems = ref<Record<string, PendingRedeemPhase | undefined>>({})
const pendingRedeemHashes = ref<Record<string, Hex | undefined>>({})
const pendingRedeemStages = ref<Record<string, 1 | 2 | undefined>>({})

function setPendingRedeem(id: string, pending?: PendingRedeemPhase): void {
  if (pending) pendingRedeems.value = {...pendingRedeems.value, [id]: pending}
  else {
    const {[id]: _finished, ...remaining} = pendingRedeems.value
    pendingRedeems.value = remaining
  }
}

function setPendingRedeemHash(id: string, hash?: Hex): void {
  if (hash) pendingRedeemHashes.value = {...pendingRedeemHashes.value, [id]: hash}
  else {
    const {[id]: _finished, ...remaining} = pendingRedeemHashes.value
    pendingRedeemHashes.value = remaining
  }
}

function setPendingRedeemStage(id: string, stage?: 1 | 2): void {
  if (stage) pendingRedeemStages.value = {...pendingRedeemStages.value, [id]: stage}
  else {
    const {[id]: _finished, ...remaining} = pendingRedeemStages.value
    pendingRedeemStages.value = remaining
  }
}

function generateUnknownWrapId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function resetPhase(): void {
  if (!isWrapping.value && phase.value.kind === 'failed') {
    phase.value = {kind: 'idle'}
    error.value = null
  }
}

function clearPhase(): void {
  if (!isWrapping.value) {
    phase.value = {kind: 'idle'}
    error.value = null
  }
}

async function wrap(
  evmToAddress: string,
  humanAmount: string | number,
  decimals: number,
  zts: string,
  symbol: string,
  zenonFromAddress: string,
): Promise<WrapSubmissionResult> {
  // Synchronous reentrancy guard: rapid double-submission races the UI's
  // awaited pre-checks, so the composable itself must refuse before any await.
  if (isWrapping.value) throw new Error('A wrap is already in progress')
  const clickedAt = Date.now()
  isWrapping.value = true
  error.value = null
  phase.value = {kind: 'submitting-wrap'}
  let lockedFlowRan = false
  try {
    // Account-scoped NON-QUEUING exclusive lock: two tabs can otherwise both
    // pass their UI gates and open two Syrius prompts for the same transfer,
    // and a QUEUED click would run after the other tab's completed submission
    // against state the user never saw. Fails closed without Web Locks.
    return await requestStore.withExclusiveSourceLock(
      `wrap-submit:${zenonFromAddress}`,
      () => {
        lockedFlowRan = true
        return wrapLocked(evmToAddress, humanAmount, decimals, zts, symbol, zenonFromAddress, clickedAt)
      },
    )
  } catch (e) {
    if (!lockedFlowRan) {
      isWrapping.value = false
      error.value = e instanceof Error ? e.message : 'Failed to submit wrap'
      phase.value = {kind: 'failed', message: error.value}
    }
    throw e
  }
}

async function wrapLocked(
  evmToAddress: string,
  humanAmount: string | number,
  decimals: number,
  zts: string,
  symbol: string,
  zenonFromAddress: string,
  clickedAt: number,
): Promise<WrapSubmissionResult> {
  let id: string
  let operationId: string | null = null
  try {
    // Atomic in-lock checks against durable state: another context's live
    // unknown-wrap intent, or a wrap recorded after this click (a submission
    // that queued behind another tab's in-flight transfer), must refuse.
    const snapshot = await requestStore.getSnapshot()
    if (Object.values(snapshot.unknownWraps).some(op => op.zenonFromAddress === zenonFromAddress)) {
      throw new Error('A wrap from this Zenon account is already in progress; resolve it in History first')
    }
    if (snapshot.requests.some(request => request.kind === 'wrap' && request.createdAt >= clickedAt)) {
      throw new Error('A wrap was just submitted in another context; review History before submitting again')
    }
    const block = BridgeService.getInstance().buildWrapBlock(evmToAddress, humanAmount, decimals, zts)
    // Persist the safety intent BEFORE the wallet call: a crash while Syrius
    // holds the prompt — or right after broadcast — must still leave a durable
    // record, so the wallet prompt may not open unless this write succeeded.
    // The originating account and the highest pre-send frontier observed by
    // both pinned RPCs are what later let polling PROVE publication from the
    // account chain. If either read fails, null prevents automatic release.
    const frontierHeight = await BridgeService.getInstance()
      .getAccountFrontierHeight(zenonFromAddress)
      .catch(() => null)
    operationId = generateUnknownWrapId()
    try {
      await requestStore.setUnknownWrap(operationId, {
        evmToAddress,
        zenonFromAddress,
        frontierHeight,
        zts,
        amount: parseAmount(humanAmount, decimals).toString(),
        decimals,
        symbol,
        createdAt: Date.now(),
      })
    } catch {
      operationId = null
      throw new Error(
        'Could not record the transfer safety lock, so the wrap was not submitted. Check storage availability and retry.',
      )
    }
    try {
      const published = await useZenonWallet().send(block)
      id = published.hash.toString()
    } catch (e) {
      if (e instanceof ZenonSubmissionError && e.kind === 'ambiguous') {
        // Syrius may have received — and may still broadcast — the block. The
        // durable intent stays; account-chain reconciliation resolves it.
        error.value = null
        phase.value = {
          kind: 'submitted-unknown',
          message: 'The wrap may have been submitted, but Syrius did not return a result. Do not submit it again; check Syrius and History before retrying.',
        }
        isWrapping.value = false
        throw e
      }
      // Definite rejection or provably pre-send failure: release the intent.
      await requestStore.clearUnknownWrap(operationId).catch(() => undefined)
      throw e
    }
  } catch (e) {
    if (e instanceof ZenonSubmissionError && e.kind === 'ambiguous') throw e
    error.value = e instanceof Error ? e.message : 'Failed to submit wrap'
    phase.value = {kind: 'failed', message: error.value}
    isWrapping.value = false
    throw e
  }

  try {
    await requestStore.trackWrap({
      id,
      zts,
      amount: parseAmount(humanAmount, decimals).toString(),
      decimals,
      symbol,
      evmToAddress,
      createdAt: Date.now(),
    })
    // The known hash is durably tracked — only now may the hashless intent go.
    if (operationId) await requestStore.clearUnknownWrap(operationId).catch(() => undefined)
    phase.value = {kind: 'idle'}
    return {id, trackingFailed: false}
  } catch (e) {
    // Tracking failed: keep the durable intent as the only reload-safe record;
    // account-chain reconciliation clears it once the node shows the wrap.
    const message = 'Wrap submitted, but local request tracking failed. Do not submit it again; check History or the Zenon explorer.'
    phase.value = {kind: 'submitted-untracked', id, message}
    return {id, trackingFailed: true}
  } finally {
    isWrapping.value = false
  }
}

async function redeemEvmLocked(
  request: WrapTokenRequest,
  bridge: Address,
  onSubmitted?: (hash: Hex, claimStage: 1 | 2) => void | Promise<void>,
): Promise<WrapRedeemResult> {
  const requestId = request.id.toString()
  let broadcast = false
  let ownsLock = false
  let definitivelyReverted = false
  const token = request.tokenAddress as Address
  const wrapId = ('0x' + request.id.toString()) as Hex
  try {
    const {evmClaims} = await requestStore.getSnapshot()
    // A leftover pre-prompt placeholder is reclaimable here: this flow holds
    // the exclusive Web Lock, so the flow that wrote it has terminated, and a
    // terminating flow always clears or upgrades its placeholder — a survivor
    // means it died mid-prompt, taking its MetaMask popup with it. That proof
    // requires the Web Locks API to actually exist (without it the writer may
    // be live in another tab). Real-hash and ambiguous locks always refuse.
    const existingLock = evmClaims[requestId]
    const reclaimable =
      requestStore.hasCrossContextLocks() &&
      existingLock !== undefined &&
      canReclaimPlaceholderLock(existingLock.hash, existingLock.updatedAt, Date.now(), 0)
    if (existingLock && !reclaimable) throw new Error('A claim for this request is already in progress')
    const progress = await EvmService.getInstance().getWrapRedeemProgress(bridge, token, wrapId)
    if (progress.kind === 'fully-redeemed') return {kind: 'already-redeemed'}
    if (progress.kind === 'waiting-delay' && progress.remainingSeconds > 0) {
      throw new Error('The final claim is not available until the security delay ends')
    }
    const claimStage: 1 | 2 = progress.kind === 'unredeemed' ? 1 : 2
    ownsLock = true
    await requestStore.setPendingEvmClaim(requestId, AWAITING_WALLET_RESULT, claimStage)

    const to = request.toAddress as Address
    const netAmount = BigInt(request.amount.toString()) - BigInt(request.fee.toString())
    const nonce = BigInt('0x' + request.id.toString())
    const signature = tssSignatureToHex(request.signature)
    const hash = await EvmService.getInstance().redeem(
      bridge,
      to,
      token,
      netAmount,
      nonce,
      signature,
      async submittedHash => {
        broadcast = true
        setPendingRedeem(requestId, 'confirming')
        setPendingRedeemHash(requestId, submittedHash)
        setPendingRedeemStage(requestId, claimStage)
        try {
          await requestStore.setPendingEvmClaim(requestId, submittedHash, claimStage)
        } catch {
          // The transaction is already broadcast; a failed persist must not
          // surface as a submission error. The in-memory lock and real hash
          // stay authoritative for recheck — but the durable lock must not be
          // left as a reclaimable pre-prompt placeholder (a reload would lose
          // the in-memory hash and let a new flow reclaim it mid-confirmation),
          // so best-effort upgrade it to the never-reclaimed ambiguous marker.
          await requestStore
            .setPendingEvmClaim(requestId, AMBIGUOUS_WALLET_RESULT, claimStage)
            .catch(() => undefined)
        }
        onSubmitted?.(submittedHash, claimStage)
      },
    )
    return {kind: 'confirmed', hash, claimStage}
  } catch (e) {
    definitivelyReverted = e instanceof EvmSubmissionError && e.kind === 'reverted'
    if (definitivelyReverted) {
      await requestStore.clearPendingEvmClaim(requestId).catch(() => undefined)
    }
    throw e
  } finally {
    if (!broadcast && ownsLock) {
      await requestStore.clearPendingEvmClaim(requestId).catch(() => undefined)
    }
    // Keep an ambiguous post-broadcast failure locked. An authoritative receipt
    // or protocol-state advance is the only automatic recovery.
    if (!broadcast || definitivelyReverted) {
      setPendingRedeem(requestId)
      setPendingRedeemHash(requestId)
      setPendingRedeemStage(requestId)
    }
  }
}

async function redeemEvm(
  request: WrapTokenRequest,
  bridge: Address,
  onSubmitted?: (hash: Hex, claimStage: 1 | 2) => void | Promise<void>,
): Promise<WrapRedeemResult> {
  const requestId = request.id.toString()
  // Guard and mark BEFORE waiting on the cross-context Web Lock: a click while
  // another context holds the lock gets immediate feedback instead of silently
  // queuing a duplicate MetaMask prompt behind it.
  if (pendingRedeems.value[requestId]) throw new Error('A claim for this request is already in progress')
  setPendingRedeem(requestId, 'wallet')
  let lockedFlowRan = false
  try {
    // Wallet-action lock: queues behind other contexts (in-lock guards
    // re-validate persisted state) but fails closed without Web Locks —
    // running unlocked would allow duplicate MetaMask prompts across tabs.
    return await requestStore.withWalletActionLock(
      `evm-claim:${requestId}`,
      () => {
        lockedFlowRan = true
        return redeemEvmLocked(request, bridge, onSubmitted)
      },
    )
  } catch (e) {
    if (!lockedFlowRan) setPendingRedeem(requestId)
    throw e
  }
}

async function recheckPendingRedeem(id: string, hash: Hex): Promise<AuthoritativeEvmOutcome> {
  const outcome = await EvmService.getInstance().getAuthoritativeOutcome(hash)
  if (outcome === 'reverted') await dismissPendingRedeem(id)
  return outcome
}

async function dismissPendingRedeem(id: string): Promise<void> {
  await requestStore.clearPendingEvmClaim(id).catch(() => undefined)
  setPendingRedeem(id)
  setPendingRedeemHash(id)
  setPendingRedeemStage(id)
}

// UI-reachable recovery for a crash-orphaned pre-prompt claim placeholder.
// Runs under the claim's exclusive Web Lock, which proves the flow that wrote
// the placeholder is dead (its MetaMask popup died with its browser context).
// Ambiguous markers and real hashes are never released here.
async function recoverClaimPlaceholder(requestId: string): Promise<'released' | 'kept' | 'no-lock'> {
  return requestStore.withCrossContextLock(`evm-claim:${requestId}`, async () => {
    const {evmClaims} = await requestStore.getSnapshot()
    const lock = evmClaims[requestId]
    if (!lock) return 'no-lock'
    // Without the Web Locks API the "writer is dead" proof does not exist.
    if (!requestStore.hasCrossContextLocks()) return 'kept'
    if (!canReclaimPlaceholderLock(lock.hash, lock.updatedAt, Date.now(), 0)) return 'kept'
    await requestStore.clearPendingEvmClaim(requestId)
    setPendingRedeem(requestId)
    setPendingRedeemHash(requestId)
    setPendingRedeemStage(requestId)
    return 'released'
  })
}

export function useWrap() {
  return {
    isWrapping,
    error,
    phase,
    pendingRedeems,
    pendingRedeemHashes,
    pendingRedeemStages,
    wrap,
    redeemEvm,
    clearPendingRedeem: dismissPendingRedeem,
    clearLocalPendingRedeem: (id: string) => {
      setPendingRedeem(id)
      setPendingRedeemHash(id)
      setPendingRedeemStage(id)
    },
    recheckPendingRedeem,
    recoverClaimPlaceholder,
    dismissPendingRedeem,
    resetPhase,
    clearPhase,
  }
}
