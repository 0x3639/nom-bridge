import {readFileSync} from 'node:fs'
import {createFakeSyrius, FAKE_SYRIUS_ADDRESS} from '../src/testing/fake-syrius-core'

function readProjectId(): string {
  if (process.env.VITE_WC_PROJECT_ID) return process.env.VITE_WC_PROJECT_ID
  try {
    const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
    const match = env.match(/^VITE_WC_PROJECT_ID=(.+)$/m)
    if (match) return match[1].trim()
  } catch {
    // no .env — fall through
  }
  return ''
}

const args = process.argv.slice(2)
const flags = {
  reject: args.includes('--reject'),
  locked: args.includes('--locked'),
  hang: args.includes('--hang'),
  badState: args.includes('--bad-state'),
}
const uri = args.find(a => a.startsWith('wc:'))

if (!uri) {
  console.error('Usage: npm run fake-wallet -- "<wc:… uri>" [--reject|--locked|--hang|--bad-state]')
  console.error('Copy the URI from the WalletConnect modal (QR screen → copy button).')
  process.exit(1)
}

const projectId = readProjectId()
if (!projectId || projectId === 'REPLACE_ME_WC_PROJECT_ID') {
  console.error('Set VITE_WC_PROJECT_ID in .env first.')
  process.exit(1)
}

const wallet = await createFakeSyrius({projectId, ...flags})
console.log(`[fake-syrius] acting as ${FAKE_SYRIUS_ADDRESS}`)
console.log('[fake-syrius] flags:', JSON.stringify(flags))
await wallet.pair(uri)
console.log('[fake-syrius] pairing initiated — leave this running; Ctrl-C to quit')
await new Promise(() => {}) // keep the relay connection alive
