import {SignClient} from '@walletconnect/sign-client'
import {createHash} from 'node:crypto'

// A real, well-formed Zenon address (the plasma embedded contract) so the
// dApp's Address.parse validation passes. Node-only module: used by the CLI
// harness (scripts/fake-syrius.ts) and the integration test — never bundled
// into the app.
export const FAKE_SYRIUS_ADDRESS = 'z1qxemdeddedxplasmaxxxxxxxxxxxxxxxsctrp'

export interface FakeSyriusFlags {
  reject?: boolean
  locked?: boolean
  hang?: boolean
  badState?: boolean
}

export interface FakeSyrius {
  pair(uri: string): Promise<void>
  /** Replaces the full flag set — flags omitted from `flags` are reset to false. */
  setFlags(flags: FakeSyriusFlags): void
  disconnectAll(): Promise<void>
  close(): Promise<void>
}

type WalletClient = Awaited<ReturnType<typeof SignClient.init>>

export async function createFakeSyrius(
  options: {projectId: string} & FakeSyriusFlags,
): Promise<FakeSyrius> {
  const flags: FakeSyriusFlags = {
    reject: options.reject,
    locked: options.locked,
    hang: options.hang,
    badState: options.badState,
  }
  let badStateFired = false

  const client: WalletClient = await SignClient.init({
    projectId: options.projectId,
    metadata: {
      name: 'Fake Syrius',
      description: 'Headless Syrius stand-in for NoM Bridge testing',
      url: 'https://example.invalid',
      icons: [],
    },
  })

  client.on('session_proposal', proposal => {
    void (async () => {
      try {
        const zenon = proposal.params.requiredNamespaces.zenon
        const chains = zenon?.chains ?? ['zenon:1']
        const {acknowledged} = await client.approve({
          id: proposal.id,
          namespaces: {
            zenon: {
              accounts: chains.map(chain => `${chain}:${FAKE_SYRIUS_ADDRESS}`),
              methods: zenon?.methods ?? ['znn_info', 'znn_sign', 'znn_send'],
              events: zenon?.events ?? ['chainIdChange', 'addressChange'],
            },
          },
        })
        await acknowledged()
        console.log('[fake-syrius] session approved')
      } catch (error) {
        console.error(
          '[fake-syrius] session_proposal error:',
          error instanceof Error ? error.message : String(error),
        )
      }
    })()
  })

  client.on('session_request', event => {
    const {topic, id, params} = event
    const respond = (result: unknown) =>
      client.respond({topic, response: {id, jsonrpc: '2.0', result}})
    const respondError = (code: number, message: string) =>
      client.respond({topic, response: {id, jsonrpc: '2.0', error: {code, message}}})

    void (async () => {
      try {
        const method = params.request.method
        console.log(`[fake-syrius] ${method} requested`)
        if (flags.hang) return // exercise the dApp's request timeout
        if (flags.locked) return respondError(9000, 'Wallet is locked')
        if (flags.reject) return respondError(5000, 'User rejected')
        if (flags.badState && !badStateFired) {
          badStateFired = true
          return respondError(-32602, 'Bad state: No element')
        }
        if (method === 'znn_info') {
          return respond({address: FAKE_SYRIUS_ADDRESS, chainId: 1, nodeUrl: 'wss://fake.node.invalid'})
        }
        if (method === 'znn_send') {
          const block = (params.request.params as {accountBlock: Record<string, unknown>}).accountBlock
          // Echo the block back "published": deterministic fake hash, filled
          // publicKey/signature. No signing, no broadcast.
          const hash = createHash('sha256').update(JSON.stringify(block)).digest('hex')
          return respond({
            ...block,
            hash,
            publicKey: (block.publicKey as string) || 'ZmFrZS1wdWJrZXk=',
            signature: (block.signature as string) || 'ZmFrZS1zaWduYXR1cmU=',
          })
        }
        if (method === 'znn_sign') {
          return respond('ZmFrZS1zaWduYXR1cmU=')
        }
        return respondError(4001, `Unsupported method ${method}`)
      } catch (error) {
        console.error(
          '[fake-syrius] session_request error:',
          error instanceof Error ? error.message : String(error),
        )
        try {
          await respondError(-32603, 'Internal fake-wallet error')
        } catch {
          // best-effort only — ignore secondary failure
        }
      }
    })()
  })

  return {
    async pair(uri: string): Promise<void> {
      await client.core.pairing.pair({uri})
    },
    setFlags(next: FakeSyriusFlags): void {
      flags.reject = next.reject ?? false
      flags.locked = next.locked ?? false
      flags.hang = next.hang ?? false
      flags.badState = next.badState ?? false
      if (next.badState) badStateFired = false
    },
    async disconnectAll(): Promise<void> {
      for (const session of client.session.getAll()) {
        await client.disconnect({
          topic: session.topic,
          reason: {code: 6000, message: 'Fake wallet disconnected'},
        })
      }
    },
    async close(): Promise<void> {
      await client.core.relayer.transportClose()
    },
  }
}
