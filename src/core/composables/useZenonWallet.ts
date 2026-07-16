import {ref} from 'vue'
import {ZenonWalletService} from '../zenon-wallet-service'
import {BridgeService} from '../bridge-service'
import type {AccountBlockTemplate} from 'znn-typescript-sdk'

const address = ref<string | null>(null)
const isConnecting = ref(false)
const error = ref<string | null>(null)

const service = ZenonWalletService.getInstance()
service.onDisconnect = () => {
  address.value = null
}
service.onInfoChange = info => {
  address.value = info.address
}

export function useZenonWallet() {
  async function connect(): Promise<void> {
    isConnecting.value = true
    error.value = null
    try {
      const info = await service.connect()
      address.value = info.address
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to connect Zenon wallet'
      throw e
    } finally {
      isConnecting.value = false
    }
  }

  // WIRED now, first USED in Phase 3.
  async function send(block: AccountBlockTemplate): Promise<AccountBlockTemplate> {
    if (!address.value) throw new Error('Zenon wallet not connected')
    return service.send(address.value, block)
  }

  async function disconnect(): Promise<void> {
    await service.disconnect()
    address.value = null
  }

  async function getTokenBalance(zts: string): Promise<bigint> {
    if (!address.value) return 0n
    return BridgeService.getInstance().getTokenBalance(address.value, zts)
  }

  return {address, isConnecting, error, connect, send, disconnect, getTokenBalance}
}
