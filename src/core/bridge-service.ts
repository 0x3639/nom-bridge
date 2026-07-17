import {ZenonService} from './zenon-service'
import {config} from '@/config'
import {Address, Hash, TokenStandard} from 'znn-typescript-sdk'
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
