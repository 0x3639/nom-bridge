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
  zenonRedeems: Record<string, {hash: string; updatedAt?: number}>
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
        const transactionHash = normalizeEvmHash(request.id.split(':')[0])
        locksMirror.zenonRedeems[transactionHash] ??= {hash: request.pendingZenonRedeemHash}
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

  async setPendingZenonRedeem(id: string, hash: string): Promise<boolean> {
    const transactionHash = normalizeEvmHash(id.split(':')[0])
    await mutateLocks(() => [
      {scope: 'zenonRedeems', op: 'set', key: transactionHash, value: {hash, updatedAt: Date.now()}},
    ])
    return true
  },

  async clearPendingZenonRedeem(id: string): Promise<void> {
    const transactionHash = normalizeEvmHash(id.split(':')[0])
    await mutateLocks(locks => locks.zenonRedeems[transactionHash]
      ? [{scope: 'zenonRedeems', op: 'delete', key: transactionHash}]
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
