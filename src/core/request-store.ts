import {storageService} from './storage/storage-service'
import type {TrackedRequest} from '@/types'
import {config} from '@/config'

const STORAGE_KEY = 'nom-bridge:requests:v2'

// In-memory mirror, loaded once on first access. Mutations update the mirror
// synchronously and persist asynchronously; reads go through the mirror so they
// never block on storage.
let mirror: TrackedRequest[] | null = null

async function ensureLoaded(): Promise<TrackedRequest[]> {
  if (mirror === null) {
    mirror = (await storageService.get<TrackedRequest[]>(STORAGE_KEY)) ?? []
  }
  return mirror
}

async function persist(): Promise<void> {
  await storageService.set(STORAGE_KEY, mirror ?? [])
}

export const requestStore = {
  async trackWrap(r: Omit<TrackedRequest, 'kind' | 'evmChainId' | 'zenonChainId'>): Promise<void> {
    const list = await ensureLoaded()
    if (list.some(e => e.id === r.id)) return
    list.push({
      kind: 'wrap',
      evmChainId: config.evmChainId,
      zenonChainId: config.zenonChainId,
      ...r,
    })
    await persist()
  },

  async trackUnwrap(r: Omit<TrackedRequest, 'kind' | 'evmChainId' | 'zenonChainId'>): Promise<void> {
    const list = await ensureLoaded()
    if (list.some(e => e.id === r.id)) return
    list.push({
      kind: 'unwrap',
      evmChainId: config.evmChainId,
      zenonChainId: config.zenonChainId,
      ...r,
    })
    await persist()
  },

  async getAll(): Promise<TrackedRequest[]> {
    return [...(await ensureLoaded())]
  },

  // Phase 5 — declared now, implemented minimally.
  async prune(predicate: (r: TrackedRequest) => boolean): Promise<void> {
    const list = await ensureLoaded()
    mirror = list.filter(r => !predicate(r))
    await persist()
  },
}
