import {defineConfig} from 'vitest/config'
import {loadEnv} from 'vite'
import {resolve} from 'path'

// Opt-in integration config: talks to the real WalletConnect relay. Loads
// VITE_* vars from .env so the project id is available as process.env inside
// the test (the default unit config deliberately loads nothing).
export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    // DISABLE_GLOBAL_CORE: the dApp service and the fake-Syrius harness each
    // call SignClient.init() with no customStoragePrefix, so WalletConnect's
    // module-level global-core cache (keyed on that empty prefix) would merge
    // both into a single Core in this one Node process — the wallet's own
    // session_proposal listener never sees the dApp's proposal. Disabling it
    // gives each SignClient its own independent Core, matching two real
    // separate parties.
    env: {...loadEnv('', process.cwd(), 'VITE_'), DISABLE_GLOBAL_CORE: 'true'},
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
