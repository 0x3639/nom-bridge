import {afterEach, describe, expect, it, vi} from 'vitest'
import {ChromeStorageAdapter} from './chrome-storage-adapter'
import {LocalStorageAdapter} from './local-storage-adapter'

function localStorageMock(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    removeItem: vi.fn((key: string) => values.delete(key)),
    clear: vi.fn(() => values.clear()),
    key: vi.fn((index: number) => [...values.keys()][index] ?? null),
    get length() {
      return values.size
    },
  } as Storage
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('LocalStorageAdapter', () => {
  it('round-trips JSON values and removes them', async () => {
    const local = localStorageMock()
    vi.stubGlobal('localStorage', local)
    const adapter = new LocalStorageAdapter()

    await expect(adapter.get('missing')).resolves.toBeNull()
    await adapter.set('request', {amount: '42'})
    await expect(adapter.get('request')).resolves.toEqual({amount: '42'})
    await adapter.remove('request')
    await expect(adapter.get('request')).resolves.toBeNull()
  })
})

describe('ChromeStorageAdapter', () => {
  it('round-trips values through chrome.storage.local', async () => {
    const values = new Map<string, unknown>()
    const local = {
      get: vi.fn(async (key: string) => ({[key]: values.get(key)})),
      set: vi.fn(async (entry: Record<string, unknown>) => {
        Object.entries(entry).forEach(([key, value]) => values.set(key, value))
      }),
      remove: vi.fn(async (key: string) => {
        values.delete(key)
      }),
    }
    vi.stubGlobal('chrome', {storage: {local}})
    const adapter = new ChromeStorageAdapter()

    await expect(adapter.get('missing')).resolves.toBeNull()
    await adapter.set('request', false)
    await expect(adapter.get('request')).resolves.toBe(false)
    await adapter.remove('request')
    await expect(adapter.get('request')).resolves.toBeNull()
  })

  it.each(['get', 'set', 'remove'] as const)('fails closed when Chrome storage is unavailable for %s', async method => {
    vi.stubGlobal('chrome', undefined)
    const adapter = new ChromeStorageAdapter()

    const operation = method === 'get'
      ? adapter.get('key')
      : method === 'set'
        ? adapter.set('key', 'value')
        : adapter.remove('key')
    await expect(operation).rejects.toThrow('Chrome storage API not available')
  })
})

describe('storageService', () => {
  it('selects local storage and forwards operations', async () => {
    const local = localStorageMock()
    vi.stubGlobal('chrome', undefined)
    vi.stubGlobal('localStorage', local)
    const {storageService} = await import('./storage-service')

    expect(storageService.getAdapterType()).toBe('local')
    await storageService.set('key', {safe: true})
    await expect(storageService.get('key')).resolves.toEqual({safe: true})
    await storageService.remove('key')
    expect(local.removeItem).toHaveBeenCalledWith('key')
  })

  it('selects Chrome storage and subscribes only to matching local changes', async () => {
    let onChanged: ((changes: Record<string, {newValue?: unknown}>, areaName: string) => void) | undefined
    const removeListener = vi.fn()
    const chromeMock = {
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => undefined),
          remove: vi.fn(async () => undefined),
        },
        onChanged: {
          addListener: vi.fn((listener: typeof onChanged) => {
            onChanged = listener
          }),
          removeListener,
        },
      },
    }
    vi.stubGlobal('chrome', chromeMock)
    const {storageService} = await import('./storage-service')
    const listener = vi.fn()

    expect(storageService.getAdapterType()).toBe('chrome')
    const unsubscribe = storageService.subscribe('request', listener)
    onChanged?.({other: {newValue: 1}}, 'local')
    onChanged?.({request: {newValue: 1}}, 'sync')
    onChanged?.({request: {newValue: {id: '1'}}}, 'local')
    onChanged?.({request: {}}, 'local')

    expect(listener).toHaveBeenNthCalledWith(1, {id: '1'})
    expect(listener).toHaveBeenNthCalledWith(2, null)
    unsubscribe()
    expect(removeListener).toHaveBeenCalledWith(onChanged)
  })

  it('falls back to local storage when the Chrome API getter is inaccessible', async () => {
    const local = localStorageMock()
    const chromeLocal = {
      get get() {
        throw new Error('blocked')
      },
    }
    vi.stubGlobal('chrome', {storage: {local: chromeLocal}})
    vi.stubGlobal('localStorage', local)
    const {storageService} = await import('./storage-service')

    expect(storageService.getAdapterType()).toBe('local')
  })

  it('subscribes to valid browser storage events and handles removals and malformed JSON', async () => {
    const local = localStorageMock()
    let onStorage: ((event: StorageEvent) => void) | undefined
    const removeEventListener = vi.fn()
    vi.stubGlobal('chrome', undefined)
    vi.stubGlobal('localStorage', local)
    vi.stubGlobal('window', {
      addEventListener: vi.fn((_event: string, listener: (event: StorageEvent) => void) => {
        onStorage = listener
      }),
      removeEventListener,
    })
    const {storageService} = await import('./storage-service')
    const listener = vi.fn()
    const unsubscribe = storageService.subscribe('request', listener)

    onStorage?.({storageArea: local, key: 'other', newValue: '1'} as StorageEvent)
    onStorage?.({storageArea: local, key: 'request', newValue: '{"id":1}'} as StorageEvent)
    onStorage?.({storageArea: local, key: 'request', newValue: null} as StorageEvent)
    onStorage?.({storageArea: local, key: 'request', newValue: '{bad'} as StorageEvent)

    expect(listener).toHaveBeenNthCalledWith(1, {id: 1})
    expect(listener).toHaveBeenNthCalledWith(2, null)
    expect(listener).toHaveBeenNthCalledWith(3, null)
    unsubscribe()
    expect(removeEventListener).toHaveBeenCalledWith('storage', onStorage)
  })

  it('returns a no-op subscriber outside a browser', async () => {
    vi.stubGlobal('chrome', undefined)
    vi.stubGlobal('window', undefined)
    vi.stubGlobal('localStorage', localStorageMock())
    const {storageService} = await import('./storage-service')

    expect(() => storageService.subscribe('request', vi.fn())()).not.toThrow()
  })
})
