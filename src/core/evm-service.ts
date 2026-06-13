import {
  createPublicClient,
  createWalletClient,
  custom,
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
])

const bridgeAbi = parseAbi([
  'function redeem(address to, address token, uint256 amount, uint256 nonce, bytes signature)',
  'function unwrap(address token, uint256 amount, string to)',
  'function tokensInfo(address) view returns (uint256 minAmount, uint32 redeemDelay, bool allowed)',
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
// `Unwrapped` logs. The node value is authoritative for the actual redeem, so a
// wrong pick here is harmless. Filters on the connected account (checksum-
// insensitive) and the exact Zenon recipient; falls back to the first log.
export function selectProvisionalLogIndex(
  logs: Array<{logIndex: number; args: {from?: string; to?: string}}>,
  account: string,
  zenonAddress: string,
): number {
  if (logs.length === 0) return 0
  const match = logs.find(log => {
    if (log.args.to !== zenonAddress) return false
    if (!log.args.from) return false
    try {
      return getAddress(log.args.from) === getAddress(account)
    } catch {
      return false
    }
  })
  return match ? match.logIndex : logs[0].logIndex
}

export class EvmService {
  private static instance: EvmService | null = null
  private publicClient: PublicClient
  private walletClient: WalletClient | null = null

  private constructor() {
    this.publicClient = createPublicClient({chain: CHAIN, transport: http()})
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
  ): Promise<{minAmount: bigint; redeemDelay: number; allowed: boolean}> {
    const [minAmount, redeemDelay, allowed] = await this.publicClient.readContract({
      address: bridge,
      abi: bridgeAbi,
      functionName: 'tokensInfo',
      args: [token],
    })
    return {minAmount, redeemDelay, allowed}
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
      const allowance = await this.publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [account, bridge],
      })
      if (allowance >= amount) return
      const hash = await wallet.writeContract({
        address: token,
        abi: erc20Abi,
        functionName: 'approve',
        args: [bridge, amount],
        chain: CHAIN,
        account,
      })
      await this.publicClient.waitForTransactionReceipt({hash})
    } catch (e) {
      throw mapEvmError(e)
    }
  }

  async unwrap(
    bridge: Address,
    token: Address,
    amount: bigint,
    zenonAddress: string,
  ): Promise<{hash: Hex; provisionalLogIndex: number}> {
    const wallet = this.getWalletClient()
    try {
      const [account] = await wallet.requestAddresses()
      const hash = await wallet.writeContract({
        address: bridge,
        abi: bridgeAbi,
        functionName: 'unwrap',
        args: [token, amount, zenonAddress],
        chain: CHAIN,
        account,
      })
      const receipt = await this.publicClient.waitForTransactionReceipt({hash})
      const decoded = parseEventLogs({abi: bridgeAbi, logs: receipt.logs, eventName: 'Unwrapped'})
      const provisionalLogIndex = selectProvisionalLogIndex(
        decoded as unknown as Array<{logIndex: number; args: {from?: string; to?: string}}>,
        account,
        zenonAddress,
      )
      return {hash, provisionalLogIndex}
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
      return await wallet.writeContract({
        address: bridge,
        abi: bridgeAbi,
        functionName: 'redeem',
        args: [to, token, netAmount, nonce, signature],
        chain: CHAIN,
        account,
      })
    } catch (e) {
      throw mapEvmError(e)
    }
  }
}

export function tssSignatureToHex(base64Sig: string): Hex {
  const sig = Buffer.from(base64Sig, 'base64')
  sig[sig.length - 1] += 27 // v: 0/1 → 27/28
  return `0x${sig.toString('hex')}`
}

export function mapEvmError(e: unknown): Error {
  if (e instanceof UserRejectedRequestError) {
    return new Error('Request rejected in MetaMask')
  }
  return e instanceof Error ? e : new Error('EVM request failed')
}
