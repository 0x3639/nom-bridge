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
    exclude: ['**/node_modules/**', '**/*.integration.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      include: ['src/core/**/*.ts', 'src/config.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/core/index.ts',
        'src/core/composables/index.ts',
      ],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
})
