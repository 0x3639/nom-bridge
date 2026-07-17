import {SignClient} from '@walletconnect/sign-client'
import {WalletConnectModal} from '@walletconnect/modal'
import type {SessionTypes} from '@walletconnect/types'
import {AccountBlockTemplate, Address} from 'znn-typescript-sdk'
import {config, WC_PROJECT_ID, ZENON_CHAIN} from '@/config'

const ZENON_NAMESPACE = {
  methods: ['znn_info', 'znn_sign', 'znn_send'],
  events: ['chainIdChange', 'addressChange'],
  chains: [ZENON_CHAIN],
}

export interface ZenonWalletInfo {
  address: string
  chainId: number
  nodeUrl?: string
}

type SignClientInstance = Awaited<ReturnType<typeof SignClient.init>>

export class ZenonWalletService {
  private static instance: ZenonWalletService | null = null
  private client: SignClientInstance | null = null
  private session: SessionTypes.Struct | null = null
  onDisconnect: (() => void) | null = null
  onInfoChange: ((info: ZenonWalletInfo) => void) | null = null

  static getInstance(): ZenonWalletService {
    if (!ZenonWalletService.instance) {
      ZenonWalletService.instance = new ZenonWalletService()
    }
    return ZenonWalletService.instance
  }

  private async getClient(): Promise<SignClientInstance> {
    if (this.client) return this.client
    this.client = await SignClient.init({
      projectId: WC_PROJECT_ID,
      metadata: {
        name: 'NoM Bridge',
        description: 'Zenon <-> EVM bridge',
        url: window.location.origin,
        icons: [window.location.origin + '/logo.svg'],
      },
    })
    this.client.on('session_delete', () => this.clearSession())
    this.client.on('session_expire', () => this.clearSession())
    this.client.on('session_event', event => {
      if (!this.session || event.topic !== this.session.topic) return
      const name = event.params.event.name
      if (name !== 'chainIdChange' && name !== 'addressChange') return
      void this.refreshInfoFromEvent()
    })
    return this.client
  }

  async connect(): Promise<ZenonWalletInfo> {
    const client = await this.getClient()
    // findLast over live zenon sessions (manual reverse scan — `Array.findLast`
    // needs lib ES2023, but this project targets ES2020).
    const sessions = client.session.getAll()
    let existing: SessionTypes.Struct | undefined
    for (let i = sessions.length - 1; i >= 0; i--) {
      const s = sessions[i]
      if (s.namespaces.zenon && s.expiry * 1000 > Date.now()) {
        existing = s
        break
      }
    }
    if (existing) {
      this.session = existing
      return this.getInfo()
    }
    const modal = new WalletConnectModal({projectId: WC_PROJECT_ID, chains: [ZENON_CHAIN]})
    try {
      const {uri, approval} = await client.connect({
        requiredNamespaces: {zenon: ZENON_NAMESPACE},
      })
      if (uri) await modal.openModal({uri})
      this.session = await approval()
      return this.getInfo()
    } catch (e) {
      throw mapWcError(e)
    } finally {
      modal.closeModal()
    }
  }

  async getInfo(): Promise<ZenonWalletInfo> {
    const info = await this.request<ZenonWalletInfo>('znn_info', undefined)
    return validateZenonWalletInfo(info)
  }

  // WIRED now, first USED in Phase 3. Do not call it this phase.
  async send(fromAddress: string, block: AccountBlockTemplate): Promise<AccountBlockTemplate> {
    const info = await this.getInfo()
    if (info.address !== fromAddress) {
      throw new Error('Zenon wallet address changed. Review the recipient and try again.')
    }
    const result = await this.request<unknown>('znn_send', {
      fromAddress,
      accountBlock: block.toJson(),
    })
    return AccountBlockTemplate.fromJson(result as any)
  }

  async disconnect(): Promise<void> {
    if (this.client && this.session) {
      try {
        await this.client.disconnect({
          topic: this.session.topic,
          reason: {code: 6000, message: 'User disconnected'},
        })
      } catch {
        // swallow: clearing local state is what matters
      }
    }
    this.clearSession()
  }

  private async request<T>(method: string, params: unknown): Promise<T> {
    const client = await this.getClient()
    if (!this.session) throw new Error('No active Zenon session')
    try {
      return await client.request<T>({
        topic: this.session.topic,
        chainId: ZENON_CHAIN,
        request: {method, params},
      })
    } catch (e) {
      throw mapWcError(e)
    }
  }

  private clearSession(): void {
    this.session = null
    this.onDisconnect?.()
  }

  private async refreshInfoFromEvent(): Promise<void> {
    try {
      const info = await this.getInfo()
      this.onInfoChange?.(info)
    } catch {
      this.clearSession()
    }
  }
}

export function validateZenonWalletInfo(info: ZenonWalletInfo): ZenonWalletInfo {
  if (info.chainId !== config.zenonChainId) {
    throw new Error(`Zenon wallet is connected to chain ${info.chainId}; expected ${config.zenonChainId}`)
  }
  try {
    Address.parse(info.address)
  } catch {
    throw new Error('Zenon wallet returned an invalid address')
  }
  return info
}

// WalletConnect JSON-RPC error codes in the 5000 range are user/wallet rejections.
export function mapWcError(e: unknown): Error {
  const code = (e as {code?: number})?.code
  if (typeof code === 'number' && code >= 5000 && code < 6000) {
    return new Error('Request rejected in the wallet')
  }
  return e instanceof Error ? e : new Error('WalletConnect request failed')
}
