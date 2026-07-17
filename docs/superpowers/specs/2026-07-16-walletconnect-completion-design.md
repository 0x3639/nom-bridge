# WalletConnect/Syrius completion — design

Date: 2026-07-16
Branch: `feature/walletconnect-syrius` (stacked on `codex/bridge-safety-hardening`)
Status: approved design, pending implementation plan

## Problem

The bridge's wrap/unwrap/redeem/tracking flows are implemented and unit-tested
(135 tests, clean typecheck and build), but connecting the Syrius wallet over
WalletConnect fails or feels broken in practice. Comparison with the production
reference dApp (github.com/0x3639/bridge-dapp) shows nom-bridge's namespace and
payload shapes are already correct; what is missing is the reliability layer of
Syrius-specific workarounds the reference app accumulated, plus any way to test
the WalletConnect path without a live Syrius wallet.

## Scope decisions (agreed)

- Token bridging only. No liquidity, staking, or affiliate features.
- Syrius connectivity via **WalletConnect only** — the Syrius browser-extension
  postMessage protocol is out of scope.
- Standalone **web app only** — the MV3 extension context stays as-is, untested.
- Keep the current WC stack (`@walletconnect/sign-client` + deprecated
  `@walletconnect/modal`); no AppKit migration, since Syrius interop is only
  proven against this stack.
- Approach: **harden the existing `zenon-wallet-service.ts` in place** (not a
  wholesale port of the reference wrapper, not a stack migration).

## Design

### 1. Reliability layer in `src/core/zenon-wallet-service.ts`

The namespace (`zenon:1`, methods `znn_info`/`znn_sign`/`znn_send`, events
`chainIdChange`/`addressChange`) and the `znn_send` envelope
(`{fromAddress, accountBlock}` with the block as a JSON object) are proven
correct against Syrius and MUST NOT change.

Additions:

- **Timeout wrapper** — every `client.request()` races a 30 s timeout. The
  pairing `approval()` promise instead races a ~5 min timeout (matching the
  WalletConnect pairing-URI expiry): manually pasting the URI into Syrius
  routinely takes longer than 30 s. On expiry the user sees a "Request timed
  out — check Syrius" style error rather than an infinite spinner. `znn_send`
  races its own 2 min timeout for the same human-paced reason as approval —
  reviewing and signing a transaction in Syrius routinely takes longer than
  30 s.
- **Relay guard** — before each request, if `client.core.relayer.connected` is
  false, reopen the transport (`transportOpen()`) and settle ~2 s. Prevents
  requests sent into a dead relay (e.g. after laptop sleep).
- **Post-approval settle** — after `approval()` resolves, wait ~5 s and re-scan
  `client.session.getAll()` for the newest live `zenon` session, falling back
  to the `approval()` result. (The SignClient session store lags behind
  `approval()`; the reference app ships this exact workaround.)
- **Retry + Syrius error map** — `znn_info`/`znn_send` retry up to 3 attempts:

  | Wallet error | Handling |
  |---|---|
  | `-32602` + "Bad state: No element" | drop session, full reconnect, retry |
  | `-32602` + "No matching key" | plain retry |
  | `9000` + "Wallet is locked" | no retry; surface "Your wallet is locked — please unlock Syrius" |
  | `5000`–`5999` | no retry; "Request rejected in the wallet" (existing behavior) |
  | anything else | generic WC failure (existing behavior) |

- **Placeholder guard** — `connect()` throws "Set VITE_WC_PROJECT_ID in .env"
  when the project ID is still `REPLACE_ME_WC_PROJECT_ID`, instead of failing
  cryptically at the relay.

### 2. Session restore on load

New non-interactive `restore()` on the service: scan for a live `zenon`
session, call `znn_info`, never open the modal; silent no-op when there is no
session. `useZenonWallet` calls it once at initialization so a page refresh
shows the still-connected wallet instead of "disconnected".

### 3. Connect UX

- Configure `WalletConnectModal` the way the reference app does: register
  Syrius as a custom desktop wallet (`syrius:` native deep-link + official
  download URL + wallet image), `enableExplorer: false` (the WC explorer can
  never list Syrius), no mobile wallets.
- Keep the modal's QR / copy-URI view; add one line of helper text telling
  users to paste the URI into Syrius's WalletConnect tab if the deep-link does
  not fire.
- Wallet-locked / timeout / rejection errors surface through the existing
  toast path.

### 4. Fake-Syrius harness (`scripts/fake-syrius.mts`)

Headless wallet-side sign-client run as `npm run fake-wallet -- <wc-uri>`:
pairs with the dApp's URI, approves the session with the exact `zenon`
namespace (accounts `["zenon:1:z1q…fake"]`), then answers:

- `znn_info` → canned `{address, chainId: 1, nodeUrl}`
- `znn_send` → echoes the received account block with a deterministic fake
  hash filled in (no signing, no broadcast — tracked requests stay in
  "signing", which is sufficient for UI-flow testing)
- `znn_sign` → canned signature

Failure-mode flags to exercise the hardening in a real browser session:
`--reject` (code 5000), `--locked` (code 9000), `--hang` (never responds →
timeout path), `--bad-state` (one `-32602 Bad state: No element`, then normal
→ reconnect-retry path).

### 5. Automated integration test

`src/core/zenon-wallet-service.integration.test.ts`, run via a separate
`npm run test:integration` (excluded from the default `npm test` glob). Runs
the real dApp-side service and the harness's wallet logic in one Node process
over the real WalletConnect relay. Asserts:

- pairing completes and session approval succeeds with our exact
  `requiredNamespaces` (regression guard on the namespace shape)
- `znn_info` and `znn_send` round-trip with the correct payload envelope
- a `5000` error maps to the "rejected in the wallet" message
- `session_delete` clears local state

Gated with `describe.skipIf(!process.env.VITE_WC_PROJECT_ID)`; generous
timeouts because the public relay is involved.

### 6. Cleanup (riding along)

- Delete stale "Phase 3"/"Phase 5" comments in `zenon-wallet-service.ts`,
  `useZenonWallet.ts`, `request-store.ts`.
- Update `docs/walletconnect-integration.md` with dApp-side timeout/retry
  semantics and the newly mapped error codes (`9000`, `-32602` variants) —
  that doc is the contract handed to wallet developers.

## Testing

- Unit tests (existing mocked style) for the timeout wrapper, retry/error map,
  post-approval settle, `restore()`, and the placeholder guard.
- Integration test as in §5.
- Manual: dev server + fake-Syrius harness for each failure-mode flag, then a
  real Syrius desktop pairing.

## Out of scope

Liquidity/staking/affiliate features, Syrius browser-extension path,
EVM-over-WalletConnect, MV3 extension context, AppKit/UniversalProvider
migration, testnet enablement (still deliberately blocked in `config.ts`).

## Risks

- The public WC relay makes the integration test inherently networky; it is
  opt-in via env and generously timed rather than CI-required.
- The 5 s settle delay is empirical (inherited from the reference app); if
  Syrius/WC fixes the store lag it becomes dead weight — acceptable.
- If the local `VITE_WC_PROJECT_ID` is not a live WalletConnect Cloud project,
  pairing still fails; the new timeout + error surfacing makes that failure
  visible instead of silent.
