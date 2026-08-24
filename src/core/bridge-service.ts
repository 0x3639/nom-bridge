import {ZenonService} from './zenon-service'
import {config} from '@/config'
import {
  Address,
  BlockTypeEnum,
  BRIDGE_ADDRESS,
  BridgeContract,
  Hash,
  TokenStandard,
} from 'znn-typescript-sdk'
import {parseAmount} from './amount'
import {
  getZenonRpcAccountBlock,
  getZenonRpcFrontierHeight,
  type ZenonRpcAccountBlock,
} from './zenon-rpc'
import type {
  AccountBlockTemplate,
  BridgeInfo,
  BridgeNetworkInfo,
  OrchestratorInfo,
  UnwrapTokenRequest,
  UnwrapTokenRequestList,
  WrapTokenRequestList,
} from 'znn-typescript-sdk'

// Decode an account block's payload as the embedded bridge's WrapToken call.
// Anything that fails to decode — or decodes to a different method — yields
// nulls, which reconciliation treats as not-a-match (fail closed).
export function decodeWrapTokenCall(data: Buffer | Uint8Array | undefined): {
  evmToAddress: string | null
  networkClass: number | null
  chainId: number | null
} {
  const empty = {evmToAddress: null, networkClass: null, chainId: null}
  if (!data || data.length === 0) return empty
  try {
    const hex = '0x' + Buffer.from(data).toString('hex')
    const decoded = BridgeContract.decodeCallData(hex, true)
    if (decoded.name !== 'WrapToken') return empty
    const args = decoded.args as {networkClass?: unknown; chainId?: unknown; toAddress?: unknown}
    if (typeof args.toAddress !== 'string') return empty
    return {
      evmToAddress: args.toAddress,
      networkClass: Number(args.networkClass),
      chainId: Number(args.chainId),
    }
  } catch {
    return empty
  }
}

interface CorroboratedWrapSend {
  hash: string
  height: number
  sourceAddress: string
  zts: string
  amount: bigint
  evmToAddress: string | null
  networkClass: number | null
  chainId: number | null
  confirmationMomentumHeight: number
  confirmationMomentumHash: string
  confirmationMomentumTimestamp: number
  corroborations: number
}

function comparableRpcUrl(url: string): string {
  return url.replace(/\/+$/, '').toLowerCase()
}

function secondaryRpcUrls(primaryUrl: string): string[] {
  const primary = comparableRpcUrl(primaryUrl)
  const unique = new Map(
    config.zenonRpcUrls.map(url => [comparableRpcUrl(url), url] as const),
  )
  unique.delete(primary)
  return [...unique.values()]
}

function wrapSendFingerprint(candidate: CorroboratedWrapSend): string {
  return JSON.stringify([
    config.zenonChainId,
    BlockTypeEnum.UserSend,
    candidate.hash.toLowerCase(),
    candidate.height,
    candidate.sourceAddress.toLowerCase(),
    BRIDGE_ADDRESS.toString().toLowerCase(),
    candidate.zts.toLowerCase(),
    candidate.amount.toString(),
    candidate.evmToAddress?.toLowerCase() ?? null,
    candidate.networkClass,
    candidate.chainId,
    candidate.confirmationMomentumHeight,
    candidate.confirmationMomentumHash,
    candidate.confirmationMomentumTimestamp,
  ])
}

function rpcWrapSendFingerprint(block: ZenonRpcAccountBlock): string | null {
  const confirmation = block.confirmationDetail
  if (!confirmation) return null
  const decoded = decodeWrapTokenCall(Buffer.from(block.data, 'base64'))
  return JSON.stringify([
    block.chainIdentifier,
    block.blockType,
    block.hash,
    block.height,
    block.address.toLowerCase(),
    block.toAddress.toLowerCase(),
    block.tokenStandard.toLowerCase(),
    block.amount.toString(),
    decoded.evmToAddress?.toLowerCase() ?? null,
    decoded.networkClass,
    decoded.chainId,
    confirmation.momentumHeight,
    confirmation.momentumHash,
    confirmation.momentumTimestamp,
  ])
}

function matchesCorroboratingBlock(
  candidate: CorroboratedWrapSend,
  block: ZenonRpcAccountBlock,
): boolean {
  return rpcWrapSendFingerprint(block) === wrapSendFingerprint(candidate)
}

export class BridgeService {
  private static instance: BridgeService | null = null
  private constructor(private readonly zenonService: ZenonService) {}

  static getInstance(): BridgeService {
    if (!BridgeService.instance) {
      BridgeService.instance = new BridgeService(ZenonService.getInstance())
    }
    return BridgeService.instance
  }

  private async ensureInitialized(): Promise<void> {
    await this.zenonService.ensureInitialized()
  }

  async getNetworkInfo(): Promise<BridgeNetworkInfo> {
    await this.ensureInitialized()
    return this.zenonService.getZenon().embedded.bridge.getNetworkInfo(
      config.networkClass,
      config.evmChainId,
    )
  }

  async getBridgeInfo(): Promise<BridgeInfo> {
    await this.ensureInitialized()
    return this.zenonService.getZenon().embedded.bridge.getBridgeInfo()
  }

  async getOrchestratorInfo(): Promise<OrchestratorInfo> {
    await this.ensureInitialized()
    return this.zenonService.getZenon().embedded.bridge.getOrchestratorInfo()
  }

  async getTokenMetadata(zts: string): Promise<{symbol: string; decimals: number}> {
    await this.ensureInitialized()
    const token = await this.zenonService
      .getZenon()
      .embedded.token.getByZts(TokenStandard.parse(zts))
    if (!token) throw new Error(`Unknown Zenon token ${zts}`)
    return {symbol: token.symbol, decimals: token.decimals}
  }

  async getTokenBalance(address: string, zts: string): Promise<bigint> {
    await this.ensureInitialized()
    const account = await this.zenonService
      .getZenon()
      .ledger.getAccountInfoByAddress(Address.parse(address))
    return account?.balanceInfoMap[zts]?.balance ?? 0n
  }

  async getWrapRequests(
    evmToAddress: string,
    page = 0,
    size = 50,
  ): Promise<WrapTokenRequestList> {
    await this.ensureInitialized()
    // The node stores wrap toAddress lowercase and matches it case-sensitively;
    // an EIP-55 checksummed address (as wallets report it) returns zero rows.
    return this.zenonService
      .getZenon()
      .embedded.bridge.getAllWrapTokenRequestsByToAddress(evmToAddress.toLowerCase(), page, size)
  }

  async getUnwrapRequests(
    zenonToAddress: string,
    page = 0,
    size = 50,
  ): Promise<UnwrapTokenRequestList> {
    await this.ensureInitialized()
    return this.zenonService
      .getZenon()
      .embedded.bridge.getAllUnwrapTokenRequestsByToAddress(zenonToAddress, page, size)
  }

  // Synchronous: redeem only constructs an unsigned AccountBlockTemplate (no node
  // read), so it does not gate on ensureInitialized. logIndex is the NODE-
  // authoritative UnwrapTokenRequest.logIndex, never the provisional EVM value.
  buildRedeemBlock(evmTxHash: string, logIndex: number): AccountBlockTemplate {
    return this.zenonService
      .getZenon()
      .embedded.bridge.redeem(Hash.parse(evmTxHash), logIndex)
  }

  // Synchronous: wrapToken only constructs an unsigned AccountBlockTemplate
  // (no node read), so it does not gate on ensureInitialized.
  // Frontier height of a user account chain — recorded before a wrap send so
  // an ambiguous submission can later be reconciled against blocks above it.
  async getAccountFrontierHeight(address: string): Promise<number> {
    await this.ensureInitialized()
    const primaryUrl = this.zenonService.getNodeUrl()
    const parsedAddress = Address.parse(address)
    const canonicalAddress = parsedAddress.toString()
    const frontierPromise = this.zenonService
      .getZenon()
      .ledger.getFrontierAccountBlock(parsedAddress)
    const [frontier, ...secondaryHeights] = await Promise.all([
      frontierPromise,
      ...secondaryRpcUrls(primaryUrl).map(url =>
        getZenonRpcFrontierHeight(url, canonicalAddress, config.zenonChainId),
      ),
    ])
    let primaryHeight = 0
    if (frontier) {
      if (
        frontier.chainIdentifier !== config.zenonChainId ||
        frontier.address.toString() !== canonicalAddress ||
        !Number.isSafeInteger(frontier.height) ||
        frontier.height < 0
      ) {
        throw new Error('Primary Zenon RPC returned an invalid account frontier')
      }
      primaryHeight = frontier.height
    }
    return Math.max(primaryHeight, ...secondaryHeights)
  }

  // Sends from `address` to the embedded bridge contract with height above
  // `afterHeight` — the authoritative account-chain evidence that a wrap was
  // published. The WrapToken calldata is decoded so callers can verify the
  // exact EVM destination and chain; a payload that does not decode as
  // WrapToken yields null fields (which reconciliation treats as no match).
  // Pages are newest-first; scanning stops once heights fall to or below the
  // recorded frontier.
  async findWrapSendsAfter(
    address: string,
    afterHeight: number,
  ): Promise<CorroboratedWrapSend[]> {
    await this.ensureInitialized()
    const ledger = this.zenonService.getZenon().ledger
    const primaryUrl = this.zenonService.getNodeUrl()
    const parsed = Address.parse(address)
    const canonicalAddress = parsed.toString()
    const results: CorroboratedWrapSend[] = []
    for (let page = 0; page < 20; page += 1) {
      const response = await ledger.getAccountBlocksByPage(parsed, page, 50)
      const blocks = response.list ?? []
      if (!blocks.length) break
      let reachedBaseline = false
      for (const block of blocks) {
        if (block.height <= afterHeight) {
          reachedBaseline = true
          continue
        }
        if (block.chainIdentifier !== config.zenonChainId) continue
        if (block.blockType !== BlockTypeEnum.UserSend) continue
        if (block.address.toString() !== canonicalAddress) continue
        if (block.toAddress.toString() !== BRIDGE_ADDRESS.toString()) continue
        const confirmation = block.confirmationDetail
        if (!confirmation) continue
        const candidate: CorroboratedWrapSend = {
          hash: block.hash.toString(),
          height: block.height,
          sourceAddress: canonicalAddress,
          zts: block.tokenStandard.toString(),
          amount: BigInt(block.amount.toString()),
          ...decodeWrapTokenCall(block.data),
          confirmationMomentumHeight: confirmation.momentumHeight,
          confirmationMomentumHash: confirmation.momentumHash.toString(),
          confirmationMomentumTimestamp: confirmation.momentumTimestamp,
          corroborations: 1,
        }
        const observations = await Promise.all(
          secondaryRpcUrls(primaryUrl).map(url =>
            getZenonRpcAccountBlock(url, candidate.hash).catch(() => null),
          ),
        )
        for (const observation of observations) {
          if (observation && matchesCorroboratingBlock(candidate, observation)) {
            candidate.corroborations += 1
          }
        }
        results.push(candidate)
      }
      if (reachedBaseline) break
    }
    return results
  }

  // Fresh single-request read (redeemed/revoked flags) for evidence checks.
  // Returns null when the node does not know the request.
  async getUnwrapRequest(txHash: string, logIndex: number): Promise<UnwrapTokenRequest | null> {
    await this.ensureInitialized()
    try {
      return await this.zenonService
        .getZenon()
        .embedded.bridge.getUnwrapTokenRequestByHashAndLog(Hash.parse(txHash), logIndex)
    } catch {
      return null
    }
  }

  // Outcome of a published account block, for resolving a Zenon redeem whose
  // embedded call may have failed on-chain: 'processed' — the block confirmed
  // AND the contract's receive block exists (the embedded call ran, so if the
  // request is still redeemable the call failed); 'pending' — published but
  // not yet received by the contract; 'not-found' — the node does not know
  // the hash.
  async getAccountBlockOutcome(hash: string): Promise<'processed' | 'pending' | 'not-found'> {
    await this.ensureInitialized()
    const block = await this.zenonService
      .getZenon()
      .ledger.getAccountBlockByHash(Hash.parse(hash))
    if (!block) return 'not-found'
    if (block.confirmationDetail && block.pairedAccountBlock) return 'processed'
    return 'pending'
  }

  buildWrapBlock(
    evmToAddress: string,
    humanAmount: string | number,
    decimals: number,
    zts: string,
  ): AccountBlockTemplate {
    const amount = parseAmount(humanAmount, decimals)
    return this.zenonService.getZenon().embedded.bridge.wrapToken(
      config.networkClass,
      config.evmChainId,
      evmToAddress,
      amount,
      TokenStandard.parse(zts),
    )
  }
}
