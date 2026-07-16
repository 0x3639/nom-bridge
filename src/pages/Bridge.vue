<script setup lang="ts">
import {computed, onMounted, onUnmounted, ref, watch} from 'vue'
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Button,
  ItemGroup,
  useToast,
} from 'nom-ui'
import {ArrowUpDown} from 'lucide-vue-next'
import TokenPairSelect from '@/components/TokenPairSelect.vue'
import AmountInput from '@/components/AmountInput.vue'
import NetworkPanel from '@/components/NetworkPanel.vue'
import RequestList from '@/components/RequestList.vue'
import UnwrapRequestItem from '@/components/UnwrapRequestItem.vue'
import {useBridge, useEvmWallet, useRequests, useUnwrap, useWrap, useZenonWallet} from '@/core'
import type {UnwrapRequestView, WrapRequestView} from '@/types'
import type {Address} from 'viem'
import {config, FEE_DENOMINATOR} from '@/config'
import {parseAmount} from '@/core/amount'
import {formatAmount} from '@/core/composables/utils/formatters'

const toast = useToast()

const {
  tokenPairs,
  bridgeAddress,
  halted,
  allowKeyGen,
  momentumTime,
  error: bridgeError,
  load,
  refresh: refreshBridge,
} = useBridge()
const {address: zenonAddress, getTokenBalance: getZenonTokenBalance} = useZenonWallet()
const {account: evmAccount, chainId: evmChainId, getTokenBalance} = useEvmWallet()
const {wrap, redeemEvm, isWrapping, error: wrapError} = useWrap()
const {unwrap: doUnwrap, redeemZenon, isUnwrapping, error: unwrapError} = useUnwrap()
const {
  activeRequests,
  activeUnwrapRequests,
  getRawWrapRequest,
  startPolling,
  stopPolling,
  refresh: refreshRequests,
  refreshForAccountChange,
  pollingError,
} = useRequests()

const direction = ref<'wrap' | 'unwrap'>('wrap')
const selectedZts = ref<string | null>(null)
const amount = ref('')
const localError = ref<string | null>(null)
const lastSubmitted = ref<{label: string; url: string} | null>(null)

const selectedPair = computed(() => tokenPairs.value.find(p => p.zts === selectedZts.value) ?? null)
const evmBalance = ref<bigint | undefined>(undefined)
const zenonBalance = ref<bigint | undefined>(undefined)
const sourceBalance = computed(() => direction.value === 'wrap' ? zenonBalance.value : evmBalance.value)
let balanceRequestId = 0

// Presentational only — derive the two sides of the bridge from `direction`.
// Wrap moves native ZNN (Zenon) → wrapped wZNN (Ethereum); unwrap reverses it.
const baseSymbol = computed(() => selectedPair.value?.symbol ?? 'token')
const zenonSide = computed(() => ({network: 'Zenon', symbol: baseSymbol.value, accent: 'zenon' as const}))
const evmSide = computed(() => ({
  network: 'Ethereum',
  symbol: selectedPair.value?.evmSymbol ?? 'token',
  accent: 'evm' as const,
}))
const fromSide = computed(() => (direction.value === 'wrap' ? zenonSide.value : evmSide.value))
const toSide = computed(() => (direction.value === 'wrap' ? evmSide.value : zenonSide.value))
const destinationAmount = computed(() => {
  const pair = selectedPair.value
  if (!pair || !amount.value) return '0.00'
  try {
    const base = parseAmount(amount.value, pair.decimals)
    const fee = (base * BigInt(pair.feePercentage)) / FEE_DENOMINATOR
    return formatAmount(base - fee, pair.decimals)
  } catch {
    return '0.00'
  }
})

function swapDirection(): void {
  direction.value = direction.value === 'wrap' ? 'unwrap' : 'wrap'
}

const canSubmit = computed<boolean>(() => {
  if (!selectedPair.value || !amount.value) return false
  if (halted.value || allowKeyGen.value) return false
  if (evmChainId.value !== config.evmChainId) return false
  let base: bigint
  try {
    base = parseAmount(amount.value, selectedPair.value.decimals)
  } catch {
    return false
  }

  if (direction.value === 'unwrap') {
    if (!selectedPair.value.unwrapEnabled || base < selectedPair.value.unwrapMinAmount) return false
    if (!evmAccount.value || !zenonAddress.value || isUnwrapping.value) return false
    if (evmBalance.value === undefined || base > evmBalance.value) return false
    return true
  }

  // wrap
  if (!selectedPair.value.wrapEnabled || base < selectedPair.value.wrapMinAmount) return false
  if (!zenonAddress.value || !evmAccount.value || isWrapping.value) return false
  if (zenonBalance.value === undefined || base > zenonBalance.value) return false
  return true
})

async function refreshBalances(): Promise<void> {
    const requestId = ++balanceRequestId
    if (direction.value === 'unwrap' && evmAccount.value && selectedPair.value) {
      try {
        const balance = await getTokenBalance(selectedPair.value.tokenAddress as Address)
        if (requestId === balanceRequestId) evmBalance.value = balance
      } catch {
        if (requestId === balanceRequestId) evmBalance.value = undefined
      }
    } else {
      evmBalance.value = undefined
    }
    if (direction.value === 'wrap' && zenonAddress.value && selectedPair.value) {
      try {
        const balance = await getZenonTokenBalance(selectedPair.value.zts)
        if (requestId === balanceRequestId) zenonBalance.value = balance
      } catch {
        if (requestId === balanceRequestId) zenonBalance.value = undefined
      }
    } else {
      zenonBalance.value = undefined
    }
}

// The source-chain balance is an execution gate, not just a display value.
watch(
  [direction, selectedZts, evmAccount, zenonAddress],
  refreshBalances,
  {immediate: true},
)

watch(
  tokenPairs,
  pairs => {
    if (!selectedZts.value && pairs.length) selectedZts.value = pairs[0].zts
  },
  {immediate: true},
)

watch([evmAccount, zenonAddress], () => {
  void refreshForAccountChange().catch(() => undefined)
})

async function onSubmit(): Promise<void> {
  localError.value = null
  lastSubmitted.value = null
  if (!selectedPair.value || !evmAccount.value) return
  if (direction.value === 'unwrap') return onUnwrapSubmit()
  const zts = selectedPair.value.zts
  try {
    await refreshBridge()
    if (halted.value || allowKeyGen.value) {
      localError.value = halted.value
        ? 'The bridge is currently halted.'
        : 'Transfers are disabled while bridge key generation is enabled.'
      return
    }
    const pair = tokenPairs.value.find(candidate => candidate.zts === zts)
    if (!pair || !pair.wrapEnabled) throw new Error('Wrapping is disabled for this token pair')
    const base = parseAmount(amount.value, pair.decimals)
    if (base < pair.wrapMinAmount) throw new Error('Amount is below the current wrap minimum')
    const hash = await wrap(
      evmAccount.value,
      amount.value,
      pair.decimals,
      pair.zts,
      pair.symbol,
    )
    toast.show('Wrap submitted', 'success')
    lastSubmitted.value = {label: 'View Zenon transaction', url: config.zenonExplorerTxUrl + hash}
    amount.value = ''
    if (zenonBalance.value !== undefined) zenonBalance.value -= base
    await refreshRequestsSafely()
  } catch (e) {
    localError.value = e instanceof Error ? e.message : 'Failed to submit wrap'
    toast.show(localError.value, 'error')
  }
}

async function onUnwrapSubmit(): Promise<void> {
  localError.value = null
  const bridge = bridgeAddress.value
  const zts = selectedPair.value?.zts
  if (!zts || !zenonAddress.value || !bridge) return
  try {
    await refreshBridge()
    if (halted.value || allowKeyGen.value) {
      localError.value = halted.value
        ? 'The bridge is currently halted.'
        : 'Transfers are disabled while bridge key generation is enabled.'
      return
    }
    const pair = tokenPairs.value.find(candidate => candidate.zts === zts)
    if (!pair || !pair.unwrapEnabled) throw new Error('Unwrapping is disabled for this token pair')
    const base = parseAmount(amount.value, pair.decimals)
    if (base < pair.unwrapMinAmount) throw new Error('Amount is below the current unwrap minimum')
    const {hash, eventMatched} = await doUnwrap(
      pair.tokenAddress as Address,
      base,
      zenonAddress.value,
      bridge as Address,
      pair.zts,
      pair.decimals,
      pair.symbol,
    )
    toast.show('Unwrap submitted', 'success')
    if (!eventMatched) {
      toast.show('Transaction confirmed; waiting for the Zenon node to recover its event index.', 'info')
    }
    lastSubmitted.value = {label: 'View Ethereum transaction', url: config.evmExplorerTxUrl + hash}
    amount.value = ''
    await refreshBalances()
    await refreshRequestsSafely()
  } catch (e) {
    localError.value = e instanceof Error ? e.message : 'Failed to submit unwrap'
    toast.show(localError.value, 'error')
  }
}

async function onUnwrapRedeem(view: UnwrapRequestView): Promise<void> {
  localError.value = null
  try {
    const hash = await redeemZenon(view)
    toast.show('Redeem submitted', 'success')
    lastSubmitted.value = {label: 'View Zenon transaction', url: config.zenonExplorerTxUrl + hash}
    await refreshRequestsSafely()
  } catch (e) {
    localError.value = e instanceof Error ? e.message : 'Failed to redeem'
    toast.show(localError.value, 'error')
  }
}

async function onRedeem(view: WrapRequestView): Promise<void> {
  localError.value = null
  const raw = getRawWrapRequest(view.id)
  const bridge = bridgeAddress.value
  if (!raw || !bridge) return
  try {
    const hash = await redeemEvm(raw, bridge as `0x${string}`)
    toast.show('Redeem submitted', 'success')
    lastSubmitted.value = {label: 'View Ethereum transaction', url: config.evmExplorerTxUrl + hash}
    await refreshRequestsSafely()
  } catch (e) {
    localError.value = e instanceof Error ? e.message : 'Failed to redeem'
    toast.show(localError.value, 'error')
  }
}

async function refreshRequestsSafely(): Promise<void> {
  try {
    await refreshRequests()
  } catch {
    toast.show('Transaction submitted; request status will retry automatically.', 'info')
  }
}

const displayError = computed(
  () => localError.value ?? bridgeError.value ?? wrapError.value ?? unwrapError.value,
)

onMounted(async () => {
  try {
    await load()
  } catch {
    // surfaced via useBridge error + global handler
  }
  startPolling(
    () => evmAccount.value,
    () => bridgeAddress.value,
    () => zenonAddress.value,
    () => momentumTime.value,
    () => tokenPairs.value,
  )
})

onUnmounted(() => {
  stopPolling()
})
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle>Bridge</CardTitle>
      <CardDescription>Move supported tokens between Zenon and Ethereum.</CardDescription>
    </CardHeader>
    <CardContent class="space-y-4">
      <Alert v-if="halted" variant="destructive">
        <AlertTitle>Bridge halted</AlertTitle>
        <AlertDescription>Wrapping and unwrapping are temporarily disabled.</AlertDescription>
      </Alert>

      <Alert v-else-if="allowKeyGen" variant="destructive">
        <AlertTitle>Bridge key generation</AlertTitle>
        <AlertDescription>
          Transfers are disabled during key generation.
          <a :href="config.bridgeStatusUrl" target="_blank" rel="noopener noreferrer" class="underline">
            Check bridge status
          </a>.
        </AlertDescription>
      </Alert>

      <Alert v-if="evmAccount && evmChainId !== config.evmChainId" variant="destructive">
        <AlertTitle>Wrong Ethereum network</AlertTitle>
        <AlertDescription>Switch your wallet to Ethereum Mainnet before continuing.</AlertDescription>
      </Alert>

      <div class="space-y-2">
        <NetworkPanel
          role="From"
          :network="fromSide.network"
          :symbol="fromSide.symbol"
          :accent="fromSide.accent"
          :pulse="fromSide.accent === 'zenon'"
          :momentum-time="momentumTime"
        >
          <div class="space-y-3">
            <TokenPairSelect v-model="selectedZts" :pairs="tokenPairs" />
            <AmountInput
              v-if="selectedPair"
              v-model="amount"
              :decimals="selectedPair.decimals"
              :balance="sourceBalance"
              :fee-percentage="selectedPair.feePercentage"
              :min-amount="direction === 'wrap' ? selectedPair.wrapMinAmount : selectedPair.unwrapMinAmount"
              :disabled="isWrapping || isUnwrapping"
            />
          </div>
        </NetworkPanel>

        <div class="relative flex justify-center">
          <button
            type="button"
            class="z-10 -my-4 grid h-9 w-9 place-items-center rounded-full border bg-card text-muted-foreground transition-colors hover:border-zenon-green/50 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            title="Swap direction"
            aria-label="Swap direction"
            @click="swapDirection"
          >
            <ArrowUpDown class="h-4 w-4" />
          </button>
        </div>

        <NetworkPanel
          role="To"
          :network="toSide.network"
          :symbol="toSide.symbol"
          :accent="toSide.accent"
          :pulse="toSide.accent === 'zenon'"
          :momentum-time="momentumTime"
        >
          <div class="flex items-baseline justify-between gap-2">
            <span class="font-mono text-2xl tabular-nums text-muted-foreground">
              ≈ {{ destinationAmount }}
            </span>
            <span class="font-mono text-xs text-muted-foreground">minus bridge fee</span>
          </div>
        </NetworkPanel>
      </div>

      <Button type="button" size="lg" class="w-full" :disabled="!canSubmit" @click="onSubmit">
        <template v-if="direction === 'wrap'">{{ isWrapping ? 'Submitting…' : `Wrap ${baseSymbol}` }}</template>
        <template v-else>{{ isUnwrapping ? 'Submitting…' : `Unwrap ${baseSymbol}` }}</template>
      </Button>

      <Alert v-if="displayError" variant="destructive">
        <AlertTitle>Error</AlertTitle>
        <AlertDescription>{{ displayError }}</AlertDescription>
      </Alert>

      <Alert v-else-if="pollingError">
        <AlertTitle>Request status unavailable</AlertTitle>
        <AlertDescription>{{ pollingError }}</AlertDescription>
      </Alert>

      <a
        v-if="lastSubmitted"
        :href="lastSubmitted.url"
        target="_blank"
        rel="noopener noreferrer"
        class="block text-center text-sm text-primary underline"
      >
        {{ lastSubmitted.label }}
      </a>

      <RequestList
        v-if="direction === 'wrap'"
        :requests="activeRequests"
        @redeem="onRedeem"
      />
      <template v-else>
        <ItemGroup v-if="activeUnwrapRequests.length" class="gap-2">
          <UnwrapRequestItem
            v-for="request in activeUnwrapRequests"
            :key="request.id"
            :request="request"
            @redeem="onUnwrapRedeem"
          />
        </ItemGroup>
        <p v-else class="text-sm text-muted-foreground">No active requests.</p>
      </template>
    </CardContent>
  </Card>
</template>
