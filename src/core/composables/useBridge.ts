import {computed, ref} from 'vue'
import {BridgeService} from '../bridge-service'
import {DEFAULT_MOMENTUM_TIME} from '@/config'
import type {TokenPairView} from '@/types'
import type {BridgeNetworkInfo} from 'znn-typescript-sdk'

const networkInfo = ref<BridgeNetworkInfo | null>(null)
const halted = ref(false)
const momentumTime = ref(DEFAULT_MOMENTUM_TIME)
const isLoading = ref(false)
const error = ref<string | null>(null)

async function load(): Promise<void> {
  if (networkInfo.value) return
  isLoading.value = true
  error.value = null
  try {
    const service = BridgeService.getInstance()
    networkInfo.value = await service.getNetworkInfo()
    const info = await service.getBridgeInfo()
    halted.value = info.halted
    const orch = await service.getOrchestratorInfo()
    momentumTime.value = orch.estimatedMomentumTime || DEFAULT_MOMENTUM_TIME
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load bridge network info'
    throw e
  } finally {
    isLoading.value = false
  }
}

async function refreshHalted(): Promise<void> {
  const info = await BridgeService.getInstance().getBridgeInfo()
  halted.value = info.halted
}

export function useBridge() {
  const tokenPairs = computed<TokenPairView[]>(() =>
    (networkInfo.value?.tokenPairs ?? []).map(p => ({
      zts: p.tokenStandard.toString(),
      tokenAddress: p.tokenAddress,
      // Stubbed: TokenPair has no decimals field. ZNN/QSR are 8-decimal.
      // Real per-token decimals (ERC-20 decimals() on the EVM side) are
      // resolved in Phase 3 when amounts are actually converted.
      decimals: 8,
      minAmount: BigInt(p.minAmount.toString()),
      feePercentage: p.feePercentage,
      redeemDelay: p.redeemDelay,
    })),
  )
  const bridgeAddress = computed(() => networkInfo.value?.contractAddress ?? null)
  return {tokenPairs, bridgeAddress, halted, momentumTime, isLoading, error, load, refreshHalted}
}
