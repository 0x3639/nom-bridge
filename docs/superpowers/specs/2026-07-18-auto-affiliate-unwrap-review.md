# Auto-affiliate unwrap review findings

Date: 2026-07-18
Branch: `feat/auto-affiliate-unwrap`
Review status: all findings resolved; scoped implementation review complete

## Scope

This review covers the auto-affiliate unwrap changes relative to `main`. The review
followed the complete unwrap lifecycle:

1. derive whether the affiliate program is active;
2. submit `<beneficiary>&<beneficiary>` to the EVM bridge;
3. discover the main and affiliate requests, which share a transaction hash but have
   different log indexes;
4. persist and reconcile Zenon redemption locks for both rows;
5. display the estimated aggregate payout and completion state.

The protocol rejects a second redemption of an already-completed request. The lock
findings therefore never enabled a double payout, but they could violate the
application's funds-critical invariant that a pending wallet action remains durably
locked until its outcome is known. The failure mode was a duplicate wallet prompt or a
second account block that fails on-chain.

## Finding 1: completion was matched by transaction hash

Priority: P1
Status: resolved

A self-referral creates two Zenon requests with the same EVM transaction hash
(`0xabc:7` main, `0xabc:4000000007` bonus). The Bridge page previously found a pending
unwrap completion by transaction hash, so after the main row was redeemed, publishing
the bonus redemption could select the already-final main row and immediately clear the
bonus row's durable lock.

Fix: `src/pages/Bridge.vue` matches completion by exact `request.id` and calls
`clearLocalPendingUnwrapRedeem` only. Durable release remains in `useRequests`
reconciliation, which clears a row only after its authoritative status is `redeemed` or
`revoked`.

## Finding 2: full-id locks were not compatible with old bundles

Priority: P1
Status: resolved (final target-unknown design); residual old-bundle risk explicitly
accepted

Old bundles persist a Zenon redeem lock under the bare EVM transaction hash and can
redeem either row (affiliate rows already exist through other dApps and are returned by
the same node query). A bare-hash lock therefore cannot be attributed to a specific row.

### Final design (implemented in `src/core/request-store.ts`)

Three entry kinds with distinct lifecycles:

| Entry | Meaning | Blocks | Released by |
| --- | --- | --- | --- |
| Full `hash:index` | Known target row | Its row | Exact-row advancement, own recheck evidence, dismiss |
| Bare `fence: true` | Compatibility mirror of a known full lock | Both rows | Only with its value-matched full lock |
| Bare unmarked | Old-bundle lock, target unknown | Both rows | `clearLegacyZenonRedeem` under hash-wide evidence only |

- Every `setPendingZenonRedeem` writes the full-id lock plus a marked bare-hash fence
  (which follows the placeholder → published-hash upgrade and never clobbers a genuine
  legacy entry), so old bundles observe new locks and vice versa.
- `ownZenonRedeemLockFor` returns only the exact full-id entry; a row's recheck or
  staleness reclaim can never manage a sibling's lock, a fence, or an unmarked entry.
- `clearPendingZenonRedeem` deletes only the exact full-id entry and its value-matched
  marked fence. Ordinary row advancement can never release an unmarked bare entry —
  the previously identified deterministic deletion of an old tab's still-live bonus
  lock via a terminal main row is structurally impossible.
- Unmarked entries resolve only through hash-wide evidence
  (`legacyZenonRedeemLockFor` + `clearLegacyZenonRedeem`), under the per-hash
  cross-context Web Lock: a pre-prompt placeholder is kept until the staleness window
  and then reclaimable; an ambiguous marker is never auto-cleared; a real block hash is
  kept while `pending`/unreadable and cleared on `processed` (the account block is no
  longer in flight for any row) with deliberately no per-row redeemable re-read. The
  hash-wide release reports `released-processed` with neutral copy — success or failure
  of the embedded call is unknowable without target inference, so no "safe to retry"
  claim is made. Reconciliation additionally sweeps the bare entry once every row
  sharing the hash is terminal.

Regression tests cover: an unmarked lock surviving every row-level clear (including the
terminal-main / live-bonus scenario), pending kept, processed released hash-wide without
target inference (`released-processed`, no `getUnwrapRequest` call), placeholder
staleness both sides, ambiguous never cleared, and full-id advancement releasing only
its matched fence.

### Accepted compatibility risk

An old bundle does not understand `fence: true` and its hash-wide reconciliation can
delete a fence (or its own bare lock) during a mixed-version window, briefly re-exposing
the duplicate-prompt window. The bridge contract rejects a second redemption of a
completed request, so the worst case is a duplicate Syrius prompt or a failed account
block — never a double payout. Complete elimination requires a versioned rollout or
forced client refresh, which is explicitly deferred; this limitation is documented in
`docs/security-model.md` as an accepted release risk, not full cross-version exclusion.

## Finding 3: activation ignored the current EVM block

Priority: P2
Status: resolved

The orchestrator pays the bonus only when `startingHeight > 0`, the event's
`blockNumber >= startingHeight`, and the wrapped-token flag is true. The frontend
originally checked only the first and third conditions.

Fix: `parseUnwrapBonusBps` accepts `currentBlock: bigint | null`, requires
`startingHeight` to be a positive safe integer and `currentBlock >= startingHeight`;
`useBridge.load()` reads the current EVM block and converts a failed read to `null`,
which disables the bonus without failing the bridge-state load. Tests cover the
activation boundary on both sides, invalid heights, and a failed block read.

## Finding 4: aggregate payout rounded differently from the protocol

Priority: P3
Status: resolved

The orchestrator floors the 1% and 2% components independently; the original display
used one aggregate `floor(amount * 3 / 100)`, over-estimating by one base unit for many
remainders (67 pays 68, not 69).

Fix: `selfReferralPayout` performs the independent divisions; the destination estimate
uses it when the bonus is active; the rate label remains the intentionally approximate
`1.03`. Regression tests cover `67 -> 68` and `10_034 -> 10_334`.

## Verification

The working tree at review close passed:

- TypeScript/Vue type checking (`vue-tsc --noEmit`);
- ESLint with zero warnings;
- 371 unit tests and configured coverage thresholds (aggregate plus per-file floors on
  the funds-critical modules);
- production Vite build; and
- `git diff --check main`.

The live small-amount Syrius unwrap and the versioned rollout infrastructure remain
explicitly deferred follow-up work, not blockers under the agreed scope.
