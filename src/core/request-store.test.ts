import {beforeEach, describe, expect, it, vi} from 'vitest'

// Mock the storage adapter so the store never touches real localStorage. The
// fake holds an in-memory cell whose initial value drives ensureLoaded().
const h = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  remove: vi.fn(),
}))

vi.mock('./storage/storage-service', () => ({
  storageService: {get: h.get, set: h.set, remove: h.remove},
}))

beforeEach(() => {
  vi.resetModules()
  h.get.mockReset().mockResolvedValue(null)
  h.set.mockReset().mockResolvedValue(undefined)
  h.remove.mockReset().mockResolvedValue(undefined)
})

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

  it('loads from storage only once across repeated reads', async () => {
    const {requestStore} = await import('./request-store')
    await requestStore.getAll()
    await requestStore.getAll()
    await requestStore.trackWrap(wrapFixture('a'))
    expect(h.get).toHaveBeenCalledTimes(1)
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
})
