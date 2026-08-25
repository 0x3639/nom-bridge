# Contributing

Thanks for helping. This app moves real funds across a bridge, so review
standards are stricter than for a typical front end. This file is the checklist
for authors and reviewers, human or AI.

## Before you open a PR

```sh
npm ci
npm run check          # lint (zero warnings) + typecheck + coverage + build
npm run test:security  # high/critical advisories in shipped dependencies
```

- Branch from `main`; one concern per PR.
- Do not commit `.env` or any real WalletConnect project id.
- Do not hand-edit `dist/` — it is committed build output produced by the
  deploy workflow.
- If you touch `src/core/zenon-wallet-service.ts`, update
  `docs/walletconnect-integration.md` in the same PR (and vice versa).
- If you touch anything listed under *Funds-critical modules* below, update
  `docs/security-model.md` if the behaviour described there changes, and add or
  extend a test that pins the new behaviour.

## Review checklist

Reviewers should be able to answer **yes** to each of these:

1. **Fail-closed preserved?** No safety gate was widened, no allowance made
   infinite, no RPC quorum lowered, no redeem/submit lock removed or released
   on weaker evidence.
2. **Amounts are `bigint`?** No `number`, `parseFloat`, or arithmetic on
   human-readable strings anywhere near token values.
3. **Pinned config untouched?** `src/config.ts` addresses and pairs are
   unchanged, or the PR is explicitly a pair/bridge release with reviewer
   sign-off.
4. **EVM writes still simulated and receipt-gated?** Every `writeContract`
   path goes through simulation first and waits for a mined receipt.
5. **Authoritative data used for redeems?** Zenon redeems use the node's
   `logIndex`, never the browser-decoded one.
6. **Tests pin the change?** New behaviour has a co-located `*.test.ts`;
   coverage floors in `vitest.config.ts` were not lowered.
7. **Docs in sync?** `docs/security-model.md`, `docs/walletconnect-integration.md`,
   `README.md`, and `CLAUDE.md` still describe what the code does.
8. **Scope is tight?** No drive-by refactors, dependency bumps, or formatting
   churn mixed into a functional change.

## Funds-critical modules

Changes here get the most scrutiny and are covered by per-file coverage floors:

- `src/config.ts`
- `src/core/request-store.ts`
- `src/core/evm-service.ts`
- `src/core/zenon-wallet-service.ts`
- `src/core/bridge-service.ts`
- `src/core/affiliate.ts`, `src/core/amount.ts`, and the other pure helpers
- `src/core/composables/useWrap.ts`, `useUnwrap.ts`, `useBridge.ts`

## Deliberate decisions — please do not "fix" these

Several things in this codebase look like bugs or missing features. They are
intentional; the rationale is in `docs/security-model.md` and the linked
commits.

| Looks like | Actually |
| --- | --- |
| Testnet mode throws in `config.ts` | No verified testnet allowlist exists. Providing one is a reviewed release. |
| Unknown token pairs from the node are silently dropped | Only pinned pairs are ever shown. Fail closed, not open. |
| Exact-amount `approve` on every unwrap (extra wallet prompt) | Infinite approvals are never granted to the bridge contract. |
| Unwrap stays "confirmation unknown" even though Etherscan shows success | One RPC's receipt is not authoritative; two of three configured RPCs must agree. Users must not resubmit while unknown. |
| Wrap safety lock will not auto-release when one Zenon RPC is down | Both pinned RPCs must agree on the confirmed block; one node could under-report the baseline. |
| Redeem locks keyed by `txHash:logIndex` with extra "fence" entries | Main and 2% bonus unwrap requests share a tx hash; the fence keeps older bundles from double-prompting. |
| Browser-decoded `logIndex` shown but not used for redeem | Display-only; the Zenon node's value is authoritative. |
| PoW runs on the main thread inside the extension | MV3 CSP forbids blob workers. |
| `dist/` committed to git | Deployed artifact is reviewed alongside source; workflow rebuilds and verifies it. |
| No Reown AppKit / WalletConnect modal | Pairing is a QR + copyable `wc:` URI by design; see `docs/walletconnect-integration.md`. |
| Low-severity `elliptic` advisories in `npm audit` | Transitive via `znn-typescript-sdk`, below the high-severity gate; an SDK bump is the fix vehicle. |

If you believe one of these should change, open an issue that proposes the
alternative and its safety argument rather than a PR that changes behaviour.

## Working with AI agents

Agents should start from [`AGENTS.md`](AGENTS.md). Agent-authored PRs are held
to the same checklist; the author is responsible for running `npm run check`
locally and pasting real output, not a summary.
