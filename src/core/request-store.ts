import {storageService} from './storage/storage-service'
import type {TrackedRequest} from '@/types'
import {config} from '@/config'
import {normalizeEvmHash} from './evm-hash'

const STORAGE_KEY = 'nom-bridge:requests:v2'
const LOCKS_STORAGE_KEY = 'nom-bridge:action-locks:v1'

export interface UnknownWrapOperation {
  evmToAddress: string
  // Originating Zenon account and its frontier height read authoritatively
  // pre-send: reconciliation scans THIS account's chain for a wrap send above
  // THIS height. null frontier → the read failed, so the operation can never
  // be auto-reconciled (fail closed).
  zenonFromAddress: string
  frontierHeight: number | null
  zts: string
  amount: string
  decimals: number
  symbol: string
  createdAt: number
}

interface PendingActionLocks {
  evmClaims: Record<string, {hash: string; stage: 1 | 2; updatedAt?: number}>
  // `fence: true` marks the bare-hash compatibility entry written alongside
  // every full-id lock (see setPendingZenonRedeem) — old bundles that still
  // read/write bare-hash keys see it and refuse to redeem either row.
  zenonRedeems: Record<string, {hash: string; updatedAt?: number; fence?: boolean}>
  // Sender + nonce captured while a broadcast transaction was still visible on
  // some RPC, keyed by normalized transaction hash. The only positive evidence
  // that a later-vanished hash can never mine (nonce consumption).
  evmTxFacts: Record<string, {from: string; nonce: number}>
  // Hashless source-transfer safety records for wraps whose znn_send ended
  // ambiguously — Syrius may still broadcast the block, so the form must stay
  // locked across reloads until the node shows a matching new wrap request.
  unknownWraps: Record<string, UnknownWrapOperation>
}

// Local mutations not yet confirmed persisted. Replayed over cross-context
// storage snapshots so a stale event can neither resurrect a deleted lock nor
// drop a just-added one.
type LockOp = {
  scope: keyof PendingActionLocks
  op: 'set' | 'delete'
  key: string
  value?: unknown
}

// In-memory mirror, loaded once on first access. Mutations update the mirror
// synchronously and persist asynchronously; reads go through the mirror so they
// never block on storage.
let mirror: TrackedRequest[] | null = null
let locksMirror: PendingActionLocks | null = null
let revision = 0
let locksDirty = false
let locksWriteVersion = 0
let pendingLockOps: LockOp[] = []

function emptyLocks(): PendingActionLocks {
  return {evmClaims: {}, zenonRedeems: {}, evmTxFacts: {}, unknownWraps: {}}
}

function normalizeLocks(value: Partial<PendingActionLocks> | null | undefined): PendingActionLocks {
  return {
    evmClaims: value?.evmClaims ?? {},
    zenonRedeems: value?.zenonRedeems ?? {},
    evmTxFacts: value?.evmTxFacts ?? {},
    unknownWraps: value?.unknownWraps ?? {},
  }
}

// Zenon redeem locks are keyed by the full `txHash:logIndex` id: an affiliate
// bonus request shares its tx hash with the main unwrap, and redeeming one
// must not silently unlock the other. Because old bundles (and locks they
// persisted) key by the bare tx hash — and an old bundle can lock EITHER row
// (bonus rows already exist via other dApps' referrals) — every full-id lock
// is accompanied by a bare-hash compatibility fence, and any bare entry
// conservatively blocks BOTH rows until it is released. Main and bonus
// therefore redeem sequentially, never concurrently.
function normalizeUnwrapLockKey(id: string): string {
  const [hash, index] = id.split(':')
  return `${normalizeEvmHash(hash)}:${index}`
}

type ZenonRedeemLock = {hash: string; updatedAt?: number; fence?: boolean}

// BLOCKING view: the lock that must stop this row from opening a wallet
// prompt. Full-id entry first; otherwise ANY bare-hash entry blocks — it may
// be this app's compatibility fence for the sibling row, or an old bundle's
// lock on either row. Conservative by design: main and bonus redeem
// sequentially whenever a bare entry exists.
export function zenonRedeemLockFor(
  zenonRedeems: Record<string, ZenonRedeemLock>,
  id: string,
): ZenonRedeemLock | undefined {
  return zenonRedeems[normalizeUnwrapLockKey(id)] ??
    zenonRedeems[normalizeEvmHash(id.split(':')[0])]
}

// OWN view: the lock this row is allowed to release (recheck, staleness
// reclaim) — exactly the full-id entry, nothing else. An unmarked bare entry
// is an old bundle's lock with an UNKNOWN target row (old bundles can redeem
// either row), so no row may claim it; it is resolved only by the
// evidence-based legacy path (legacyZenonRedeemLockFor /
// clearLegacyZenonRedeem), never attributed by log index.
export function ownZenonRedeemLockFor(
  zenonRedeems: Record<string, ZenonRedeemLock>,
  id: string,
): ZenonRedeemLock | undefined {
  return zenonRedeems[normalizeUnwrapLockKey(id)]
}

// A genuine legacy (unmarked) bare-hash lock for this transaction, if any.
// Marked fences are excluded — they mirror a known full-id lock and share its
// lifecycle. Callers resolve the returned lock ONLY with hash-wide evidence
// (its block's on-chain outcome, staleness of a placeholder, or every row
// sharing the hash being terminal), never by guessing its target row.
export function legacyZenonRedeemLockFor(
  zenonRedeems: Record<string, ZenonRedeemLock>,
  transactionHash: string,
): ZenonRedeemLock | undefined {
  const bare = zenonRedeems[normalizeEvmHash(transactionHash)]
  return bare && bare.fence !== true ? bare : undefined
}

export function pendingZenonRedeemFor(
  zenonRedeems: Record<string, ZenonRedeemLock>,
  id: string,
): string | undefined {
  return zenonRedeemLockFor(zenonRedeems, id)?.hash
}

function applyLockOps(base: PendingActionLocks, ops: LockOp[]): PendingActionLocks {
  const next = normalizeLocks({
    evmClaims: {...base.evmClaims},
    zenonRedeems: {...base.zenonRedeems},
    evmTxFacts: {...base.evmTxFacts},
    unknownWraps: {...base.unknownWraps},
  })
  for (const op of ops) {
    const map = next[op.scope] as Record<string, unknown>
    if (op.op === 'delete') delete map[op.key]
    else map[op.key] = op.value
  }
  return next
}

// All lock mutations are read-apply-write: re-read the latest stored document,
// apply this mutation's ops, persist. Serialized against other browser
// contexts by the 'action-locks-write' Web Lock (whole-document storage means
// unserialized concurrent writers are last-writer-wins and would lose each
// other's active locks), and against same-context callers by a promise chain.
let locksWriteQueue: Promise<unknown> = Promise.resolve()

function mutateLocks(deriveOps: (locks: PendingActionLocks) => LockOp[]): Promise<void> {
  const run = () => requestStore.withCrossContextLock('action-locks-write', async () => {
    await ensureLocksLoaded()
    // ALWAYS re-read the stored document under the write lock — even while
    // dirty from an earlier failed persist — and replay the unconfirmed local
    // ops on top. Skipping the read would write a stale whole-document mirror
    // and lose external locks whose storage event was delayed or dropped.
    const stored = normalizeLocks(await storageService.get<PendingActionLocks>(LOCKS_STORAGE_KEY))
    locksMirror = locksDirty ? applyLockOps(stored, pendingLockOps) : stored
    const ops = deriveOps(locksMirror)
    if (!ops.length) return
    const mirrorBeforeMutation = locksMirror
    const pendingOpsBeforeMutation = pendingLockOps.length
    locksMirror = applyLockOps(locksMirror, ops)
    for (const op of ops) recordLockOp(op)
    notifyLocksChanged()
    try {
      await persistLocks()
    } catch (e) {
      // A rejected mutation must leave no trace: callers treat the rejection
      // as "not recorded" and abort their flow, so keeping the optimistic
      // record would lock the UI on a phantom operation — and its pending op
      // would be silently persisted by the next successful mutation.
      pendingLockOps = pendingLockOps.slice(0, pendingOpsBeforeMutation)
      locksMirror = mirrorBeforeMutation
      locksDirty = pendingLockOps.length > 0
      bumpRevision()
      notifyLocksChanged()
      throw e
    }
  })
  const next = locksWriteQueue.then(run, run)
  locksWriteQueue = next.catch(() => undefined)
  return next
}

async function ensureLoaded(): Promise<TrackedRequest[]> {
  if (mirror === null) {
    mirror = (await storageService.get<TrackedRequest[]>(STORAGE_KEY)) ?? []
  }
  return mirror
}

async function persist(): Promise<void> {
  await storageService.set(STORAGE_KEY, mirror ?? [])
}

// Tracked-request mutations are read-apply-write like the lock document:
// re-read the latest stored list under a cross-context write lock, apply, and
// persist — a whole-document write from a stale mirror would silently drop
// another tab's submitted transfer. Rolls back on persist failure.
let requestsDirty = false
let requestsWriteQueue: Promise<unknown> = Promise.resolve()

function mutateRequests(
  mutate: (list: TrackedRequest[]) => TrackedRequest[] | null,
): Promise<void> {
  const run = () => requestStore.withCrossContextLock('tracked-requests-write', async () => {
    const stored = (await storageService.get<TrackedRequest[]>(STORAGE_KEY)) ?? []
    const next = mutate(stored)
    if (next === null) {
      mirror = stored
      return
    }
    requestsDirty = true
    mirror = next
    bumpRevision()
    try {
      await storageService.set(STORAGE_KEY, next)
    } catch (e) {
      // A rejected mutation must leave no trace (mutation applied iff resolved).
      mirror = stored
      bumpRevision()
      throw e
    } finally {
      requestsDirty = false
    }
  })
  const nextPromise = requestsWriteQueue.then(run, run)
  requestsWriteQueue = nextPromise.catch(() => undefined)
  return nextPromise
}

async function ensureLocksLoaded(): Promise<PendingActionLocks> {
  if (locksMirror === null) {
    locksMirror = normalizeLocks(await storageService.get<PendingActionLocks>(LOCKS_STORAGE_KEY))
    // One-time in-memory migration from the earlier implementation where
    // action locks were embedded in display requests.
    const requests = await ensureLoaded() as Array<TrackedRequest & {
      pendingClaimHash?: string
      pendingClaimStage?: 1 | 2
      pendingZenonRedeemHash?: string
    }>
    let migrated = false
    for (const request of requests) {
      if (request.kind === 'wrap' && request.pendingClaimHash && request.pendingClaimStage) {
        locksMirror.evmClaims[request.id] ??= {
          hash: request.pendingClaimHash,
          stage: request.pendingClaimStage,
        }
        delete request.pendingClaimHash
        delete request.pendingClaimStage
        migrated = true
      }
      if (request.kind === 'unwrap' && request.pendingZenonRedeemHash) {
        // A tracked row still at its provisional id (`hash:-1`, before the
        // node assigns an authoritative logIndex) must migrate to the bare
        // legacy key: mirroring to the full provisional id would be
        // unreachable forever, since the real row later becomes `hash:7` and
        // only the bare-hash legacy fallback — never `hash:-1` — is ever
        // checked for it.
        const [rawHash, indexPart] = request.id.split(':')
        const indexNum = Number(indexPart)
        const isProvisionalIndex = !Number.isFinite(indexNum) || indexNum < 0
        const key = isProvisionalIndex
          ? normalizeEvmHash(rawHash)
          : normalizeUnwrapLockKey(request.id)
        locksMirror.zenonRedeems[key] ??= {hash: request.pendingZenonRedeemHash}
        delete request.pendingZenonRedeemHash
        migrated = true
      }
    }
    if (migrated) {
      bumpRevision()
      await Promise.all([persistLocks(), persist()])
    }
  }
  return locksMirror
}

async function persistLocks(): Promise<void> {
  const writeVersion = locksWriteVersion
  await storageService.set(LOCKS_STORAGE_KEY, locksMirror ?? emptyLocks())
  if (writeVersion === locksWriteVersion) {
    locksDirty = false
    pendingLockOps = []
  }
}

function bumpRevision(): void {
  revision += 1
}

function recordLockOp(op: LockOp): void {
  pendingLockOps.push(op)
  locksDirty = true
  locksWriteVersion += 1
  bumpRevision()
}

async function refreshLocksFromStorage(): Promise<PendingActionLocks> {
  const current = await ensureLocksLoaded()
  if (locksDirty) return current
  const stored = normalizeLocks(await storageService.get<PendingActionLocks>(LOCKS_STORAGE_KEY))
  if (!locksDirty) locksMirror = stored
  return locksMirror ?? current
}

type SubscribableStorage = typeof storageService & {
  subscribe?<T>(key: string, listener: (value: T | null) => void): () => void
}

// Listeners fired on any lock-state change (local mutation or cross-context
// storage event) so safety-critical UI can react immediately rather than on
// the next 30-second poll.
const lockChangeListeners = new Set<() => void>()

function notifyLocksChanged(): void {
  for (const listener of [...lockChangeListeners]) {
    try {
      listener()
    } catch {
      // listener errors must never break lock bookkeeping
    }
  }
}

;(storageService as SubscribableStorage).subscribe?.<TrackedRequest[]>(
  STORAGE_KEY,
  incoming => {
    // Our own in-flight write is authoritative over any event racing it; the
    // event's content predates the fresh read taken under the write lock.
    if (requestsDirty) return
    mirror = incoming ?? []
    bumpRevision()
  },
)

;(storageService as SubscribableStorage).subscribe?.<PendingActionLocks>(
  LOCKS_STORAGE_KEY,
  incoming => {
    const next = normalizeLocks(incoming)
    // While a local write is in flight, replay the unconfirmed local ops over
    // the incoming snapshot — a key-wise merge cannot represent deletions and
    // would resurrect a lock this context just released.
    locksMirror = locksDirty && locksMirror ? applyLockOps(next, pendingLockOps) : next
    bumpRevision()
    notifyLocksChanged()
  },
)

export const requestStore = {
  async withCrossContextLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    if (typeof navigator === 'undefined' || !navigator.locks) return action()
    return navigator.locks.request(`nom-bridge:${key}`, {mode: 'exclusive'}, () => action())
  },

  hasCrossContextLocks(): boolean {
    return typeof navigator !== 'undefined' && Boolean(navigator.locks)
  },

  // Exclusion for wallet-invoking DESTINATION actions (claims/redeems): fails
  // closed without the Web Locks API — running unlocked would allow duplicate
  // wallet prompts across tabs — but MAY queue, because these flows re-read
  // persisted lock state inside the lock and re-validate against whatever the
  // previous holder did.
  async withWalletActionLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    if (typeof navigator === 'undefined' || !navigator.locks) {
      throw new Error('This browser does not support the locking features required for safe bridge actions. Please use a current browser.')
    }
    return navigator.locks.request(`nom-bridge:${key}`, {mode: 'exclusive'}, () => action())
  },

  // Exclusion for SOURCE transfers: never queues (a queued click would run
  // later against state the user never saw and could submit a second
  // transfer) and never runs without real cross-context exclusion (a browser
  // lacking the Web Locks API fails closed rather than double-submitting).
  async withExclusiveSourceLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    if (typeof navigator === 'undefined' || !navigator.locks) {
      throw new Error('This browser does not support the locking features required for safe bridge submissions. Please use a current browser.')
    }
    return navigator.locks.request(
      `nom-bridge:${key}`,
      {mode: 'exclusive', ifAvailable: true},
      lock => {
        if (!lock) {
          throw new Error('A submission for this account is already in progress in another tab or window')
        }
        return action()
      },
    )
  },

  onLocksChanged(listener: () => void): () => void {
    lockChangeListeners.add(listener)
    return () => lockChangeListeners.delete(listener)
  },

  async trackWrap(r: Omit<TrackedRequest, 'kind' | 'evmChainId' | 'zenonChainId'>): Promise<void> {
    await mutateRequests(list => list.some(e => e.id === r.id)
      ? null
      : [...list, {
          kind: 'wrap' as const,
          evmChainId: config.evmChainId,
          zenonChainId: config.zenonChainId,
          ...r,
        }])
  },

  async trackUnwrap(r: Omit<TrackedRequest, 'kind' | 'evmChainId' | 'zenonChainId'>): Promise<void> {
    const transactionHash = normalizeEvmHash(r.id.split(':')[0])
    await mutateRequests(list => list.some(e =>
      e.kind === 'unwrap' &&
      e.evmChainId === config.evmChainId &&
      e.zenonChainId === config.zenonChainId &&
      normalizeEvmHash(e.id.split(':')[0]) === transactionHash,
    )
      ? null
      : [...list, {
          kind: 'unwrap' as const,
          evmChainId: config.evmChainId,
          zenonChainId: config.zenonChainId,
          ...r,
        }])
  },

  async getAll(): Promise<TrackedRequest[]> {
    return [...(await ensureLoaded())]
  },

  async getSnapshot(): Promise<{
    requests: TrackedRequest[]
    evmClaims: PendingActionLocks['evmClaims']
    zenonRedeems: PendingActionLocks['zenonRedeems']
    evmTxFacts: PendingActionLocks['evmTxFacts']
    unknownWraps: PendingActionLocks['unknownWraps']
    revision: number
  }> {
    const [requests, locks] = await Promise.all([ensureLoaded(), refreshLocksFromStorage()])
    return {
      requests: [...requests],
      evmClaims: {...locks.evmClaims},
      zenonRedeems: {...locks.zenonRedeems},
      evmTxFacts: {...locks.evmTxFacts},
      unknownWraps: {...locks.unknownWraps},
      revision,
    }
  },

  getRevision(): number {
    return revision
  },

  async setPendingEvmClaim(id: string, hash: string, stage: 1 | 2): Promise<boolean> {
    await mutateLocks(() => [
      {scope: 'evmClaims', op: 'set', key: id, value: {hash, stage, updatedAt: Date.now()}},
    ])
    return true
  },

  async clearPendingEvmClaim(id: string): Promise<void> {
    await mutateLocks(locks => locks.evmClaims[id]
      ? [{scope: 'evmClaims', op: 'delete', key: id}]
      : [])
  },

  // Writes the full-id lock plus a bare-hash compatibility fence so bundles
  // that still key by bare hash refuse both rows while this redeem is live.
  // The fence tracks its writer's lock value (including the placeholder →
  // published-hash upgrade), but never clobbers a genuine legacy bare entry —
  // that is another context's lock evidence, and it already fences old
  // bundles on its own.
  async setPendingZenonRedeem(id: string, hash: string): Promise<boolean> {
    const key = normalizeUnwrapLockKey(id)
    const legacyKey = normalizeEvmHash(id.split(':')[0])
    await mutateLocks(locks => {
      const value = {hash, updatedAt: Date.now()}
      const ops: LockOp[] = [{scope: 'zenonRedeems', op: 'set', key, value}]
      const bare = locks.zenonRedeems[legacyKey]
      if (legacyKey !== key && (!bare || bare.fence === true)) {
        ops.push({scope: 'zenonRedeems', op: 'set', key: legacyKey, value: {...value, fence: true}})
      }
      return ops
    })
    return true
  },

  // Releases this row's lock: exactly the full-id entry, plus a MARKED fence
  // whose value matches it (the fence mirrors this lock and dies with it).
  // An unmarked bare entry is never touched here — its target row is unknown
  // (an old bundle can lock either row), so ordinary row advancement must not
  // release it; only clearLegacyZenonRedeem, gated on hash-wide evidence, may.
  async clearPendingZenonRedeem(id: string): Promise<void> {
    const key = normalizeUnwrapLockKey(id)
    const legacyKey = normalizeEvmHash(id.split(':')[0])
    await mutateLocks(locks => {
      const ops: LockOp[] = []
      const own = locks.zenonRedeems[key]
      if (own) ops.push({scope: 'zenonRedeems', op: 'delete', key})
      const bare = locks.zenonRedeems[legacyKey]
      if (
        bare && legacyKey !== key &&
        bare.fence === true && own !== undefined && bare.hash === own.hash
      ) {
        ops.push({scope: 'zenonRedeems', op: 'delete', key: legacyKey})
      }
      return ops
    })
  },

  // Removes the bare-hash entry for a transaction. Callers must hold
  // hash-wide evidence that no wallet action can still be in flight for ANY
  // row sharing the hash: the legacy lock's block outcome is processed, its
  // placeholder passed the staleness window, or every row is terminal
  // (redeemed/revoked). Never call this from ordinary single-row advancement.
  async clearLegacyZenonRedeem(transactionHash: string): Promise<void> {
    const legacyKey = normalizeEvmHash(transactionHash)
    await mutateLocks(locks => locks.zenonRedeems[legacyKey]
      ? [{scope: 'zenonRedeems', op: 'delete', key: legacyKey}]
      : [])
  },

  async recordEvmTxFacts(hash: string, facts: {from: string; nonce: number}): Promise<void> {
    const key = normalizeEvmHash(hash)
    await mutateLocks(locks => {
      const existing = locks.evmTxFacts[key]
      if (existing && existing.from === facts.from && existing.nonce === facts.nonce) return []
      return [{scope: 'evmTxFacts', op: 'set', key, value: facts}]
    })
  },

  async clearEvmTxFacts(hash: string): Promise<void> {
    const key = normalizeEvmHash(hash)
    await mutateLocks(locks => locks.evmTxFacts[key] !== undefined
      ? [{scope: 'evmTxFacts', op: 'delete', key}]
      : [])
  },

  async setUnknownWrap(id: string, operation: UnknownWrapOperation): Promise<void> {
    await mutateLocks(() => [{scope: 'unknownWraps', op: 'set', key: id, value: operation}])
  },

  async clearUnknownWrap(id: string): Promise<void> {
    await mutateLocks(locks => locks.unknownWraps[id]
      ? [{scope: 'unknownWraps', op: 'delete', key: id}]
      : [])
  },

  async prune(predicate: (r: TrackedRequest) => boolean): Promise<void> {
    await mutateRequests(list => {
      const next = list.filter(r => !predicate(r))
      return next.length === list.length ? null : next
    })
  },
}
