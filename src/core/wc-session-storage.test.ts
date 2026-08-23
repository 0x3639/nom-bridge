import {beforeEach, describe, expect, it, vi} from 'vitest'
import {createWcStorage, SessionKeyValueStorage, WC_STORAGE_PREFIX} from './wc-session-storage'

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial))
  return {
    get length() {
      return map.size
    },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  }
}

describe('SessionKeyValueStorage', () => {
  it('round-trips JSON values and lists only its own keys', async () => {
    const backing = memoryStorage({unrelated: 'x'})
    const storage = new SessionKeyValueStorage(backing)

    await storage.setItem('wc@2:client:0.3//session', [{topic: 't'}])
    await storage.setItem('wc@2:core:0.3//keychain', {a: 1})

    expect(await storage.getItem('wc@2:client:0.3//session')).toEqual([{topic: 't'}])
    expect(await storage.getItem('missing')).toBeUndefined()
    expect((await storage.getKeys()).sort()).toEqual([
      'wc@2:client:0.3//session',
      'wc@2:core:0.3//keychain',
    ])
    expect(await storage.getEntries()).toContainEqual(['wc@2:core:0.3//keychain', {a: 1}])
    expect(backing.getItem(WC_STORAGE_PREFIX + 'wc@2:core:0.3//keychain')).toBe('{"a":1}')

    await storage.removeItem('wc@2:core:0.3//keychain')
    expect(await storage.getKeys()).toEqual(['wc@2:client:0.3//session'])
  })

  it('treats a corrupt stored value as absent instead of throwing', async () => {
    const backing = memoryStorage({[WC_STORAGE_PREFIX + 'bad']: '{not json'})
    const storage = new SessionKeyValueStorage(backing)

    expect(await storage.getItem('bad')).toBeUndefined()
  })
})

describe('createWcStorage', () => {
  beforeEach(() => vi.unstubAllGlobals())

  it('backs WalletConnect with sessionStorage and purges legacy localStorage state', () => {
    const session = memoryStorage()
    const local = memoryStorage({
      'wc@2:client:0.3//session': '[]',
      'wc@2:core:0.3//keychain': '{}',
      'nom-bridge:requests': '{}',
    })
    vi.stubGlobal('window', {sessionStorage: session, localStorage: local})

    const storage = createWcStorage()

    expect(storage).toBeInstanceOf(SessionKeyValueStorage)
    expect(local.getItem('wc@2:client:0.3//session')).toBeNull()
    expect(local.getItem('wc@2:core:0.3//keychain')).toBeNull()
    expect(local.getItem('nom-bridge:requests')).toBe('{}')
  })

  it('falls back to an ephemeral in-memory store (never WalletConnect persistent default) when sessionStorage is unavailable', async () => {
    const local = memoryStorage({'wc@2:client:0.3//session': '[]'})
    vi.stubGlobal('window', {
      get sessionStorage(): Storage {
        throw new Error('SecurityError')
      },
      localStorage: local,
    })

    const storage = createWcStorage()

    await storage.setItem('k', {v: 1})
    expect(await storage.getItem('k')).toEqual({v: 1})
    expect(await storage.getKeys()).toEqual(['k'])
    // Nothing reached a persistent store, and legacy state was still purged.
    expect(local.getItem('wc@2:client:0.3//session')).toBeNull()
    expect(local.length).toBe(0)
  })
})
