// Reliability primitives for the Syrius/WalletConnect integration. The timing
// values and error taxonomy are inherited from the production reference dApp
// (github.com/0x3639/bridge-dapp), which accumulated them against real Syrius
// behavior. WC_TIMING is a mutable object so tests can shrink the waits.
export const WC_TIMING = {
  requestTimeoutMs: 30_000,
  sendTimeoutMs: 120_000, // znn_send is human-paced (review + sign in Syrius)
  approvalTimeoutMs: 300_000, // pairing approval is human-paced (manual URI paste)
  settleMs: 5_000, // SignClient's session store lags behind approval()
  relaySettleMs: 2_000,
  maxAttempts: 3,
}

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Typed so callers can react to "the wallet never answered" structurally —
// e.g. connect() discards a stored session that only ever times out.
export class WalletTimeoutError extends Error {
  constructor(label: string) {
    super(`${label} timed out — check that Syrius is open and responsive`)
    this.name = 'WalletTimeoutError'
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new WalletTimeoutError(label)), ms)
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

export type WalletErrorAction = 'reconnect' | 'retry' | 'locked' | 'rejected' | 'fatal'

// Known Syrius/WalletConnect failure shapes. Callers still decide whether a
// retry is safe: in particular, znn_send must never be replayed automatically.
export function classifyWalletError(e: unknown): WalletErrorAction {
  const code = (e as {code?: number})?.code
  const message = String((e as {message?: string})?.message ?? '')
  if (typeof code === 'number' && code >= 5000 && code < 6000) return 'rejected'
  if (code === 4001) return 'rejected' // EIP-1193 userRejectedRequest

  if (code === 9000 && message.includes('Wallet is locked')) return 'locked'
  if (code === -32602 && message.includes('Bad state: No element')) return 'reconnect'
  if (code === -32602 && message.includes('No matching key')) return 'retry'
  return 'fatal'
}
