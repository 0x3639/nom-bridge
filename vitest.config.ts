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
    // The heavier async composable suites can exceed vitest's 5s default on
    // loaded CI runners, and a timed-out test leaks unfinished async work
    // into the next one. 10s keeps full parallel runs deterministic.
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      include: ['src/core/**/*.ts', 'src/config.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/core/index.ts',
        'src/core/composables/index.ts',
      ],
      // Two-level gate. The aggregate thresholds sit ~5 points below current
      // coverage so unrelated PRs don't flip CI red and invite threshold
      // lowering. The per-file floors are the real safety gate: they pin the
      // funds-critical modules at (just under) their current coverage so none
      // of them can silently regress behind a passing aggregate.
      // KNOWN DEBT: useRequests.ts (the poll/reconciliation loop) is only
      // ~18% statement-covered — its floor documents that gap rather than
      // hiding it; raise the floor as poll tests land.
      thresholds: {
        statements: 75,
        branches: 85,
        functions: 80,
        lines: 75,
        'src/config.ts': {statements: 100, branches: 100, functions: 100, lines: 100},
        'src/core/amount.ts': {statements: 100, branches: 100, functions: 100, lines: 100},
        'src/core/approval-ux.ts': {statements: 100, branches: 100, functions: 100, lines: 100},
        'src/core/evm-hash.ts': {statements: 100, branches: 100, functions: 100, lines: 100},
        'src/core/zenon-rpc.ts': {statements: 90, branches: 70, functions: 80, lines: 90},
        'src/core/wc-reliability.ts': {statements: 100, branches: 100, functions: 100, lines: 100},
        'src/core/request-store.ts': {statements: 95, branches: 80, functions: 90, lines: 95},
        'src/core/evm-service.ts': {statements: 90, branches: 85, functions: 90, lines: 90},
        'src/core/zenon-wallet-service.ts': {statements: 95, branches: 90, functions: 95, lines: 95},
        'src/core/composables/useUnwrap.ts': {statements: 88, branches: 85, functions: 60, lines: 88},
        'src/core/composables/useWrap.ts': {statements: 88, branches: 85, functions: 70, lines: 88},
        'src/core/composables/useRequests.ts': {statements: 15, branches: 90, functions: 35, lines: 15},
        'src/core/bridge-service.ts': {statements: 60, branches: 75, functions: 60, lines: 60},
        'src/core/zenon-service.ts': {statements: 70, branches: 60, functions: 80, lines: 70},
        'src/core/composables/useBridge.ts': {statements: 90, branches: 75, functions: 95, lines: 90},
      },
    },
  },
})
