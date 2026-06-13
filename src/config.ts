export interface NetworkConfig {
  nodeUrl: string
  zenonChainId: number       // 1 mainnet, 3 testnet — sole source of the WC chain string
  networkClass: number       // 2 = EVM
  evmChainId: number         // 1 mainnet, 11155111 sepolia
  evmExplorerTxUrl: string
  zenonExplorerTxUrl: string
}

export const WC_PROJECT_ID = import.meta.env.VITE_WC_PROJECT_ID ?? 'REPLACE_ME_WC_PROJECT_ID'
export const FEE_DENOMINATOR = 10_000n
export const DEFAULT_MOMENTUM_TIME = 10

const mainnet: NetworkConfig = {
  nodeUrl: 'wss://node.zenonhub.io:35998',
  zenonChainId: 1,
  networkClass: 2,
  evmChainId: 1,
  evmExplorerTxUrl: 'https://etherscan.io/tx/',
  zenonExplorerTxUrl: 'https://zenonhub.io/explorer/transaction/',
}

const testnet: NetworkConfig = {
  nodeUrl: 'wss://node.zenonhub.io:35998',   // testnet node TBD in Phase 5; mainnet url placeholder OK for Phase 1
  zenonChainId: 3,
  networkClass: 2,
  evmChainId: 11155111,
  evmExplorerTxUrl: 'https://sepolia.etherscan.io/tx/',
  zenonExplorerTxUrl: 'https://zenonhub.io/explorer/transaction/',
}

export const config: NetworkConfig = import.meta.env.MODE === 'testnet' ? testnet : mainnet

export const ZENON_CHAIN = `zenon:${config.zenonChainId}`
