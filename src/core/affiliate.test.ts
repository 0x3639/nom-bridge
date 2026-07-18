import {describe, expect, it} from 'vitest'
import {
  AFFILIATE_BONUS_BPS,
  AFFILIATE_LOG_INDEX_THRESHOLD,
  beneficiaryOf,
  isAffiliateBonusLogIndex,
  parseUnwrapBonusBps,
  selfReferralReceiver,
} from './affiliate'

const ACTIVE_METADATA = JSON.stringify({
  affiliateProgram: {
    networks: {'1': {startingHeight: 17678862, ZNN: true, QSR: true, wZNN: true, wQSR: true}},
  },
})

describe('parseUnwrapBonusBps', () => {
  it('returns 300 for ZNN when the wZNN flag is active', () => {
    expect(parseUnwrapBonusBps(ACTIVE_METADATA, 1, 'ZNN')).toBe(AFFILIATE_BONUS_BPS)
  })
  it('returns 300 for QSR when the wQSR flag is active', () => {
    expect(parseUnwrapBonusBps(ACTIVE_METADATA, 1, 'QSR')).toBe(AFFILIATE_BONUS_BPS)
  })
  it('returns 0 when the token flag is false', () => {
    const metadata = JSON.stringify({
      affiliateProgram: {networks: {'1': {startingHeight: 17678862, wZNN: false, wQSR: true}}},
    })
    expect(parseUnwrapBonusBps(metadata, 1, 'ZNN')).toBe(0)
  })
  it('returns 0 when startingHeight is 0 or missing', () => {
    const zeroHeight = JSON.stringify({
      affiliateProgram: {networks: {'1': {startingHeight: 0, wZNN: true}}},
    })
    expect(parseUnwrapBonusBps(zeroHeight, 1, 'ZNN')).toBe(0)
    const noHeight = JSON.stringify({affiliateProgram: {networks: {'1': {wZNN: true}}}})
    expect(parseUnwrapBonusBps(noHeight, 1, 'ZNN')).toBe(0)
  })
  it('returns 0 for a chain id with no entry', () => {
    expect(parseUnwrapBonusBps(ACTIVE_METADATA, 5, 'ZNN')).toBe(0)
  })
  it('returns 0 for an unknown base symbol', () => {
    expect(parseUnwrapBonusBps(ACTIVE_METADATA, 1, 'FOO')).toBe(0)
  })
  it('returns 0 for malformed, empty, null, or non-object metadata', () => {
    expect(parseUnwrapBonusBps('not json', 1, 'ZNN')).toBe(0)
    expect(parseUnwrapBonusBps('', 1, 'ZNN')).toBe(0)
    expect(parseUnwrapBonusBps(null, 1, 'ZNN')).toBe(0)
    expect(parseUnwrapBonusBps(undefined, 1, 'ZNN')).toBe(0)
    expect(parseUnwrapBonusBps('"just a string"', 1, 'ZNN')).toBe(0)
    expect(parseUnwrapBonusBps('{"affiliateProgram":{}}', 1, 'ZNN')).toBe(0)
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
