import {describe, expect, it} from 'vitest'
import {UserRejectedRequestError} from 'viem'
import {mainnet, sepolia} from 'viem/chains'
import {mapWcError} from '../zenon-wallet-service'
import {mapEvmError, CHAIN} from '../evm-service'
import {config, ZENON_CHAIN} from '@/config'

describe('mapWcError', () => {
  it('maps a 5000-range code to a wallet-rejection message', () => {
    expect(mapWcError({code: 5000}).message).toBe('Request rejected in the wallet')
  })

  it('passes a plain Error through unchanged', () => {
    const e = new Error('boom')
    expect(mapWcError(e)).toBe(e)
  })

  it('falls back to a generic message for a non-error, non-rejection value', () => {
    expect(mapWcError('nope').message).toBe('WalletConnect request failed')
  })

  it('treats code 5999 (upper bound) as a rejection', () => {
    expect(mapWcError({code: 5999}).message).toBe('Request rejected in the wallet')
  })

  it('does NOT treat code 6000 (disconnect) as a rejection', () => {
    // 6000 is the WC disconnect reason code, not a user rejection.
    expect(mapWcError({code: 6000}).message).toBe('WalletConnect request failed')
  })

  it('passes a non-5000 coded Error through unchanged', () => {
    const e = Object.assign(new Error('rpc failed'), {code: 4001})
    expect(mapWcError(e)).toBe(e)
  })
})

describe('mapEvmError', () => {
  it('maps a UserRejectedRequestError to a MetaMask-rejection message', () => {
    const e = new UserRejectedRequestError(new Error('x'))
    expect(mapEvmError(e).message).toBe('Request rejected in MetaMask')
  })

  it('passes a plain Error through unchanged', () => {
    const e = new Error('boom')
    expect(mapEvmError(e)).toBe(e)
  })

  it('falls back to a generic message for a non-error value', () => {
    expect(mapEvmError('nope').message).toBe('EVM request failed')
  })

  it('passes the "switch network" Error through unchanged (not a UserRejected)', () => {
    // EvmService.connect re-throws this from switchChain; mapEvmError must not rewrite it.
    const e = new Error('Please switch MetaMask to Sepolia')
    expect(mapEvmError(e)).toBe(e)
  })
})

describe('config-driven chain selection', () => {
  it('ZENON_CHAIN derives from config.zenonChainId', () => {
    expect(ZENON_CHAIN).toBe(`zenon:${config.zenonChainId}`)
  })

  it('EVM CHAIN matches mainnet/sepolia for config.evmChainId', () => {
    const expected = config.evmChainId === mainnet.id ? mainnet : sepolia
    expect(CHAIN.id).toBe(expected.id)
  })
})
