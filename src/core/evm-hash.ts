export function stripEvmHashPrefix(hash: string): string {
  return hash.replace(/^0x/i, '').toLowerCase()
}

export function normalizeEvmHash(hash: string): string {
  return `0x${stripEvmHashPrefix(hash)}`
}
