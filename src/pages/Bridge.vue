<script setup lang="ts">
import {computed, onMounted, onUnmounted, ref, watch} from 'vue'
import {extractNumberDecimals} from 'znn-typescript-sdk'
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

const toast = useToast()

const {tokenPairs, bridgeAddress, halted, momentumTime, load, refreshHalted} = useBridge()
const {address: zenonAddress} = useZenonWallet()
const {account: evmAccount, getTokenBalance} = useEvmWallet()
const {wrap, redeemEvm, isWrapping, error: wrapError} = useWrap()
const {unwrap: doUnwrap, redeemZenon, isUnwrapping, error: unwrapError} = useUnwrap()
const {
  activeRequests,
  activeUnwrapRequests,
  getRawWrapRequest,
  startPolling,
  stopPolling,
  refresh,
} = useRequests()

const direction = ref<'wrap' | 'unwrap'>('wrap')
const selectedZts = ref<string | null>(null)
const amount = ref('')
const localError = ref<string | null>(null)

const selectedPair = computed(() => tokenPairs.value.find(p => p.zts === selectedZts.value) ?? null)
const evmBalance = ref<bigint | undefined>(undefined)

// Presentational only — derive the two sides of the bridge from `direction`.
// Wrap moves native ZNN (Zenon) → wrapped wZNN (Ethereum); unwrap reverses it.
const baseSymbol = computed(() => {
  const z = selectedPair.value?.zts ?? ''
  if (z.startsWith('zts1znn')) return 'ZNN'
  if (z.startsWith('zts1qsr')) return 'QSR'
  return 'token'
})
const zenonSide = computed(() => ({network: 'Zenon', symbol: baseSymbol.value, accent: 'zenon' as const}))
const evmSide = computed(() => ({network: 'Ethereum', symbol: `w${baseSymbol.value}`, accent: 'evm' as const}))
const fromSide = computed(() => (direction.value === 'wrap' ? zenonSide.value : evmSide.value))
const toSide = computed(() => (direction.value === 'wrap' ? evmSide.value : zenonSide.value))

function swapDirection(): void {
  direction.value = direction.value === 'wrap' ? 'unwrap' : 'wrap'
}

const canSubmit = computed<boolean>(() => {
  if (!selectedPair.value || !amount.value) return false
  if (halted.value) return false
  let base: bigint
  try {
    base = BigInt(extractNumberDecimals(amount.value, selectedPair.value.decimals).toString())
  } catch {
    return false
  }
  if (base < selectedPair.value.minAmount) return false

  if (direction.value === 'unwrap') {
    if (!evmAccount.value || !zenonAddress.value || isUnwrapping.value) return false
    if (evmBalance.value === undefined || base > evmBalance.value) return false
    return true
  }

  // wrap
  if (!zenonAddress.value || !evmAccount.value || isWrapping.value) return false
  if (evmBalance.value !== undefined && base > evmBalance.value) return false
  return true
})

// Live wZNN balance for the unwrap direction; gates submit. For wrap it stays
// undefined (wrap balance gating is Zenon-side, out of scope here).
watch(
  [direction, selectedZts, evmAccount],
  async () => {
    if (direction.value === 'unwrap' && evmAccount.value && selectedPair.value) {
      try {
        evmBalance.value = await getTokenBalance(selectedPair.value.tokenAddress as Address)
      } catch {
        evmBalance.value = undefined
      }
    } else {
      evmBalance.value = undefined
    }
  },
  {immediate: true},
)

watch(
  tokenPairs,
  pairs => {
    if (!selectedZts.value && pairs.length) selectedZts.value = pairs[0].zts
  },
  {immediate: true},
)

async function onSubmit(): Promise<void> {
  localError.value = null
  if (!selectedPair.value || !evmAccount.value) return
  if (direction.value === 'unwrap') return onUnwrapSubmit()
  try {
    await refreshHalted()
    if (halted.value) {
      localError.value = 'The bridge is currently halted.'
      return
    }
    await wrap(evmAccount.value, amount.value, selectedPair.value.decimals, selectedPair.value.zts)
    toast.show('Wrap submitted', 'success')
    amount.value = ''
    await refresh()
  } catch (e) {
    localError.value = e instanceof Error ? e.message : 'Failed to submit wrap'
    toast.show(localError.value, 'error')
  }
}

async function onUnwrapSubmit(): Promise<void> {
  localError.value = null
  const pair = selectedPair.value
  const bridge = bridgeAddress.value
  if (!pair || !zenonAddress.value || !bridge) return
  try {
    await refreshHalted()
    if (halted.value) {
      localError.value = 'The bridge is currently halted.'
      return
    }
    const base = BigInt(extractNumberDecimals(amount.value, pair.decimals).toString())
    await doUnwrap(
      pair.tokenAddress as Address,
      base,
      zenonAddress.value,
      bridge as Address,
      pair.zts,
    )
    toast.show('Unwrap submitted', 'success')
    amount.value = ''
    await refresh()
  } catch (e) {
    localError.value = e instanceof Error ? e.message : 'Failed to submit unwrap'
    toast.show(localError.value, 'error')
  }
}

async function onUnwrapRedeem(view: UnwrapRequestView): Promise<void> {
  localError.value = null
  try {
    await redeemZenon(view)
    toast.show('Redeem submitted', 'success')
    await refresh()
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
    await redeemEvm(raw, bridge as `0x${string}`)
    toast.show('Redeem submitted', 'success')
    await refresh()
  } catch (e) {
    localError.value = e instanceof Error ? e.message : 'Failed to redeem'
    toast.show(localError.value, 'error')
  }
}

const displayError = computed(() => localError.value ?? wrapError.value ?? unwrapError.value)

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
      <CardDescription>Move ZNN between Zenon and EVM.</CardDescription>
    </CardHeader>
    <CardContent class="space-y-4">
      <Alert v-if="halted" variant="destructive">
        <AlertTitle>Bridge halted</AlertTitle>
        <AlertDescription>Wrapping and unwrapping are temporarily disabled.</AlertDescription>
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
              :balance="evmBalance"
              :fee-percentage="selectedPair.feePercentage"
              :min-amount="selectedPair.minAmount"
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
              ≈ {{ amount || '0.00' }}
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
