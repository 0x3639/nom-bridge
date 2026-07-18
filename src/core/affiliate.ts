// Protocol facts verified against HyperCore-Team/orchestrator
// (network/evm.go:182-249, common/constants.go:32-33): the EVM `Unwrapped.to`
// string may be `<beneficiary>&<affiliate>`; when the bridge metadata's
// affiliate program is active for the token, the orchestrator adds 1% to the
// beneficiary's unwrap request and creates a separate 2% request for the
// affiliate at logIndex + 4e9. Self-referral is not rejected; an invalid
// affiliate part is ignored (the unwrap still processes at 100%).

export const AFFILIATE_BONUS_BPS = 300

export const AFFILIATE_LOG_INDEX_THRESHOLD = 4_000_000_000

const AFFILIATE_SEPARATOR = '&'

// Flag names in the bridge metadata keyed by the pair's native symbol. For
// EVM-side unwraps the orchestrator gates on the wrapped-token flags.
const UNWRAP_FLAG_BY_SYMBOL: Record<string, 'wZNN' | 'wQSR'> = {
  ZNN: 'wZNN',
  QSR: 'wQSR',
}

// Total bonus (in basis points of the unwrapped amount) the destination
// address collects on an unwrap when it is its own affiliate. 0 whenever the
// program is off or the metadata cannot be understood (fail-safe: callers
// then send a bare receiver, which is today's behavior).
export function parseUnwrapBonusBps(
  metadata: string | null | undefined,
  evmChainId: number,
  baseSymbol: string,
): number {
  const flag = UNWRAP_FLAG_BY_SYMBOL[baseSymbol]
  if (!flag || !metadata) return 0
  let parsed: unknown
  try {
    parsed = JSON.parse(metadata)
  } catch {
    return 0
  }
  if (typeof parsed !== 'object' || parsed === null) return 0
  const networks = (parsed as {affiliateProgram?: {networks?: Record<string, unknown>}})
    .affiliateProgram?.networks
  if (typeof networks !== 'object' || networks === null) return 0
  const network = networks[String(evmChainId)]
  if (typeof network !== 'object' || network === null) return 0
  const entry = network as {startingHeight?: unknown} & Record<string, unknown>
  if (typeof entry.startingHeight !== 'number' || entry.startingHeight <= 0) return 0
  return entry[flag] === true ? AFFILIATE_BONUS_BPS : 0
}

export function selfReferralReceiver(zenonAddress: string): string {
  return `${zenonAddress}${AFFILIATE_SEPARATOR}${zenonAddress}`
}

export function beneficiaryOf(receiver: string): string {
  return receiver.split(AFFILIATE_SEPARATOR)[0]
}

export function isAffiliateBonusLogIndex(logIndex: number): boolean {
  return logIndex >= AFFILIATE_LOG_INDEX_THRESHOLD
}
