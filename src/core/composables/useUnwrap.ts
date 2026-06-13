import {ref} from 'vue'
import {BridgeService} from '../bridge-service'
import {EvmService} from '../evm-service'
import {requestStore} from '../request-store'
import {useZenonWallet} from './useZenonWallet'
import type {UnwrapRequestView} from '@/types'
import type {Address, Hex} from 'viem'

const isUnwrapping = ref(false)
const error = ref<string | null>(null)

async function unwrap(
  token: Address,
  amount: bigint,
  zenonAddress: string,
  bridge: Address,
  zts: string,
): Promise<{hash: Hex; provisionalLogIndex: number}> {
  isUnwrapping.value = true
  error.value = null
  try {
    await EvmService.getInstance().ensureAllowance(token, bridge, amount)
    const {hash, provisionalLogIndex} = await EvmService.getInstance().unwrap(
      bridge,
      token,
      amount,
      zenonAddress,
    )
    await requestStore.trackUnwrap({
      id: `${hash}:${provisionalLogIndex}`,
      zts,
      amount: amount.toString(),
      zenonToAddress: zenonAddress,
      createdAt: Date.now(),
    })
    return {hash, provisionalLogIndex}
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to submit unwrap'
    throw e
  } finally {
    isUnwrapping.value = false
  }
}

async function redeemZenon(request: UnwrapRequestView): Promise<void> {
  error.value = null
  try {
    const block = BridgeService.getInstance().buildRedeemBlock(
      request.transactionHash,
      request.logIndex,
    )
    await useZenonWallet().send(block)
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to redeem'
    throw e
  }
}

export function useUnwrap() {
  return {isUnwrapping, error, unwrap, redeemZenon}
}
