import {SignClient} from '@walletconnect/sign-client'
import type {SessionTypes} from '@walletconnect/types'
import {AccountBlockTemplate, Address} from 'znn-typescript-sdk'
import {config, WC_PROJECT_ID, ZENON_CHAIN} from '@/config'
import {classifyWalletError, delay, WalletTimeoutError, WC_TIMING, withTimeout} from './wc-reliability'
import {createWcStorage} from './wc-session-storage'

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

// `wc:<pairingTopic>@2?...` — the topic the wallet would pair on.
export function pairingTopicOf(uri: string): string | null {
  const match = /^wc:([0-9a-f]+)@\d/i.exec(uri)
  return match ? match[1] : null
}

// The user closed the pairing dialog before Syrius approved. A rejection
// (no session, nothing signed) that callers treat as "nothing happened".
export class PairingCancelledError extends Error {
  constructor() {
    super('Pairing cancelled')
    this.name = 'PairingCancelledError'
  }
}

export class ZenonSubmissionError extends Error {
  constructor(
    readonly kind: 'rejected' | 'ambiguous',
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'ZenonSubmissionError'
  }
}

type SignClientInstance = Awaited<ReturnType<typeof SignClient.init>>

export class ZenonWalletService {
  private static instance: ZenonWalletService | null = null
  private clientPromise: Promise<SignClientInstance> | null = null
  private session: SessionTypes.Struct | null = null
  onDisconnect: (() => void) | null = null
  onInfoChange: ((info: ZenonWalletInfo) => void) | null = null
  // Fresh pairings hand the URI to this callback for display (the in-app
  // PairingDialog, or the integration test harness); onPairingClosed fires
  // once the pairing resolves, fails, times out, or is cancelled.
  onPairingUri: ((uri: string) => void) | null = null
  onPairingClosed: (() => void) | null = null
  private pairingCancel: (() => void) | null = null

  static getInstance(): ZenonWalletService {
    if (!ZenonWalletService.instance) {
      ZenonWalletService.instance = new ZenonWalletService()
    }
    return ZenonWalletService.instance
  }

  private async getClient(): Promise<SignClientInstance> {
    if (!this.clientPromise) {
      const promise = this.initClient()
      this.clientPromise = promise
      // A failed init must not poison future attempts; clear the memo so the
      // next call retries (unless a newer attempt already replaced it).
      promise.catch(() => {
        if (this.clientPromise === promise) this.clientPromise = null
      })
    }
    return this.clientPromise
  }

  private async initClient(): Promise<SignClientInstance> {
    const client = await SignClient.init({
      projectId: WC_PROJECT_ID,
      // Tab-scoped: a pairing must not outlive the tab (see wc-session-storage).
      storage: createWcStorage(),
      metadata: {
        name: 'NoM Bridge',
        description: 'Zenon <-> EVM bridge',
        url: window.location.origin,
        icons: [window.location.origin + '/logo.svg'],
      },
    })
    client.on('session_delete', () => this.clearSession())
    client.on('session_expire', () => this.clearSession())
    client.on('session_event', event => {
      if (!this.session || event.topic !== this.session.topic) return
      const name = event.params.event.name
      if (name !== 'chainIdChange' && name !== 'addressChange') return
      void this.refreshInfoFromEvent()
    })
    return client
  }

  async connect(): Promise<ZenonWalletInfo> {
    if (!isWcConfigured()) {
      throw new Error('WalletConnect is not configured — set VITE_WC_PROJECT_ID in .env (see .env.example)')
    }
    const reused = await this.ensureSession()
    if (!reused) return this.getInfo()
    try {
      return await this.getInfo()
    } catch (e) {
      if (!(e instanceof WalletTimeoutError)) throw e
      // A stored session the wallet no longer holds (Syrius or the machine
      // restarted) never answers. Discard it and offer a fresh pairing instead
      // of timing out on the dead topic on every Connect.
      console.debug('[wc] stored session unresponsive, pairing afresh:', e.message)
      const client = await this.getClient()
      await client.session.delete(reused.topic, {code: 6000, message: 'Stale session'}).catch(() => undefined)
      this.session = null
      await this.ensureSession()
      return this.getInfo()
    }
  }

  // Non-interactive session restore for app startup: adopt a still-live
  // session so a page refresh doesn't show "disconnected". Never opens the
  // modal and never throws — absence of a session is a normal outcome.
  async restore(): Promise<ZenonWalletInfo | null> {
    if (!isWcConfigured()) return null
    let existing: SessionTypes.Struct | null = null
    try {
      const client = await this.getClient()
      existing = this.findLiveZenonSession(client)
      if (!existing) return null
      this.session = existing
      return await this.getInfo()
    } catch (e) {
      // A session established concurrently by connect() (e.g. while this
      // restore() was still in flight) must survive a restore failure — only
      // clear the session if it's still the one restore() itself set.
      // Not airtight: if that concurrent connect() reused this SAME session
      // object (e.g. adopted the same live session restore() found), a late
      // restore failure still clears it out from under connect(). Accepted
      // residual window — the next reconnect self-heals.
      if (this.session === existing) this.session = null
      console.debug('[wc] restore failed:', e instanceof Error ? e.message : String(e))
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

  // Resolves to the reused stored session, or null when a fresh pairing was made.
  private async ensureSession(): Promise<SessionTypes.Struct | null> {
    const client = await this.getClient()
    const existing = this.findLiveZenonSession(client)
    if (existing) {
      this.session = existing
      return existing
    }
    let pairingShown = false
    try {
      const {uri, approval} = await client.connect({
        requiredNamespaces: {zenon: ZENON_NAMESPACE},
      })
      // Cancellation must be armed BEFORE the UI sees the uri: a handler may
      // cancel synchronously.
      const cancelled = new Promise<never>((_, reject) => {
        this.pairingCancel = () => reject(new PairingCancelledError())
      })
      if (uri) {
        // The UI renders the pairing QR/URI (see PairingDialog); the deprecated
        // @walletconnect/modal is no longer used. Without a handler (headless
        // harness) the approval simply waits.
        pairingShown = true
        this.onPairingUri?.(uri)
      }
      const approvalPromise = approval()
      let cancelledEarly = false
      // Racing does not stop approval(): if Syrius approves after the user
      // cancelled, the session would land in the store and be silently reused
      // by the next connect(). Tear it down instead.
      void approvalPromise.then(
        session => {
          if (!cancelledEarly) return
          void client
            .disconnect({topic: session.topic, reason: {code: 6000, message: 'Pairing cancelled'}})
            .catch(() => undefined)
        },
        () => undefined,
      )
      let approved: SessionTypes.Struct
      try {
        approved = await Promise.race([
          withTimeout(approvalPromise, WC_TIMING.approvalTimeoutMs, 'Wallet approval'),
          cancelled,
        ])
      } catch (e) {
        if (e instanceof PairingCancelledError && uri) {
          cancelledEarly = true
          const topic = pairingTopicOf(uri)
          if (topic) await client.core.pairing.disconnect({topic}).catch(() => undefined)
        }
        throw e
      }
      // The SignClient session store lags behind approval(); give it a moment,
      // then prefer the store's copy of the newest live zenon session.
      await delay(WC_TIMING.settleMs)
      this.session = this.findLiveZenonSession(client) ?? approved
      return null
    } catch (e) {
      if (e instanceof PairingCancelledError) throw e
      throw mapWcError(e)
    } finally {
      this.pairingCancel = null
      if (pairingShown) this.onPairingClosed?.()
    }
  }

  // Abort a pending fresh pairing (user closed the QR dialog).
  cancelPairing(): void {
    this.pairingCancel?.()
  }

  async getInfo(): Promise<ZenonWalletInfo> {
    const info = await this.requestWithRetry<ZenonWalletInfo>('znn_info', undefined)
    return validateZenonWalletInfo(info)
  }

  async send(fromAddress: string, block: AccountBlockTemplate): Promise<AccountBlockTemplate> {
    const info = await this.getInfo()
    if (info.address !== fromAddress) {
      throw new Error('Zenon wallet address changed. Review the recipient and try again.')
    }
    let result: unknown
    try {
      result = await this.requestWithRetry<unknown>('znn_send', {
        fromAddress,
        accountBlock: block.toJson(),
      })
    } catch (e) {
      // Rejections are recognized structurally (typed by requestWithRetry from
      // the wallet's error code), never by matching a message string. Anything
      // not provably a rejection is ambiguous: the wallet may still have
      // signed and broadcast the block, so callers must keep safety locks.
      if (e instanceof ZenonSubmissionError) throw e
      throw new ZenonSubmissionError(
        'ambiguous',
        'Zenon redemption may have been submitted, but WalletConnect did not return a result',
        e,
      )
    }
    try {
      return AccountBlockTemplate.fromJson(result as Parameters<typeof AccountBlockTemplate.fromJson>[0])
    } catch (e) {
      // znn_send already returned: the wallet signed and broadcast the block.
      // A result we cannot decode (version skew) must never surface as a
      // retryable failure — callers would release safety locks and resubmit.
      throw new ZenonSubmissionError(
        'ambiguous',
        'Zenon transaction was submitted, but its result could not be decoded',
        e,
      )
    }
  }

  async disconnect(): Promise<void> {
    if (this.clientPromise && this.session) {
      try {
        const client = await this.clientPromise
        await client.disconnect({
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
    const timeoutMs = method === 'znn_send' ? WC_TIMING.sendTimeoutMs : WC_TIMING.requestTimeoutMs
    return withTimeout(
      client.request<T>({
        topic: this.session.topic,
        chainId: ZENON_CHAIN,
        request: {method, params},
      }),
      timeoutMs,
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
            // A locked wallet provably did not sign — typed like a rejection so
            // send() never classifies it as ambiguous (which would latch
            // pre-send safety records forever).
            throw new ZenonSubmissionError('rejected', 'Your wallet is locked — please unlock Syrius', e)
          case 'rejected':
            throw new ZenonSubmissionError('rejected', 'Request rejected in the wallet', e)
          case 'reconnect':
            // Known Syrius desync ("Bad state: No element"): drop the session
            // and re-acquire before the next attempt — but not after the
            // final attempt, since there won't be a next attempt to use it.
            if (attempt < WC_TIMING.maxAttempts) {
              this.session = null
              await this.ensureSession()
            }
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
