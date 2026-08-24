export interface NetworkConfig {
  nodeUrl: string
  zenonRpcUrls: readonly string[]
  zenonChainId: number
  zenonNetworkId: number
  networkClass: number       // 2 = EVM
  evmChainId: number
  evmRpcUrls: readonly string[]
  evmExplorerTxUrl: string
  zenonExplorerTxUrl: string
  bridgeStatusUrl: string
  expectedBridgeAddress: string
  expectedTokenPairs: Readonly<Record<string, {tokenAddress: string; decimals: number}>>
}

export const WC_PROJECT_ID = import.meta.env.VITE_WC_PROJECT_ID ?? 'REPLACE_ME_WC_PROJECT_ID'
export const FEE_DENOMINATOR = 10_000n
export const DEFAULT_MOMENTUM_TIME = 10

const mainnet: NetworkConfig = {
  nodeUrl: 'wss://node.zenonhub.io:35998',
  // Distinct endpoints from zenon-network/zenon-node-database.
  // Ambiguous wrap reconciliation requires matching observations from both;
  // the first remains the application's normal read/write node.
  zenonRpcUrls: [
    'wss://node.zenonhub.io:35998',
    'wss://my.hc1node.com:35998',
  ],
  zenonChainId: 1,
  zenonNetworkId: 1,
  networkClass: 2,
  evmChainId: 1,
  evmRpcUrls: [
    'https://ethereum-rpc.publicnode.com',
    'https://eth.drpc.org',
    'https://rpc.mevblocker.io',
  ],
  evmExplorerTxUrl: 'https://etherscan.io/tx/',
  zenonExplorerTxUrl: 'https://zenonhub.io/explorer/transaction/',
  bridgeStatusUrl: 'https://status.bridge.zenon.community/',
  expectedBridgeAddress: '0xa98706106f7710d743186031be2245f33acea106',
  expectedTokenPairs: {
    zts1znnxxxxxxxxxxxxx9z4ulx: {
      tokenAddress: '0xb2e96a63479c2edd2fd62b382c89d5ca79f572d3',
      decimals: 8,
    },
    zts17d6yr02kh0r9qr566p7tg6: {
      tokenAddress: '0xdac866a3796f85cb84a914d98faec052e3b5596d',
      decimals: 18,
    },
    zts1qsrxxxxxxxxxxxxxmrhjll: {
      tokenAddress: '0x96546afe4a21515a3a30cd3fd64a70eb478dc174',
      decimals: 8,
    },
    zts14pmddt35kawqweg3re08zj: {
      tokenAddress: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',
      decimals: 8,
    },
  },
}

if (import.meta.env.MODE === 'testnet') {
  throw new Error('Testnet mode is disabled until a verified Zenon testnet node and contract allowlist are configured.')
}

export const config: NetworkConfig = mainnet

export const ZENON_CHAIN = `zenon:${config.zenonChainId}`
