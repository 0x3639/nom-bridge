import {addNumberDecimals} from 'znn-typescript-sdk'
import {config} from '@/config'

export function formatAmount(base: bigint, decimals: number): string {
  return addNumberDecimals(base.toString(), decimals)
}

export function formatCountdown(totalSeconds: number): string {
  const total = Math.floor(totalSeconds)
  if (total <= 0) return 'Ready'
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const parts: string[] = []
  if (h > 0) parts.push(`${h}h`)
  if (m > 0) parts.push(`${m}m`)
  if (s > 0 || parts.length === 0) parts.push(`${s}s`)
  return parts.join(' ')
}

export function truncateAddress(a: string, lead = 6, tail = 4): string {
  if (a.length <= lead + tail) return a
  return `${a.slice(0, lead)}…${a.slice(-tail)}`
}

export function evmTxUrl(hash: string): string {
  return config.evmExplorerTxUrl + hash
}

export function zenonTxUrl(hash: string): string {
  return config.zenonExplorerTxUrl + hash
}
