import {extractNumberDecimals} from 'znn-typescript-sdk'

export function parseAmount(value: string | number, decimals: number): bigint {
  // Out-of-range integers may already have lost precision before this
  // function receives them. Require a string for those values so the caller's
  // exact decimal representation is preserved.
  if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw new Error('Enter large amounts as a decimal string')
  }
  const normalized = value.toString().trim()
  const match = normalized.match(/^\d+(?:\.(\d+))?$/)
  if (!match) throw new Error('Enter a positive decimal amount')
  if ((match[1]?.length ?? 0) > decimals) {
    throw new Error(`Amount supports at most ${decimals} decimal places`)
  }
  const amount = BigInt(extractNumberDecimals(normalized, decimals).toString())
  if (amount <= 0n) throw new Error('Enter a positive decimal amount')
  return amount
}
