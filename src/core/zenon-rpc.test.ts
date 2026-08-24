import {describe, expect, it} from 'vitest'
import {
  getZenonRpcAccountBlock,
  getZenonRpcFrontierHeight,
  parseZenonRpcAccountBlock,
  websocketJsonRpc,
  type JsonRpcSocketFactory,
} from './zenon-rpc'

const SENDER_ADDRESS = 'z1qxemdeddedxplasmaxxxxxxxxxxxxxxxxsctrp'
const BRIDGE_ADDRESS = 'z1qxemdeddedxdrydgexxxxxxxxxxxxxxxmqgr0d'
const ZNN_TOKEN_STANDARD = 'zts1znnxxxxxxxxxxxxx9z4ulx'

function rawBlock(overrides: Record<string, unknown> = {}) {
  return {
    chainIdentifier: 1,
    blockType: 2,
    hash: 'ab'.repeat(32),
    height: 42,
    address: SENDER_ADDRESS,
    toAddress: BRIDGE_ADDRESS,
    amount: '150000000',
    tokenStandard: ZNN_TOKEN_STANDARD,
    data: 'd3JhcA==',
    confirmationDetail: {
      numConfirmations: 2,
      momentumHeight: 100,
      momentumHash: 'cd'.repeat(32),
      momentumTimestamp: 1_700_000_000,
    },
    ...overrides,
  }
}

function resultSocket(
  result: unknown,
  envelopeOverrides: Record<string, unknown> = {},
): JsonRpcSocketFactory {
  return () => {
    const socket = {
      onopen: null as ((event: Event) => void) | null,
      onmessage: null as ((event: MessageEvent) => void) | null,
      onerror: null as ((event: Event) => void) | null,
      onclose: null as ((event: CloseEvent) => void) | null,
      send(data: string) {
        const request = JSON.parse(data) as {id: number}
        queueMicrotask(() => socket.onmessage?.(new MessageEvent('message', {
          data: JSON.stringify({jsonrpc: '2.0', id: request.id, result, ...envelopeOverrides}),
        })))
      },
      close() {},
    }
    queueMicrotask(() => socket.onopen?.(new Event('open')))
    return socket
  }
}

describe('parseZenonRpcAccountBlock', () => {
  it('accepts the exact account-block fields used for corroboration', () => {
    expect(parseZenonRpcAccountBlock(rawBlock())).toEqual({
      chainIdentifier: 1,
      blockType: 2,
      hash: 'ab'.repeat(32),
      height: 42,
      address: SENDER_ADDRESS,
      toAddress: BRIDGE_ADDRESS,
      amount: 150000000n,
      tokenStandard: ZNN_TOKEN_STANDARD,
      data: 'd3JhcA==',
      confirmationDetail: {
        numConfirmations: 2,
        momentumHeight: 100,
        momentumHash: 'cd'.repeat(32),
        momentumTimestamp: 1_700_000_000,
      },
    })
  })

  it('rejects unsafe numeric amounts and malformed confirmation evidence', () => {
    expect(() => parseZenonRpcAccountBlock(rawBlock({amount: 150000000}))).toThrow(
      'Invalid Zenon RPC account block',
    )
    expect(() => parseZenonRpcAccountBlock(rawBlock({
      confirmationDetail: {...rawBlock().confirmationDetail as object, momentumHash: 'not-a-hash'},
    }))).toThrow('Invalid Zenon RPC confirmation detail')
  })

  it('accepts an account block that has not received confirmation detail yet', () => {
    expect(parseZenonRpcAccountBlock(rawBlock({confirmationDetail: null})).confirmationDetail)
      .toBeNull()
  })

  it('validates and canonicalizes uppercase Zenon Bech32 identifiers', () => {
    expect(parseZenonRpcAccountBlock(rawBlock({
      address: SENDER_ADDRESS.toUpperCase(),
      toAddress: BRIDGE_ADDRESS.toUpperCase(),
      tokenStandard: ZNN_TOKEN_STANDARD.toUpperCase(),
    }))).toMatchObject({
      address: SENDER_ADDRESS,
      toAddress: BRIDGE_ADDRESS,
      tokenStandard: ZNN_TOKEN_STANDARD,
    })
  })
})

describe('scoped Zenon RPC reads', () => {
  it('reads a validated frontier height and treats a new account as height zero', async () => {
    await expect(getZenonRpcFrontierHeight(
      'wss://node.example',
      SENDER_ADDRESS,
      1,
      {createSocket: resultSocket(rawBlock())},
    )).resolves.toBe(42)
    await expect(getZenonRpcFrontierHeight(
      'wss://node.example',
      SENDER_ADDRESS,
      1,
      {createSocket: resultSocket(null)},
    )).resolves.toBe(0)
  })

  it('rejects a frontier returned for a different account', async () => {
    await expect(getZenonRpcFrontierHeight(
      'wss://node.example',
      SENDER_ADDRESS,
      1,
      {createSocket: resultSocket(rawBlock({address: BRIDGE_ADDRESS}))},
    )).rejects.toThrow('wrong account frontier')
  })

  it('rejects a frontier returned for a different chain', async () => {
    await expect(getZenonRpcFrontierHeight(
      'wss://node.example',
      SENDER_ADDRESS,
      1,
      {createSocket: resultSocket(rawBlock({chainIdentifier: 2}))},
    )).rejects.toThrow('wrong chain frontier')
  })

  it('reads only the requested account-block hash and preserves not-found', async () => {
    const hash = 'ab'.repeat(32)
    await expect(getZenonRpcAccountBlock(
      'wss://node.example',
      hash,
      {createSocket: resultSocket(rawBlock())},
    )).resolves.toMatchObject({hash, height: 42})
    await expect(getZenonRpcAccountBlock(
      'wss://node.example',
      hash,
      {createSocket: resultSocket(null)},
    )).resolves.toBeNull()
  })

  it('rejects a node response for a different account-block hash', async () => {
    await expect(getZenonRpcAccountBlock(
      'wss://node.example',
      'ab'.repeat(32),
      {createSocket: resultSocket(rawBlock({hash: 'ef'.repeat(32)}))},
    )).rejects.toThrow('wrong account block')
  })
})

describe('websocketJsonRpc', () => {
  it('sends one scoped request, accepts its matching response, and closes', async () => {
    let sent: Record<string, unknown> | null = null
    let closed = false
    let socket: {
      onopen: ((event: Event) => void) | null
      onmessage: ((event: MessageEvent) => void) | null
      onerror: ((event: Event) => void) | null
      onclose: ((event: CloseEvent) => void) | null
      send(data: string): void
      close(): void
    }
    const createSocket: JsonRpcSocketFactory = () => {
      socket = {
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        send(data) {
          sent = JSON.parse(data) as Record<string, unknown>
          queueMicrotask(() => socket.onmessage?.(new MessageEvent('message', {
            data: JSON.stringify({jsonrpc: '2.0', id: sent?.id, result: {height: 42}}),
          })))
        },
        close() {
          closed = true
        },
      }
      queueMicrotask(() => socket.onopen?.(new Event('open')))
      return socket
    }

    await expect(websocketJsonRpc<{height: number}>(
      'wss://node.example',
      'ledger.getFrontierAccountBlock',
      ['z1qsender'],
      {createSocket},
    )).resolves.toEqual({height: 42})

    expect(sent).toMatchObject({
      jsonrpc: '2.0',
      method: 'ledger.getFrontierAccountBlock',
      params: ['z1qsender'],
    })
    expect(closed).toBe(true)
  })

  it('fails closed on an RPC error response', async () => {
    let socket: {
      onopen: ((event: Event) => void) | null
      onmessage: ((event: MessageEvent) => void) | null
      onerror: ((event: Event) => void) | null
      onclose: ((event: CloseEvent) => void) | null
      send(data: string): void
      close(): void
    }
    const createSocket: JsonRpcSocketFactory = () => {
      socket = {
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        send(data) {
          const request = JSON.parse(data) as {id: number}
          queueMicrotask(() => socket.onmessage?.(new MessageEvent('message', {
            data: JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              error: {code: -32603, message: 'internal details'},
            }),
          })))
        },
        close() {},
      }
      queueMicrotask(() => socket.onopen?.(new Event('open')))
      return socket
    }

    await expect(websocketJsonRpc(
      'wss://node.example',
      'ledger.getAccountBlockByHash',
      ['ab'.repeat(32)],
      {createSocket},
    )).rejects.toThrow('Zenon RPC error (-32603): ledger.getAccountBlockByHash')
  })

  it.each([
    {label: 'missing', jsonrpc: undefined},
    {label: 'mismatched', jsonrpc: '1.0'},
  ])('rejects a $label JSON-RPC version', async ({jsonrpc}) => {
    await expect(websocketJsonRpc(
      'wss://node.example',
      'ledger.getAccountBlockByHash',
      ['ab'.repeat(32)],
      {createSocket: resultSocket(rawBlock(), {jsonrpc})},
    )).rejects.toThrow('invalid JSON-RPC version')
  })

  it.each([
    {label: 'null', error: null},
    {label: 'primitive', error: 'internal details'},
  ])('rejects a response containing both result and a $label error', async ({error}) => {
    await expect(websocketJsonRpc(
      'wss://node.example',
      'ledger.getAccountBlockByHash',
      ['ab'.repeat(32)],
      {createSocket: resultSocket(rawBlock(), {error})},
    )).rejects.toThrow('exactly one of result or error')
  })

  it.each([
    {label: 'null', error: null},
    {label: 'primitive', error: 'internal details'},
  ])('rejects an error-only response with a $label error value', async ({error}) => {
    await expect(websocketJsonRpc(
      'wss://node.example',
      'ledger.getAccountBlockByHash',
      ['ab'.repeat(32)],
      {createSocket: resultSocket(undefined, {error})},
    )).rejects.toThrow('invalid error object')
  })
})
