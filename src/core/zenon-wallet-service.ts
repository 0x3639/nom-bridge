import {SignClient} from '@walletconnect/sign-client'
import type {SessionTypes} from '@walletconnect/types'
import {AccountBlockTemplate, Address} from 'znn-typescript-sdk'
import {config, WC_PROJECT_ID, ZENON_CHAIN} from '@/config'
import {classifyWalletError, delay, WC_TIMING, withTimeout} from './wc-reliability'

const ZENON_NAMESPACE = {
  methods: ['znn_info', 'znn_sign', 'znn_send'],
  events: ['chainIdChange', 'addressChange'],
  chains: [ZENON_CHAIN],
}

function isWcConfigured(): boolean {
  return Boolean(WC_PROJECT_ID) && WC_PROJECT_ID !== 'REPLACE_ME_WC_PROJECT_ID'
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
  // When set, fresh pairings hand the URI to this callback instead of opening
  // the WalletConnect modal (used by the integration test harness).
  onPairingUri: ((uri: string) => void) | null = null

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
    if (!isWcConfigured()) {
      throw new Error('WalletConnect is not configured — set VITE_WC_PROJECT_ID in .env (see .env.example)')
    }
    await this.ensureSession()
    return this.getInfo()
  }

  // Non-interactive session restore for app startup: adopt a still-live
  // session so a page refresh doesn't show "disconnected". Never opens the
  // modal and never throws — absence of a session is a normal outcome.
  async restore(): Promise<ZenonWalletInfo | null> {
    if (!isWcConfigured()) return null
    try {
      const client = await this.getClient()
      const existing = this.findLiveZenonSession(client)
      if (!existing) return null
      this.session = existing
      return await this.getInfo()
    } catch {
      this.session = null
      return null
    }
  }

  private findLiveZenonSession(client: SignClientInstance): SessionTypes.Struct | null {
    // findLast over live zenon sessions (manual reverse scan — `Array.findLast`
    // needs lib ES2023, but this project targets ES2020).
    const sessions = client.session.getAll()
    for (let i = sessions.length - 1; i >= 0; i--) {
      const s = sessions[i]
      if (s.namespaces.zenon && s.expiry * 1000 > Date.now()) return s
    }
    return null
  }

  private async ensureSession(): Promise<void> {
    const client = await this.getClient()
    const existing = this.findLiveZenonSession(client)
    if (existing) {
      this.session = existing
      return
    }
    let modal: {openModal: (opts: {uri: string}) => Promise<unknown>; closeModal: () => void} | null = null
    try {
      const {uri, approval} = await client.connect({
        requiredNamespaces: {zenon: ZENON_NAMESPACE},
      })
      if (uri) {
        if (this.onPairingUri) {
          this.onPairingUri(uri)
        } else {
          const {WalletConnectModal} = await import('@walletconnect/modal')
          modal = new WalletConnectModal({
            projectId: WC_PROJECT_ID,
            chains: [ZENON_CHAIN],
            enableExplorer: false, // the WC explorer can never list Syrius
            mobileWallets: [],
            desktopWallets: [
              {
                id: 'syrius',
                name: 'Syrius',
                links: {native: 'syrius:', universal: 'https://zenon.network'},
              },
            ],
          })
          await modal.openModal({uri})
        }
      }
      const approved = await withTimeout(approval(), WC_TIMING.approvalTimeoutMs, 'Wallet approval')
      // The SignClient session store lags behind approval(); give it a moment,
      // then prefer the store's copy of the newest live zenon session.
      await delay(WC_TIMING.settleMs)
      this.session = this.findLiveZenonSession(client) ?? approved
    } catch (e) {
      throw mapWcError(e)
    } finally {
      modal?.closeModal()
    }
  }

  async getInfo(): Promise<ZenonWalletInfo> {
    const info = await this.requestWithRetry<ZenonWalletInfo>('znn_info', undefined)
    return validateZenonWalletInfo(info)
  }

  // WIRED now, first USED in Phase 3. Do not call it this phase.
  async send(fromAddress: string, block: AccountBlockTemplate): Promise<AccountBlockTemplate> {
    const info = await this.getInfo()
    if (info.address !== fromAddress) {
      throw new Error('Zenon wallet address changed. Review the recipient and try again.')
    }
    const result = await this.requestWithRetry<unknown>('znn_send', {
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

  private async ensureRelayConnected(client: SignClientInstance): Promise<void> {
    if (client.core.relayer.connected) return
    // A request sent into a dead relay (e.g. after laptop sleep) vanishes
    // silently; reopen the transport and let it settle first.
    await client.core.relayer.transportOpen()
    await delay(WC_TIMING.relaySettleMs)
  }

  private async request<T>(method: string, params: unknown): Promise<T> {
    const client = await this.getClient()
    if (!this.session) throw new Error('No active Zenon session')
    await this.ensureRelayConnected(client)
    return withTimeout(
      client.request<T>({
        topic: this.session.topic,
        chainId: ZENON_CHAIN,
        request: {method, params},
      }),
      WC_TIMING.requestTimeoutMs,
      `Syrius request (${method})`,
    )
  }

  private async requestWithRetry<T>(method: string, params: unknown): Promise<T> {
    let lastError: unknown = null
    for (let attempt = 1; attempt <= WC_TIMING.maxAttempts; attempt++) {
      try {
        return await this.request<T>(method, params)
      } catch (e) {
        lastError = e
        switch (classifyWalletError(e)) {
          case 'locked':
            throw new Error('Your wallet is locked — please unlock Syrius')
          case 'rejected':
            throw new Error('Request rejected in the wallet')
          case 'reconnect':
            // Known Syrius desync ("Bad state: No element"): drop the session
            // and re-acquire before the next attempt.
            this.session = null
            await this.ensureSession()
            break
          case 'retry':
            break
          case 'fatal':
            throw mapWcError(e)
        }
      }
    }
    throw mapWcError(lastError)
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
