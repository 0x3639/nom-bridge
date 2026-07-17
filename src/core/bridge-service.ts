import {ZenonService} from './zenon-service'
import {config} from '@/config'
import {Address, BRIDGE_ADDRESS, Hash, TokenStandard} from 'znn-typescript-sdk'
import {parseAmount} from './amount'
import type {
  AccountBlockTemplate,
  BridgeInfo,
  BridgeNetworkInfo,
  OrchestratorInfo,
  UnwrapTokenRequestList,
  WrapTokenRequestList,
} from 'znn-typescript-sdk'

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
    return this.zenonService
      .getZenon()
      .embedded.bridge.getAllWrapTokenRequestsByToAddress(evmToAddress, page, size)
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
    const frontier = await this.zenonService
      .getZenon()
      .ledger.getFrontierAccountBlock(Address.parse(address))
    return frontier?.height ?? 0
  }

  // Sends from `address` to the embedded bridge contract with height above
  // `afterHeight` — the authoritative account-chain evidence that a wrap was
  // published. Pages are newest-first; scanning stops once heights fall to or
  // below the recorded frontier.
  async findWrapSendsAfter(
    address: string,
    afterHeight: number,
  ): Promise<Array<{hash: string; height: number; zts: string; amount: string}>> {
    await this.ensureInitialized()
    const ledger = this.zenonService.getZenon().ledger
    const parsed = Address.parse(address)
    const results: Array<{hash: string; height: number; zts: string; amount: string}> = []
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
        if (block.toAddress.toString() !== BRIDGE_ADDRESS.toString()) continue
        results.push({
          hash: block.hash.toString(),
          height: block.height,
          zts: block.tokenStandard.toString(),
          amount: block.amount.toString(),
        })
      }
      if (reachedBaseline) break
    }
    return results
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
