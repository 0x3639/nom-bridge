# AGENTS.md

Brief for AI coding agents (Codex, Cursor, Claude Code, and others) working in
this repository. Human contributors: see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Read first, in this order

1. [`README.md`](README.md) — what the app is and how the two bridge flows work.
2. [`CLAUDE.md`](CLAUDE.md) — the detailed working guide: commands, architecture,
   safety model, build quirks. It is written for Claude Code but applies to
   every agent; treat it as the authoritative engineering brief.
3. [`docs/security-model.md`](docs/security-model.md) — the invariants. Any
   change to `src/config.ts`, `src/core/*-service.ts`, `request-store.ts`,
   `affiliate.ts`, or the wrap/unwrap composables must preserve every statement
   in that file, or update the file in the same change.
4. [`CONTRIBUTING.md`](CONTRIBUTING.md) — the review checklist and the list of
   deliberate decisions that look like bugs but are not.

## Ground rules

- This is a bridge front end that moves real funds. Prefer failing closed over
  guessing. Never widen a safety gate, loosen an allowance, relax a quorum, or
  remove a lock to make a test or a flow "work".
- Token amounts are `bigint` in core and decimal strings in storage. Never
  introduce `number` or floating-point arithmetic for amounts.
- Do not edit `dist/` (committed build output) or `coverage/`.
- Do not change pinned addresses or token pairs in `src/config.ts`; that is a
  reviewed release, not a code fix. Do not "fix" the testnet `throw`.
- `docs/walletconnect-integration.md` is derived from
  `src/core/zenon-wallet-service.ts`. Change both together.
- Tests run in a plain `node` environment with wallet, storage, and network
  boundaries mocked; no Vue rendering and no live node. Put new tests next to
  the code as `src/**/*.test.ts` and extract pure functions where that makes
  them testable.
- Per-file coverage floors in `vitest.config.ts` pin the funds-critical modules.
  Do not lower them.

## Verify before claiming done

```sh
npm run check          # lint + typecheck + coverage + production build
npm run test:security  # high/critical advisories in shipped deps
```

Both must pass. Report failures verbatim rather than summarising them away.

## Scope discipline

Deliver the requested change and nothing else. Unrelated refactors, dependency
bumps, and formatting sweeps go in their own PR. If a task appears to require
weakening an invariant, stop and say so instead of proceeding.
