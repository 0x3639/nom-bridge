import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// Partial-mock viem: keep the real parseAbi / UserRejectedRequestError / custom /
// http (so CHAIN selection and mapEvmError's instanceof check stay genuine), but
// swap the client factories for fakes we can drive.
const h = vi.hoisted(() => ({
  publicClient: {
    readContract: vi.fn(),
    getBlockNumber: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
    simulateContract: vi.fn(),
  },
  walletClient: {
    requestAddresses: vi.fn(),
    switchChain: vi.fn(),
    writeContract: vi.fn(),
    getChainId: vi.fn(),
  },
}))

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>()
  return {
    ...actual,
    createPublicClient: vi.fn(() => h.publicClient),
    createWalletClient: vi.fn(() => h.walletClient),
  }
})

beforeEach(() => {
  vi.resetModules()
  h.publicClient.readContract.mockReset()
  h.publicClient.getBlockNumber.mockReset()
  h.publicClient.waitForTransactionReceipt.mockReset()
  h.publicClient.simulateContract.mockReset().mockResolvedValue({request: {}})
  h.walletClient.requestAddresses.mockReset()
  h.walletClient.switchChain.mockReset()
  h.walletClient.writeContract.mockReset()
  h.walletClient.getChainId.mockReset().mockResolvedValue(1)
  // A present, minimal EIP-1193 provider for the wallet path.
  vi.stubGlobal('window', {ethereum: {request: vi.fn()}})
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('EvmService singleton', () => {
  it('getInstance returns the same instance', async () => {
    const {EvmService} = await import('./evm-service')
    expect(EvmService.getInstance()).toBe(EvmService.getInstance())
  })
})

describe('EvmService.connect', () => {
  it('returns the first account after requesting addresses and switching chain', async () => {
    h.walletClient.requestAddresses.mockResolvedValue(['0xAbC0000000000000000000000000000000000001'])
    h.walletClient.switchChain.mockResolvedValue(undefined)
    const {EvmService, CHAIN} = await import('./evm-service')

    const account = await EvmService.getInstance().connect()

    expect(account).toBe('0xAbC0000000000000000000000000000000000001')
    expect(h.walletClient.switchChain).toHaveBeenCalledWith({id: CHAIN.id})
  })

  it('throws a friendly "switch network" error when switchChain fails', async () => {
    h.walletClient.requestAddresses.mockResolvedValue(['0xabc'])
    h.walletClient.switchChain.mockRejectedValue(new Error('chain not added'))
    const {EvmService, CHAIN} = await import('./evm-service')

    await expect(EvmService.getInstance().connect()).rejects.toThrow(
      `Please switch MetaMask to ${CHAIN.name}`,
    )
  })

  it('throws "no wallet" when window.ethereum is absent', async () => {
    vi.stubGlobal('window', {})
    const {EvmService} = await import('./evm-service')

    await expect(EvmService.getInstance().connect()).rejects.toThrow(
      'No EVM wallet detected. Please install MetaMask.',
    )
  })
})

describe('EvmService.getBalance', () => {
  it('reads balanceOf(owner) on the token contract and returns the bigint', async () => {
    h.publicClient.readContract.mockResolvedValue(123456789n)
    const {EvmService} = await import('./evm-service')

    const token = '0xToken0000000000000000000000000000000001'
    const owner = '0xOwner0000000000000000000000000000000002'
    const balance = await EvmService.getInstance().getBalance(token, owner)

    expect(balance).toBe(123456789n)
    expect(h.publicClient.readContract).toHaveBeenCalledWith(
      expect.objectContaining({address: token, functionName: 'balanceOf', args: [owner]}),
    )
  })
})

describe('EvmService token and bridge metadata', () => {
  it('reads ERC-20 decimals and symbol', async () => {
    h.publicClient.readContract
      .mockResolvedValueOnce(18)
      .mockResolvedValueOnce('UNI-V2')
    const {EvmService} = await import('./evm-service')

    await expect(
      EvmService.getInstance().getTokenMetadata(
        '0xdac866a3796f85cb84a914d98faec052e3b5596d',
      ),
    ).resolves.toEqual({decimals: 18, symbol: 'UNI-V2'})
  })

  it('decodes all five deployed tokensInfo fields', async () => {
    h.publicClient.readContract.mockResolvedValue([100n, 90n, true, false, true])
    const {EvmService} = await import('./evm-service')

    await expect(
      EvmService.getInstance().getTokenInfo(
        '0xa98706106f7710d743186031be2245f33acea106',
        '0xdac866a3796f85cb84a914d98faec052e3b5596d',
      ),
    ).resolves.toEqual({
      minAmount: 100n,
      redeemDelay: 90,
      bridgeable: true,
      redeemable: false,
      owned: true,
    })
  })
})

describe('tssSignatureToHex', () => {
  it('converts a 65-byte base64 sig with final byte 0x00 → 0x…1b', async () => {
    const {tssSignatureToHex} = await import('./evm-service')
    const bytes = new Uint8Array(65)
    bytes.fill(0xab, 0, 64)
    bytes[64] = 0x00
    const b64 = Buffer.from(bytes).toString('base64')
    const hex = tssSignatureToHex(b64)
    expect(hex.startsWith('0x')).toBe(true)
    expect(hex.length).toBe(132)
    expect(hex.endsWith('1b')).toBe(true)
  })

  it('final byte 0x01 → 0x…1c (with 0x prefix and 132-char length)', async () => {
    const {tssSignatureToHex} = await import('./evm-service')
    const bytes = new Uint8Array(65)
    bytes[64] = 0x01
    const b64 = Buffer.from(bytes).toString('base64')
    const hex = tssSignatureToHex(b64)
    expect(hex.startsWith('0x')).toBe(true)
    expect(hex.length).toBe(132)
    expect(hex.endsWith('1c')).toBe(true)
  })

  it('matches a known exact-hex fixture (r/s preserved, v=0 → 0x1b)', async () => {
    const {tssSignatureToHex} = await import('./evm-service')
    // r = 0x01..(32 bytes), s = 0x02..(32 bytes), v byte = 0x00 → 0x1b
    const bytes = new Uint8Array(65)
    bytes.fill(0x01, 0, 32)
    bytes.fill(0x02, 32, 64)
    bytes[64] = 0x00
    const b64 = Buffer.from(bytes).toString('base64')
    const expected =
      '0x' + '01'.repeat(32) + '02'.repeat(32) + '1b'
    expect(tssSignatureToHex(b64)).toBe(expected)
  })

  it('rejects malformed length and recovery bytes', async () => {
    const {tssSignatureToHex} = await import('./evm-service')
    expect(() => tssSignatureToHex(Buffer.from(new Uint8Array(64)).toString('base64'))).toThrow(
      'signature length',
    )
    const bytes = new Uint8Array(65)
    bytes[64] = 2
    expect(() => tssSignatureToHex(Buffer.from(bytes).toString('base64'))).toThrow(
      'recovery byte',
    )
  })
})

describe('computeRemainingSeconds', () => {
  it('delay not elapsed → positive seconds including the +1 safety block', async () => {
    const {computeRemainingSeconds} = await import('./evm-service')
    // redeemDelay=10, elapsed=2 → remainingBlocks = 10-2+1 = 9; *3s = 27
    expect(computeRemainingSeconds(100n, 102n, 10, 3n)).toBe(27)
  })

  it('exactly at delay still has the +1 block remaining', async () => {
    const {computeRemainingSeconds} = await import('./evm-service')
    // elapsed=10 → 10-10+1 = 1; *3 = 3
    expect(computeRemainingSeconds(100n, 110n, 10, 3n)).toBe(3)
  })

  it('exactly at the zero-crossing (elapsed == delay+1) → 0', async () => {
    const {computeRemainingSeconds} = await import('./evm-service')
    // elapsed=11 → 10-11+1 = 0; *3 = 0 (the boundary where the +1 block is consumed)
    expect(computeRemainingSeconds(100n, 111n, 10, 3n)).toBe(0)
  })

  it('one block before the zero-crossing (elapsed == delay) → blockTime seconds', async () => {
    const {computeRemainingSeconds} = await import('./evm-service')
    // elapsed=10 → 10-10+1 = 1; *3 = 3 (last non-zero step before redeemable-2)
    expect(computeRemainingSeconds(100n, 110n, 10, 3n)).toBe(3)
  })

  it('elapsed past delay floors to 0 via max(0,…)', async () => {
    const {computeRemainingSeconds} = await import('./evm-service')
    // elapsed=20 → 10-20+1 = -9 → 0
    expect(computeRemainingSeconds(100n, 120n, 10, 3n)).toBe(0)
  })

  it('scales remaining blocks by estimatedBlockTime', async () => {
    const {computeRemainingSeconds} = await import('./evm-service')
    // remainingBlocks = 5-0+1 = 6; *12 = 72
    expect(computeRemainingSeconds(100n, 100n, 5, 12n)).toBe(72)
  })
})

describe('EvmService.getWrapRedeemProgress', () => {
  const bridge = '0xBridge00000000000000000000000000000000' as const
  const token = '0xToken000000000000000000000000000000001' as const
  const id = '0x00' as const

  it('UINT256_MAX blockNumber → fully-redeemed with a single read', async () => {
    const {EvmService, UINT256_MAX} = await import('./evm-service')
    h.publicClient.readContract.mockResolvedValueOnce([UINT256_MAX, '0x0'])
    const progress = await EvmService.getInstance().getWrapRedeemProgress(bridge, token, id)
    expect(progress).toEqual({kind: 'fully-redeemed'})
    expect(h.publicClient.readContract).toHaveBeenCalledTimes(1)
  })

  it('blockNumber 0 → unredeemed with a single read', async () => {
    const {EvmService} = await import('./evm-service')
    h.publicClient.readContract.mockResolvedValueOnce([0n, '0x0'])
    const progress = await EvmService.getInstance().getWrapRedeemProgress(bridge, token, id)
    expect(progress).toEqual({kind: 'unredeemed'})
    expect(h.publicClient.readContract).toHaveBeenCalledTimes(1)
  })

  it('0 < blockNumber < max → waiting-delay with computed remainingSeconds', async () => {
    const {EvmService} = await import('./evm-service')
    h.publicClient.readContract
      .mockResolvedValueOnce([100n, '0x0']) // redeemsInfo.blockNumber
      .mockResolvedValueOnce(3n) // estimatedBlockTime
      .mockResolvedValueOnce([0n, 10n, true, true, false]) // tokensInfo → redeemDelay=10
    h.publicClient.getBlockNumber.mockResolvedValue(102n)
    const progress = await EvmService.getInstance().getWrapRedeemProgress(bridge, token, id)
    // remainingBlocks = 10-2+1 = 9; *3 = 27
    expect(progress).toEqual({kind: 'waiting-delay', remainingSeconds: 27})
  })
})

describe('selectProvisionalLogIndex', () => {
  const account = '0x52908400098527886E0F7030069857D2E4169EE7'
  const zenon = 'z1qztestrecipient'

  it('empty logs → null', async () => {
    const {selectProvisionalLogIndex} = await import('./evm-service')
    expect(selectProvisionalLogIndex([], account, zenon)).toBeNull()
  })

  it('matches from (checksum-insensitive) + exact to, returns that logIndex', async () => {
    const {selectProvisionalLogIndex} = await import('./evm-service')
    const logs = [
      {logIndex: 7, args: {from: account.toLowerCase(), to: zenon}},
    ]
    expect(selectProvisionalLogIndex(logs, account, zenon)).toBe(7)
  })

  it('multiple logs picks the matching one', async () => {
    const {selectProvisionalLogIndex} = await import('./evm-service')
    const logs = [
      {logIndex: 1, args: {from: '0x0000000000000000000000000000000000000099', to: zenon}},
      {logIndex: 2, args: {from: account, to: 'z1qother'}},
      {logIndex: 3, args: {from: account, to: zenon}},
    ]
    expect(selectProvisionalLogIndex(logs, account, zenon)).toBe(3)
  })

  it('no match → null', async () => {
    const {selectProvisionalLogIndex} = await import('./evm-service')
    const logs = [
      {logIndex: 5, args: {from: account, to: 'z1qsomeoneelse'}},
      {logIndex: 6, args: {from: '0x0000000000000000000000000000000000000099', to: zenon}},
    ]
    expect(selectProvisionalLogIndex(logs, account, zenon)).toBeNull()
  })

  it('malformed from does not throw, treated as no-match', async () => {
    const {selectProvisionalLogIndex} = await import('./evm-service')
    const logs = [{logIndex: 9, args: {from: 'not-an-address', to: zenon}}]
    expect(() => selectProvisionalLogIndex(logs, account, zenon)).not.toThrow()
    expect(selectProvisionalLogIndex(logs, account, zenon)).toBeNull()
  })

  it('missing from is guarded (no throw), treated as no-match → null', async () => {
    const {selectProvisionalLogIndex} = await import('./evm-service')
    const logs = [{logIndex: 4, args: {to: zenon}}]
    expect(() => selectProvisionalLogIndex(logs, account, zenon)).not.toThrow()
    expect(selectProvisionalLogIndex(logs, account, zenon)).toBeNull()
  })

  it('matching from but non-matching to is rejected (both must match)', async () => {
    // Same account, but the `to` is a different Zenon recipient than the one we
    // unwrapped to → must NOT match.
    const {selectProvisionalLogIndex} = await import('./evm-service')
    const logs = [
      {logIndex: 2, args: {from: account, to: 'z1qdifferentrecipient'}},
    ]
    expect(selectProvisionalLogIndex(logs, account, zenon)).toBeNull()
  })
})

describe('EvmService.ensureAllowance', () => {
  const token = '0xToken0000000000000000000000000000000001' as const
  const bridge = '0xBridge00000000000000000000000000000000' as const

  it('does NOT approve when allowance >= amount', async () => {
    h.walletClient.requestAddresses.mockResolvedValue(['0xOwner000000000000000000000000000000001'])
    h.publicClient.readContract.mockResolvedValue(1000n)
    const {EvmService} = await import('./evm-service')

    await EvmService.getInstance().ensureAllowance(token, bridge, 500n)

    expect(h.walletClient.writeContract).not.toHaveBeenCalled()
    expect(h.publicClient.waitForTransactionReceipt).not.toHaveBeenCalled()
  })

  it('does NOT approve at the boundary allowance === amount', async () => {
    h.walletClient.requestAddresses.mockResolvedValue(['0xOwner000000000000000000000000000000001'])
    h.publicClient.readContract.mockResolvedValue(500n)
    const {EvmService} = await import('./evm-service')

    await EvmService.getInstance().ensureAllowance(token, bridge, 500n)

    expect(h.walletClient.writeContract).not.toHaveBeenCalled()
    expect(h.publicClient.waitForTransactionReceipt).not.toHaveBeenCalled()
  })

  it('approves and awaits the receipt when allowance < amount', async () => {
    h.walletClient.requestAddresses.mockResolvedValue(['0xOwner000000000000000000000000000000001'])
    h.publicClient.readContract.mockResolvedValue(100n)
    h.publicClient.simulateContract.mockResolvedValue({request: {simulated: 'approve'}})
    h.walletClient.writeContract.mockResolvedValue('0xapprovetx')
    h.publicClient.waitForTransactionReceipt.mockResolvedValue({status: 'success'})
    const {EvmService} = await import('./evm-service')

    await EvmService.getInstance().ensureAllowance(token, bridge, 500n)

    expect(h.publicClient.simulateContract).toHaveBeenCalledWith(
      expect.objectContaining({address: token, functionName: 'approve', args: [bridge, 500n]}),
    )
    expect(h.walletClient.writeContract).toHaveBeenCalledWith({simulated: 'approve'})
    expect(h.publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({hash: '0xapprovetx'})
  })

  it('rejects writes when the wallet changed to another chain', async () => {
    h.walletClient.requestAddresses.mockResolvedValue(['0xOwner000000000000000000000000000000001'])
    h.walletClient.getChainId.mockResolvedValue(10)
    const {EvmService} = await import('./evm-service')

    await expect(EvmService.getInstance().ensureAllowance(token, bridge, 500n)).rejects.toThrow(
      'Please switch MetaMask',
    )
    expect(h.publicClient.readContract).not.toHaveBeenCalled()
  })
})

describe('EvmService write verification', () => {
  const bridge = '0xa98706106f7710d743186031be2245f33acea106' as const
  const token = '0xb2e96a63479c2edd2fd62b382c89d5ca79f572d3' as const
  const account = '0x52908400098527886E0F7030069857D2E4169EE7' as const

  it('simulates unwrap and preserves a confirmed hash when event recovery is needed', async () => {
    h.walletClient.requestAddresses.mockResolvedValue([account])
    h.publicClient.simulateContract.mockResolvedValue({request: {simulated: 'unwrap'}})
    h.walletClient.writeContract.mockResolvedValue('0xunwraptx')
    h.publicClient.waitForTransactionReceipt.mockResolvedValue({status: 'success', logs: []})
    const {EvmService} = await import('./evm-service')

    await expect(
      EvmService.getInstance().unwrap(bridge, token, 100n, 'z1recipient'),
    ).resolves.toEqual({hash: '0xunwraptx', provisionalLogIndex: -1, eventMatched: false})
    expect(h.walletClient.writeContract).toHaveBeenCalledWith({simulated: 'unwrap'})
  })

  it('rejects a reverted unwrap receipt', async () => {
    h.walletClient.requestAddresses.mockResolvedValue([account])
    h.publicClient.simulateContract.mockResolvedValue({request: {simulated: 'unwrap'}})
    h.walletClient.writeContract.mockResolvedValue('0xunwraptx')
    h.publicClient.waitForTransactionReceipt.mockResolvedValue({status: 'reverted', logs: []})
    const {EvmService} = await import('./evm-service')

    await expect(
      EvmService.getInstance().unwrap(bridge, token, 100n, 'z1recipient'),
    ).rejects.toThrow('Unwrap transaction reverted')
  })

  it('simulates redeem and returns only after a successful receipt', async () => {
    h.walletClient.requestAddresses.mockResolvedValue([account])
    h.publicClient.simulateContract.mockResolvedValue({request: {simulated: 'redeem'}})
    h.walletClient.writeContract.mockResolvedValue('0xredeemtx')
    h.publicClient.waitForTransactionReceipt.mockResolvedValue({status: 'success'})
    const {EvmService} = await import('./evm-service')

    await expect(
      EvmService.getInstance().redeem(bridge, account, token, 100n, 1n, '0x1234'),
    ).resolves.toBe('0xredeemtx')
    expect(h.walletClient.writeContract).toHaveBeenCalledWith({simulated: 'redeem'})
  })
})
