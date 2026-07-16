import {ref} from 'vue'
import {parseAmount} from '../amount'
import {BridgeService} from '../bridge-service'
import {EvmService, tssSignatureToHex} from '../evm-service'
import {requestStore} from '../request-store'
import {useZenonWallet} from './useZenonWallet'
import type {WrapTokenRequest} from 'znn-typescript-sdk'
import type {Address, Hex} from 'viem'

const isWrapping = ref(false)
const error = ref<string | null>(null)

async function wrap(
  evmToAddress: string,
  humanAmount: string | number,
  decimals: number,
  zts: string,
  symbol: string,
): Promise<string> {
  isWrapping.value = true
  error.value = null
  try {
    const block = BridgeService.getInstance().buildWrapBlock(evmToAddress, humanAmount, decimals, zts)
    const published = await useZenonWallet().send(block)
    const id = published.hash.toString()
    await requestStore.trackWrap({
      id,
      zts,
      amount: parseAmount(humanAmount, decimals).toString(),
      decimals,
      symbol,
      evmToAddress,
      createdAt: Date.now(),
    })
    return id
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to submit wrap'
    throw e
  } finally {
    isWrapping.value = false
  }
}

async function redeemEvm(request: WrapTokenRequest, bridge: Address): Promise<Hex> {
  const token = request.tokenAddress as Address
  const wrapId = ('0x' + request.id.toString()) as Hex
  const progress = await EvmService.getInstance().getWrapRedeemProgress(bridge, token, wrapId)
  if (progress.kind === 'fully-redeemed') return wrapId

  const to = request.toAddress as Address
  const netAmount = BigInt(request.amount.toString()) - BigInt(request.fee.toString())
  const nonce = BigInt('0x' + request.id.toString())
  const signature = tssSignatureToHex(request.signature)
  return EvmService.getInstance().redeem(bridge, to, token, netAmount, nonce, signature)
}

export function useWrap() {
  return {isWrapping, error, wrap, redeemEvm}
}
