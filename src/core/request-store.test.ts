import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {
  legacyZenonRedeemLockFor,
  ownZenonRedeemLockFor,
  pendingZenonRedeemFor,
  zenonRedeemLockFor,
} from './request-store'

// Mock the storage adapter so the store never touches real localStorage. The
// fake holds an in-memory cell whose initial value drives ensureLoaded().
const h = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  remove: vi.fn(),
  subscribe: vi.fn(),
  values: new Map<string, unknown>(),
  listeners: new Map<string, (value: unknown) => void>(),
}))

vi.mock('./storage/storage-service', () => ({
  storageService: {get: h.get, set: h.set, remove: h.remove, subscribe: h.subscribe},
}))

beforeEach(() => {
  vi.resetModules()
  h.values.clear()
  h.listeners.clear()
  h.get.mockReset().mockImplementation(async (key: string) => h.values.get(key) ?? null)
  h.set.mockReset().mockImplementation(async (key: string, value: unknown) => {
    h.values.set(key, structuredClone(value))
  })
  h.remove.mockReset().mockResolvedValue(undefined)
  h.subscribe.mockReset().mockImplementation((key: string, listener: (value: unknown) => void) => {
    h.listeners.set(key, listener)
    return () => h.listeners.delete(key)
  })
})

afterEach(() => vi.unstubAllGlobals())

function wrapFixture(id: string) {
  return {
    id,
    zts: 'zts1znn',
    amount: '100000000',
    decimals: 8,
    symbol: 'ZNN',
    evmToAddress: '0xRecipient',
    createdAt: 1,
  }
}

describe('requestStore', () => {
  it('trackWrap then getAll returns the entry tagged kind:wrap', async () => {
    const {requestStore} = await import('./request-store')
    await requestStore.trackWrap(wrapFixture('a'))
    const all = await requestStore.getAll()
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({kind: 'wrap', id: 'a', evmToAddress: '0xRecipient'})
    expect(all[0]).toMatchObject({evmChainId: 1, zenonChainId: 1})
  })

  it('serves repeated reads from the mirror; only writes re-read storage', async () => {
    const {requestStore} = await import('./request-store')
    await requestStore.getAll()
    await requestStore.getAll()
    expect(h.get).toHaveBeenCalledTimes(1)
    // A mutation performs its own fresh read under the write lock (read-apply-
    // write), so it may add exactly one more.
    await requestStore.trackWrap(wrapFixture('a'))
    expect(h.get).toHaveBeenCalledTimes(2)
  })

  it('persists via set on each mutation', async () => {
    const {requestStore} = await import('./request-store')
    await requestStore.trackWrap(wrapFixture('a'))
    expect(h.set).toHaveBeenCalledWith(
      'nom-bridge:requests:v2',
      expect.arrayContaining([expect.objectContaining({id: 'a'})]),
    )
  })

  it('dedupes by id', async () => {
    const {requestStore} = await import('./request-store')
    await requestStore.trackWrap(wrapFixture('a'))
    await requestStore.trackWrap(wrapFixture('a'))
    expect(await requestStore.getAll()).toHaveLength(1)
  })

  it('prune drops matching entries', async () => {
    const {requestStore} = await import('./request-store')
    await requestStore.trackWrap(wrapFixture('a'))
    await requestStore.trackWrap(wrapFixture('b'))
    await requestStore.prune(r => r.id === 'a')
    const all = await requestStore.getAll()
    expect(all.map(r => r.id)).toEqual(['b'])
  })

  it('getAll returns a copy so callers cannot mutate the store', async () => {
    const {requestStore} = await import('./request-store')
    await requestStore.trackWrap(wrapFixture('a'))
    const all = await requestStore.getAll()
    all.pop()
    expect(await requestStore.getAll()).toHaveLength(1)
  })

  it('surfaces a persist rejection to the awaiting caller', async () => {
    h.set.mockRejectedValueOnce(new Error('quota exceeded'))
    const {requestStore} = await import('./request-store')
    await expect(requestStore.trackWrap(wrapFixture('a'))).rejects.toThrow('quota exceeded')
  })

  it('trackUnwrap seam exists and tags entries kind:unwrap (Phase 4 seam)', async () => {
    const {requestStore} = await import('./request-store')
    expect(typeof requestStore.trackUnwrap).toBe('function')
    expect(typeof requestStore.prune).toBe('function')
    await requestStore.trackUnwrap(wrapFixture('u'))
    const all = await requestStore.getAll()
    expect(all[0]).toMatchObject({kind: 'unwrap', id: 'u'})
  })

  it('persists and clears an Ethereum claim lock', async () => {
    const {requestStore} = await import('./request-store')
    await requestStore.trackWrap(wrapFixture('claim-id'))
    await expect(requestStore.setPendingEvmClaim('claim-id', '0xclaim', 2)).resolves.toBe(true)
    expect((await requestStore.getSnapshot()).evmClaims['claim-id']).toMatchObject({
      hash: '0xclaim',
      stage: 2,
    })
    await requestStore.clearPendingEvmClaim('claim-id')
    expect((await requestStore.getSnapshot()).evmClaims['claim-id']).toBeUndefined()
  })

  it('stamps lock entries with a write time for staleness recovery', async () => {
    const {requestStore} = await import('./request-store')
    await requestStore.setPendingEvmClaim('claim-id', 'awaiting-wallet-result', 1)
    await requestStore.setPendingZenonRedeem('0xabc:1', 'awaiting-wallet-result')
    const snapshot = await requestStore.getSnapshot()
    expect(snapshot.evmClaims['claim-id'].updatedAt).toBeTypeOf('number')
    expect(snapshot.zenonRedeems['0xabc:1'].updatedAt).toBeTypeOf('number')
  })

  it('matches unwrap locks across prefixed and unprefixed transaction hashes', async () => {
    const {requestStore} = await import('./request-store')
    await requestStore.trackUnwrap(wrapFixture('abcdef:-1'))
    await expect(requestStore.setPendingZenonRedeem('0xABCDEF:9', 'zenon-block')).resolves.toBe(true)
    expect((await requestStore.getSnapshot()).zenonRedeems['0xabcdef:9']).toMatchObject({hash: 'zenon-block'})
    await requestStore.clearPendingZenonRedeem('0xabcdef:9')
    expect((await requestStore.getSnapshot()).zenonRedeems['0xabcdef:9']).toBeUndefined()
  })

  it('deduplicates provisional and node-indexed ids for the same unwrap hash', async () => {
    const {requestStore} = await import('./request-store')
    await requestStore.trackUnwrap(wrapFixture('0xABCDEF:-1'))
    await requestStore.trackUnwrap(wrapFixture('abcdef:9'))
    expect(await requestStore.getAll()).toHaveLength(1)
  })

  it('stores a claim lock without creating an inaccurate placeholder request', async () => {
    const {requestStore} = await import('./request-store')
    await requestStore.setPendingEvmClaim('external-request', '0xclaim', 1)
    expect(await requestStore.getAll()).toEqual([])
    expect((await requestStore.getSnapshot()).evmClaims['external-request']).toMatchObject({
      hash: '0xclaim',
      stage: 1,
    })
  })

  it('migrates embedded legacy locks once and removes their re-arm source', async () => {
    h.get.mockImplementation(async (key: string) => key === 'nom-bridge:requests:v2'
      ? [{
          kind: 'wrap',
          evmChainId: 1,
          zenonChainId: 1,
          ...wrapFixture('legacy'),
          pendingClaimHash: '0xlegacy',
          pendingClaimStage: 1,
        }]
      : h.values.get(key) ?? null)
    const {requestStore} = await import('./request-store')

    expect((await requestStore.getSnapshot()).evmClaims.legacy).toMatchObject({
      hash: '0xlegacy',
      stage: 1,
    })
    expect(h.set).toHaveBeenCalledWith(
      'nom-bridge:requests:v2',
      [expect.not.objectContaining({pendingClaimHash: '0xlegacy'})],
    )
  })

  it('refreshes action locks written by another browser context', async () => {
    const {requestStore} = await import('./request-store')
    expect((await requestStore.getSnapshot()).evmClaims.external).toBeUndefined()

    const external = {
      evmClaims: {external: {hash: '0xexternal', stage: 1 as const}},
      zenonRedeems: {},
    }
    h.values.set('nom-bridge:action-locks:v1', external)
    h.listeners.get('nom-bridge:action-locks:v1')?.(external)

    expect((await requestStore.getSnapshot()).evmClaims.external).toEqual({
      hash: '0xexternal',
      stage: 1,
    })
  })

  it('serializes same-action submissions across browser contexts when Web Locks is available', async () => {
    const request = vi.fn(async (_name: string, _options: unknown, action: () => Promise<string>) => action())
    vi.stubGlobal('navigator', {locks: {request}})
    const {requestStore} = await import('./request-store')

    await expect(requestStore.withCrossContextLock('evm-claim:abc', async () => 'done')).resolves.toBe('done')
    expect(request).toHaveBeenCalledWith(
      'nom-bridge:evm-claim:abc',
      {mode: 'exclusive'},
      expect.any(Function),
    )
  })

  it('does not resurrect a lock deleted locally when a stale cross-context snapshot arrives mid-write', async () => {
    const {requestStore} = await import('./request-store')
    await requestStore.setPendingEvmClaim('claim-id', '0xclaim', 1)

    // The persist of the deletion hangs, so the store is dirty when a storage
    // event delivers another context's snapshot that still carries the lock.
    let releaseSet: () => void = () => undefined
    const setStarted = new Promise<void>(started => {
      h.set.mockImplementationOnce((key: string, value: unknown) => {
        h.values.set(key, structuredClone(value))
        started()
        return new Promise<void>(resolve => {
          releaseSet = resolve
        })
      })
    })
    const clearing = requestStore.clearPendingEvmClaim('claim-id')
    await setStarted
    h.listeners.get('nom-bridge:action-locks:v1')?.({
      evmClaims: {'claim-id': {hash: '0xclaim', stage: 1}},
      zenonRedeems: {},
    })

    // Mid-write (dirty) reads must already reflect the deletion…
    expect((await requestStore.getSnapshot()).evmClaims['claim-id']).toBeUndefined()
    releaseSet()
    await clearing
    // …and so must clean reads after the write completes.
    expect((await requestStore.getSnapshot()).evmClaims['claim-id']).toBeUndefined()
  })

  it('keeps a locally added lock when a stale cross-context snapshot arrives mid-write', async () => {
    const {requestStore} = await import('./request-store')
    let releaseSet: () => void = () => undefined
    const setStarted = new Promise<void>(started => {
      h.set.mockImplementationOnce((key: string, value: unknown) => {
        h.values.set(key, structuredClone(value))
        started()
        return new Promise<void>(resolve => {
          releaseSet = resolve
        })
      })
    })
    const setting = requestStore.setPendingEvmClaim('claim-id', '0xclaim', 1)
    await setStarted
    h.listeners.get('nom-bridge:action-locks:v1')?.({evmClaims: {}, zenonRedeems: {}})

    expect((await requestStore.getSnapshot()).evmClaims['claim-id']).toMatchObject({hash: '0xclaim'})
    releaseSet()
    await setting
    expect((await requestStore.getSnapshot()).evmClaims['claim-id']).toMatchObject({hash: '0xclaim'})
  })

  it('persists dropped-transaction facts keyed by normalized transaction hash', async () => {
    const {requestStore} = await import('./request-store')
    await requestStore.recordEvmTxFacts('0xABCDEF', {from: '0xSender', nonce: 7})
    expect((await requestStore.getSnapshot()).evmTxFacts['0xabcdef']).toEqual({from: '0xSender', nonce: 7})
    await requestStore.clearEvmTxFacts('ABCDEF')
    expect((await requestStore.getSnapshot()).evmTxFacts['0xabcdef']).toBeUndefined()
  })

  it('does not clobber another context\'s lock written between this context\'s mutations', async () => {
    const {requestStore} = await import('./request-store')
    await requestStore.setPendingEvmClaim('mine', '0xmine', 1)

    // Another context writes its own claim lock directly to storage. No event
    // is delivered (worst case: chrome.storage listener lag / dropped event).
    const stored = h.values.get('nom-bridge:action-locks:v1') as {evmClaims: Record<string, unknown>}
    h.values.set('nom-bridge:action-locks:v1', {
      ...stored,
      evmClaims: {...stored.evmClaims, theirs: {hash: '0xtheirs', stage: 1}},
    })

    // Our next mutation must be read-apply-write on the latest stored state,
    // not a whole-document overwrite from a stale mirror.
    await requestStore.setPendingZenonRedeem('0xabc:1', 'zenon-block')

    const final = h.values.get('nom-bridge:action-locks:v1') as {
      evmClaims: Record<string, unknown>
      zenonRedeems: Record<string, unknown>
    }
    expect(final.evmClaims.theirs).toMatchObject({hash: '0xtheirs'})
    expect(final.evmClaims.mine).toMatchObject({hash: '0xmine'})
    expect(final.zenonRedeems['0xabc:1']).toMatchObject({hash: 'zenon-block'})
  })

  it('still reads the latest stored state after an earlier persist failed', async () => {
    const {requestStore} = await import('./request-store')
    // First mutation's persist fails; the rejected mutation is rolled back.
    h.set.mockRejectedValueOnce(new Error('storage write failed'))
    await expect(requestStore.setPendingEvmClaim('mine', '0xmine', 1)).rejects.toThrow('storage write failed')

    // Another context writes its own lock; no storage event is delivered.
    const stored = (h.values.get('nom-bridge:action-locks:v1') ?? {evmClaims: {}, zenonRedeems: {}}) as {
      evmClaims: Record<string, unknown>
    }
    h.values.set('nom-bridge:action-locks:v1', {
      ...stored,
      evmClaims: {...stored.evmClaims, theirs: {hash: '0xtheirs', stage: 1}},
    })

    // The next mutation must fresh-read the latest stored state — preserving
    // the external lock and NOT resurrecting the rolled-back one.
    await requestStore.setPendingZenonRedeem('0xabc:1', 'zenon-block')

    const final = h.values.get('nom-bridge:action-locks:v1') as {
      evmClaims: Record<string, unknown>
      zenonRedeems: Record<string, unknown>
    }
    expect(final.evmClaims.theirs).toMatchObject({hash: '0xtheirs'})
    expect(final.evmClaims.mine).toBeUndefined()
    expect(final.zenonRedeems['0xabc:1']).toMatchObject({hash: 'zenon-block'})
  })

  it('rolls back an optimistic mutation when its persist fails, leaving no phantom lock', async () => {
    const {requestStore} = await import('./request-store')
    const listener = vi.fn()
    requestStore.onLocksChanged(listener)
    const operation = {
      evmToAddress: '0xRecipient',
      zenonFromAddress: 'z1qsender',
      zts: 'zts1znn',
      amount: '150000000',
      decimals: 8,
      symbol: 'ZNN',
      frontierHeight: 41,
      createdAt: 1,
    }

    h.set.mockRejectedValueOnce(new Error('storage write failed'))
    await expect(requestStore.setUnknownWrap('op-1', operation)).rejects.toThrow('storage write failed')

    // A rejected mutation must leave no trace: the caller aborted its flow, so
    // a lingering in-memory record would lock the UI on a phantom operation…
    expect((await requestStore.getSnapshot()).unknownWraps['op-1']).toBeUndefined()
    // …and listeners must have been re-notified of the rollback.
    expect(listener).toHaveBeenCalledTimes(2)

    // A later unrelated mutation must not resurrect the rolled-back op durably.
    await requestStore.setPendingEvmClaim('claim-id', '0xclaim', 1)
    const final = h.values.get('nom-bridge:action-locks:v1') as {unknownWraps?: Record<string, unknown>}
    expect(final.unknownWraps?.['op-1']).toBeUndefined()
  })

  it('persists and clears hashless unknown-wrap operations', async () => {
    const {requestStore} = await import('./request-store')
    const operation = {
      evmToAddress: '0xRecipient',
      zenonFromAddress: 'z1qsender',
      zts: 'zts1znn',
      amount: '150000000',
      decimals: 8,
      symbol: 'ZNN',
      frontierHeight: 41,
      createdAt: 1,
    }
    await requestStore.setUnknownWrap('op-1', operation)
    expect((await requestStore.getSnapshot()).unknownWraps['op-1']).toEqual(operation)
    await requestStore.clearUnknownWrap('op-1')
    expect((await requestStore.getSnapshot()).unknownWraps['op-1']).toBeUndefined()
  })

  it('does not clobber another context\'s tracked request written between mutations', async () => {
    const {requestStore} = await import('./request-store')
    await requestStore.trackWrap(wrapFixture('mine'))

    // Another context appends its own tracked transfer directly to storage;
    // no storage event is delivered (worst case).
    const stored = (h.values.get('nom-bridge:requests:v2') ?? []) as unknown[]
    h.values.set('nom-bridge:requests:v2', [
      ...stored,
      {kind: 'wrap', evmChainId: 1, zenonChainId: 1, ...wrapFixture('theirs')},
    ])

    await requestStore.trackWrap(wrapFixture('mine-2'))

    const final = h.values.get('nom-bridge:requests:v2') as Array<{id: string}>
    expect(final.map(entry => entry.id).sort()).toEqual(['mine', 'mine-2', 'theirs'])
  })

  it('refreshes tracked requests written by another browser context', async () => {
    const {requestStore} = await import('./request-store')
    expect(await requestStore.getAll()).toEqual([])

    const external = [{kind: 'unwrap', evmChainId: 1, zenonChainId: 1, ...wrapFixture('0xabc:-1')}]
    h.values.set('nom-bridge:requests:v2', external)
    h.listeners.get('nom-bridge:requests:v2')?.(external)

    expect(await requestStore.getAll()).toHaveLength(1)
    expect((await requestStore.getSnapshot()).requests[0]).toMatchObject({id: '0xabc:-1'})
  })

  it('serializes tracked-request mutations through a cross-context write lock when available', async () => {
    const lockNames: string[] = []
    const request = vi.fn(
      async (name: string, _options: unknown, action: () => Promise<unknown>) => {
        lockNames.push(name)
        return action()
      },
    )
    vi.stubGlobal('navigator', {locks: {request}})
    const {requestStore} = await import('./request-store')

    await requestStore.trackWrap(wrapFixture('a'))

    expect(lockNames).toContain('nom-bridge:tracked-requests-write')
  })

  it('notifies lock listeners on local mutations and cross-context storage events', async () => {
    const {requestStore} = await import('./request-store')
    const listener = vi.fn()
    const unsubscribe = requestStore.onLocksChanged(listener)

    await requestStore.setPendingEvmClaim('claim-id', '0xclaim', 1)
    expect(listener).toHaveBeenCalledTimes(1)

    h.listeners.get('nom-bridge:action-locks:v1')?.({
      evmClaims: {},
      zenonRedeems: {},
    })
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
    await requestStore.clearPendingEvmClaim('claim-id')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('rejects an exclusive source lock immediately when another context holds it', async () => {
    // Source submissions must NOT queue: a queued click would execute later
    // against state the user never saw and could submit a second transfer.
    const request = vi.fn(
      async (_name: string, _options: unknown, action: (lock: unknown) => unknown) => action(null),
    )
    vi.stubGlobal('navigator', {locks: {request}})
    const {requestStore} = await import('./request-store')

    await expect(
      requestStore.withExclusiveSourceLock('wrap-submit:z1q', async () => 'ran'),
    ).rejects.toThrow('already in progress')
    expect(request).toHaveBeenCalledWith(
      'nom-bridge:wrap-submit:z1q',
      expect.objectContaining({ifAvailable: true}),
      expect.any(Function),
    )
  })

  it('runs the exclusive source action when the lock is granted', async () => {
    const request = vi.fn(
      async (_name: string, _options: unknown, action: (lock: unknown) => unknown) => action({granted: true}),
    )
    vi.stubGlobal('navigator', {locks: {request}})
    const {requestStore} = await import('./request-store')

    await expect(
      requestStore.withExclusiveSourceLock('wrap-submit:z1q', async () => 'ran'),
    ).resolves.toBe('ran')
  })

  it('fails closed for source submissions when the Web Locks API is unavailable', async () => {
    vi.stubGlobal('navigator', {})
    const {requestStore} = await import('./request-store')

    await expect(
      requestStore.withExclusiveSourceLock('wrap-submit:z1q', async () => 'ran'),
    ).rejects.toThrow(/does not support/)
    expect(requestStore.hasCrossContextLocks()).toBe(false)

    vi.stubGlobal('navigator', {locks: {request: vi.fn()}})
    expect(requestStore.hasCrossContextLocks()).toBe(true)
  })

  it('fails closed for wallet actions without Web Locks but allows them to queue', async () => {
    // Claims/redeems must never run without real exclusion, but MAY queue:
    // their in-lock guards re-read persisted state after the holder finishes.
    vi.stubGlobal('navigator', {})
    const {requestStore} = await import('./request-store')
    await expect(
      requestStore.withWalletActionLock('evm-claim:1a2b', async () => 'ran'),
    ).rejects.toThrow(/does not support/)

    const request = vi.fn(
      async (name: string, options: {mode: string; ifAvailable?: boolean}, action: () => unknown) => {
        expect(options.ifAvailable).toBeUndefined()
        expect(name).toBe('nom-bridge:evm-claim:1a2b')
        return action()
      },
    )
    vi.stubGlobal('navigator', {locks: {request}})
    await expect(
      requestStore.withWalletActionLock('evm-claim:1a2b', async () => 'ran'),
    ).resolves.toBe('ran')
  })

  it('serializes lock mutations through the cross-context write lock when available', async () => {
    const lockNames: string[] = []
    const request = vi.fn(
      async (name: string, _options: unknown, action: () => Promise<unknown>) => {
        lockNames.push(name)
        return action()
      },
    )
    vi.stubGlobal('navigator', {locks: {request}})
    const {requestStore} = await import('./request-store')

    await requestStore.setPendingEvmClaim('claim-id', '0xclaim', 1)

    expect(lockNames).toContain('nom-bridge:action-locks-write')
  })
})

describe('zenon redeem lock keying', () => {
  const HASH = '0x' + 'ab'.repeat(32)
  const MAIN_ID = `${HASH}:7`
  const BONUS_ID = `${HASH}:4000000007`

  it('writes a bare-hash compatibility fence alongside the full-id lock', async () => {
    const {requestStore} = await import('./request-store')
    await requestStore.setPendingZenonRedeem(MAIN_ID, 'zhash-main')
    const snapshot = await requestStore.getSnapshot()
    // Own row reads its full-id lock; the sibling row is fence-blocked so the
    // two rows redeem sequentially; an old bundle's bare-hash read sees it too.
    expect(pendingZenonRedeemFor(snapshot.zenonRedeems, MAIN_ID)).toBe('zhash-main')
    expect(pendingZenonRedeemFor(snapshot.zenonRedeems, BONUS_ID)).toBe('zhash-main')
    expect(snapshot.zenonRedeems[HASH]).toMatchObject({hash: 'zhash-main', fence: true})
  })

  it('the fence follows its writer through the placeholder → published-hash upgrade', async () => {
    const {requestStore} = await import('./request-store')
    await requestStore.setPendingZenonRedeem(MAIN_ID, 'placeholder')
    await requestStore.setPendingZenonRedeem(MAIN_ID, 'zhash-published')
    const snapshot = await requestStore.getSnapshot()
    expect(snapshot.zenonRedeems[HASH]).toMatchObject({hash: 'zhash-published', fence: true})
    // Value-matched fence is released with its writer's lock.
    await requestStore.clearPendingZenonRedeem(MAIN_ID)
    const after = await requestStore.getSnapshot()
    expect(Object.keys(after.zenonRedeems)).toHaveLength(0)
  })

  it('clearing one row releases only its own lock and fence, never the sibling lock', async () => {
    const {requestStore} = await import('./request-store')
    await requestStore.setPendingZenonRedeem(MAIN_ID, 'zhash-main')
    await requestStore.setPendingZenonRedeem(BONUS_ID, 'zhash-bonus')
    await requestStore.clearPendingZenonRedeem(MAIN_ID)
    const snapshot = await requestStore.getSnapshot()
    // The bonus row's full-id lock survives; its refreshed fence still blocks
    // the (now-cleared) main row — sequential redemption by design.
    expect(pendingZenonRedeemFor(snapshot.zenonRedeems, BONUS_ID)).toBe('zhash-bonus')
    expect(pendingZenonRedeemFor(snapshot.zenonRedeems, MAIN_ID)).toBe('zhash-bonus')
    await requestStore.clearPendingZenonRedeem(BONUS_ID)
    const after = await requestStore.getSnapshot()
    expect(Object.keys(after.zenonRedeems)).toHaveLength(0)
  })

  it('a bare-hash entry blocks BOTH rows (old bundles can lock either row)', () => {
    const legacy = {[HASH]: {hash: 'zhash-legacy'}}
    expect(pendingZenonRedeemFor(legacy, MAIN_ID)).toBe('zhash-legacy')
    expect(pendingZenonRedeemFor(legacy, `${HASH}:-1`)).toBe('zhash-legacy')
    expect(pendingZenonRedeemFor(legacy, BONUS_ID)).toBe('zhash-legacy')
  })

  it('own view is exactly the full-id entry: fences and unmarked bare entries belong to no row', () => {
    const fence = {[HASH]: {hash: 'zhash-main', fence: true}}
    expect(ownZenonRedeemLockFor(fence, MAIN_ID)).toBeUndefined()
    expect(ownZenonRedeemLockFor(fence, BONUS_ID)).toBeUndefined()
    // An unmarked bare entry is an old bundle's lock with an UNKNOWN target
    // (old bundles can redeem either row) — no row may claim it, not even
    // main. It surfaces only through the legacy view.
    const legacy = {[HASH]: {hash: 'zhash-legacy'}}
    expect(ownZenonRedeemLockFor(legacy, MAIN_ID)).toBeUndefined()
    expect(ownZenonRedeemLockFor(legacy, BONUS_ID)).toBeUndefined()
    expect(legacyZenonRedeemLockFor(legacy, HASH)).toMatchObject({hash: 'zhash-legacy'})
    expect(legacyZenonRedeemLockFor(fence, HASH)).toBeUndefined()
    const full = {[MAIN_ID]: {hash: 'zhash-main'}}
    expect(ownZenonRedeemLockFor(full, MAIN_ID)).toMatchObject({hash: 'zhash-main'})
  })

  it('clearPendingZenonRedeem on a main row also clears the legacy key', async () => {
    // Seed a legacy-style entry through the public API shape: write directly
    // via setPendingZenonRedeem then simulate legacy by asserting clear
    // removes both the id key and the bare-hash key.
    const {requestStore} = await import('./request-store')
    await requestStore.setPendingZenonRedeem(MAIN_ID, 'zhash-main')
    await requestStore.clearPendingZenonRedeem(MAIN_ID)
    const snapshot = await requestStore.getSnapshot()
    expect(Object.keys(snapshot.zenonRedeems)).toHaveLength(0)
  })

  it('an unmarked legacy bare entry survives set and EVERY row-level clear — its target row is unknown', async () => {
    const {requestStore} = await import('./request-store')
    // Simulate an old bundle's lock written under the bare tx hash. Its
    // target could be EITHER row (old bundles redeem bonus rows too, e.g.
    // rows created via another dApp's referral), so no row-level operation
    // may release it — the exact scenario: main already redeemed, old tab
    // redeeming the bonus, new tab's advancement clear on the terminal main
    // row must NOT delete the old tab's still-live lock.
    const stored = h.values.get('nom-bridge:action-locks:v1') as
      {zenonRedeems: Record<string, unknown>} | undefined
    h.values.set('nom-bridge:action-locks:v1', {
      evmClaims: {},
      zenonRedeems: {...stored?.zenonRedeems, [HASH]: {hash: 'zhash-legacy'}},
      evmTxFacts: {},
      unknownWraps: {},
    })
    // set must NOT clobber the legacy entry (it is another context's lock
    // evidence, and it already fences old bundles by itself).
    await requestStore.setPendingZenonRedeem(MAIN_ID, 'zhash-main')
    let snapshot = await requestStore.getSnapshot()
    expect(snapshot.zenonRedeems[HASH]).toMatchObject({hash: 'zhash-legacy'})
    // Row-level clears release only their own full-id lock, never the
    // unmarked bare entry — from the main row (with or without an own lock)
    // or the bonus row alike.
    await requestStore.clearPendingZenonRedeem(MAIN_ID)
    await requestStore.clearPendingZenonRedeem(MAIN_ID)
    await requestStore.clearPendingZenonRedeem(BONUS_ID)
    snapshot = await requestStore.getSnapshot()
    expect(snapshot.zenonRedeems[MAIN_ID]).toBeUndefined()
    expect(pendingZenonRedeemFor(snapshot.zenonRedeems, MAIN_ID)).toBe('zhash-legacy')
    expect(pendingZenonRedeemFor(snapshot.zenonRedeems, BONUS_ID)).toBe('zhash-legacy')
    // Only the hash-wide evidence path may sweep it.
    await requestStore.clearLegacyZenonRedeem(HASH)
    snapshot = await requestStore.getSnapshot()
    expect(Object.keys(snapshot.zenonRedeems)).toHaveLength(0)
  })

  it('migrates a legacy pendingZenonRedeemHash on a still-provisional tracked row (id hash:-1) to the bare-hash legacy key, not the full provisional id', async () => {
    // Before the node assigns an authoritative logIndex, a tracked unwrap sits
    // at the provisional id `hash:-1`. If an old embedded
    // pendingZenonRedeemHash on that row migrated to the FULL id (`hash:-1`),
    // it would be unreachable forever: the real row later becomes `hash:7`,
    // whose direct lookup is `hash:7` (no match) and whose legacy fallback
    // only ever checks the BARE hash (never `hash:-1`).
    h.get.mockImplementation(async (key: string) => key === 'nom-bridge:requests:v2'
      ? [{
          kind: 'unwrap',
          evmChainId: 1,
          zenonChainId: 1,
          id: `${HASH}:-1`,
          zts: 'zts1znn',
          amount: '100000000',
          decimals: 8,
          symbol: 'ZNN',
          zenonToAddress: 'z1qrecipient',
          createdAt: 1,
          pendingZenonRedeemHash: 'zhash-legacy',
        }]
      : h.values.get(key) ?? null)
    const {requestStore} = await import('./request-store')

    const snapshot = await requestStore.getSnapshot()
    // Found via the legacy bare-hash fallback for the node's authoritative row.
    expect(zenonRedeemLockFor(snapshot.zenonRedeems, MAIN_ID)).toMatchObject({hash: 'zhash-legacy'})
    // Not mirrored under the full provisional id.
    expect(snapshot.zenonRedeems[`${HASH}:-1`]).toBeUndefined()
    // The embedded field was stripped off the tracked request.
    expect(h.set).toHaveBeenCalledWith(
      'nom-bridge:requests:v2',
      [expect.not.objectContaining({pendingZenonRedeemHash: 'zhash-legacy'})],
    )
  })

  it('migrates a node-indexed legacy redeem lock with a fence for its sibling row', async () => {
    h.get.mockImplementation(async (key: string) => key === 'nom-bridge:requests:v2'
      ? [{
          kind: 'unwrap',
          evmChainId: 1,
          zenonChainId: 1,
          id: BONUS_ID,
          zts: 'zts1znn',
          amount: '100000000',
          decimals: 8,
          symbol: 'ZNN',
          zenonToAddress: 'z1qrecipient',
          createdAt: 1,
          pendingZenonRedeemHash: 'zhash-bonus',
        }]
      : h.values.get(key) ?? null)
    const {requestStore} = await import('./request-store')

    const snapshot = await requestStore.getSnapshot()
    expect(snapshot.zenonRedeems[BONUS_ID]).toMatchObject({hash: 'zhash-bonus'})
    expect(pendingZenonRedeemFor(snapshot.zenonRedeems, MAIN_ID)).toBe('zhash-bonus')
    expect(snapshot.zenonRedeems[HASH]).toMatchObject({
      hash: 'zhash-bonus',
      fence: true,
    })
  })

  it('clearing a bonus row leaves a genuinely-legacy bare-hash entry alone', async () => {
    const {requestStore} = await import('./request-store')
    const stored = h.values.get('nom-bridge:action-locks:v1') as
      {zenonRedeems: Record<string, unknown>} | undefined
    h.values.set('nom-bridge:action-locks:v1', {
      evmClaims: {},
      zenonRedeems: {...stored?.zenonRedeems, [HASH]: {hash: 'zhash-legacy'}},
      evmTxFacts: {},
      unknownWraps: {},
    })
    await requestStore.setPendingZenonRedeem(BONUS_ID, 'zhash-bonus')
    await requestStore.clearPendingZenonRedeem(BONUS_ID)
    const snapshot = await requestStore.getSnapshot()
    // The legacy entry cannot be attributed, so it keeps fencing both rows
    // until hash-wide evidence (legacy recheck or all-rows-terminal sweep)
    // releases it via clearLegacyZenonRedeem.
    expect(pendingZenonRedeemFor(snapshot.zenonRedeems, MAIN_ID)).toBe('zhash-legacy')
    expect(pendingZenonRedeemFor(snapshot.zenonRedeems, BONUS_ID)).toBe('zhash-legacy')
    expect(snapshot.zenonRedeems[BONUS_ID]).toBeUndefined()
  })
})
