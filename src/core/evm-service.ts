import {
  createPublicClient,
  createWalletClient,
  custom,
  fallback,
  getAddress,
  http,
  parseAbi,
  parseEventLogs,
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

export type WrapRedeemProgress =
  | {kind: 'unredeemed'}
  | {kind: 'waiting-delay'; remainingSeconds: number}
  | {kind: 'fully-redeemed'}

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
// Filters on the connected account (checksum-insensitive) and the exact Zenon
// recipient; an unmatched receipt is recovered later from the Zenon node.
export function selectProvisionalLogIndex(
  logs: Array<{
    logIndex: number
    args: {from?: string; to?: string; token?: string; amount?: bigint}
  }>,
  account: string,
  zenonAddress: string,
  token?: string,
  amount?: bigint,
): number | null {
  const match = logs.find(log => {
    if (log.args.to !== zenonAddress) return false
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
  private walletClient: WalletClient | null = null

  private constructor() {
    this.publicClient = createPublicClient({
      chain: CHAIN,
      transport: fallback(config.evmRpcUrls.map(url => http(url))),
    })
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

  async ensureAllowance(token: Address, bridge: Address, amount: bigint): Promise<void> {
    const wallet = this.getWalletClient()
    try {
      const [account] = await wallet.requestAddresses()
      await this.assertWalletChain(wallet)
      const allowance = await this.publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [account, bridge],
      })
      if (allowance >= amount) return
      const {request} = await this.publicClient.simulateContract({
        address: token,
        abi: erc20Abi,
        functionName: 'approve',
        args: [bridge, amount],
        chain: CHAIN,
        account,
      })
      const hash = await wallet.writeContract(request)
      const receipt = await this.publicClient.waitForTransactionReceipt({hash})
      assertSuccessfulReceipt(receipt, 'Approval')
    } catch (e) {
      throw mapEvmError(e)
    }
  }

  async unwrap(
    bridge: Address,
    token: Address,
    amount: bigint,
    zenonAddress: string,
  ): Promise<{hash: Hex; provisionalLogIndex: number; eventMatched: boolean}> {
    const wallet = this.getWalletClient()
    try {
      const [account] = await wallet.requestAddresses()
      await this.assertWalletChain(wallet)
      const {request} = await this.publicClient.simulateContract({
        address: bridge,
        abi: bridgeAbi,
        functionName: 'unwrap',
        args: [token, amount, zenonAddress],
        chain: CHAIN,
        account,
      })
      const hash = await wallet.writeContract(request)
      const receipt = await this.publicClient.waitForTransactionReceipt({hash})
      assertSuccessfulReceipt(receipt, 'Unwrap')
      const decoded = parseEventLogs({abi: bridgeAbi, logs: receipt.logs, eventName: 'Unwrapped'})
      const provisionalLogIndex = selectProvisionalLogIndex(
        decoded as unknown as Array<{
          logIndex: number
          args: {from?: string; to?: string; token?: string; amount?: bigint}
        }>,
        account,
        zenonAddress,
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
      const receipt = await this.publicClient.waitForTransactionReceipt({hash})
      assertSuccessfulReceipt(receipt, 'Redeem')
      return hash
    } catch (e) {
      throw mapEvmError(e)
    }
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
