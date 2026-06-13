import {computed, ref} from 'vue'
import {BridgeService} from '../bridge-service'
import {EvmService} from '../evm-service'
import type {WrapRedeemProgress} from '../evm-service'
import {requestStore} from '../request-store'
import {DEFAULT_MOMENTUM_TIME} from '@/config'
import type {UnwrapRequestView, UnwrapStatus, WrapRequestView, WrapStatus} from '@/types'
import type {WrapTokenRequest} from 'znn-typescript-sdk'
import type {Address, Hex} from 'viem'

const wrapRequests = ref<WrapRequestView[]>([])
const unwrapRequests = ref<UnwrapRequestView[]>([])
const isLoading = ref(false)

// Parallel map id → raw node WrapTokenRequest from the last poll, so the redeem
// handler can source the SDK fields (amount/fee/signature/tokenAddress/toAddress).
let rawById = new Map<string, WrapTokenRequest>()

let intervalId: ReturnType<typeof setInterval> | null = null
let polling = false
let getEvmAddressFn: (() => string | null) | null = null
let getBridgeFn: (() => string | null) | null = null
let getZenonAddressFn: (() => string | null) | null = null
let getMomentumTimeFn: (() => number) | null = null

async function runPoll(): Promise<void> {
  const addr = getEvmAddressFn?.() ?? null
  const bridge = getBridgeFn?.() ?? null
  await poll(addr, bridge)
}

// Pure status decision, unit-testable without viem. When the signature is empty
// progress is null (the composable skips the EVM call in that branch).
export function deriveWrapStatus(
  signature: string,
  progress: WrapRedeemProgress | null,
): WrapStatus {
  if (!signature) return 'signing'
  if (!progress) return 'signing'
  if (progress.kind === 'fully-redeemed') return 'redeemed'
  if (progress.kind === 'unredeemed') return 'redeemable'
  return progress.remainingSeconds > 0 ? 'waiting-delay' : 'redeemable-2'
}

// Pure status decision for unwraps, unit-testable without viem/SDK. STRICT order
// is load-bearing: pending → revoked → redeemed → signing → redeemableIn sign.
// The signing (empty signature) check MUST precede the redeemableIn sign test so
// an unsigned + negative request is `signing`, not `broken`.
export function deriveUnwrapStatus(
  req: {signature: string; redeemed: number; revoked: number; redeemableIn: number},
  isPendingOnly: boolean,
): UnwrapStatus {
  if (isPendingOnly) return 'pending'
  if (req.revoked === 1) return 'revoked'
  if (req.redeemed === 1) return 'redeemed'
  if (!req.signature) return 'signing'
  if (req.redeemableIn < 0) return 'broken'
  if (req.redeemableIn > 0) return 'waiting'
  return 'redeemable'
}

async function poll(evmAddress: string | null, bridge: string | null): Promise<void> {
  if (polling) return
  polling = true
  try {
    const tracked = await requestStore.getAll()

    // Wrap section — runs only when both the EVM address and bridge are known.
    if (evmAddress && bridge) {
      const list = (await BridgeService.getInstance().getWrapRequests(evmAddress)).list
      const nextRaw = new Map<string, WrapTokenRequest>()
      const views: WrapRequestView[] = []
      const nodeIds = new Set<string>()

      for (const request of list) {
        const id = request.id.toString()
        nodeIds.add(id)
        nextRaw.set(id, request)

        let progress: WrapRedeemProgress | null = null
        if (request.signature) {
          progress = await EvmService.getInstance().getWrapRedeemProgress(
            bridge as Address,
            request.tokenAddress as Address,
            ('0x' + id) as Hex,
          )
        }
        const status = deriveWrapStatus(request.signature, progress)
        views.push({
          id,
          zts: request.tokenStandard.toString(),
          amount: BigInt(request.amount.toString()),
          toAddress: request.toAddress,
          status,
          remainingSeconds:
            progress && progress.kind === 'waiting-delay' ? progress.remainingSeconds : undefined,
        })
      }

      // Just-submitted wraps not yet indexed by the node show as a synthetic
      // `signing` row.
      for (const t of tracked) {
        if (t.kind !== 'wrap' || nodeIds.has(t.id)) continue
        views.push({
          id: t.id,
          zts: t.zts,
          amount: BigInt(t.amount),
          toAddress: t.evmToAddress ?? '',
          status: 'signing',
        })
      }

      rawById = nextRaw
      wrapRequests.value = views
    }

    // Unwrap section — independent of the wrap guard; runs when the Zenon
    // recipient address is known.
    const zenonAddr = getZenonAddressFn?.() ?? null
    if (zenonAddr) {
      const momentumTime = getMomentumTimeFn?.() ?? DEFAULT_MOMENTUM_TIME
      const list = (await BridgeService.getInstance().getUnwrapRequests(zenonAddr)).list
      const unwrapViews: UnwrapRequestView[] = []
      const nodeIds = new Set<string>()

      for (const req of list) {
        const id = `${req.transactionHash.toString()}:${req.logIndex}`
        nodeIds.add(id)
        const status = deriveUnwrapStatus(req, false)
        unwrapViews.push({
          id,
          transactionHash: req.transactionHash.toString(),
          logIndex: req.logIndex,
          zts: req.tokenStandard.toString(),
          amount: BigInt(req.amount.toString()),
          toAddress: req.toAddress.toString(),
          status,
          remainingSeconds: status === 'waiting' ? req.redeemableIn * momentumTime : undefined,
        })
      }

      for (const t of tracked) {
        if (t.kind !== 'unwrap' || nodeIds.has(t.id)) continue
        const [hash, idx] = t.id.split(':')
        unwrapViews.push({
          id: t.id,
          transactionHash: hash,
          logIndex: Number(idx),
          zts: t.zts,
          amount: BigInt(t.amount),
          toAddress: t.zenonToAddress ?? '',
          status: deriveUnwrapStatus(
            {signature: '', redeemed: 0, revoked: 0, redeemableIn: 0},
            true,
          ),
        })
      }

      unwrapRequests.value = unwrapViews
    } else {
      unwrapRequests.value = []
    }
  } finally {
    polling = false
  }
}

export function useRequests() {
  const activeRequests = computed(() => wrapRequests.value.filter(r => r.status !== 'redeemed'))
  const activeUnwrapRequests = computed(() =>
    unwrapRequests.value.filter(r => r.status !== 'redeemed' && r.status !== 'revoked'),
  )

  function getRawWrapRequest(id: string): WrapTokenRequest | undefined {
    return rawById.get(id)
  }

  function startPolling(
    getEvmAddress: () => string | null,
    getBridge: () => string | null,
    getZenonAddress: () => string | null,
    getMomentumTime: () => number,
  ): void {
    getEvmAddressFn = getEvmAddress
    getBridgeFn = getBridge
    getZenonAddressFn = getZenonAddress
    getMomentumTimeFn = getMomentumTime
    if (intervalId === null) {
      intervalId = setInterval(() => {
        void runPoll()
      }, 30_000)
    }
    isLoading.value = true
    void runPoll().finally(() => {
      isLoading.value = false
    })
  }

  function stopPolling(): void {
    if (intervalId !== null) {
      clearInterval(intervalId)
      intervalId = null
    }
  }

  async function refresh(): Promise<void> {
    await runPoll()
  }

  return {
    wrapRequests,
    activeRequests,
    unwrapRequests,
    activeUnwrapRequests,
    isLoading,
    getRawWrapRequest,
    startPolling,
    stopPolling,
    refresh,
  }
}
