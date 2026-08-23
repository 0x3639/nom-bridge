import {ref} from 'vue'
import {PairingCancelledError, ZenonWalletService} from '../zenon-wallet-service'
import {BridgeService} from '../bridge-service'
import type {AccountBlockTemplate} from 'znn-typescript-sdk'

const address = ref<string | null>(null)
const isConnecting = ref(false)
const error = ref<string | null>(null)
// Non-null while a fresh WalletConnect pairing awaits approval in Syrius;
// PairingDialog renders it as a QR code + copyable URI.
const pairingUri = ref<string | null>(null)

const service = ZenonWalletService.getInstance()
service.onDisconnect = () => {
  address.value = null
}
service.onInfoChange = info => {
  address.value = info.address
}
service.onPairingUri = uri => {
  pairingUri.value = uri
}
service.onPairingClosed = () => {
  pairingUri.value = null
}

// Adopt a still-live WalletConnect session on app load so a page refresh
// doesn't present as "disconnected". No-op when nothing is restorable.
void service
  .restore()
  .then(info => {
    if (info && !address.value) address.value = info.address
  })
  .catch(() => {})

export function useZenonWallet() {
  async function connect(): Promise<void> {
    isConnecting.value = true
    error.value = null
    try {
      const info = await service.connect()
      address.value = info.address
    } catch (e) {
      // Closing the pairing dialog is a normal outcome, not a failure.
      if (e instanceof PairingCancelledError) return
      error.value = e instanceof Error ? e.message : 'Failed to connect Zenon wallet'
      throw e
    } finally {
      isConnecting.value = false
    }
  }

  async function send(block: AccountBlockTemplate): Promise<AccountBlockTemplate> {
    if (!address.value) throw new Error('Zenon wallet not connected')
    return service.send(address.value, block)
  }

  function cancelPairing(): void {
    service.cancelPairing()
  }

  async function disconnect(): Promise<void> {
    await service.disconnect()
    address.value = null
  }

  async function getTokenBalance(zts: string): Promise<bigint> {
    if (!address.value) return 0n
    return BridgeService.getInstance().getTokenBalance(address.value, zts)
  }

  return {
    address,
    isConnecting,
    error,
    pairingUri,
    connect,
    cancelPairing,
    send,
    disconnect,
    getTokenBalance,
  }
}
