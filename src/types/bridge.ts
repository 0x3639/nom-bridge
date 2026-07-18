export type WrapStatus =
  | 'signing'
  | 'redeemable'
  | 'waiting-delay'
  | 'redeemable-2'
  | 'redeemed'

export type UnwrapStatus =
  | 'submitted'
  | 'pending'
  | 'signing'
  | 'waiting'
  | 'redeemable'
  | 'redeemed'
  | 'revoked'
  | 'broken'

export interface TokenPairView {
  zts: string            // TokenStandard string
  tokenAddress: string   // EVM ERC-20 address
  symbol: string
  evmSymbol: string
  decimals: number
  wrapMinAmount: bigint
  unwrapMinAmount: bigint
  feePercentage: number  // basis points
  redeemDelay: number    // Zenon-side unwrap delay (momentums)
  wrapEnabled: boolean
  unwrapEnabled: boolean
  owned: boolean
  unwrapBonusBps: number // 300 when the unwrap affiliate self-bonus is live, else 0
}

export interface WrapRequestView {
  id: string             // wrap block hash
  zts: string
  amount: bigint
  decimals: number
  symbol: string
  toAddress: string      // EVM recipient
  status: WrapStatus
  remainingSeconds?: number
  pendingClaimHash?: string
  pendingClaimStage?: 1 | 2
}

export interface UnwrapRequestView {
  id: string             // `${evmTxHash}:${logIndex}`
  transactionHash: string
  logIndex: number
  zts: string
  amount: bigint
  decimals: number
  symbol: string
  toAddress: string      // Zenon recipient
  status: UnwrapStatus
  remainingSeconds?: number
  totalApprovals?: 2 | 3
  pendingZenonRedeemHash?: string
}

export interface TrackedRequest {
  kind: 'wrap' | 'unwrap'
  id: string
  evmChainId: number
  zenonChainId: number
  zts: string
  amount: string         // bigint as string (JSON-safe)
  decimals: number
  symbol: string
  evmToAddress?: string
  zenonToAddress?: string
  approvalCount?: 2 | 3
  createdAt: number
}
