# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm run dev        # Vite dev server
npm run build      # production build (outputs dist/)
npm run lint       # ESLint for TypeScript and Vue files
npm run typecheck  # vue-tsc --noEmit
npm run test       # vitest run (all tests)
npm run test:coverage  # unit tests + enforced core coverage thresholds
npm run test:security  # fail on high/critical npm advisories
npm run check      # lint + typecheck + coverage + production build
npx vitest run src/core/amount.test.ts   # single test file
npx vitest run -t "test name"            # single test by name
npm run fake-wallet -- "<wc-uri>" [--reject|--locked|--hang|--bad-state]  # headless Syrius stand-in
npm run test:integration  # live-relay WC test; skips without VITE_WC_PROJECT_ID
```

Setup: copy `.env.example` to `.env` and set `VITE_WC_PROJECT_ID` (WalletConnect Cloud project id). The app builds without it, but WC pairing fails.

Tests run in a plain `node` environment (see `vitest.config.ts`) with browser and wallet APIs mocked — no Vue component rendering and no live node. Test files are co-located as `src/**/*.test.ts`. Keep new tests in that style: extract pure functions from services/composables where practical and mock external wallet, storage, and network boundaries. Coverage is gated two ways (see `vitest.config.ts`): aggregate thresholds with headroom, plus per-file floors that pin the funds-critical modules (`request-store`, `evm-service`, `zenon-wallet-service`, the wrap/unwrap composables, and the pure safety helpers) at their current levels so they cannot silently regress.

CI (`.github/workflows/ci.yml`) runs lint, typecheck, `test:coverage`, and build as separate steps on Node 22 and 24, and uploads coverage and production-bundle artifacts (`npm run check` is the equivalent local one-shot). The Security workflow gates on `npm audit --omit=dev --audit-level=high` (shipped dependencies only; a full audit runs report-only). CodeQL and dependency review are opt-in via the `ENABLE_GHAS_CHECKS` repository variable — they need GitHub Advanced Security while the repo is private — and CodeQL is advisory: requiring its status check only proves analysis completed, so gating on alerts additionally needs a branch ruleset with "Require code scanning results" and severity thresholds. Note the low-severity `elliptic` advisories arrive through `znn-typescript-sdk`, so they are in the shipped bundle (below the high-severity gate); an SDK bump is the fix vehicle. The live WalletConnect relay test is intentionally manual because it requires the `VITE_WC_PROJECT_ID` repository secret and external relay availability.

## What this is

A Vue 3 + TypeScript + Vite dApp that bridges tokens between Zenon Network of Momentum (NoM) and Ethereum. Two routes (`src/router.ts`): `/` → `pages/Bridge.vue` (wrap/unwrap forms) and `/requests` → `pages/Requests.vue` (tracked request list with redeem actions). It runs in two contexts: as a standalone web app and inside an MV3 Chrome extension (affects PoW and storage — see below).

## Architecture

Three layers, all under `src/`:

1. **Singleton services** (`src/core/*.ts`) — classes with `getInstance()`, no Vue dependencies:
   - `ZenonService` — owns the single WebSocket connection to the Zenon node (`znn-typescript-sdk`); configures chain/network IDs and the PoW provider before instantiation. In the MV3 extension, blob workers are forbidden by CSP, so PoW falls back to the main thread (`pow-status.ts` tracks worker-based PoW reactively).
   - `BridgeService` — reads from the NoM embedded bridge contract (network info, wrap/unwrap request lists, token metadata/balances) and **builds unsigned** `AccountBlockTemplate`s for wrap/redeem calls.
   - `EvmService` — viem public client (fallback over multiple RPCs from config) + wallet client for Ethereum: ERC-20 allowance/approve, `bridge.unwrap`, `bridge.redeem`, redeem-delay progress.
   - `ZenonWalletService` — WalletConnect v2 Sign client for the `zenon` namespace (`znn_info`, `znn_send`). The wallet fills in previousHash/height/plasma-or-PoW, signs, broadcasts, and returns the published block with its hash. `docs/walletconnect-integration.md` is the wallet-side spec derived from this file — keep them in sync when changing it.

2. **Composables** (`src/core/composables/`) — thin reactive wrappers over the services. State refs are declared at module level, so each composable is effectively a global store shared by all components (`useBridge`, `useZenonWallet`, `useEvmWallet`, `useWrap`, `useUnwrap`, `useRequests`). Components import them via the barrel `@/core`.

3. **Components/pages** (`src/components/`, `src/pages/`) — presentation only; all chain logic lives in the layers above.

**Request tracking**: `request-store.ts` persists user-initiated wrap/unwrap requests (keyed by block hash or `txHash:logIndex`) through `storage/storage-service.ts`, which auto-selects `chrome.storage.local` (extension) vs `localStorage` (web), with an in-memory mirror for synchronous reads.

**Bridge flows** (each is two async legs, resumed from the Requests page):
- **Wrap (Zenon → Ethereum)**: build unsigned wrap block → wallet signs/broadcasts via `znn_send` → after orchestrator signing + redeem delay, submit `redeem` on Ethereum with the TSS signature (`useWrap.redeemEvm`).
- **Unwrap (Ethereum → Zenon)**: exact-amount ERC-20 approve + `bridge.unwrap` via viem (simulated first, receipt required) → later redeem on Zenon via `znn_send`, using the node's authoritative `logIndex` (the browser-decoded log index is provisional/display-only).

**Amounts** are `bigint` everywhere in core (`amount.ts#parseAmount` converts human input; stored as decimal strings in tracked requests). Never use floating point for token amounts.

## Safety model (read before touching config or bridge logic)

`docs/security-model.md` is the authoritative statement. Key invariants enforced in code:

- `src/config.ts` pins the mainnet bridge contract address and the exact ZTS ↔ ERC-20 pairs (with decimals). `useBridge.validatePinnedNetwork` **fails closed** if the node advertises a different bridge or token address; unknown pairs are silently dropped. Adding/changing a pair is a reviewed release, not a runtime concern.
- Testnet mode deliberately throws in `config.ts` until a verified testnet allowlist exists — don't "fix" that error without providing one.
- Before transfers, the app re-fetches bridge state and blocks on halt/key-gen/disabled-direction/wrong-chain/minimum/balance. Ethereum writes are simulated first, use exact allowances (no infinite approve), and require a successful receipt.

## Build quirks

`vite.config.ts` has a custom plugin that serves/copies `pow.js` + `pow.wasm` from `znn-typescript-sdk` into the web root — the SDK fetches them at runtime. It also applies node polyfills (crypto/buffer/stream/util) required by the SDK and WalletConnect, and excludes `znn-typescript-sdk` from dep optimization. `dist/` is committed build output; don't hand-edit it.
