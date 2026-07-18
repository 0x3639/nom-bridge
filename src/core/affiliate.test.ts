import {describe, expect, it} from 'vitest'
import {
  AFFILIATE_BONUS_BPS,
  AFFILIATE_LOG_INDEX_THRESHOLD,
  beneficiaryOf,
  isAffiliateBonusLogIndex,
  parseUnwrapBonusBps,
  selfReferralPayout,
  selfReferralReceiver,
} from './affiliate'

const ACTIVE_METADATA = JSON.stringify({
  affiliateProgram: {
    networks: {'1': {startingHeight: 17678862, ZNN: true, QSR: true, wZNN: true, wQSR: true}},
  },
})

const CURRENT_BLOCK = 23_000_000n

describe('parseUnwrapBonusBps', () => {
  it('returns 300 for ZNN when the wZNN flag is active', () => {
    expect(parseUnwrapBonusBps(ACTIVE_METADATA, 1, 'ZNN', CURRENT_BLOCK)).toBe(AFFILIATE_BONUS_BPS)
  })
  it('returns 300 for QSR when the wQSR flag is active', () => {
    expect(parseUnwrapBonusBps(ACTIVE_METADATA, 1, 'QSR', CURRENT_BLOCK)).toBe(AFFILIATE_BONUS_BPS)
  })
  it('returns 0 when the token flag is false', () => {
    const metadata = JSON.stringify({
      affiliateProgram: {networks: {'1': {startingHeight: 17678862, wZNN: false, wQSR: true}}},
    })
    expect(parseUnwrapBonusBps(metadata, 1, 'ZNN', CURRENT_BLOCK)).toBe(0)
  })
  it('returns 0 when startingHeight is 0 or missing', () => {
    const zeroHeight = JSON.stringify({
      affiliateProgram: {networks: {'1': {startingHeight: 0, wZNN: true}}},
    })
    expect(parseUnwrapBonusBps(zeroHeight, 1, 'ZNN', CURRENT_BLOCK)).toBe(0)
    const noHeight = JSON.stringify({affiliateProgram: {networks: {'1': {wZNN: true}}}})
    expect(parseUnwrapBonusBps(noHeight, 1, 'ZNN', CURRENT_BLOCK)).toBe(0)
  })
  it('returns 0 before the program activates (currentBlock < startingHeight)', () => {
    expect(parseUnwrapBonusBps(ACTIVE_METADATA, 1, 'ZNN', 17678861n)).toBe(0)
  })
  it('returns 300 exactly at activation (currentBlock === startingHeight)', () => {
    expect(parseUnwrapBonusBps(ACTIVE_METADATA, 1, 'ZNN', 17678862n)).toBe(AFFILIATE_BONUS_BPS)
  })
  it('returns 0 when the current block is unknown (fail-closed)', () => {
    expect(parseUnwrapBonusBps(ACTIVE_METADATA, 1, 'ZNN', null)).toBe(0)
  })
  it('returns 0 for a non-safe-integer startingHeight', () => {
    const huge = JSON.stringify({
      affiliateProgram: {networks: {'1': {startingHeight: 2 ** 53, wZNN: true}}},
    })
    expect(parseUnwrapBonusBps(huge, 1, 'ZNN', CURRENT_BLOCK)).toBe(0)
    const fractional = JSON.stringify({
      affiliateProgram: {networks: {'1': {startingHeight: 17678862.5, wZNN: true}}},
    })
    expect(parseUnwrapBonusBps(fractional, 1, 'ZNN', CURRENT_BLOCK)).toBe(0)
  })
  it('returns 0 for a chain id with no entry', () => {
    expect(parseUnwrapBonusBps(ACTIVE_METADATA, 5, 'ZNN', CURRENT_BLOCK)).toBe(0)
  })
  it('returns 0 for an unknown base symbol', () => {
    expect(parseUnwrapBonusBps(ACTIVE_METADATA, 1, 'FOO', CURRENT_BLOCK)).toBe(0)
  })
  it('returns 0 for malformed, empty, null, or non-object metadata', () => {
    expect(parseUnwrapBonusBps('not json', 1, 'ZNN', CURRENT_BLOCK)).toBe(0)
    expect(parseUnwrapBonusBps('', 1, 'ZNN', CURRENT_BLOCK)).toBe(0)
    expect(parseUnwrapBonusBps(null, 1, 'ZNN', CURRENT_BLOCK)).toBe(0)
    expect(parseUnwrapBonusBps(undefined, 1, 'ZNN', CURRENT_BLOCK)).toBe(0)
    expect(parseUnwrapBonusBps('"just a string"', 1, 'ZNN', CURRENT_BLOCK)).toBe(0)
    expect(parseUnwrapBonusBps('{"affiliateProgram":{}}', 1, 'ZNN', CURRENT_BLOCK)).toBe(0)
  })
})

describe('selfReferralPayout', () => {
  it('mirrors the orchestrator: floor(1%) + floor(2%) applied independently', () => {
    // 67: floor(0.67) + floor(1.34) = 0 + 1 — a single floor(3%) would give 2.
    expect(selfReferralPayout(67n)).toBe(68n)
    // 134: floor(1.34) + floor(2.68) = 1 + 2
    expect(selfReferralPayout(134n)).toBe(137n)
    // 10034: floor(100.34) + floor(200.68) = 100 + 200 — single floor(3%) gives 301.
    expect(selfReferralPayout(10_034n)).toBe(10_334n)
    // 10067: floor(100.67) + floor(201.34) = 100 + 201
    expect(selfReferralPayout(10_067n)).toBe(10_368n)
  })
  it('exact multiples of 100 receive the full 3%', () => {
    expect(selfReferralPayout(100n)).toBe(103n)
    expect(selfReferralPayout(0n)).toBe(0n)
  })
})

describe('selfReferralReceiver / beneficiaryOf', () => {
  const addr = 'z1qqjnwjjpnue8xmmpanz6csze6tcmtzzdtfsww7'
  it('builds addr&addr', () => {
    expect(selfReferralReceiver(addr)).toBe(`${addr}&${addr}`)
  })
  it('beneficiaryOf extracts the part before the first &', () => {
    expect(beneficiaryOf(`${addr}&${addr}`)).toBe(addr)
    expect(beneficiaryOf(addr)).toBe(addr)
    expect(beneficiaryOf(`${addr}&other&extra`)).toBe(addr)
    expect(beneficiaryOf('')).toBe('')
  })
})

describe('isAffiliateBonusLogIndex', () => {
  it('threshold boundary', () => {
    expect(isAffiliateBonusLogIndex(AFFILIATE_LOG_INDEX_THRESHOLD)).toBe(true)
    expect(isAffiliateBonusLogIndex(AFFILIATE_LOG_INDEX_THRESHOLD - 1)).toBe(false)
    expect(isAffiliateBonusLogIndex(0)).toBe(false)
    expect(isAffiliateBonusLogIndex(-1)).toBe(false)
  })
})
