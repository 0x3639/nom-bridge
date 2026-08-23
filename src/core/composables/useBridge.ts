import {ref} from 'vue'
import {BridgeService} from '../bridge-service'
import {EvmService} from '../evm-service'
import {parseUnwrapBonusBps} from '../affiliate'
import {config, DEFAULT_MOMENTUM_TIME} from '@/config'
import type {TokenPairView} from '@/types'
import type {BridgeNetworkInfo, TokenPair} from 'znn-typescript-sdk'
import type {Address} from 'viem'

const networkInfo = ref<BridgeNetworkInfo | null>(null)
const tokenPairs = ref<TokenPairView[]>([])
const halted = ref(false)
const allowKeyGen = ref(false)
const momentumTime = ref(DEFAULT_MOMENTUM_TIME)
// Ethereum confirmations the orchestrators wait for before processing an
// event; display-only (unwrap finality countdown). Null when unreported.
const confirmationsToFinality = ref<number | null>(null)
const isLoading = ref(false)
const error = ref<string | null>(null)

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

export function validatePinnedNetwork(info: BridgeNetworkInfo): TokenPair[] {
  if (!sameAddress(info.contractAddress, config.expectedBridgeAddress)) {
    throw new Error(
      `Bridge address mismatch: expected ${config.expectedBridgeAddress}, received ${info.contractAddress}`,
    )
  }

  const supported: TokenPair[] = []
  for (const pair of info.tokenPairs) {
    const zts = pair.tokenStandard.toString()
    const expectedToken = config.expectedTokenPairs[zts]
    if (!expectedToken) continue
    if (!sameAddress(pair.tokenAddress, expectedToken.tokenAddress)) {
      throw new Error(
        `Token address mismatch for ${zts}: expected ${expectedToken.tokenAddress}, received ${pair.tokenAddress}`,
      )
    }
    supported.push(pair)
  }
  if (supported.length === 0) throw new Error('The node returned no recognized bridge token pairs')
  return supported
}

// viem errors carry a one-line shortMessage; their full message spans
// several lines of request details that are noise in the UI.
function describeCause(e: unknown): string {
  if (e && typeof e === 'object') {
    const short = (e as {shortMessage?: unknown}).shortMessage
    if (typeof short === 'string' && short) return short
    const msg = (e as {message?: unknown}).message
    if (typeof msg === 'string' && msg) return msg
  }
  return String(e)
}

async function resolvePair(
  pair: TokenPair,
  bridgeAddress: Address,
  bridgeMetadata: string | null | undefined,
  currentEvmBlock: bigint | null,
): Promise<TokenPairView> {
  const zts = pair.tokenStandard.toString()
  const tokenAddress = pair.tokenAddress as Address
  const expected = config.expectedTokenPairs[zts]
  if (!expected) throw new Error(`Unsupported bridge token ${zts}`)
  let native: {symbol: string; decimals: number}
  let evmToken: {symbol: string; decimals: number}
  let evmBridge: Awaited<ReturnType<EvmService['getTokenInfo']>>
  try {
    const resolved = await Promise.all([
      BridgeService.getInstance().getTokenMetadata(zts),
      EvmService.getInstance().getTokenMetadata(tokenAddress),
      EvmService.getInstance().getTokenInfo(bridgeAddress, tokenAddress),
    ])
    native = resolved[0]
    evmToken = resolved[1]
    evmBridge = resolved[2]
  } catch (e) {
    throw new Error(`Failed to verify bridge metadata for ${zts}: ${describeCause(e)}`)
  }
  if (native.decimals !== evmToken.decimals) {
    throw new Error(
      `Decimal mismatch for ${native.symbol}: Zenon uses ${native.decimals}, Ethereum uses ${evmToken.decimals}`,
    )
  }
  if (native.decimals !== expected.decimals) {
    throw new Error(
      `Pinned decimal mismatch for ${native.symbol}: expected ${expected.decimals}, received ${native.decimals}`,
    )
  }

  return {
    zts,
    tokenAddress: pair.tokenAddress,
    symbol: native.symbol,
    evmSymbol: evmToken.symbol,
    decimals: native.decimals,
    wrapMinAmount: BigInt(pair.minAmount.toString()),
    unwrapMinAmount: evmBridge.minAmount,
    feePercentage: pair.feePercentage,
    redeemDelay: pair.redeemDelay,
    wrapEnabled: pair.bridgeable && evmBridge.redeemable,
    unwrapEnabled: pair.redeemable && evmBridge.bridgeable,
    owned: pair.owned,
    unwrapBonusBps: parseUnwrapBonusBps(
      bridgeMetadata,
      config.evmChainId,
      native.symbol,
      currentEvmBlock,
    ),
  }
}

async function load(force = false): Promise<void> {
  if (networkInfo.value && !force) return
  isLoading.value = true
  error.value = null
  try {
    const service = BridgeService.getInstance()
    // The block number gates the unwrap bonus (orchestrator pays only for
    // events at block >= the program's startingHeight); a failed read fails
    // closed to bonus-off rather than failing the whole load.
    const [network, info, orch, currentEvmBlock] = await Promise.all([
      service.getNetworkInfo(),
      service.getBridgeInfo(),
      service.getOrchestratorInfo(),
      EvmService.getInstance().getBlockNumber().catch(() => null),
    ])
    const supportedPairs = validatePinnedNetwork(network)
    const resolvedPairs = await Promise.all(
      supportedPairs.map(pair =>
        resolvePair(pair, network.contractAddress as Address, info.metadata, currentEvmBlock),
      ),
    )

    networkInfo.value = network
    tokenPairs.value = resolvedPairs
    halted.value = info.halted
    allowKeyGen.value = info.allowKeyGen
    momentumTime.value = orch.estimatedMomentumTime || DEFAULT_MOMENTUM_TIME
    confirmationsToFinality.value =
      Number.isSafeInteger(orch.confirmationsToFinality) && orch.confirmationsToFinality > 0
        ? orch.confirmationsToFinality
        : null
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load bridge network info'
    throw e
  } finally {
    isLoading.value = false
  }
}

async function refresh(): Promise<void> {
  await load(true)
}

export function useBridge() {
  return {
    tokenPairs,
    bridgeAddress: ref(config.expectedBridgeAddress),
    halted,
    allowKeyGen,
    momentumTime,
    confirmationsToFinality,
    isLoading,
    error,
    load,
    refresh,
  }
}
