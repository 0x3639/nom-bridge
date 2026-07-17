import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

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
    expect(snapshot.zenonRedeems['0xabc'].updatedAt).toBeTypeOf('number')
  })

  it('matches unwrap locks across prefixed and unprefixed transaction hashes', async () => {
    const {requestStore} = await import('./request-store')
    await requestStore.trackUnwrap(wrapFixture('abcdef:-1'))
    await expect(requestStore.setPendingZenonRedeem('0xABCDEF:9', 'zenon-block')).resolves.toBe(true)
    expect((await requestStore.getSnapshot()).zenonRedeems['0xabcdef']).toMatchObject({hash: 'zenon-block'})
    await requestStore.clearPendingZenonRedeem('0xabcdef:9')
    expect((await requestStore.getSnapshot()).zenonRedeems['0xabcdef']).toBeUndefined()
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
    expect(final.zenonRedeems['0xabc']).toMatchObject({hash: 'zenon-block'})
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
    expect(final.zenonRedeems['0xabc']).toMatchObject({hash: 'zenon-block'})
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
