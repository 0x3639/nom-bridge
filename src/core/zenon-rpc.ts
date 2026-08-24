import {Address, TokenStandard} from 'znn-typescript-sdk'

const DEFAULT_RPC_TIMEOUT_MS = 8_000
export const MIN_ZENON_RPC_CORROBORATIONS = 2

interface JsonRpcSocket {
  onopen: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  onerror: ((event: Event) => void) | null
  onclose: ((event: CloseEvent) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}

export type JsonRpcSocketFactory = (url: string) => JsonRpcSocket

export interface JsonRpcOptions {
  timeoutMs?: number
  createSocket?: JsonRpcSocketFactory
}

interface ZenonRpcConfirmationDetail {
  numConfirmations: number
  momentumHeight: number
  momentumHash: string
  momentumTimestamp: number
}

export interface ZenonRpcAccountBlock {
  chainIdentifier: number
  blockType: number
  hash: string
  height: number
  address: string
  toAddress: string
  amount: string
  tokenStandard: string
  data: string
  confirmationDetail: ZenonRpcConfirmationDetail | null
}

let nextRequestId = 0

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function parseConfirmationDetail(value: unknown): ZenonRpcConfirmationDetail | null {
  if (value === null || value === undefined) return null
  if (!isRecord(value)) throw new Error('Invalid Zenon RPC confirmation detail')
  if (
    !isSafeNonNegativeInteger(value.numConfirmations) ||
    !isSafeNonNegativeInteger(value.momentumHeight) ||
    typeof value.momentumHash !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(value.momentumHash) ||
    !isSafeNonNegativeInteger(value.momentumTimestamp)
  ) {
    throw new Error('Invalid Zenon RPC confirmation detail')
  }
  return {
    numConfirmations: value.numConfirmations,
    momentumHeight: value.momentumHeight,
    momentumHash: value.momentumHash.toLowerCase(),
    momentumTimestamp: value.momentumTimestamp,
  }
}

export function parseZenonRpcAccountBlock(value: unknown): ZenonRpcAccountBlock {
  if (!isRecord(value)) throw new Error('Invalid Zenon RPC account block')
  if (
    !isSafeNonNegativeInteger(value.chainIdentifier) ||
    !isSafeNonNegativeInteger(value.blockType) ||
    typeof value.hash !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(value.hash) ||
    !isSafeNonNegativeInteger(value.height) ||
    typeof value.address !== 'string' ||
    typeof value.toAddress !== 'string' ||
    typeof value.amount !== 'string' ||
    !/^\d+$/.test(value.amount) ||
    typeof value.tokenStandard !== 'string' ||
    typeof value.data !== 'string'
  ) {
    throw new Error('Invalid Zenon RPC account block')
  }
  let address: string
  let toAddress: string
  let tokenStandard: string
  try {
    address = Address.parse(value.address).toString()
    toAddress = Address.parse(value.toAddress).toString()
    tokenStandard = TokenStandard.parse(value.tokenStandard).toString()
  } catch {
    throw new Error('Invalid Zenon RPC account block')
  }
  return {
    chainIdentifier: value.chainIdentifier,
    blockType: value.blockType,
    hash: value.hash.toLowerCase(),
    height: value.height,
    address,
    toAddress,
    amount: value.amount,
    tokenStandard,
    data: value.data,
    confirmationDetail: parseConfirmationDetail(value.confirmationDetail),
  }
}

export function websocketJsonRpc<T>(
  url: string,
  method: string,
  params: unknown[],
  options: JsonRpcOptions = {},
): Promise<T> {
  const requestId = ++nextRequestId
  const timeoutMs = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS
  const createSocket = options.createSocket ?? (socketUrl => new WebSocket(socketUrl))

  return new Promise<T>((resolve, reject) => {
    let settled = false
    let socket: JsonRpcSocket

    const cleanup = () => {
      clearTimeout(timer)
      socket.onopen = null
      socket.onmessage = null
      socket.onerror = null
      socket.onclose = null
      try {
        socket.close(1000, 'request complete')
      } catch {
        // The response has already settled; closing is best effort.
      }
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const succeed = (result: T) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }

    try {
      socket = createSocket(url)
    } catch (error) {
      reject(error)
      return
    }

    const timer = setTimeout(
      () => fail(new Error(`Zenon RPC request timed out: ${method}`)),
      timeoutMs,
    )
    socket.onopen = () => {
      try {
        socket.send(JSON.stringify({jsonrpc: '2.0', id: requestId, method, params}))
      } catch (error) {
        fail(error instanceof Error ? error : new Error('Zenon RPC send failed'))
      }
    }
    socket.onmessage = event => {
      if (typeof event.data !== 'string') {
        fail(new Error('Zenon RPC returned a non-text response'))
        return
      }
      let response: unknown
      try {
        response = JSON.parse(event.data)
      } catch {
        fail(new Error('Zenon RPC returned invalid JSON'))
        return
      }
      if (!isRecord(response) || response.id !== requestId) return
      if (response.jsonrpc !== '2.0') {
        fail(new Error('Zenon RPC returned an invalid JSON-RPC version'))
        return
      }
      if (isRecord(response.error)) {
        const code = typeof response.error.code === 'number' ? ` (${response.error.code})` : ''
        fail(new Error(`Zenon RPC error${code}: ${method}`))
        return
      }
      if (!Object.prototype.hasOwnProperty.call(response, 'result')) {
        fail(new Error('Zenon RPC response has no result'))
        return
      }
      succeed(response.result as T)
    }
    socket.onerror = () => fail(new Error(`Zenon RPC connection failed: ${method}`))
    socket.onclose = () => fail(new Error(`Zenon RPC connection closed: ${method}`))
  })
}

export async function getZenonRpcFrontierHeight(
  url: string,
  address: string,
  options: JsonRpcOptions = {},
): Promise<number> {
  const canonicalAddress = Address.parse(address).toString()
  const response = await websocketJsonRpc<unknown>(
    url,
    'ledger.getFrontierAccountBlock',
    [canonicalAddress],
    options,
  )
  if (response === null) return 0
  const block = parseZenonRpcAccountBlock(response)
  if (block.address !== canonicalAddress) {
    throw new Error('Zenon RPC returned the wrong account frontier')
  }
  return block.height
}

export async function getZenonRpcAccountBlock(
  url: string,
  hash: string,
  options: JsonRpcOptions = {},
): Promise<ZenonRpcAccountBlock | null> {
  const response = await websocketJsonRpc<unknown>(
    url,
    'ledger.getAccountBlockByHash',
    [hash],
    options,
  )
  if (response === null) return null
  const block = parseZenonRpcAccountBlock(response)
  if (block.hash !== hash.toLowerCase()) throw new Error('Zenon RPC returned the wrong account block')
  return block
}
