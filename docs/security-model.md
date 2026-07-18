# NoM Bridge security model

NoM Bridge intentionally provides token bridging only. Liquidity management,
staking, referrals, and affiliate routing are outside the application scope.

## Pinned mainnet deployment

The application fails closed if the Zenon RPC advertises a different Ethereum
bridge or a different ERC-20 address for a supported ZTS. Token decimals are
also checked against this release configuration and against both chains.

- Ethereum Bridge: `0xa98706106f7710d743186031be2245f33acea106`
- ZNN / wZNN: `0xb2e96a63479c2edd2fd62b382c89d5ca79f572d3` (8 decimals)
- ZNNETHLP / UNI-V2: `0xdac866a3796f85cb84a914d98faec052e3b5596d` (18 decimals)
- QSR / wQSR: `0x96546afe4a21515a3a30cd3fd64a70eb478dc174` (8 decimals)
- WBTC: `0x2260fac5e5542a773aa44fbcfedf7c193bc2c599` (8 decimals)

Adding or changing a pair requires a reviewed application release. Unknown
pairs returned by an RPC node are not shown.

## Runtime safety gates

Before a transfer, the application refreshes the full bridge configuration and
blocks when the bridge is halted, key generation is enabled, either direction
is disabled, the connected chain is wrong, the current minimum is not met, or
the source balance is insufficient. Ethereum writes are simulated, use exact
allowances, and require a successful receipt. Redeems use the Zenon node's
authoritative unwrap log index rather than the provisional browser value.

Bridge availability and signing still depend on the Zenon orchestrator set.
Users should expect finality delays and verify operator health at
<https://status.bridge.zenon.community/>.

## Unwrap self-referral bonus

On unwrap the app passes `<zenonAddress>&<zenonAddress>` as the bridge
receiver. The orchestrator (HyperCore-Team/orchestrator,
`network/evm.go:182-249`) splits on `&`: part 0 is the beneficiary, part 1
the affiliate. When the bridge metadata's affiliate program is active for the
token, the beneficiary's unwrap request is created at 101% of the amount and
a separate 2% request is created for the affiliate at
`logIndex + 4_000_000_000` — so the destination address collects the full 3%
itself. Safety properties, verified against orchestrator source:

- An invalid or ignored affiliate part never blocks the unwrap; worst case is
  a normal 100% unwrap. Funds are never at risk from the suffix.
- The suffix is only sent when `getBridgeInfo().metadata` advertises the
  program as active for the pair (`wZNN`/`wQSR` flags, `startingHeight` a
  positive safe integer) AND the current EVM block has reached
  `startingHeight` — the orchestrator only pays for events at
  `blockNumber >= startingHeight`. Missing or malformed metadata, or a failed
  block-number read, fails safe to a bare receiver
  (`src/core/affiliate.ts#parseUnwrapBonusBps`).
- The displayed estimate uses the orchestrator's exact rounding — two
  independent floors (+1%, +2%, `affiliate.ts#selfReferralPayout`) — not a
  single floor of 3%, which would over-estimate by one base unit for many
  amounts.
- Tracked requests store the clean beneficiary address; the node's
  authoritative unwrap requests carry parsed clean addresses, so Zenon-side
  redeem and reconciliation are unchanged.
- Zenon redeem locks are keyed by `txHash:logIndex` because the bonus request
  shares the main request's tx hash. Three kinds of `zenonRedeems` entries
  exist, with distinct lifecycles:
  - **Full `hash:index`** — a known row's lock. Released only for that exact
    row (protocol advancement, own recheck evidence, dismiss).
  - **Bare with `fence: true`** — a compatibility mirror written alongside
    every full-id lock so old bundles (which key by bare hash) refuse both
    rows. Blocks both rows here too; released only together with its
    value-matched full lock.
  - **Bare without `fence`** — an old bundle's lock whose target row is
    UNKNOWN (old bundles can redeem either row; bonus rows already exist via
    other dApps' referrals). Blocks both rows and is NEVER attributed to a
    row: ordinary row advancement cannot release it. It is released only
    with hash-wide evidence (`clearLegacyZenonRedeem`): its block's outcome
    is `processed` (no wallet action can still be in flight for any row), a
    stale pre-prompt placeholder passed the staleness window, or every row
    sharing the hash is terminal (redeemed/revoked — the reconciliation
    sweep).

  Any bare entry therefore forces main and bonus to redeem sequentially.
  Rows may only recheck/reclaim locks they own
  (`request-store.ts#ownZenonRedeemLockFor`) — a row's evidence can never
  release a sibling's lock. The Bridge page's completion watcher matches
  rows by exact request id and clears only transient UI state; durable lock
  release belongs to reconciliation's forward-only clearing.
- **Accepted compatibility risk (mixed-version windows):** an old bundle
  does not understand `fence: true` and its hash-wide reconciliation can
  delete a fence (or its own bare lock) while a new bundle's redeem is
  pending, briefly re-exposing the duplicate-prompt window the locks exist
  to close. The bridge contract rejects a second redemption of a completed
  request, so the worst case is a duplicate Syrius prompt or a failed
  account block — never a double payout. Full elimination requires a
  versioned rollout / forced client refresh, which is deliberately deferred.

## Audit provenance and remaining assurance work

ChainSafe's May 2023 review covered three Ethereum contracts at commit
`15bbf40ef7cba95dba797133b0da5ab3792a6b9e`; fixes were recorded at commit
`5204c0df4e0a2a1bcaa69e5fa22c9131c09e76e9`. It did not cover this frontend,
the NoM embedded contract, orchestrator/TSS operations, WalletConnect, or the
deployment pipeline.

Etherscan currently identifies the mainnet bridge source as a similar match.
An exact reproducible-build and deployed-bytecode attestation against the
post-audit commit remains a release requirement.

## Deployment checklist

- Set a production WalletConnect project ID; never ship the placeholder.
- Serve only immutable, reviewed build artifacts over HTTPS.
- Configure restrictive CSP, frame-ancestor, MIME-sniffing, referrer, and
  permissions headers at the hosting layer. Test the SDK's worker/blob behavior
  before enforcing CSP and do not add `unsafe-eval` merely to silence warnings.
- Keep the pinned bridge and token configuration under code review.
- Run tests, type checking, the production build, and dependency audit for every
  release.
- Publish the exact git commit and artifact hashes used by the deployment.
