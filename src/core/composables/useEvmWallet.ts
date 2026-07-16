import {ref} from 'vue'
import {EvmService} from '../evm-service'
import {config} from '@/config'
import {getAddress, type Address} from 'viem'

const account = ref<Address | null>(null)
const chainId = ref<number | null>(null)
const isConnecting = ref(false)
const error = ref<string | null>(null)

let listenersAttached = false

function attachProviderListeners() {
  if (listenersAttached || !window.ethereum) return
  listenersAttached = true
  window.ethereum.on('accountsChanged', (accounts: string[]) => {
    if (!accounts.length) {
      account.value = null
      return
    }
    try {
      account.value = getAddress(accounts[0])
    } catch {
      account.value = null
    }
  })
  window.ethereum.on('chainChanged', (hexChainId: string) => {
    const nextChainId = Number.parseInt(hexChainId, 16)
    chainId.value = Number.isSafeInteger(nextChainId) ? nextChainId : null
  })
}

export function useEvmWallet() {
  async function connect(): Promise<void> {
    isConnecting.value = true
    error.value = null
    try {
      account.value = await EvmService.getInstance().connect()
      chainId.value = config.evmChainId
      attachProviderListeners()
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to connect EVM wallet'
      throw e
    } finally {
      isConnecting.value = false
    }
  }

  function disconnect(): void {
    account.value = null
    chainId.value = null
  }

  async function getTokenBalance(token: Address): Promise<bigint> {
    if (!account.value) return 0n
    return EvmService.getInstance().getBalance(token, account.value)
  }

  return {account, chainId, isConnecting, error, connect, disconnect, getTokenBalance}
}
