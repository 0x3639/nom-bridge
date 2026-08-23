import type {IKeyValueStorage} from '@walletconnect/keyvaluestorage'

// WalletConnect's default browser store is localStorage, where a pairing and
// its 7-day session outlive the tab, the browser, and the machine. After a
// reboot Syrius no longer holds that session, but the dApp still adopts it on
// Connect and every request into it times out — with no way to pair afresh.
// Backing the SignClient with sessionStorage keeps a session across a page
// refresh (restore() still works) but ends it with the tab.
export const WC_STORAGE_PREFIX = 'nom-bridge:wc:'
const LEGACY_WC_KEY_PREFIX = 'wc@2:'

export class SessionKeyValueStorage implements IKeyValueStorage {
  constructor(private readonly backing: Storage) {}

  async getKeys(): Promise<string[]> {
    const keys: string[] = []
    for (let i = 0; i < this.backing.length; i += 1) {
      const key = this.backing.key(i)
      if (key?.startsWith(WC_STORAGE_PREFIX)) keys.push(key.slice(WC_STORAGE_PREFIX.length))
    }
    return keys
  }

  async getEntries<T = unknown>(): Promise<[string, T][]> {
    const entries: [string, T][] = []
    for (const key of await this.getKeys()) {
      const value = await this.getItem<T>(key)
      if (value !== undefined) entries.push([key, value])
    }
    return entries
  }

  async getItem<T = unknown>(key: string): Promise<T | undefined> {
    const raw = this.backing.getItem(WC_STORAGE_PREFIX + key)
    if (raw === null) return undefined
    try {
      return JSON.parse(raw) as T
    } catch {
      return undefined
    }
  }

  async setItem<T = unknown>(key: string, value: T): Promise<void> {
    this.backing.setItem(WC_STORAGE_PREFIX + key, JSON.stringify(value))
  }

  async removeItem(key: string): Promise<void> {
    this.backing.removeItem(WC_STORAGE_PREFIX + key)
  }
}

// Sessions and key material written by earlier builds under WalletConnect's
// default localStorage keys are never read again once the store moves to
// sessionStorage; remove them so stale pairings do not linger on disk.
function purgeLegacyWcState(): void {
  try {
    const local = window.localStorage
    const stale: string[] = []
    for (let i = 0; i < local.length; i += 1) {
      const key = local.key(i)
      if (key?.startsWith(LEGACY_WC_KEY_PREFIX)) stale.push(key)
    }
    for (const key of stale) local.removeItem(key)
  } catch {
    // localStorage unavailable — nothing to purge.
  }
}

// Minimal Storage over a Map for contexts where sessionStorage is inaccessible
// (e.g. site data blocked). Ephemeral by construction — the SignClient must
// never fall through to its persistent default store (IndexedDB/localStorage).
function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    key: index => Array.from(map.keys())[index] ?? null,
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: key => void map.delete(key),
    clear: () => map.clear(),
  }
}

export function createWcStorage(): IKeyValueStorage {
  purgeLegacyWcState()
  let backing: Storage | null = null
  try {
    backing = window.sessionStorage ?? null
  } catch {
    backing = null
  }
  return new SessionKeyValueStorage(backing ?? memoryStorage())
}
