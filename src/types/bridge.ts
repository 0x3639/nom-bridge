export type WrapStatus =
  | 'signing'
  | 'redeemable'
  | 'waiting-delay'
  | 'redeemable-2'
  | 'redeemed'

export type UnwrapStatus =
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
  decimals: number       // see useBridge note on decimals sourcing
  minAmount: bigint
  feePercentage: number  // basis points
  redeemDelay: number    // Zenon-side unwrap delay (momentums)
}

export interface WrapRequestView {
  id: string             // wrap block hash
  zts: string
  amount: bigint
  toAddress: string      // EVM recipient
  status: WrapStatus
  remainingSeconds?: number
}

export interface UnwrapRequestView {
  id: string             // `${evmTxHash}:${logIndex}`
  transactionHash: string
  logIndex: number
  zts: string
  amount: bigint
  toAddress: string      // Zenon recipient
  status: UnwrapStatus
  remainingSeconds?: number
}

export interface TrackedRequest {
  kind: 'wrap' | 'unwrap'
  id: string
  zts: string
  amount: string         // bigint as string (JSON-safe)
  evmToAddress?: string
  zenonToAddress?: string
  createdAt: number
}
