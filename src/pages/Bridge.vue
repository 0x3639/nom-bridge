<script setup lang="ts">
import PairingDialog from '@/components/PairingDialog.vue'
import {computed, nextTick, onMounted, onUnmounted, ref, watch} from 'vue'
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Card,
  CardContent,
  useToast,
} from 'nom-ui'
import {ArrowUpDown, Clock3, Wallet} from 'lucide-vue-next'
import TransferProgress from '@/components/TransferProgress.vue'
import {
  createSubmitInterlock,
  sameBridgeSubmitIntent,
  type BridgeSubmitIntent,
  useBridge,
  useEvmWallet,
  useRequests,
  useUnwrap,
  useWrap,
  useZenonWallet,
} from '@/core'
import {
  approvalPlan,
  isAuthoritativeLockHash,
  isUnwrapSourceConfirmed,
  shouldHandoffLocalUnwrapLock,
  shouldHandoffLocalWrapLock,
  unwrapRequestProgress,
  wrapRequestProgress,
} from '@/core/approval-ux'
import {selfReferralPayout} from '@/core/affiliate'
import {normalizeEvmHash} from '@/core/evm-hash'
import {EvmSubmissionError} from '@/core/evm-service'
import {ZenonSubmissionError} from '@/core/zenon-wallet-service'
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
  confirmationsToFinality,
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
const {
  wrap,
  redeemEvm,
  isWrapping,
  phase: wrapPhase,
  pendingRedeems: pendingWrapRedeems,
  pendingRedeemHashes: pendingWrapRedeemHashes,
  pendingRedeemStages: pendingWrapRedeemStages,
  clearPendingRedeem: clearPendingWrapRedeem,
  clearLocalPendingRedeem: clearLocalPendingWrapRedeem,
  recheckPendingRedeem: recheckPendingWrapRedeem,
  recoverClaimPlaceholder: recoverWrapClaimPlaceholder,
  resetPhase: resetWrapPhase,
  clearPhase: clearWrapPhase,
  error: wrapError,
} = useWrap()
const {
  unwrap: doUnwrap,
  redeemZenon,
  isUnwrapping,
  phase: unwrapPhase,
  pendingRedeems: pendingUnwrapRedeems,
  clearLocalPendingRedeem: clearLocalPendingUnwrapRedeem,
  recheckZenonRedeem,
  recheckSubmittedUnwrap,
  resetPhase: resetUnwrapPhase,
  clearPhase: clearUnwrapPhase,
  error: unwrapError,
} = useUnwrap()
const {
  wrapRequests,
  activeRequests,
  unwrapRequests,
  activeUnwrapRequests,
  unknownWrapOperations,
  unknownUnwrapOperations,
  unknownSourceOperationsHydrated,
  getRawWrapRequest,
  startPolling,
  stopPolling,
  refresh: refreshRequests,
  refreshForAccountChange,
  clearUnknownUnwrapOperation,
  pollingError,
} = useRequests()

const direction = ref<'wrap' | 'unwrap'>('unwrap')
const selectedZts = ref<string | null>(null)
const amount = ref('')
const localError = ref<string | null>(null)
const lastSubmitted = ref<{label: string; url: string} | null>(null)
const lastCompleted = ref<{label: string; url: string} | null>(null)
const awaitingCompletion = ref<{
  kind: 'wrap' | 'unwrap'
  requestId: string
  transactionHash?: string
  explorer: {label: string; url: string}
} | null>(null)
const progressRegion = ref<HTMLElement | null>(null)
const sourceRechecking = ref(false)
const {inFlight: submitInFlight, run: withSubmitInterlock} = createSubmitInterlock()
// Durable hashless safety records for ambiguous Zenon wrap submissions by the
// connected account; polling reconciles them against the node's request list.
const relevantUnknownWraps = computed(() =>
  unknownWrapOperations.value.filter(operation =>
    evmAccount.value &&
    operation.evmToAddress.toLowerCase() === evmAccount.value.toLowerCase(),
  ),
)
const relevantUnknownUnwraps = computed(() =>
  unknownUnwrapOperations.value.filter(operation =>
    evmAccount.value &&
    operation.evmChainId === config.evmChainId &&
    operation.evmFromAddress.toLowerCase() === evmAccount.value.toLowerCase(),
  ),
)

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
    if (direction.value === 'wrap') {
      const fee = (base * BigInt(pair.feePercentage)) / FEE_DENOMINATOR
      return formatAmount(base - fee, pair.decimals)
    }
    // Exact protocol payout (two independent floors), not floor(base * bps):
    // the aggregate rounding over-estimates by one base unit for many amounts.
    return formatAmount(
      pair.unwrapBonusBps > 0 ? selfReferralPayout(base) : base,
      pair.decimals,
    )
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
const isSubmitting = computed(() =>
  submitInFlight.value || isWrapping.value || isUnwrapping.value,
)
const hasSubmittedSafetyState = computed(() =>
  wrapPhase.value.kind === 'submitted-untracked' ||
  wrapPhase.value.kind === 'submitted-unknown' ||
  relevantUnknownWraps.value.length > 0 ||
  unwrapPhase.value.kind === 'submitted-unknown' ||
  relevantUnknownUnwraps.value.length > 0 ||
  unwrapPhase.value.kind === 'submitted-unconfirmed' ||
  unwrapPhase.value.kind === 'submitted-untracked',
)
const directionLocked = computed(() => isSubmitting.value || hasSubmittedSafetyState.value)
const operationDirection = computed<'wrap' | 'unwrap'>(() => {
  if (
    isWrapping.value ||
    wrapPhase.value.kind === 'submitted-untracked' ||
    wrapPhase.value.kind === 'submitted-unknown'
  ) return 'wrap'
  if (
    isUnwrapping.value ||
    unwrapPhase.value.kind === 'submitted-unknown' ||
    unwrapPhase.value.kind === 'submitted-unconfirmed' ||
    unwrapPhase.value.kind === 'submitted-untracked'
  ) return 'unwrap'
  if (direction.value === 'unwrap' && relevantUnknownUnwraps.value.length > 0) return 'unwrap'
  if (direction.value === 'wrap' && relevantUnknownWraps.value.length > 0) return 'wrap'
  if (relevantUnknownUnwraps.value.length > 0) return 'unwrap'
  if (relevantUnknownWraps.value.length > 0) return 'wrap'
  return direction.value
})
const approvalPlanCopy = computed(() => approvalPlan(direction.value))
const displayedPendingWrapRedeems = computed(() => {
  const pending = {...pendingWrapRedeems.value}
  for (const request of wrapRequests.value) {
    if (request.pendingClaimHash && !pending[request.id]) pending[request.id] = 'confirming'
  }
  return pending
})
const displayedPendingUnwrapRedeems = computed(() => {
  const pending = {...pendingUnwrapRedeems.value}
  for (const request of unwrapRequests.value) {
    if (request.pendingZenonRedeemHash && !pending[request.id]) pending[request.id] = 'confirming'
  }
  return pending
})
const actionableRequestCount = computed(() =>
  activeRequests.value.filter(request =>
    wrapRequestProgress(request.status, displayedPendingWrapRedeems.value[request.id]).actionable,
  ).length +
  activeUnwrapRequests.value.filter(request =>
    unwrapRequestProgress(
      request.status,
      displayedPendingUnwrapRedeems.value[request.id],
      request.totalApprovals,
    ).actionable,
  ).length,
)

// The unwrap branch ends in a switch that TypeScript verifies as exhaustive
// over the UnwrapPhase union — adding a `default` would silence that compile-
// time check, so the lint rule (which cannot see exhaustiveness) is disabled
// here instead. A new phase kind without a case fails `vue-tsc`.
const operationPhase = computed<{
  badge: string
  title: string
  description: string
  explorerUrl?: string
  explorerLabel?: string
  // eslint-disable-next-line vue/return-in-computed-property
} | null>(() => {
  if (operationDirection.value === 'wrap') {
    if (wrapPhase.value.kind === 'submitting-wrap') {
      return {
        badge: 'Step 1 of 3',
        title: 'Approve wrap in Syrius',
        description: 'Confirm the Zenon source transaction. Two Ethereum claims will follow after bridge signatures and the security delay.',
      }
    }
    if (wrapPhase.value.kind === 'failed') {
      return {badge: 'Retry available', title: 'Syrius request did not complete', description: wrapPhase.value.message}
    }
    if (wrapPhase.value.kind === 'submitted-untracked') {
      return {
        badge: 'Submitted',
        title: 'Wrap submitted; tracking unavailable',
        description: wrapPhase.value.message,
        explorerUrl: config.zenonExplorerTxUrl + wrapPhase.value.id,
        explorerLabel: 'View submitted Zenon transaction',
      }
    }
    if (wrapPhase.value.kind === 'submitted-unknown') {
      return {
        badge: 'Submitted · verify status',
        title: 'Wrap may have been submitted',
        description: wrapPhase.value.message,
      }
    }
    if (relevantUnknownWraps.value.length > 0) {
      // Restored after a reload from the durable operation record.
      return {
        badge: 'Submitted · verify status',
        title: 'Wrap may have been submitted',
        description: 'A previous wrap may have been submitted, but Syrius did not return a result. Do not submit it again; the node is being checked for the transfer.',
      }
    }
    return null
  }

  switch (unwrapPhase.value.kind) {
    case 'checking-allowance':
      return {
        badge: 'Read only',
        title: 'Checking token allowance',
        description: 'The bridge is checking whether token approval is needed. No wallet confirmation is required for this read.',
      }
    case 'approving-token':
      return {
        badge: 'Step 1 of 3',
        title: `Approve ${selectedPair.value?.evmSymbol ?? 'token'} in MetaMask`,
        description: 'Approve only the exact bridge amount. The bridge transfer prompt comes next.',
      }
    case 'confirming-approval':
      return {
        badge: 'Step 1 of 3',
        title: 'Confirming token approval',
        description: 'The approval was submitted to Ethereum. The bridge transfer will not be requested until it confirms.',
        explorerUrl: config.evmExplorerTxUrl + unwrapPhase.value.hash,
        explorerLabel: 'View submitted Ethereum transaction',
      }
    case 'submitting-unwrap':
      return {
        badge: `Step ${unwrapPhase.value.step} of ${unwrapPhase.value.total}`,
        title: 'Confirm bridge transfer in MetaMask',
        description: unwrapPhase.value.total === 2
          ? 'The existing token allowance is sufficient, so the separate approval was skipped.'
          : 'The exact-amount token approval is confirmed. Submit the bridge transfer next.',
      }
    case 'confirming-unwrap':
      return {
        badge: `Step ${unwrapPhase.value.step} of ${unwrapPhase.value.total}`,
        title: 'Confirming bridge transfer',
        description: 'The Ethereum transaction was submitted. Keep this page open while it confirms.',
        explorerUrl: config.evmExplorerTxUrl + unwrapPhase.value.hash,
        explorerLabel: 'View submitted Ethereum transaction',
      }
    case 'submitted-unknown':
      return {
        badge: 'Submitted · verify status',
        title: 'Bridge transfer may have been submitted',
        description: unwrapPhase.value.message,
      }
    case 'submitted-unconfirmed':
      return {
        badge: 'Submitted · verify status',
        title: 'Bridge transfer submitted',
        description: unwrapPhase.value.message,
        explorerUrl: config.evmExplorerTxUrl + unwrapPhase.value.hash,
        explorerLabel: 'View submitted Ethereum transaction',
      }
    case 'submitted-untracked':
      return {
        badge: 'Confirmed · tracking unavailable',
        title: 'Bridge transfer confirmed',
        description: unwrapPhase.value.message,
        explorerUrl: config.evmExplorerTxUrl + unwrapPhase.value.hash,
        explorerLabel: 'View confirmed Ethereum transaction',
      }
    case 'failed':
      return {
        badge: 'Retry available',
        title: unwrapPhase.value.stage === 'token-approval'
          ? 'Token approval did not complete'
          : unwrapPhase.value.stage === 'bridge-transfer'
            ? 'Bridge transfer did not complete'
            : 'Allowance check failed',
        description: unwrapPhase.value.message,
      }
    case 'idle':
      if (relevantUnknownUnwraps.value.length > 0) {
        return {
          badge: 'Submitted · verify status',
          title: 'Bridge transfer may have been submitted',
          description: 'A previous transfer may have reached MetaMask or Ethereum without returning its transaction hash. Do not submit it again; review MetaMask activity and History while automatic checks look for a matching confirmed event.',
        }
      }
      return null
  }
})
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
const rateLabel = computed(() => {
  const pair = selectedPair.value
  const basisPoints = direction.value === 'wrap'
    ? -(pair?.feePercentage ?? 0)
    : (pair?.unwrapBonusBps ?? 0)
  const rate = (1 + basisPoints / Number(FEE_DENOMINATOR)).toFixed(4)
  return rate.replace(/0+$/, '').replace(/\.$/, '')
})
const feeSummaryLabel = computed(() => {
  const pair = selectedPair.value
  const formatBps = (bps: number) =>
    (bps / 100).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')
  if (direction.value === 'wrap') return `${formatBps(pair?.feePercentage ?? 0)}% bridge fee`
  const bonus = pair?.unwrapBonusBps ?? 0
  return bonus > 0 ? `includes ${formatBps(bonus)}% bonus` : 'no bridge fee'
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
  if (direction.value === 'wrap' && wrapPhase.value.kind === 'failed') return 'Retry wrap submission'
  if (direction.value === 'unwrap' && unwrapPhase.value.kind === 'failed') {
    if (unwrapPhase.value.stage === 'allowance') return 'Retry allowance check'
    if (unwrapPhase.value.stage === 'token-approval') return 'Retry token approval'
    return 'Retry bridge transfer'
  }
  // An active submission wins: its own pre-send safety record would otherwise
  // relabel a normal in-flight wrap as "already submitted".
  if (isSubmitting.value) return operationPhase.value ? `${operationPhase.value.title}…` : 'Submitting…'
  if (hasSubmittedSafetyState.value) return 'Transfer already submitted'
  return `Bridge to ${toSide.value.network}`
})
const ctaDisabled = computed(() => {
  if (isSubmitting.value) return true
  if (hasSubmittedSafetyState.value) return true
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
  if (isSubmitting.value) return
  amount.value = (event.target as HTMLInputElement).value
}

function updateTokenPair(event: Event): void {
  if (isSubmitting.value) return
  selectedZts.value = (event.target as HTMLSelectElement).value
}

function setBalanceFraction(percent: 25 | 50 | 100): void {
  if (isSubmitting.value) return
  const pair = selectedPair.value
  const balance = sourceBalance.value
  if (!pair || balance === undefined) return
  const base = (balance * BigInt(percent)) / 100n
  amount.value = addNumberDecimals(base.toString(), pair.decimals)
}

async function connectWallet(accent: 'zenon' | 'evm'): Promise<void> {
  if (isSubmitting.value) return
  try {
    if (accent === 'zenon') await connectZenon()
    else await connectEvm()
  } catch (error) {
    toast.show(error instanceof Error ? error.message : 'Failed to connect wallet', 'error')
  }
}

async function disconnectWallet(accent: 'zenon' | 'evm'): Promise<void> {
  if (isSubmitting.value) return
  try {
    if (accent === 'zenon') await disconnectZenon()
    else disconnectEvm()
  } catch (error) {
    toast.show(error instanceof Error ? error.message : 'Failed to disconnect wallet', 'error')
  }
}

async function onCtaClick(): Promise<void> {
  if (isSubmitting.value) return
  if (!sourceConnected.value) return connectWallet(fromSide.value.accent)
  if (!destinationConnected.value) return connectWallet(toSide.value.accent)
  return onSubmit()
}

function swapDirection(): void {
  if (directionLocked.value) return
  direction.value = direction.value === 'wrap' ? 'unwrap' : 'wrap'
}

const canSubmit = computed<boolean>(() => {
  // Durable safety records must be enforced before any submission is possible;
  // until hydration completes the form cannot know whether a lock exists.
  if (isSubmitting.value) return false
  if (!unknownSourceOperationsHydrated.value) return false
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

// An ambiguous wrap submission resolves when polling reconciles its durable
// operation record against the originating account chain and clears it. Only
// records observed OUTSIDE an active submission count — a normal wrap creates
// and clears its own pre-send record.
let hadUnknownWrapOperations = false
watch([relevantUnknownWraps, isWrapping], ([operations, wrapping]) => {
  if (operations.length > 0) {
    if (!wrapping) hadUnknownWrapOperations = true
    return
  }
  if (!hadUnknownWrapOperations) return
  hadUnknownWrapOperations = false
  if (wrapPhase.value.kind === 'submitted-unknown') clearWrapPhase()
  toast.show('The wrap was published after all. Continue from the transfer progress list.', 'success')
})

let manuallyClearingUnknownUnwrapId: string | null = null
watch(unknownUnwrapOperations, operations => {
  const current = unwrapPhase.value
  if (current.kind !== 'submitted-unknown') return
  if (operations.some(operation => operation.id === current.operationId)) return
  clearUnwrapPhase()
  if (manuallyClearingUnknownUnwrapId === current.operationId) {
    manuallyClearingUnknownUnwrapId = null
    return
  }
  toast.show('The bridge transfer was found on Ethereum and restored to History.', 'success')
})

// Failed prompts are contextual. Editing the route, token, amount, or wallet
// clears stale retry copy, while submitted/unknown states remain locked until
// authoritative request polling finds them.
watch([direction, selectedZts, amount, evmAccount, zenonAddress], () => {
  const hadFailure = wrapPhase.value.kind === 'failed' || unwrapPhase.value.kind === 'failed'
  resetWrapPhase()
  resetUnwrapPhase()
  if (hadFailure) localError.value = null
}, {immediate: true})

watch([wrapRequests, unwrapRequests], () => {
  for (const id of Object.keys(pendingWrapRedeems.value)) {
    const request = wrapRequests.value.find(candidate => candidate.id === id)
    const stage = pendingWrapRedeemStages.value[id]
    if (
      pendingWrapRedeems.value[id] === 'confirming' &&
      request &&
      // A persisted placeholder is not a handoff-worthy hash: it means the
      // real broadcast hash exists only in this context's memory.
      shouldHandoffLocalWrapLock(stage, request.status, isAuthoritativeLockHash(request.pendingClaimHash))
    ) {
      clearLocalPendingWrapRedeem(id)
    }
  }
  for (const id of Object.keys(pendingUnwrapRedeems.value)) {
    const request = unwrapRequests.value.find(candidate => candidate.id === id)
    if (
      pendingUnwrapRedeems.value[id] === 'confirming' &&
      request &&
      shouldHandoffLocalUnwrapLock(request.status, isAuthoritativeLockHash(request.pendingZenonRedeemHash))
    ) {
      clearLocalPendingUnwrapRedeem(id)
    }
  }

  const currentWrapPhase = wrapPhase.value
  if (
    currentWrapPhase.kind === 'submitted-untracked' &&
    wrapRequests.value.some(request => request.id === currentWrapPhase.id)
  ) clearWrapPhase()


  const currentUnwrapPhase = unwrapPhase.value
  if (
    (currentUnwrapPhase.kind === 'submitted-unconfirmed' || currentUnwrapPhase.kind === 'submitted-untracked') &&
    unwrapRequests.value.some(request =>
      isUnwrapSourceConfirmed(request.status) &&
      normalizeEvmHash(request.transactionHash) === normalizeEvmHash(currentUnwrapPhase.hash),
    )
  ) clearUnwrapPhase()

  const awaiting = awaitingCompletion.value
  if (!awaiting) return
  if (awaiting.kind === 'wrap') {
    if (wrapRequests.value.some(request => request.id === awaiting.requestId && request.status === 'redeemed')) {
      lastCompleted.value = awaiting.explorer
      awaitingCompletion.value = null
      void clearPendingWrapRedeem(awaiting.requestId)
    }
    return
  }

  // Exact-id match: a self-referral bonus row shares the main row's tx hash,
  // so a hash lookup could observe the OTHER row's terminal status and clear
  // this row's state while its redeem block is still pending. Only transient
  // UI state is cleared here — the durable redeem lock is owned by the
  // reconciliation layer, which releases it per-row on authoritative protocol
  // advancement (useRequests forward-only clearing).
  const final = unwrapRequests.value.find(request => request.id === awaiting.requestId)
  if (final?.status === 'redeemed') {
    lastCompleted.value = awaiting.explorer
    awaitingCompletion.value = null
    clearLocalPendingUnwrapRedeem(awaiting.requestId)
  } else if (final?.status === 'revoked') {
    awaitingCompletion.value = null
    clearLocalPendingUnwrapRedeem(awaiting.requestId)
  }
}, {immediate: true})

function captureSubmitIntent(): BridgeSubmitIntent | null {
  const pair = selectedPair.value
  const evm = evmAccount.value
  const zenon = zenonAddress.value
  const bridge = bridgeAddress.value
  if (!pair || !amount.value || !evm || !zenon) return null
  if (direction.value === 'unwrap' && !bridge) return null
  let baseAmount: bigint
  try {
    baseAmount = parseAmount(amount.value, pair.decimals)
  } catch {
    return null
  }

  return {
    direction: direction.value,
    zts: pair.zts,
    amount: baseAmount,
    decimals: pair.decimals,
    evmAccount: evm,
    zenonAddress: zenon,
    evmChainId: evmChainId.value,
    bridgeAddress: bridge,
  }
}

function assertSubmitIntentUnchanged(intent: BridgeSubmitIntent): void {
  const current = captureSubmitIntent()
  if (!current || !sameBridgeSubmitIntent(intent, current)) {
    throw new Error('Transfer details changed during the safety check. Review them and submit again.')
  }
}

async function onSubmit(): Promise<void> {
  if (!canSubmit.value) return
  const intent = captureSubmitIntent()
  if (!intent) return
  await withSubmitInterlock(() => onSubmitLocked(intent))
}

async function onSubmitLocked(intent: BridgeSubmitIntent): Promise<void> {
  localError.value = null
  lastSubmitted.value = null
  lastCompleted.value = null
  if (intent.direction === 'unwrap') return onUnwrapSubmit(intent)
  try {
    await refreshBridge()
    assertSubmitIntentUnchanged(intent)
    if (halted.value || allowKeyGen.value) {
      localError.value = halted.value
        ? 'The bridge is currently halted.'
        : 'Transfers are disabled while bridge key generation is enabled.'
      return
    }
    const pair = tokenPairs.value.find(candidate => candidate.zts === intent.zts)
    if (!pair || !pair.wrapEnabled) throw new Error('Wrapping is disabled for this token pair')
    const base = intent.amount
    if (base < pair.wrapMinAmount) throw new Error('Amount is below the current wrap minimum')
    await refreshBalances()
    assertSubmitIntentUnchanged(intent)
    const refreshedBalance = zenonBalance.value
    if (refreshedBalance === undefined) {
      throw new Error('Could not refresh the Zenon balance; the wrap was not submitted')
    }
    if (base > refreshedBalance) {
      throw new Error('Zenon balance changed and is now insufficient for this wrap')
    }
    const {id: hash, trackingFailed} = await wrap(
      intent.evmAccount,
      formatAmount(base, intent.decimals),
      intent.decimals,
      pair.zts,
      pair.symbol,
      intent.zenonAddress,
    )
    toast.show('Wrap submitted', 'success')
    if (trackingFailed) {
      toast.show('The wrap was submitted, but local tracking failed. Do not submit it again.', 'info')
    }
    lastSubmitted.value = {label: 'View Zenon transaction', url: config.zenonExplorerTxUrl + hash}
    amount.value = ''
    if (zenonBalance.value !== undefined) zenonBalance.value -= base
    await refreshRequestsSafely()
    await focusProgressRegion()
  } catch (e) {
    if (e instanceof ZenonSubmissionError && e.kind === 'ambiguous') {
      // The wrap block may still be signed and broadcast by Syrius; the form
      // is locked (submitted-unknown) until the node shows a new wrap request
      // or the user verifies in Syrius that nothing was sent.
      localError.value = null
      toast.show('The wrap may have been submitted. Do not submit it again — checking the Zenon node for the transfer.', 'info')
      await refreshRequestsSafely()
      return
    }
    localError.value = e instanceof Error ? e.message : 'Failed to submit wrap'
    toast.show(localError.value, 'error')
  }
}

async function onUnwrapSubmit(intent: BridgeSubmitIntent): Promise<void> {
  localError.value = null
  const bridge = intent.bridgeAddress
  if (!bridge) return
  try {
    await refreshBridge()
    assertSubmitIntentUnchanged(intent)
    if (halted.value || allowKeyGen.value) {
      localError.value = halted.value
        ? 'The bridge is currently halted.'
        : 'Transfers are disabled while bridge key generation is enabled.'
      return
    }
    const pair = tokenPairs.value.find(candidate => candidate.zts === intent.zts)
    if (!pair || !pair.unwrapEnabled) throw new Error('Unwrapping is disabled for this token pair')
    const base = intent.amount
    if (base < pair.unwrapMinAmount) throw new Error('Amount is below the current unwrap minimum')
    await refreshBalances()
    assertSubmitIntentUnchanged(intent)
    const refreshedBalance = evmBalance.value
    if (refreshedBalance === undefined) {
      throw new Error('Could not refresh the EVM token balance; the unwrap was not submitted')
    }
    if (base > refreshedBalance) {
      throw new Error('EVM token balance changed and is now insufficient for this unwrap')
    }
    const result = await doUnwrap(
      pair.tokenAddress as Address,
      base,
      intent.zenonAddress,
      bridge as Address,
      pair.zts,
      pair.decimals,
      pair.symbol,
      intent.evmAccount,
      pair.unwrapBonusBps > 0,
    )
    const {hash} = result
    toast.show(
      result.kind === 'confirmed'
        ? 'Bridge transfer confirmed'
        : 'Bridge transfer submitted; confirmation status is unavailable',
      result.kind === 'confirmed' ? 'success' : 'info',
    )
    if (result.trackingFailed) {
      toast.show('Local request tracking failed. Do not submit the transfer again.', 'info')
    }
    if (result.kind === 'confirmed' && !result.eventMatched) {
      toast.show('Transaction confirmed; waiting for the Zenon node to recover its event index.', 'info')
    }
    lastSubmitted.value = {label: 'View Ethereum transaction', url: config.evmExplorerTxUrl + hash}
    amount.value = ''
    await refreshBalances()
    await refreshRequestsSafely()
    await focusProgressRegion()
  } catch (e) {
    if (e instanceof EvmSubmissionError && e.kind === 'submission-unknown') {
      localError.value = null
      toast.show('The bridge transfer may have been submitted. Do not submit it again while its status is resolved.', 'info')
      await refreshRequestsSafely()
      return
    }
    localError.value = e instanceof Error ? e.message : 'Failed to submit unwrap'
    toast.show(localError.value, 'error')
  }
}

async function onUnwrapRedeem(view: UnwrapRequestView): Promise<void> {
  if (displayedPendingUnwrapRedeems.value[view.id]) return
  localError.value = null
  try {
    const hash = await redeemZenon(view)
    toast.show('Zenon redemption published; waiting for node confirmation', 'success')
    lastSubmitted.value = {label: 'View Zenon transaction', url: config.zenonExplorerTxUrl + hash}
    awaitingCompletion.value = {
      kind: 'unwrap',
      requestId: view.id,
      transactionHash: normalizeEvmHash(view.transactionHash),
      explorer: lastSubmitted.value,
    }
    await refreshRequestsSafely()
  } catch (e) {
    if (e instanceof ZenonSubmissionError && e.kind === 'ambiguous') {
      localError.value = null
      toast.show('Zenon redemption may have been submitted. The safety lock remains active while node status is checked.', 'info')
      await refreshRequestsSafely()
      return
    }
    localError.value = e instanceof Error ? e.message : 'Failed to redeem'
    toast.show(localError.value, 'error')
    await refreshRequestsSafely()
  }
}

async function onRedeem(view: WrapRequestView): Promise<void> {
  if (displayedPendingWrapRedeems.value[view.id]) return
  localError.value = null
  const raw = getRawWrapRequest(view.id)
  const bridge = bridgeAddress.value
  if (!raw || !bridge) return
  try {
    const result = await redeemEvm(raw, bridge as `0x${string}`, (submittedHash, claimStage) => {
      lastSubmitted.value = {
        label: 'View Ethereum transaction',
        url: config.evmExplorerTxUrl + submittedHash,
      }
      if (claimStage === 2) {
        awaitingCompletion.value = {
          kind: 'wrap',
          requestId: view.id,
          explorer: lastSubmitted.value,
        }
      }
    })
    if (result.kind === 'already-redeemed') {
      lastSubmitted.value = null
      toast.show('This claim was already completed. Refreshing its authoritative status.', 'info')
      await refreshRequestsSafely()
      return
    }
    const hash = result.hash
    const completed = result.claimStage === 2
    toast.show(completed ? 'Bridge complete' : 'First claim confirmed', 'success')
    lastSubmitted.value = {label: 'View Ethereum transaction', url: config.evmExplorerTxUrl + hash}
    if (completed) lastCompleted.value = lastSubmitted.value
    if (completed) awaitingCompletion.value = null
    await refreshRequestsSafely()
  } catch (e) {
    if (e instanceof EvmSubmissionError && e.kind === 'reverted') {
      localError.value = e.message
      toast.show('Ethereum confirms the claim reverted. It is safe to retry.', 'error')
      await refreshRequestsSafely()
      return
    }
    if (
      (e instanceof EvmSubmissionError && e.kind === 'confirmation-unknown') ||
      (!(e instanceof EvmSubmissionError) &&
        displayedPendingWrapRedeems.value[view.id] === 'confirming')
    ) {
      localError.value = null
      toast.show('Claim submitted; confirmation is unavailable. Do not submit it again. Recheck its status below.', 'info')
      await refreshRequestsSafely()
      return
    }
    localError.value = e instanceof Error ? e.message : 'Failed to redeem'
    toast.show(localError.value, 'error')
  }
}

async function onRecheckSubmittedUnwrap(): Promise<void> {
  sourceRechecking.value = true
  try {
    const outcome = await recheckSubmittedUnwrap()
    if (outcome === 'confirmed') {
      toast.show('Ethereum confirms the bridge transfer succeeded.', 'success')
      await refreshRequestsSafely()
    } else if (outcome === 'reverted') {
      toast.show('Ethereum confirms the transaction reverted. It is safe to retry.', 'info')
      await refreshRequestsSafely()
    } else if (outcome === 'absent') {
      toast.show('No configured RPC knows this transaction yet. The safety lock remains active until its outcome can be proven.', 'info')
    } else {
      toast.show('Ethereum could not confirm success or failure across the configured RPCs. The safety lock remains active.', 'info')
    }
  } finally {
    sourceRechecking.value = false
  }
}

async function onRecheckWrap(request: WrapRequestView): Promise<void> {
  // Prefer a real persisted hash; if the persisted lock still holds the
  // pre-prompt placeholder (its persist failed post-broadcast), the in-memory
  // hash is the only authoritative record of the submitted transaction.
  const persisted = request.pendingClaimHash
  const hash = isAuthoritativeLockHash(persisted)
    ? persisted
    : pendingWrapRedeemHashes.value[request.id]
  if (!hash) {
    if (!persisted) {
      clearLocalPendingWrapRedeem(request.id)
      await refreshRequestsSafely()
      return
    }
    // Placeholder-only lock: recover it here, under the claim's Web Lock —
    // this is the only UI-reachable path for a crash-orphaned placeholder.
    const recovery = await recoverWrapClaimPlaceholder(request.id)
    await refreshRequestsSafely()
    if (recovery === 'released') {
      toast.show('The abandoned claim attempt was cleared. You can claim again.', 'info')
    } else if (recovery === 'kept') {
      toast.show('The previous claim attempt is still unresolved; the safety lock remains active.', 'info')
    }
    return
  }
  const outcome = await recheckPendingWrapRedeem(request.id, hash as `0x${string}`)
  await refreshRequestsSafely()
  if (outcome === 'reverted') {
    toast.show('Ethereum confirms the claim reverted. It is safe to retry.', 'info')
  } else if (outcome === 'confirmed') {
    toast.show('The claim transaction is confirmed; refreshing bridge state.', 'success')
  } else if (outcome === 'absent') {
    toast.show('No configured RPC knows this transaction. The safety lock remains active until its outcome can be proven.', 'info')
  } else {
    toast.show('The claim could not be confirmed or reverted across the configured RPCs. Its safety lock remains active.', 'info')
  }
}

async function onRecheckUnwrap(request: UnwrapRequestView): Promise<void> {
  await refreshRequestsSafely()
  const current = unwrapRequests.value.find(candidate => candidate.id === request.id) ?? request
  if (current.status === 'redeemed') {
    toast.show('Zenon confirms the redemption completed.', 'success')
    return
  }
  if (current.pendingZenonRedeemHash) {
    // Evidence-based lock resolution: probes the published block's outcome on
    // the account chain, or recovers a crash-orphaned placeholder.
    const result = await recheckZenonRedeem(current)
    await refreshRequestsSafely()
    if (result === 'released-failed') {
      toast.show('Zenon confirms the redemption failed on-chain. It is safe to retry.', 'info')
    } else if (result === 'released-processed') {
      // Target-unknown legacy lock: the block finished, but whether the main
      // or bonus redemption succeeded is unknowable — neutral copy only.
      toast.show('The previous redemption attempt finished; request statuses were refreshed.', 'info')
    } else if (result === 'released-orphan') {
      toast.show('The abandoned redemption attempt was cleared. You can redeem again.', 'info')
    } else {
      toast.show('The redemption is not confirmed yet. The safety lock remains active.', 'info')
    }
    return
  }
  toast.show('Zenon has not confirmed completion. The safety lock remains active.', 'info')
}

function dismissSubmittedNotice(): void {
  if (wrapPhase.value.kind === 'submitted-untracked') clearWrapPhase()
  if (unwrapPhase.value.kind === 'submitted-untracked') clearUnwrapPhase()
  toast.show('Tracking notice dismissed. The confirmed transfer must not be submitted again.', 'info')
}

async function onResolveUnknownUnwrap(): Promise<void> {
  const operation = relevantUnknownUnwraps.value[0]
  if (!operation) return
  const confirmed = window.confirm(
    'Clear this safety lock only if you verified in MetaMask activity and an Ethereum explorer that no matching transaction is pending or confirmed. Clear it now?',
  )
  if (!confirmed) return
  manuallyClearingUnknownUnwrapId = operation.id
  try {
    await clearUnknownUnwrapOperation(operation.id)
    if (unwrapPhase.value.kind === 'submitted-unknown') clearUnwrapPhase()
    manuallyClearingUnknownUnwrapId = null
    toast.show('Safety lock cleared after manual verification. Review the transfer details before retrying.', 'info')
  } catch (e) {
    manuallyClearingUnknownUnwrapId = null
    toast.show(e instanceof Error ? e.message : 'Could not clear the transfer safety lock', 'error')
  }
}

async function focusProgressRegion(): Promise<void> {
  await nextTick()
  progressRegion.value?.focus({preventScroll: false})
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
    () => confirmationsToFinality.value,
  )
})

onUnmounted(() => {
  stopPolling()
})
</script>

<template>
  <PairingDialog />
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
            class="relative grid h-9 w-9 place-items-center rounded-full border border-border/80 text-muted-foreground transition-colors hover:border-foreground/25 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            title="History"
            aria-label="History"
          >
            <Clock3 class="h-4 w-4" />
            <span
              v-if="actionableRequestCount"
              class="absolute -right-1.5 -top-1.5 grid min-h-5 min-w-5 place-items-center rounded-full bg-zenon-green px-1 text-[10px] font-semibold text-[#04150b]"
              :aria-label="`${actionableRequestCount} bridge actions required`"
            >
              {{ actionableRequestCount }}
            </span>
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
                :disabled="sourceConnecting || isSubmitting"
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
                  class="flex shrink-0 items-center gap-1.5 rounded-full border border-border/80 bg-background/70 px-2.5 py-1 font-mono text-[11px] text-foreground transition-colors hover:border-foreground/25 disabled:cursor-not-allowed disabled:opacity-50"
                  :title="`Disconnect ${fromSide.network} wallet`"
                  :disabled="isSubmitting"
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
                  :disabled="isSubmitting"
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
              class="-my-6 grid h-10 w-10 place-items-center rounded-full border border-border/80 bg-card text-muted-foreground shadow-sm transition-colors hover:border-zenon-green/50 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40"
              title="Swap direction"
              aria-label="Swap direction"
              :disabled="directionLocked"
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
                :disabled="destinationConnecting || isSubmitting"
                @click="connectWallet(toSide.accent)"
              >
                {{ destinationConnecting ? 'Connecting…' : 'Not connected' }}
                <Wallet class="h-3.5 w-3.5" />
              </button>

              <button
                v-else
                type="button"
                class="flex shrink-0 items-center gap-1.5 rounded-full border border-border/80 bg-background/70 px-2.5 py-1 font-mono text-[11px] text-foreground transition-colors hover:border-foreground/25 disabled:cursor-not-allowed disabled:opacity-50"
                :title="`Disconnect ${toSide.network} wallet`"
                :disabled="isSubmitting"
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
              {{ feeSummaryLabel }}
            </p>
          </section>
        </div>

        <p
          v-if="sourceConnected && destinationConnected && !operationPhase"
          class="px-2 text-center text-xs leading-relaxed text-muted-foreground"
        >
          {{ approvalPlanCopy }}
        </p>

        <div
          v-if="operationPhase"
          class="rounded-[14px] border border-border/80 bg-background/50 p-4"
          aria-live="polite"
        >
          <div class="mb-2 flex items-center justify-between gap-3">
            <p class="text-sm font-semibold">{{ operationPhase.title }}</p>
            <span class="shrink-0 rounded-full bg-primary/10 px-2.5 py-1 text-[10px] font-medium text-primary">
              {{ operationPhase.badge }}
            </span>
          </div>
          <p class="text-xs leading-relaxed text-muted-foreground">{{ operationPhase.description }}</p>
          <a
            v-if="operationPhase.explorerUrl"
            :href="operationPhase.explorerUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="mt-2 inline-block text-xs text-primary underline"
          >
            {{ operationPhase.explorerLabel ?? 'View pending Ethereum transaction' }}
          </a>
          <div
            v-if="unwrapPhase.kind === 'submitted-unconfirmed'"
            class="mt-3 flex flex-wrap gap-2"
          >
            <button
              type="button"
              class="rounded-full border border-border px-3 py-1.5 text-xs font-medium text-foreground disabled:opacity-40"
              :disabled="sourceRechecking"
              @click="onRecheckSubmittedUnwrap"
            >
              {{ sourceRechecking ? 'Rechecking…' : 'Recheck on Ethereum' }}
            </button>
          </div>
          <button
            v-if="relevantUnknownUnwraps.length > 0"
            type="button"
            class="mt-3 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-foreground"
            @click="onResolveUnknownUnwrap"
          >
            I verified no transaction was sent
          </button>
          <button
            v-if="wrapPhase.kind === 'submitted-untracked' || unwrapPhase.kind === 'submitted-untracked'"
            type="button"
            class="mt-3 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-foreground"
            @click="dismissSubmittedNotice"
          >
            Continue without local tracking
          </button>
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

    <div ref="progressRegion" tabindex="-1" class="rounded-[18px] outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <TransferProgress
        :wrap-requests="activeRequests"
        :unwrap-requests="activeUnwrapRequests"
        :pending-wrap-redeems="displayedPendingWrapRedeems"
        :pending-unwrap-redeems="displayedPendingUnwrapRedeems"
        @redeem-wrap="onRedeem"
        @redeem-unwrap="onUnwrapRedeem"
        @recheck-wrap="onRecheckWrap"
        @recheck-unwrap="onRecheckUnwrap"
      />
    </div>

    <Card v-if="lastCompleted" class="rounded-[18px] border-border/80 bg-card">
      <CardContent class="space-y-3 !p-5" aria-live="polite">
        <div>
          <p class="text-sm font-semibold">Bridge complete</p>
          <p class="mt-1 text-xs text-muted-foreground">
            The final destination transaction is confirmed. No further wallet action is required.
          </p>
        </div>
        <div class="flex flex-wrap gap-2">
          <button
            type="button"
            class="rounded-full bg-zenon-green px-4 py-2 text-xs font-semibold text-[#04150b]"
            @click="lastCompleted = null"
          >
            Bridge another token
          </button>
          <a
            :href="lastCompleted.url"
            target="_blank"
            rel="noopener noreferrer"
            class="rounded-full border border-border px-4 py-2 text-xs font-medium text-foreground"
          >
            {{ lastCompleted.label }}
          </a>
          <router-link
            to="/requests"
            class="rounded-full border border-border px-4 py-2 text-xs font-medium text-foreground"
          >
            View history
          </router-link>
        </div>
      </CardContent>
    </Card>
  </div>
</template>
