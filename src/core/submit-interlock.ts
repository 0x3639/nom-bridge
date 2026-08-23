import {readonly, ref} from 'vue'

export interface BridgeSubmitIntent {
  direction: 'wrap' | 'unwrap'
  zts: string
  amount: string
  evmAccount: string
  zenonAddress: string
  evmChainId: number | null
  bridgeAddress: string | null
}

function sameOptionalEvmAddress(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right
  return left.toLowerCase() === right.toLowerCase()
}

export function sameBridgeSubmitIntent(
  left: BridgeSubmitIntent,
  right: BridgeSubmitIntent,
): boolean {
  return (
    left.direction === right.direction &&
    left.zts === right.zts &&
    left.amount === right.amount &&
    left.evmAccount.toLowerCase() === right.evmAccount.toLowerCase() &&
    left.zenonAddress === right.zenonAddress &&
    left.evmChainId === right.evmChainId &&
    sameOptionalEvmAddress(left.bridgeAddress, right.bridgeAddress)
  )
}

export function createSubmitInterlock() {
  const inFlight = ref(false)

  async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
    if (inFlight.value) return undefined
    inFlight.value = true
    try {
      return await action()
    } finally {
      inFlight.value = false
    }
  }

  return {inFlight: readonly(inFlight), run}
}
