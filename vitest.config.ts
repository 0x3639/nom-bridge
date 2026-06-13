import {defineConfig} from 'vitest/config'
import {resolve} from 'path'

// Minimal test config for Phase 1 unit tests (pure logic only — no Vue render,
// no live node). The `@` alias mirrors vite.config.ts so `@/config` / `@/types`
// resolve in tests.
export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
