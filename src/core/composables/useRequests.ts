import {computed, ref} from 'vue'
import {BridgeService} from '../bridge-service'
import {EvmService} from '../evm-service'
import type {WrapRedeemProgress} from '../evm-service'
import {requestStore, type UnknownWrapOperation} from '../request-store'
import {DEFAULT_MOMENTUM_TIME} from '@/config'
import {config} from '@/config'
import type {TrackedRequest, TokenPairView, UnwrapRequestView, UnwrapStatus, WrapRequestView, WrapStatus} from '@/types'
import type {UnwrapTokenRequest, WrapTokenRequest} from 'znn-typescript-sdk'
import type {Address, Hex} from 'viem'
import {normalizeEvmHash} from '../evm-hash'
import {
  hasUnwrapProtocolAdvanced,
  hasWrapProtocolAdvanced,
  isAuthoritativeLockHash,
} from '../approval-ux'
import {isNonceConsumed} from '../evm-service'
export {normalizeEvmHash} from '../evm-hash'

const wrapRequests = ref<WrapRequestView[]>([])
const unwrapRequests = ref<UnwrapRequestView[]>([])
// Durable hashless safety records for ambiguous wrap submissions, surfaced so
// the Bridge form stays locked across reloads until reconciliation. Hydrated
// straight from storage (not the network poll) and refreshed on every lock
// change; the form must stay gated until the first hydration completes.
const unknownWrapOperations = ref<Array<{id: string} & UnknownWrapOperation>>([])
const unknownWrapsHydrated = ref(false)
const isLoading = ref(false)
const pollingError = ref<string | null>(null)

async function hydrateUnknownWraps(): Promise<void> {
  try {
    const snapshot = await requestStore.getSnapshot()
    unknownWrapOperations.value = Object.entries(snapshot.unknownWraps)
      .map(([id, operation]) => ({id, ...operation}))
    unknownWrapsHydrated.value = true
  } catch {
    // stays un-hydrated; the Bridge form remains gated
  }
}

let locksSubscribed = false
function ensureLockSubscription(): void {
  if (locksSubscribed) return
  locksSubscribed = true
  requestStore.onLocksChanged(() => {
    void hydrateUnknownWraps()
  })
}

// Parallel map id → raw node WrapTokenRequest from the last poll, so the redeem
// handler can source the SDK fields (amount/fee/signature/tokenAddress/toAddress).
let rawById = new Map<string, WrapTokenRequest>()

let intervalId: ReturnType<typeof setInterval> | null = null
let polling = false
let rerunRequested = false
let rerunWaiters: Array<{resolve: () => void; reject: (error: unknown) => void}> = []
let getEvmAddressFn: (() => string | null) | null = null
let getBridgeFn: (() => string | null) | null = null
let getZenonAddressFn: (() => string | null) | null = null
let getMomentumTimeFn: (() => number) | null = null
let getTokenPairsFn: (() => TokenPairView[]) | null = null

export function findTrackedUnwrapByHash(
  requests: TrackedRequest[],
  transactionHash: string,
): TrackedRequest | undefined {
  const normalized = normalizeEvmHash(transactionHash)
  return requests.find(request =>
    request.kind === 'unwrap' && normalizeEvmHash(request.id.split(':')[0]) === normalized,
  )
}

// Reconciliation for ambiguous (hashless) wrap submissions against the
// ORIGINATING account chain: an operation is proven published only by a wrap
// send on its own Zenon account above its own pre-send frontier height with
// the exact token and amount. Candidate blocks are consumed one-to-one
// (oldest operation first) so a single published block can never clear
// multiple ambiguous operations. A null frontier (pre-send read failed) never
// auto-reconciles. Returns the ids of proven operations.
export function reconcileUnknownWrapOperations(
  operations: Array<{id: string} & UnknownWrapOperation>,
  accountChainWrapSends: Array<{hash: string; height: number; zts: string; amount: string}>,
): string[] {
  const availableBlocks = [...accountChainWrapSends]
  const proven: string[] = []
  const ordered = [...operations].sort((a, b) => a.createdAt - b.createdAt)
  for (const operation of ordered) {
    if (operation.frontierHeight === null) continue
    const index = availableBlocks.findIndex(block =>
      block.height > (operation.frontierHeight as number) &&
      block.zts === operation.zts &&
      block.amount === operation.amount,
    )
    if (index === -1) continue
    availableBlocks.splice(index, 1)
    proven.push(operation.id)
  }
  return proven
}

async function runPoll(): Promise<void> {
  const addr = getEvmAddressFn?.() ?? null
  const bridge = getBridgeFn?.() ?? null
  await poll(addr, bridge)
}

async function getAllWrapRequests(evmAddress: string): Promise<WrapTokenRequest[]> {
  const result: WrapTokenRequest[] = []
  for (let page = 0; page < 20; page += 1) {
    const response = await BridgeService.getInstance().getWrapRequests(evmAddress, page, 50)
    result.push(...response.list)
    if (result.length >= response.count || response.list.length === 0) break
  }
  return result
}

async function getAllUnwrapRequests(zenonAddress: string): Promise<UnwrapTokenRequest[]> {
  const result: UnwrapTokenRequest[] = []
  for (let page = 0; page < 20; page += 1) {
    const response = await BridgeService.getInstance().getUnwrapRequests(zenonAddress, page, 50)
    result.push(...response.list)
    if (result.length >= response.count || response.list.length === 0) break
  }
  return result
}

// Pure status decision, unit-testable without viem. When the signature is empty
// progress is null (the composable skips the EVM call in that branch).
export function deriveWrapStatus(
  signature: string,
  progress: WrapRedeemProgress | null,
): WrapStatus {
  if (!signature) return 'signing'
  if (!progress) return 'signing'
  if (progress.kind === 'fully-redeemed') return 'redeemed'
  if (progress.kind === 'unredeemed') return 'redeemable'
  return progress.remainingSeconds > 0 ? 'waiting-delay' : 'redeemable-2'
}

// Pure status decision for unwraps, unit-testable without viem/SDK. STRICT order
// is load-bearing: pending → revoked → redeemed → signing → redeemableIn sign.
// The signing (empty signature) check MUST precede the redeemableIn sign test so
// an unsigned + negative request is `signing`, not `broken`.
export function deriveUnwrapStatus(
  req: {signature: string; redeemed: number; revoked: number; redeemableIn: number},
  isPendingOnly: boolean,
): UnwrapStatus {
  if (isPendingOnly) return 'pending'
  if (req.revoked === 1) return 'revoked'
  if (req.redeemed === 1) return 'redeemed'
  if (!req.signature) return 'signing'
  if (req.redeemableIn < 0) return 'broken'
  if (req.redeemableIn > 0) return 'waiting'
  return 'redeemable'
}

const MAX_POLL_RERUNS = 5

async function poll(evmAddress: string | null, bridge: string | null): Promise<void> {
  if (polling) {
    rerunRequested = true
    return new Promise<void>((resolve, reject) => {
      rerunWaiters.push({resolve, reject})
    })
  }
  polling = true
  try {
    // A pass that mutates the lock store invalidates its own snapshot; rerun
    // inside the same call so an awaited refresh never resolves on stale views.
    let committed = false
    for (let attempt = 0; attempt < MAX_POLL_RERUNS && !committed; attempt += 1) {
      committed = await pollOnce(evmAddress, bridge)
    }
    // Never resolve successfully without a committed pass — callers (recheck
    // handlers) rely on awaited refreshes reflecting current state.
    if (!committed) throw new Error('Request state kept changing during refresh; retry shortly')
  } finally {
    polling = false
    if (rerunRequested) {
      rerunRequested = false
      const waiters = rerunWaiters
      rerunWaiters = []
      void runPoll().then(
        () => waiters.forEach(waiter => waiter.resolve()),
        e => {
          pollingError.value = e instanceof Error ? e.message : 'Failed to refresh requests'
          waiters.forEach(waiter => waiter.reject(e))
        },
      )
    }
  }
}

// One polling pass. Returns true when its views were committed, false when a
// mid-pass lock-store mutation invalidated the snapshot and a rerun is needed.
async function pollOnce(evmAddress: string | null, bridge: string | null): Promise<boolean> {
  {
    const snapshot = await requestStore.getSnapshot()
    const allTracked = snapshot.requests
    const evmClaims = snapshot.evmClaims
    const zenonRedeems = snapshot.zenonRedeems
    const evmTxFacts = snapshot.evmTxFacts
    const unknownWraps = snapshot.unknownWraps
    const pairs = new Map((getTokenPairsFn?.() ?? []).map(pair => [pair.zts, pair]))
    const outcomeHashes = new Set<string>()
    for (const lock of Object.values(evmClaims)) {
      if (isAuthoritativeLockHash(lock.hash)) outcomeHashes.add(normalizeEvmHash(lock.hash))
    }
    for (const tracked of allTracked) {
      if (tracked.kind === 'unwrap') outcomeHashes.add(normalizeEvmHash(tracked.id.split(':')[0]))
    }
    const outcomeEntries = await Promise.all(
      [...outcomeHashes].map(async hash => [
        hash,
        await EvmService.getInstance().getAuthoritativeOutcomeWithFacts(hash as Hex),
      ] as const),
    )
    const outcomes = new Map(
      outcomeEntries.map(([hash, result]) => [hash, result.outcome] as const),
    )

    // Capture sender+nonce while a transaction is still visible on some RPC —
    // the only facts that can later PROVE a vanished hash is dead.
    for (const [hash, result] of outcomeEntries) {
      if (result.from !== undefined && result.nonce !== undefined && !evmTxFacts[hash]) {
        await requestStore.recordEvmTxFacts(hash, {from: result.from, nonce: result.nonce})
      }
    }

    // A hash is provably dropped ONLY on positive evidence: it is universally
    // absent AND its recorded nonce has been consumed on-chain by another
    // transaction (speed-up replacement / eviction followed by reuse).
    // Absence alone — however long — never authorizes release: the tx may
    // live in a private mempool none of the configured RPCs can see.
    const droppedHashes = new Set<string>()
    for (const [hash, outcome] of outcomes) {
      if (outcome !== 'absent') continue
      const facts = evmTxFacts[hash]
      if (!facts) continue
      const confirmedCount = await EvmService.getInstance()
        .getConfirmedTransactionCount(facts.from as Address)
        .catch(() => null)
      if (confirmedCount !== null && isNonceConsumed(facts.nonce, confirmedCount)) {
        droppedHashes.add(hash)
      }
    }

    // Reconcile ambiguous (hashless) wrap submissions against each operation's
    // originating Zenon account chain: a wrap send above the recorded pre-send
    // frontier with the exact token/amount proves publication.
    const operationsByAccount = new Map<string, Array<{id: string} & UnknownWrapOperation>>()
    for (const [operationId, operation] of Object.entries(unknownWraps)) {
      if (operation.frontierHeight === null) continue
      const group = operationsByAccount.get(operation.zenonFromAddress) ?? []
      group.push({id: operationId, ...operation})
      operationsByAccount.set(operation.zenonFromAddress, group)
    }
    for (const [account, operations] of operationsByAccount) {
      const minFrontier = Math.min(...operations.map(op => op.frontierHeight as number))
      const wrapSends = await BridgeService.getInstance()
        .findWrapSendsAfter(account, minFrontier)
        .catch(() => null)
      if (!wrapSends) continue
      for (const provenId of reconcileUnknownWrapOperations(operations, wrapSends)) {
        await requestStore.clearUnknownWrap(provenId)
      }
    }

    // Wrap section — runs only when both the EVM address and bridge are known.
    if (evmAddress && bridge) {
      const list = await getAllWrapRequests(evmAddress)
      const nextRaw = new Map<string, WrapTokenRequest>()
      const views: WrapRequestView[] = []
      const nodeIds = new Set<string>()

      const progressEntries = await Promise.all(list.map(async request => {
        const id = request.id.toString()
        const progress = request.signature
          ? await EvmService.getInstance().getWrapRedeemProgress(
              bridge as Address,
              request.tokenAddress as Address,
              ('0x' + id) as Hex,
            )
          : null
        return [id, progress] as const
      }))
      const progressById = new Map(progressEntries)

      for (const request of list) {
        const id = request.id.toString()
        nodeIds.add(id)
        nextRaw.set(id, request)

        const progress: WrapRedeemProgress | null = progressById.get(id) ?? null
        const status = deriveWrapStatus(request.signature, progress)
        const claimLock = evmClaims[id]
        let pendingClaimHash: string | undefined = claimLock?.hash
        let pendingClaimStage: 1 | 2 | undefined = claimLock?.stage
        if (pendingClaimHash && pendingClaimStage) {
          const normalizedClaimHash = normalizeEvmHash(pendingClaimHash)
          const outcome = outcomes.get(normalizedClaimHash)
          const protocolAdvanced = hasWrapProtocolAdvanced(pendingClaimStage, status)
          const dropped = droppedHashes.has(normalizedClaimHash)
          if (outcome === 'reverted' || protocolAdvanced || dropped) {
            await requestStore.clearPendingEvmClaim(id)
            await requestStore.clearEvmTxFacts(normalizedClaimHash)
            pendingClaimHash = undefined
            pendingClaimStage = undefined
          }
        }
        const pair = pairs.get(request.tokenStandard.toString())
        views.push({
          id,
          zts: request.tokenStandard.toString(),
          amount: BigInt(request.amount.toString()),
          decimals: pair?.decimals ?? 0,
          symbol: pair?.symbol ?? request.tokenStandard.toString(),
          toAddress: request.toAddress,
          status,
          remainingSeconds:
            progress && progress.kind === 'waiting-delay' ? progress.remainingSeconds : undefined,
          pendingClaimHash,
          pendingClaimStage,
        })
      }

      // Just-submitted wraps not yet indexed by the node show as a synthetic
      // `signing` row.
      for (const t of allTracked) {
        if (t.kind !== 'wrap' || nodeIds.has(t.id)) continue
        if (t.evmChainId !== config.evmChainId || t.zenonChainId !== config.zenonChainId) continue
        if (t.evmToAddress?.toLowerCase() !== evmAddress.toLowerCase()) continue
        views.push({
          id: t.id,
          zts: t.zts,
          amount: BigInt(t.amount),
          decimals: t.decimals,
          symbol: t.symbol,
          toAddress: t.evmToAddress ?? '',
          status: 'signing',
          pendingClaimHash: evmClaims[t.id]?.hash,
          pendingClaimStage: evmClaims[t.id]?.stage,
        })
      }

      if (requestStore.getRevision() !== snapshot.revision) return false
      if ((getEvmAddressFn?.() ?? '').toLowerCase() === evmAddress.toLowerCase()) {
        rawById = nextRaw
        wrapRequests.value = views
      }
    } else {
      rawById = new Map()
      wrapRequests.value = []
    }

    // Unwrap section — independent of the wrap guard; runs when the Zenon
    // recipient address is known.
    const zenonAddr = getZenonAddressFn?.() ?? null
    if (zenonAddr) {
      const momentumTime = getMomentumTimeFn?.() ?? DEFAULT_MOMENTUM_TIME
      const list = await getAllUnwrapRequests(zenonAddr)
      const unwrapViews: UnwrapRequestView[] = []
      const nodeIds = new Set<string>()
      const nodeHashes = new Set<string>()

      for (const req of list) {
        const transactionHash = normalizeEvmHash(req.transactionHash.toString())
        const id = `${transactionHash}:${req.logIndex}`
        const tracked = findTrackedUnwrapByHash(allTracked, transactionHash)
        nodeIds.add(id)
        nodeHashes.add(transactionHash)
        const status = deriveUnwrapStatus(req, false)
        let pendingZenonRedeemHash: string | undefined = zenonRedeems[transactionHash]?.hash
        // Forward-only: a transient regression (signing/waiting during TSS
        // re-signing) must never release the redeem lock.
        if (pendingZenonRedeemHash && hasUnwrapProtocolAdvanced(status)) {
          await requestStore.clearPendingZenonRedeem(id)
          pendingZenonRedeemHash = undefined
        }
        const pair = pairs.get(req.tokenStandard.toString())
        unwrapViews.push({
          id,
          transactionHash,
          logIndex: req.logIndex,
          zts: req.tokenStandard.toString(),
          amount: BigInt(req.amount.toString()),
          decimals: pair?.decimals ?? 0,
          symbol: pair?.symbol ?? req.tokenStandard.toString(),
          toAddress: req.toAddress.toString(),
          status,
          remainingSeconds: status === 'waiting' ? req.redeemableIn * momentumTime : undefined,
          totalApprovals: tracked?.approvalCount,
          pendingZenonRedeemHash,
        })
      }

      for (const t of allTracked) {
        if (t.kind !== 'unwrap') continue
        if (t.evmChainId !== config.evmChainId || t.zenonChainId !== config.zenonChainId) continue
        if (t.zenonToAddress !== zenonAddr) continue
        const [rawHash, idx] = t.id.split(':')
        const hash = normalizeEvmHash(rawHash)
        if (nodeHashes.has(hash)) continue
        const id = `${hash}:${idx}`
        if (nodeIds.has(id)) continue
        const outcome = outcomes.get(hash) ?? 'unknown'
        // Prune on a consensus revert, or on positive dropped evidence
        // (universally absent AND its nonce consumed by another transaction).
        // Either way this transfer can never exist on-chain under this hash.
        if (outcome === 'reverted' || droppedHashes.has(hash)) {
          await requestStore.prune(request =>
            request.kind === 'unwrap' &&
            normalizeEvmHash(request.id.split(':')[0]) === hash,
          )
          await requestStore.clearEvmTxFacts(hash)
          continue
        }
        unwrapViews.push({
          id,
          transactionHash: hash,
          logIndex: Number(idx),
          zts: t.zts,
          amount: BigInt(t.amount),
          decimals: t.decimals,
          symbol: t.symbol,
          toAddress: t.zenonToAddress ?? '',
          status: outcome === 'confirmed' ? 'pending' : 'submitted',
          totalApprovals: t.approvalCount,
          pendingZenonRedeemHash: zenonRedeems[hash]?.hash,
        })
      }

      if (requestStore.getRevision() !== snapshot.revision) return false
      if ((getZenonAddressFn?.() ?? '') === zenonAddr) unwrapRequests.value = unwrapViews
    } else {
      unwrapRequests.value = []
    }
    const finalWrapIds = new Set(
      wrapRequests.value.filter(r => r.status === 'redeemed').map(r => r.id),
    )
    const finalUnwrapHashes = new Set(
      unwrapRequests.value
        .filter(r => r.status === 'redeemed' || r.status === 'revoked')
        .map(r => normalizeEvmHash(r.transactionHash)),
    )
    if (finalWrapIds.size || finalUnwrapHashes.size) {
      await requestStore.prune(request =>
        request.kind === 'wrap'
          ? finalWrapIds.has(request.id)
          : finalUnwrapHashes.has(normalizeEvmHash(request.id.split(':')[0])),
      )
    }
    return true
  }
}

export function useRequests() {
  const activeRequests = computed(() => wrapRequests.value.filter(r => r.status !== 'redeemed'))
  const activeUnwrapRequests = computed(() =>
    unwrapRequests.value.filter(r => r.status !== 'redeemed' && r.status !== 'revoked'),
  )

  function getRawWrapRequest(id: string): WrapTokenRequest | undefined {
    return rawById.get(id)
  }

  function startPolling(
    getEvmAddress: () => string | null,
    getBridge: () => string | null,
    getZenonAddress: () => string | null,
    getMomentumTime: () => number,
    getTokenPairs: () => TokenPairView[],
  ): void {
    getEvmAddressFn = getEvmAddress
    getBridgeFn = getBridge
    getZenonAddressFn = getZenonAddress
    getMomentumTimeFn = getMomentumTime
    getTokenPairsFn = getTokenPairs
    // Enforce durable safety records immediately — never wait for the first
    // full network poll to finish before the form can be gated.
    ensureLockSubscription()
    void hydrateUnknownWraps()
    if (intervalId === null) {
      intervalId = setInterval(() => {
        void runPoll().catch(e => {
          pollingError.value = e instanceof Error ? e.message : 'Failed to refresh requests'
        })
      }, 30_000)
    }
    isLoading.value = true
    void runPoll()
      .then(() => {
        pollingError.value = null
      })
      .catch(e => {
        pollingError.value = e instanceof Error ? e.message : 'Failed to refresh requests'
      })
      .finally(() => {
        isLoading.value = false
      })
  }

  function stopPolling(): void {
    if (intervalId !== null) {
      clearInterval(intervalId)
      intervalId = null
    }
  }

  async function refresh(): Promise<void> {
    await runPoll()
  }

  async function refreshForAccountChange(): Promise<void> {
    rawById = new Map()
    wrapRequests.value = []
    unwrapRequests.value = []
    await runPoll()
  }

  return {
    wrapRequests,
    activeRequests,
    unwrapRequests,
    activeUnwrapRequests,
    unknownWrapOperations,
    unknownWrapsHydrated,
    isLoading,
    pollingError,
    getRawWrapRequest,
    startPolling,
    stopPolling,
    refresh,
    refreshForAccountChange,
  }
}
