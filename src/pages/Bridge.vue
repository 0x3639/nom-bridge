<script setup lang="ts">
import {computed, onMounted, onUnmounted, ref, watch} from 'vue'
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Card,
  CardContent,
  ItemGroup,
  useToast,
} from 'nom-ui'
import {ArrowUpDown, Clock3, Wallet} from 'lucide-vue-next'
import RequestList from '@/components/RequestList.vue'
import UnwrapRequestItem from '@/components/UnwrapRequestItem.vue'
import {useBridge, useEvmWallet, useRequests, useUnwrap, useWrap, useZenonWallet} from '@/core'
import type {UnwrapRequestView, WrapRequestView} from '@/types'
import type {Address} from 'viem'
import {config, FEE_DENOMINATOR} from '@/config'
import {parseAmount} from '@/core/amount'
import {formatAmount, truncateAddress} from '@/core/composables/utils/formatters'
import {addNumberDecimals} from 'znn-typescript-sdk'

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
const {
  address: zenonAddress,
  isConnecting: isZenonConnecting,
  connect: connectZenon,
  disconnect: disconnectZenon,
  getTokenBalance: getZenonTokenBalance,
} = useZenonWallet()
const {
  account: evmAccount,
  chainId: evmChainId,
  isConnecting: isEvmConnecting,
  connect: connectEvm,
  disconnect: disconnectEvm,
  getTokenBalance,
} = useEvmWallet()
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

const direction = ref<'wrap' | 'unwrap'>('unwrap')
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
  if (!pair || !amount.value) return '0'
  try {
    const base = parseAmount(amount.value, pair.decimals)
    const fee = (base * BigInt(pair.feePercentage)) / FEE_DENOMINATOR
    return formatAmount(base - fee, pair.decimals)
  } catch {
    return '0'
  }
})

const sourceAddress = computed(() =>
  direction.value === 'wrap' ? zenonAddress.value : evmAccount.value,
)
const destinationAddress = computed(() =>
  direction.value === 'wrap' ? evmAccount.value : zenonAddress.value,
)
const sourceConnected = computed(() => Boolean(sourceAddress.value))
const destinationConnected = computed(() => Boolean(destinationAddress.value))
const sourceConnecting = computed(() =>
  direction.value === 'wrap' ? isZenonConnecting.value : isEvmConnecting.value,
)
const destinationConnecting = computed(() =>
  direction.value === 'wrap' ? isEvmConnecting.value : isZenonConnecting.value,
)
const isSubmitting = computed(() => isWrapping.value || isUnwrapping.value)
const minimumAmount = computed(() => {
  const pair = selectedPair.value
  if (!pair) return undefined
  return direction.value === 'wrap' ? pair.wrapMinAmount : pair.unwrapMinAmount
})
const sourceBalanceLabel = computed(() => {
  const pair = selectedPair.value
  const balance = sourceBalance.value
  if (!pair || balance === undefined) return null
  return `${formatDisplayAmount(balance, pair.decimals)} ${fromSide.value.symbol}`
})
const minimumLabel = computed(() => {
  const pair = selectedPair.value
  const minimum = minimumAmount.value
  if (!pair || minimum === undefined) return null
  return `Min ${formatDisplayAmount(minimum, pair.decimals)} ${fromSide.value.symbol}`
})
const feePercentageLabel = computed(() => {
  const basisPoints = selectedPair.value?.feePercentage ?? 0
  return (basisPoints / 100).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')
})
const rateLabel = computed(() => {
  const basisPoints = selectedPair.value?.feePercentage ?? 0
  const rate = (1 - basisPoints / Number(FEE_DENOMINATOR)).toFixed(4)
  return rate.replace(/0+$/, '').replace(/\.$/, '')
})
const ctaLabel = computed(() => {
  if (!sourceConnected.value) {
    return sourceConnecting.value ? 'Connecting source wallet…' : 'Connect source wallet'
  }
  if (!destinationConnected.value) {
    return destinationConnecting.value
      ? 'Connecting destination wallet…'
      : 'Connect destination wallet'
  }
  if (isSubmitting.value) return 'Submitting…'
  return `Bridge to ${toSide.value.network}`
})
const ctaDisabled = computed(() => {
  if (!sourceConnected.value) return sourceConnecting.value
  if (!destinationConnected.value) return destinationConnecting.value
  return !canSubmit.value
})

function formatDisplayAmount(base: bigint, decimals: number): string {
  const [whole = '0', fraction = ''] = formatAmount(base, decimals).split('.')
  const groupedWhole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const compactFraction = fraction.replace(/0+$/, '').slice(0, 6).replace(/0+$/, '')
  return compactFraction ? `${groupedWhole}.${compactFraction}` : groupedWhole
}

function updateAmount(event: Event): void {
  amount.value = (event.target as HTMLInputElement).value
}

function updateTokenPair(event: Event): void {
  selectedZts.value = (event.target as HTMLSelectElement).value
}

function setBalanceFraction(percent: 25 | 50 | 100): void {
  const pair = selectedPair.value
  const balance = sourceBalance.value
  if (!pair || balance === undefined) return
  const base = (balance * BigInt(percent)) / 100n
  amount.value = addNumberDecimals(base.toString(), pair.decimals)
}

async function connectWallet(accent: 'zenon' | 'evm'): Promise<void> {
  try {
    if (accent === 'zenon') await connectZenon()
    else await connectEvm()
  } catch (error) {
    toast.show(error instanceof Error ? error.message : 'Failed to connect wallet', 'error')
  }
}

async function disconnectWallet(accent: 'zenon' | 'evm'): Promise<void> {
  try {
    if (accent === 'zenon') await disconnectZenon()
    else disconnectEvm()
  } catch (error) {
    toast.show(error instanceof Error ? error.message : 'Failed to disconnect wallet', 'error')
  }
}

async function onCtaClick(): Promise<void> {
  if (!sourceConnected.value) return connectWallet(fromSide.value.accent)
  if (!destinationConnected.value) return connectWallet(toSide.value.accent)
  return onSubmit()
}

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
  <div class="space-y-4">
    <Card class="overflow-hidden rounded-[18px] border-border/80 bg-card shadow-2xl shadow-black/20">
      <CardContent class="space-y-4 !p-5">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2.5">
            <span
              class="inline-block h-3 w-3 rotate-45 rounded-[2px] bg-zenon-green"
              aria-hidden="true"
            />
            <h2 class="text-lg font-semibold tracking-tight">Bridge</h2>
          </div>
          <router-link
            to="/requests"
            class="grid h-9 w-9 place-items-center rounded-full border border-border/80 text-muted-foreground transition-colors hover:border-foreground/25 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            title="History"
            aria-label="History"
          >
            <Clock3 class="h-4 w-4" />
          </router-link>
        </div>

        <Alert v-if="halted" variant="destructive">
          <AlertTitle>Bridge halted</AlertTitle>
          <AlertDescription>Wrapping and unwrapping are temporarily disabled.</AlertDescription>
        </Alert>

        <Alert v-else-if="allowKeyGen" variant="destructive">
          <AlertTitle>Bridge key generation</AlertTitle>
          <AlertDescription>
            Transfers are disabled during key generation.
            <a
              :href="config.bridgeStatusUrl"
              target="_blank"
              rel="noopener noreferrer"
              class="underline"
            >
              Check bridge status
            </a>.
          </AlertDescription>
        </Alert>

        <Alert v-if="evmAccount && evmChainId !== config.evmChainId" variant="destructive">
          <AlertTitle>Wrong Ethereum network</AlertTitle>
          <AlertDescription>Switch your wallet to Ethereum Mainnet before continuing.</AlertDescription>
        </Alert>

        <div class="flex flex-col gap-2">
          <section
            class="rounded-[14px] border p-4"
            :class="
              fromSide.accent === 'zenon'
                ? 'border-zenon-green/35 bg-zenon-green/[0.06]'
                : 'border-zenon-blue/35 bg-zenon-blue/[0.06]'
            "
          >
            <div class="mb-3.5 flex min-h-6 items-center justify-between gap-3">
              <p
                class="font-mono text-[10px] font-medium uppercase tracking-[0.2em]"
                :class="fromSide.accent === 'zenon' ? 'text-zenon-green' : 'text-zenon-blue'"
              >
                From · {{ fromSide.network }}
              </p>

              <button
                v-if="!sourceConnected"
                type="button"
                class="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:cursor-wait"
                :disabled="sourceConnecting"
                @click="connectWallet(fromSide.accent)"
              >
                {{ sourceConnecting ? 'Connecting…' : 'Not connected' }}
                <Wallet class="h-3.5 w-3.5" />
              </button>

              <div v-else class="flex min-w-0 items-center justify-end gap-2">
                <span
                  v-if="sourceBalanceLabel"
                  class="hidden truncate font-mono text-[11px] text-muted-foreground sm:inline"
                >
                  {{ sourceBalanceLabel }}
                </span>
                <button
                  type="button"
                  class="flex shrink-0 items-center gap-1.5 rounded-full border border-border/80 bg-background/70 px-2.5 py-1 font-mono text-[11px] text-foreground transition-colors hover:border-foreground/25"
                  :title="`Disconnect ${fromSide.network} wallet`"
                  @click="disconnectWallet(fromSide.accent)"
                >
                  <span>{{ truncateAddress(sourceAddress ?? '') }}</span>
                  <Wallet class="h-[13px] w-[13px] text-muted-foreground" />
                  <span class="h-1.5 w-1.5 rounded-full bg-zenon-green" aria-hidden="true" />
                </button>
              </div>
            </div>

            <div class="flex items-center gap-3">
              <div
                class="relative flex shrink-0 items-center gap-2 rounded-full border border-border/80 bg-background/70 px-4 py-2.5"
                :class="tokenPairs.length > 1 ? 'cursor-pointer' : ''"
              >
                <span
                  class="inline-block h-3 w-3 shrink-0"
                  :class="
                    fromSide.accent === 'zenon'
                      ? 'rotate-45 rounded-[2px] bg-zenon-green'
                      : 'rounded-full bg-zenon-blue'
                  "
                  aria-hidden="true"
                />
                <span class="font-mono text-[15px] font-semibold text-foreground">
                  {{ fromSide.symbol }}
                </span>
                <select
                  v-if="tokenPairs.length > 1"
                  class="absolute inset-0 cursor-pointer opacity-0"
                  :value="selectedZts ?? ''"
                  aria-label="Select bridge token"
                  title="Select bridge token"
                  @change="updateTokenPair"
                >
                  <option v-for="pair in tokenPairs" :key="pair.zts" :value="pair.zts">
                    {{ direction === 'wrap' ? pair.symbol : pair.evmSymbol }}
                  </option>
                </select>
              </div>

              <input
                :value="amount"
                type="text"
                inputmode="decimal"
                autocomplete="off"
                placeholder="0"
                aria-label="Amount to bridge"
                class="min-w-0 flex-1 bg-transparent text-right font-mono text-[28px] leading-none tabular-nums text-zinc-300 outline-none placeholder:text-zinc-600 disabled:cursor-not-allowed disabled:text-zinc-600"
                :disabled="!sourceConnected || isSubmitting || !selectedPair"
                @input="updateAmount"
              />
            </div>

            <div v-if="sourceConnected" class="mt-3.5 flex items-center justify-between gap-3">
              <span class="font-mono text-[10px] text-muted-foreground">
                {{ minimumLabel ?? 'Minimum unavailable' }}
              </span>
              <div class="flex items-center gap-[18px]">
                <button
                  v-for="shortcut in ([25, 50, 100] as const)"
                  :key="shortcut"
                  type="button"
                  class="font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                  :disabled="sourceBalance === undefined || isSubmitting"
                  @click="setBalanceFraction(shortcut)"
                >
                  {{ shortcut === 100 ? 'Max' : `${shortcut}%` }}
                </button>
              </div>
            </div>
          </section>

          <div class="relative z-10 flex justify-center">
            <button
              type="button"
              class="-my-6 grid h-10 w-10 place-items-center rounded-full border border-border/80 bg-card text-muted-foreground shadow-sm transition-colors hover:border-zenon-green/50 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              title="Swap direction"
              aria-label="Swap direction"
              @click="swapDirection"
            >
              <ArrowUpDown class="h-4 w-4" />
            </button>
          </div>

          <section
            class="rounded-[14px] border p-4"
            :class="
              toSide.accent === 'zenon'
                ? 'border-zenon-green/35 bg-zenon-green/[0.06]'
                : 'border-zenon-blue/35 bg-zenon-blue/[0.06]'
            "
          >
            <div class="mb-3.5 flex min-h-6 items-center justify-between gap-3">
              <p
                class="font-mono text-[10px] font-medium uppercase tracking-[0.2em]"
                :class="toSide.accent === 'zenon' ? 'text-zenon-green' : 'text-zenon-blue'"
              >
                To · {{ toSide.network }}
              </p>

              <button
                v-if="!destinationConnected"
                type="button"
                class="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:cursor-wait"
                :disabled="destinationConnecting"
                @click="connectWallet(toSide.accent)"
              >
                {{ destinationConnecting ? 'Connecting…' : 'Not connected' }}
                <Wallet class="h-3.5 w-3.5" />
              </button>

              <button
                v-else
                type="button"
                class="flex shrink-0 items-center gap-1.5 rounded-full border border-border/80 bg-background/70 px-2.5 py-1 font-mono text-[11px] text-foreground transition-colors hover:border-foreground/25"
                :title="`Disconnect ${toSide.network} wallet`"
                @click="disconnectWallet(toSide.accent)"
              >
                <span>{{ truncateAddress(destinationAddress ?? '') }}</span>
                <Wallet class="h-[13px] w-[13px] text-muted-foreground" />
                <span class="h-1.5 w-1.5 rounded-full bg-zenon-green" aria-hidden="true" />
              </button>
            </div>

            <div class="flex items-center gap-3">
              <div class="flex shrink-0 items-center gap-2 rounded-full border border-border/80 bg-background/70 px-4 py-2.5">
                <span
                  class="inline-block h-3 w-3 shrink-0"
                  :class="
                    toSide.accent === 'zenon'
                      ? 'rotate-45 rounded-[2px] bg-zenon-green'
                      : 'rounded-full bg-zenon-blue'
                  "
                  aria-hidden="true"
                />
                <span class="font-mono text-[15px] font-semibold text-foreground">
                  {{ toSide.symbol }}
                </span>
              </div>
              <output
                class="min-w-0 flex-1 text-right font-mono text-[28px] leading-none tabular-nums text-zinc-500"
                aria-label="Estimated amount received"
              >
                {{ destinationAmount }}
              </output>
            </div>

            <p class="mt-3.5 font-mono text-[10px] text-muted-foreground">
              1 {{ fromSide.symbol }} ≈ {{ rateLabel }} {{ toSide.symbol }} ·
              {{ feePercentageLabel }}% bridge fee
            </p>
          </section>
        </div>

        <button
          type="button"
          class="w-full rounded-full bg-zenon-green px-4 py-3.5 text-sm font-semibold text-[#04150b] transition-colors hover:bg-zenon-green/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40"
          :disabled="ctaDisabled"
          @click="onCtaClick"
        >
          {{ ctaLabel }}
        </button>

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
      </CardContent>
    </Card>

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
  </div>
</template>
