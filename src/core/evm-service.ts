import {
  createPublicClient,
  createWalletClient,
  custom,
  fallback,
  getAddress,
  http,
  parseAbi,
  parseAbiItem,
  parseEventLogs,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  UserRejectedRequestError,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem'
import {mainnet, sepolia} from 'viem/chains'
import {config} from '@/config'

export const CHAIN = config.evmChainId === mainnet.id ? mainnet : sepolia

const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
])

const bridgeAbi = parseAbi([
  'function redeem(address to, address token, uint256 amount, uint256 nonce, bytes signature)',
  'function unwrap(address token, uint256 amount, string to)',
  'function tokensInfo(address) view returns (uint256 minAmount, uint256 redeemDelay, bool bridgeable, bool redeemable, bool owned)',
  'function redeemsInfo(uint256 nonce) view returns (uint256 blockNumber, bytes32 paramsHash)',
  'function estimatedBlockTime() view returns (uint64)',
  'event Unwrapped(address indexed from, address indexed token, string to, uint256 amount)',
])

export const UINT256_MAX = (1n << 256n) - 1n

// Per-RPC transports must fail fast. viem honours a 429's `Retry-After`
// header on retry (public RPCs send values in the hundreds of seconds), so a
// rate-limited RPC with default retries would park a quorum Promise.all for
// many minutes and stall every Requests poll. The fallback transport still
// moves to the next RPC, and the quorum reads already treat a failed client
// as non-responsive.
export const RPC_TRANSPORT_OPTIONS = {retryCount: 0, timeout: 15_000} as const

export type WrapRedeemProgress =
  | {kind: 'unredeemed'}
  | {kind: 'waiting-delay'; remainingSeconds: number}
  | {kind: 'fully-redeemed'}

export type EvmTransactionOutcome = 'success' | 'reverted' | 'pending' | 'not-found' | 'unavailable'
export type AuthoritativeEvmOutcome = 'confirmed' | 'reverted' | 'absent' | 'unknown'
export type EvmSubmissionFailureKind = 'reverted' | 'confirmation-unknown'

export class EvmSubmissionError extends Error {
  constructor(
    readonly kind: EvmSubmissionFailureKind,
    readonly hash: Hex,
    message: string,
    options?: {cause?: unknown},
  ) {
    super(message)
    this.name = 'EvmSubmissionError'
    if (options?.cause !== undefined) Object.assign(this, {cause: options.cause})
  }
}

// A success receipt from any RPC is authoritative (fabricating success only
// clears warning copy, never enables a resubmit). A revert must be the
// consensus of every responsive RPC — corroborated by a second node unless only
// one is configured — so a single stale or forked node cannot release a
// duplicate-submit lock. `absent` requires every RPC to answer not-found; it
// feeds the sustained-absence dropped-transaction policy below and is never a
// release signal by itself.
export function collapseAuthoritativeOutcomes(
  outcomes: EvmTransactionOutcome[],
): AuthoritativeEvmOutcome {
  const confirmed = outcomes.includes('success')
  const revertedCount = outcomes.filter(outcome => outcome === 'reverted').length
  if (confirmed && revertedCount) return 'unknown'
  if (confirmed) return 'confirmed'
  const responsive = outcomes.filter(outcome => outcome !== 'unavailable')
  if (
    revertedCount > 0 &&
    revertedCount === responsive.length &&
    (outcomes.length === 1 || revertedCount >= 2)
  ) return 'reverted'
  if (outcomes.length > 0 && outcomes.every(outcome => outcome === 'not-found')) return 'absent'
  return 'unknown'
}

// Positive dropped-transaction evidence. Universal not-found is never proof a
// wallet-broadcast transaction is dead (private mempools, poor propagation, a
// low-fee tx that mines late). The only positive fact is nonce consumption:
// getTransactionCount('latest') is the next unused nonce, so once the sender's
// confirmed count passes the transaction's nonce, that nonce was consumed —
// by this tx (then it would not be absent) or by a replacement — and this hash
// can never mine.
export function isNonceConsumed(txNonce: number, confirmedTransactionCount: number): boolean {
  return confirmedTransactionCount > txNonce
}

export interface AuthoritativeOutcomeWithFacts {
  outcome: AuthoritativeEvmOutcome
  from?: string
  nonce?: number
  // Block of the successful receipt (display-only: finality countdown).
  blockNumber?: bigint
}

export interface FinalityProgress {
  confirmations: number
  required: number
  remainingSeconds: number
}

// Display-only progress toward the orchestrators' Ethereum finality window.
// Confirmations are clamped to [0, required] so a lagging RPC never shows a
// negative count and a finalized event keeps reading required/required until
// the node registers it.
export function computeFinalityProgress(
  receiptBlock: bigint,
  currentBlock: bigint,
  required: number,
  estimatedBlockTime: bigint,
): FinalityProgress {
  const elapsed = currentBlock - receiptBlock
  const clamped = elapsed < 0n ? 0n : elapsed > BigInt(required) ? BigInt(required) : elapsed
  const confirmations = Number(clamped)
  return {
    confirmations,
    required,
    remainingSeconds: (required - confirmations) * Number(estimatedBlockTime),
  }
}

// The HIGHEST receipt block across RPCs: a forked/lagging RPC reporting an
// earlier block would otherwise overstate confirmations.
export function pickConfirmedBlock(
  results: Array<{outcome: EvmTransactionOutcome; blockNumber?: bigint}>,
): bigint | undefined {
  let best: bigint | undefined
  for (const result of results) {
    if (result.outcome !== 'success' || result.blockNumber === undefined) continue
    if (best === undefined || result.blockNumber > best) best = result.blockNumber
  }
  return best
}

// On-chain redeem state for a wrap request id: 'unredeemed' — no claim ever
// landed; 'partial' — the first claim landed, the final one has not;
// 'fully-redeemed' — both claims done.
export type RedeemState = 'unredeemed' | 'partial' | 'fully-redeemed'

// Release evidence requires a unanimous responsive quorum (≥2 unless only one
// RPC is configured): one stale RPC reporting "unadvanced" progress must not
// authorize releasing a claim lock whose replacement claim actually landed.
export function collapseRedeemStates(
  states: Array<RedeemState | null>,
  totalClients: number,
): RedeemState | null {
  const responsive = states.filter((state): state is RedeemState => state !== null)
  const required = totalClients === 1 ? 1 : 2
  if (responsive.length < required) return null
  return responsive.every(state => state === responsive[0]) ? responsive[0] : null
}

// Per-claim-stage interpretation of a corroborated redeem state.
export function isRedeemStateAdvancedForStage(stage: 1 | 2, state: RedeemState | null): boolean {
  if (state === null) return false
  return stage === 1 ? state !== 'unredeemed' : state === 'fully-redeemed'
}

export function isRedeemStateUnclaimedForStage(stage: 1 | 2, state: RedeemState | null): boolean {
  if (state === null) return false
  return stage === 1 ? state === 'unredeemed' : state === 'partial'
}

export interface UnwrappedEventRecord {
  transactionHash: string
  logIndex: number
  token: string
  to: string
  amount: bigint
}

// Release-critical facts must never rest on a single RPC's word. Sender/nonce
// count as evidence only when at least two independent RPCs report the
// identical pair (single-RPC deployments have no peer and stand alone).
export function corroborateTxFacts(
  perClientFacts: Array<{from?: string; nonce?: number}>,
  totalClients: number,
): {from: string; nonce: number} | undefined {
  const counts = new Map<string, {from: string; nonce: number; seen: number}>()
  for (const facts of perClientFacts) {
    if (facts.from === undefined || facts.nonce === undefined) continue
    const key = `${facts.from.toLowerCase()}:${facts.nonce}`
    const entry = counts.get(key) ?? {from: facts.from, nonce: facts.nonce, seen: 0}
    entry.seen += 1
    counts.set(key, entry)
  }
  const required = totalClients === 1 ? 1 : 2
  for (const entry of counts.values()) {
    if (entry.seen >= required) return {from: entry.from, nonce: entry.nonce}
  }
  return undefined
}

// The MINIMUM confirmed count across responsive RPCs: one RPC inflating its
// answer cannot force a nonce-consumption release, while a lagging honest RPC
// only fails closed. Multi-RPC configs require at least two responses.
export function collapseConfirmedCounts(
  counts: Array<number | null>,
  totalClients: number,
): number | null {
  const responsive = counts.filter((count): count is number => count !== null)
  const required = totalClients === 1 ? 1 : 2
  if (responsive.length < required) return null
  return Math.min(...responsive)
}

// Pure arithmetic for the wrap countdown, factored out for unit-testing without
// viem. remainingSeconds = max(0, redeemDelay - elapsedBlocks + 1) * blockTime,
// with a +1 safety block.
export function computeRemainingSeconds(
  blockNumber: bigint,
  currentBlock: bigint,
  redeemDelay: number,
  estimatedBlockTime: bigint,
): number {
  const elapsedBlocks = currentBlock - blockNumber
  const remainingBlocks = BigInt(redeemDelay) - elapsedBlocks + 1n
  return Number(remainingBlocks < 0n ? 0n : remainingBlocks) * Number(estimatedBlockTime)
}

// Pure selection of the display-only provisional logIndex from decoded
// `Unwrapped` logs. The node value is authoritative for the actual redeem.
// Filters on the connected account (checksum-insensitive) and the exact
// receiver string as sent (may be `addr&addr` for self-referral); an
// unmatched receipt is recovered later from the Zenon node.
export function selectProvisionalLogIndex(
  logs: Array<{
    logIndex: number
    args: {from?: string; to?: string; token?: string; amount?: bigint}
  }>,
  account: string,
  receiver: string,
  token?: string,
  amount?: bigint,
): number | null {
  const match = logs.find(log => {
    if (log.args.to !== receiver) return false
    if (!log.args.from) return false
    try {
      if (getAddress(log.args.from) !== getAddress(account)) return false
      if (token !== undefined) {
        if (!log.args.token || getAddress(log.args.token) !== getAddress(token)) return false
      }
      if (amount !== undefined && log.args.amount !== amount) return false
      return true
    } catch {
      return false
    }
  })
  return match?.logIndex ?? null
}

function assertSuccessfulReceipt(receipt: {status: string}, action: string): void {
  if (receipt.status !== 'success') throw new Error(`${action} transaction reverted`)
}

export class EvmService {
  private static instance: EvmService | null = null
  private publicClient: PublicClient
  private outcomeClients: PublicClient[]
  private walletClient: WalletClient | null = null

  private constructor() {
    this.publicClient = createPublicClient({
      chain: CHAIN,
      // The outer retry would sleep on a trailing 429's Retry-After as well;
      // one pass over every RPC is the whole retry budget for a read.
      transport: fallback(
        config.evmRpcUrls.map(url => http(url, RPC_TRANSPORT_OPTIONS)),
        {retryCount: 0},
      ),
    })
    this.outcomeClients = config.evmRpcUrls.map(url => createPublicClient({
      chain: CHAIN,
      transport: http(url, RPC_TRANSPORT_OPTIONS),
    }))
  }

  static getInstance(): EvmService {
    if (!EvmService.instance) {
      EvmService.instance = new EvmService()
    }
    return EvmService.instance
  }

  private getWalletClient(): WalletClient {
    if (!window.ethereum) throw new Error('No EVM wallet detected. Please install MetaMask.')
    if (!this.walletClient) {
      this.walletClient = createWalletClient({chain: CHAIN, transport: custom(window.ethereum)})
    }
    return this.walletClient
  }

  async connect(): Promise<Address> {
    const wallet = this.getWalletClient()
    try {
      const [account] = await wallet.requestAddresses()
      await wallet.switchChain({id: CHAIN.id}).catch(() => {
        throw new Error(`Please switch MetaMask to ${CHAIN.name}`)
      })
      return account
    } catch (e) {
      throw mapEvmError(e)
    }
  }

  async getBalance(token: Address, owner: Address): Promise<bigint> {
    return this.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [owner],
    })
  }

  async getTokenMetadata(token: Address): Promise<{decimals: number; symbol: string}> {
    const [decimals, symbol] = await Promise.all([
      this.publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'decimals',
      }),
      this.publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'symbol',
      }),
    ])
    return {decimals, symbol}
  }

  async getBlockNumber(): Promise<bigint> {
    return this.publicClient.getBlockNumber()
  }

  async getTransactionOutcome(hash: Hex): Promise<EvmTransactionOutcome> {
    return (await this.getTransactionOutcomeFrom(this.publicClient, hash)).outcome
  }

  async getAuthoritativeOutcome(hash: Hex): Promise<AuthoritativeEvmOutcome> {
    return (await this.getAuthoritativeOutcomeWithFacts(hash)).outcome
  }

  async getAuthoritativeOutcomeWithFacts(hash: Hex): Promise<AuthoritativeOutcomeWithFacts> {
    const results = await Promise.all(
      this.outcomeClients.map(client => this.getTransactionOutcomeFrom(client, hash)),
    )
    const outcome = collapseAuthoritativeOutcomes(results.map(result => result.outcome))
    const facts = corroborateTxFacts(results, this.outcomeClients.length)
    const blockNumber = outcome === 'confirmed' ? pickConfirmedBlock(results) : undefined
    return {
      outcome,
      ...(facts ? {from: facts.from, nonce: facts.nonce} : {}),
      ...(blockNumber !== undefined ? {blockNumber} : {}),
    }
  }

  // Corroborated confirmed transaction count for dropped-tx evidence; null
  // when the quorum cannot be met.
  async getConfirmedTransactionCount(address: Address): Promise<number | null> {
    const counts = await Promise.all(
      this.outcomeClients.map(client =>
        client.getTransactionCount({address, blockTag: 'latest'}).catch(() => null),
      ),
    )
    return collapseConfirmedCounts(counts, this.outcomeClients.length)
  }

  // Quorum-corroborated redeem state for a wrap request, read directly from
  // redeemsInfo on every configured RPC. Null when the quorum cannot be met —
  // callers must then keep their locks (fail closed).
  async getCorroboratedRedeemState(bridge: Address, wrapRequestId: Hex): Promise<RedeemState | null> {
    const states = await Promise.all(
      this.outcomeClients.map(client =>
        client.readContract({
          address: bridge,
          abi: bridgeAbi,
          functionName: 'redeemsInfo',
          args: [BigInt(wrapRequestId)],
        }).then(([blockNumber]): RedeemState => {
          if (blockNumber === 0n) return 'unredeemed'
          if (blockNumber === UINT256_MAX) return 'fully-redeemed'
          return 'partial'
        }).catch(() => null),
      ),
    )
    return collapseRedeemStates(states, this.outcomeClients.length)
  }

  // Unwrapped events emitted by the bridge for `from` since `fromBlock`,
  // queried across every configured RPC. Used to decide whether a dropped
  // (speed-up replaced) transaction's replacement executed the SAME unwrap.
  // `responsiveClients` lets callers apply the quorum policy to the ABSENCE of
  // a match — a single silent/lying RPC must not authorize a release.
  async findUnwrappedEvents(
    bridge: Address,
    from: Address,
    fromBlock: bigint,
  ): Promise<{events: UnwrappedEventRecord[]; responsiveClients: number}> {
    const unwrappedEvent = parseAbiItem(
      'event Unwrapped(address indexed from, address indexed token, string to, uint256 amount)',
    )
    const perClient = await Promise.all(
      this.outcomeClients.map(client =>
        client.getLogs({
          address: bridge,
          event: unwrappedEvent,
          args: {from},
          fromBlock,
        }).catch(() => null),
      ),
    )
    const events = new Map<string, UnwrappedEventRecord>()
    let responsiveClients = 0
    for (const logs of perClient) {
      if (logs === null) continue
      responsiveClients += 1
      for (const log of logs as unknown as Array<{
        transactionHash: string
        logIndex: number
        args: {token?: string; to?: string; amount?: bigint}
      }>) {
        if (!log.args.token || log.args.to === undefined || log.args.amount === undefined) continue
        events.set(`${log.transactionHash}:${log.logIndex}`, {
          transactionHash: log.transactionHash,
          logIndex: log.logIndex,
          token: log.args.token,
          to: log.args.to,
          amount: log.args.amount,
        })
      }
    }
    return {events: [...events.values()], responsiveClients}
  }

  private async getTransactionOutcomeFrom(
    client: PublicClient,
    hash: Hex,
  ): Promise<{outcome: EvmTransactionOutcome; from?: string; nonce?: number; blockNumber?: bigint}> {
    try {
      const receipt = await client.getTransactionReceipt({hash})
      return {
        outcome: receipt.status === 'success' ? 'success' : 'reverted',
        blockNumber: receipt.blockNumber,
      }
    } catch (e) {
      if (!(e instanceof TransactionReceiptNotFoundError)) return {outcome: 'unavailable'}
      try {
        const transaction = await client.getTransaction({hash})
        // Capture sender + nonce while the transaction is still visible: these
        // are the only facts that can later PROVE a vanished hash is dead.
        return {outcome: 'pending', from: transaction.from, nonce: transaction.nonce}
      } catch (transactionError) {
        return {
          outcome: transactionError instanceof TransactionNotFoundError ? 'not-found' : 'unavailable',
        }
      }
    }
  }

  async getEstimatedBlockTime(bridge: Address): Promise<bigint> {
    return this.publicClient.readContract({
      address: bridge,
      abi: bridgeAbi,
      functionName: 'estimatedBlockTime',
    })
  }

  async getTokenInfo(
    bridge: Address,
    token: Address,
  ): Promise<{
    minAmount: bigint
    redeemDelay: number
    bridgeable: boolean
    redeemable: boolean
    owned: boolean
  }> {
    const [minAmount, redeemDelay, bridgeable, redeemable, owned] = await this.publicClient.readContract({
      address: bridge,
      abi: bridgeAbi,
      functionName: 'tokensInfo',
      args: [token],
    })
    const redeemDelayNumber = Number(redeemDelay)
    if (!Number.isSafeInteger(redeemDelayNumber)) throw new Error('Token redeem delay is out of range')
    return {minAmount, redeemDelay: redeemDelayNumber, bridgeable, redeemable, owned}
  }

  async getWrapRedeemProgress(
    bridge: Address,
    token: Address,
    wrapRequestId: Hex,
  ): Promise<WrapRedeemProgress> {
    const [blockNumber] = await this.publicClient.readContract({
      address: bridge,
      abi: bridgeAbi,
      functionName: 'redeemsInfo',
      args: [BigInt(wrapRequestId)],
    })

    if (blockNumber === UINT256_MAX) return {kind: 'fully-redeemed'}
    if (blockNumber === 0n) return {kind: 'unredeemed'}

    const currentBlock = await this.getBlockNumber()
    const estimatedBlockTime = await this.getEstimatedBlockTime(bridge)
    const {redeemDelay} = await this.getTokenInfo(bridge, token)
    const remainingSeconds = computeRemainingSeconds(
      blockNumber,
      currentBlock,
      redeemDelay,
      estimatedBlockTime,
    )
    return {kind: 'waiting-delay', remainingSeconds}
  }

  async getAllowance(token: Address, bridge: Address): Promise<bigint> {
    const wallet = this.getWalletClient()
    try {
      const [account] = await wallet.requestAddresses()
      await this.assertWalletChain(wallet)
      return await this.publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [account, bridge],
      })
    } catch (e) {
      throw mapEvmError(e)
    }
  }

  async approveAllowance(
    token: Address,
    bridge: Address,
    amount: bigint,
    onSubmitted?: (hash: Hex) => void | Promise<void>,
  ): Promise<Hex> {
    const wallet = this.getWalletClient()
    try {
      const [account] = await wallet.requestAddresses()
      await this.assertWalletChain(wallet)
      const {request} = await this.publicClient.simulateContract({
        address: token,
        abi: erc20Abi,
        functionName: 'approve',
        args: [bridge, amount],
        chain: CHAIN,
        account,
      })
      const hash = await wallet.writeContract(request)
      onSubmitted?.(hash)
      const receipt = await this.publicClient.waitForTransactionReceipt({hash})
      assertSuccessfulReceipt(receipt, 'Approval')
      return hash
    } catch (e) {
      throw mapEvmError(e)
    }
  }

  async unwrap(
    bridge: Address,
    token: Address,
    amount: bigint,
    receiver: string,
    onSubmitted?: (hash: Hex) => void,
  ): Promise<{hash: Hex; provisionalLogIndex: number; eventMatched: boolean}> {
    const wallet = this.getWalletClient()
    try {
      const [account] = await wallet.requestAddresses()
      await this.assertWalletChain(wallet)
      const {request} = await this.publicClient.simulateContract({
        address: bridge,
        abi: bridgeAbi,
        functionName: 'unwrap',
        args: [token, amount, receiver],
        chain: CHAIN,
        account,
      })
      const hash = await wallet.writeContract(request)
      await onSubmitted?.(hash)
      let receipt
      try {
        receipt = await this.publicClient.waitForTransactionReceipt({hash})
      } catch (e) {
        throw new EvmSubmissionError(
          'confirmation-unknown',
          hash,
          'Unwrap transaction was submitted, but confirmation could not be verified',
          {cause: e},
        )
      }
      if (receipt.status !== 'success') {
        throw await this.classifyReceiptRevert(hash, 'Unwrap')
      }
      const decoded = parseEventLogs({abi: bridgeAbi, logs: receipt.logs, eventName: 'Unwrapped'})
      const provisionalLogIndex = selectProvisionalLogIndex(
        decoded as unknown as Array<{
          logIndex: number
          args: {from?: string; to?: string; token?: string; amount?: bigint}
        }>,
        account,
        receiver,
        token,
        amount,
      )
      return {
        hash,
        provisionalLogIndex: provisionalLogIndex ?? -1,
        eventMatched: provisionalLogIndex !== null,
      }
    } catch (e) {
      throw mapEvmError(e)
    }
  }

  async redeem(
    bridge: Address,
    to: Address,
    token: Address,
    netAmount: bigint,
    nonce: bigint,
    signature: Hex,
    onSubmitted?: (hash: Hex) => void | Promise<void>,
  ): Promise<Hex> {
    const wallet = this.getWalletClient()
    try {
      const [account] = await wallet.requestAddresses()
      await this.assertWalletChain(wallet)
      const {request} = await this.publicClient.simulateContract({
        address: bridge,
        abi: bridgeAbi,
        functionName: 'redeem',
        args: [to, token, netAmount, nonce, signature],
        chain: CHAIN,
        account,
      })
      const hash = await wallet.writeContract(request)
      await onSubmitted?.(hash)
      let receipt
      try {
        receipt = await this.publicClient.waitForTransactionReceipt({hash})
      } catch (e) {
        throw new EvmSubmissionError(
          'confirmation-unknown',
          hash,
          'Redeem transaction was submitted, but confirmation could not be verified',
          {cause: e},
        )
      }
      if (receipt.status !== 'success') {
        throw await this.classifyReceiptRevert(hash, 'Redeem')
      }
      return hash
    } catch (e) {
      throw mapEvmError(e)
    }
  }

  // waitForTransactionReceipt runs on the fallback transport, which accepts
  // the FIRST successful RPC response — a stale or forked node's reverted
  // receipt must not release safety locks and authorize a retry. A revert is
  // definitive only when the multi-RPC quorum policy corroborates it;
  // otherwise the failure is classified confirmation-unknown (locks kept).
  private async classifyReceiptRevert(hash: Hex, action: string): Promise<EvmSubmissionError> {
    const outcome = await this.getAuthoritativeOutcome(hash).catch(() => 'unknown' as const)
    if (outcome === 'reverted') {
      return new EvmSubmissionError('reverted', hash, `${action} transaction reverted`)
    }
    return new EvmSubmissionError(
      'confirmation-unknown',
      hash,
      `${action} transaction may have reverted, but the configured RPCs do not agree; do not resubmit until its status is verified`,
    )
  }

  private async assertWalletChain(wallet: WalletClient): Promise<void> {
    const chainId = await wallet.getChainId()
    if (chainId !== CHAIN.id) throw new Error(`Please switch MetaMask to ${CHAIN.name}`)
  }
}

export function tssSignatureToHex(base64Sig: string): Hex {
  const sig = Buffer.from(base64Sig, 'base64')
  if (sig.length !== 65) throw new Error('Invalid TSS signature length')
  const recovery = sig[64]
  if (recovery !== 0 && recovery !== 1) throw new Error('Invalid TSS signature recovery byte')
  sig[64] = recovery + 27 // v: 0/1 → 27/28
  return `0x${sig.toString('hex')}`
}

export function mapEvmError(e: unknown): Error {
  if (e instanceof UserRejectedRequestError) {
    return new Error('Request rejected in MetaMask')
  }
  return e instanceof Error ? e : new Error('EVM request failed')
}
