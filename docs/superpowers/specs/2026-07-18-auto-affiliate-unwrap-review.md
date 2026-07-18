# Auto-affiliate unwrap review findings

Date: 2026-07-18
Branch: `feat/auto-affiliate-unwrap`
Review status: three findings resolved; one cross-version lock finding remains open

## Scope

This review covers the auto-affiliate unwrap changes relative to `main`, including the
current staged and unstaged fixes. The review followed the complete unwrap lifecycle:

1. derive whether the affiliate program is active;
2. submit `<beneficiary>&<beneficiary>` to the EVM bridge;
3. discover the main and affiliate requests, which share a transaction hash but have
   different log indexes;
4. persist and reconcile Zenon redemption locks for both rows;
5. display the estimated aggregate payout and completion state.

The protocol is expected to reject a second redemption of an already-completed request.
The lock findings therefore do not enable a double payout, but they can violate the
application's funds-critical invariant that a pending wallet action remains durably locked
until its outcome is known. The resulting failure mode is a duplicate wallet prompt or a
second account block that fails on-chain.

## Finding 1: completion was matched by transaction hash

Priority: P1
Status: resolved

A self-referral creates two Zenon requests with the same EVM transaction hash:

```text
0xabc:7           main request
0xabc:4000000007 bonus request
```

The Bridge page previously found a pending unwrap completion by transaction hash. After
the main row was redeemed, publishing the bonus redemption could therefore select the
already-final main row and immediately clear the bonus row's durable lock.

### Implemented fix

- `src/pages/Bridge.vue` matches completion by exact `request.id`.
- The watcher calls `clearLocalPendingUnwrapRedeem` only.
- Durable release remains in `useRequests` reconciliation, which clears a row only after
  its authoritative status is `redeemed` or `revoked`.

This restores row-level identity and separates presentation cleanup from durable safety
decisions.

## Finding 2: full-id locks were not compatible with old bundles

Priority: P1
Status: partially resolved; one deterministic release path remains

Old bundles persist a Zenon redeem lock under the bare EVM transaction hash:

```text
zenonRedeems["0xabc"]
```

The new implementation persists row-specific locks:

```text
zenonRedeems["0xabc:7"]
zenonRedeems["0xabc:4000000007"]
```

An old bundle can redeem either row because affiliate rows already exist through other
dApps and are returned by the same node query. Consequently, an unmarked bare-hash lock
cannot safely be attributed to the main row.

### Implemented compatibility improvement

The current fix writes a marked bare-hash compatibility fence alongside every full-id
lock:

```ts
{
  hash: "zenon-block-hash",
  updatedAt: 123,
  fence: true,
}
```

The blocking read treats any bare entry as hash-wide, so main and bonus redeem
sequentially. The ownership read prevents a row's recheck from managing a marked sibling
fence. This closes the original same-version sibling-release hole and lets an old bundle
observe a lock written by a new bundle.

### Remaining defect

`clearPendingZenonRedeem` still treats an unmarked bare entry as manageable by a main row
when no full main-row lock exists:

```ts
const isManageableLegacy =
  own === undefined && bare.fence !== true && isMainRowIndexPart(index)
```

That attribution is unsafe. Consider this sequence:

1. The main request is already `redeemed`.
2. An old tab starts redeeming the bonus request and writes an unmarked bare-hash lock.
3. A new tab polls the main request.
4. `pendingZenonRedeemFor` exposes the bare lock on the main row because bare locks block
   both rows.
5. The main row is terminal, so `useRequests` calls
   `clearPendingZenonRedeem(mainId)`.
6. `isManageableLegacy` deletes the old tab's still-live bonus lock.

This is deterministic behavior in the new implementation, not merely the acknowledged
residual race in which an old bundle deletes a new compatibility fence.

### Recommended fix

Treat an unmarked bare lock as hash-wide and target-unknown. Do not assign it to either
row based on log index.

#### Store API and ownership

1. Make `ownZenonRedeemLockFor` return only an exact full-id entry.
2. Add a separate helper for an unmarked legacy entry, for example
   `legacyZenonRedeemLockFor(locks, transactionHash)`.
3. Make `clearPendingZenonRedeem(id)` delete only:
   - the exact full-id entry; and
   - a marked fence whose value matches that exact entry.
4. Add an explicit `clearLegacyZenonRedeem(transactionHash)` operation. Call it only from
   evidence-based legacy reconciliation, never from ordinary row advancement.

This separates three meanings that currently overlap:

| Entry | Meaning | May block | May row advancement clear it? |
| --- | --- | --- | --- |
| Full `hash:index` | Known target row | Its row | Yes, for the exact row |
| Bare `fence: true` | Compatibility mirror of a known full lock | Both rows | Only with its matching full lock |
| Bare without `fence` | Old-bundle lock with unknown target | Both rows | No |

#### Legacy recheck behavior

Resolve an unmarked legacy lock under the existing per-hash cross-context Web Lock:

- `awaiting-wallet-result`: keep it until the existing placeholder staleness threshold;
  after the threshold, the explicit legacy reclaim path may clear it.
- `ambiguous-wallet-result`: keep it; the wallet may still publish.
- real block hash with outcome `pending` or unreadable: keep it.
- real block hash with outcome `processed`: clear it. The account block is no longer in
  flight regardless of whether the embedded bridge call succeeded or failed; a fresh
  request read will determine which rows remain redeemable.
- if every request sharing the EVM hash is already terminal, the legacy lock may also be
  removed because no row can be redeemed again.

The selected row's status must not be used to infer which row an unmarked legacy lock
belongs to.

#### Residual mixed-version limitation

An old bundle does not understand `fence: true` and can still delete the bare fence using
its original hash-wide reconciliation logic. A compatibility fence reduces this window
but cannot eliminate it while old JavaScript remains active. Complete removal requires a
versioned rollout or forced client refresh. If that infrastructure remains deferred, this
limitation should be documented as an accepted compatibility risk rather than described
as full cross-version exclusion.

### Required regression tests

Add tests that cover the target-unknown property directly:

1. Seed an unmarked bare lock representing an old bonus redemption, with the main row
   `redeemed` and the bonus row `redeemable`; polling the main row must retain the lock.
2. Rechecking an unmarked real block hash with outcome `pending` must retain it.
3. Rechecking an unmarked real block hash with outcome `processed` must clear it without
   assuming a target row.
4. An unmarked placeholder must be retained before the staleness threshold and may be
   reclaimed only after it.
5. An unmarked ambiguous marker must never be automatically cleared.
6. Exact full-id advancement must still clear its matching marked fence and leave an
   unrelated full-id lock untouched.

The existing test that expects a main-row clear with no own lock to remove an unmarked
bare entry should be replaced; it currently codifies the unsafe attribution.

## Finding 3: activation ignored the current EVM block

Priority: P2
Status: resolved

The orchestrator requires all of the following before paying the affiliate bonus:

```text
startingHeight > 0
event blockNumber >= startingHeight
wrapped-token affiliate flag == true
```

The initial frontend implementation checked only the first and third conditions, which
would advertise a bonus during a future scheduled activation.

### Implemented fix

- `parseUnwrapBonusBps` accepts `currentBlock: bigint | null`.
- `startingHeight` must be a positive safe integer.
- The parser requires `currentBlock >= startingHeight`.
- `useBridge.load()` reads the current EVM block and converts a failed read to `null`.
- A null block disables the bonus without failing the complete bridge-state load.
- Tests cover the block immediately before activation, the activation boundary, invalid
  heights, and a failed block read.

This is appropriately fail-closed. A transaction submitted just before activation may
forgo a bonus even if it later mines after activation, but it will never advertise a bonus
that the frontend cannot verify as active at submission refresh time.

## Finding 4: aggregate payout rounded differently from the protocol

Priority: P3
Status: resolved

The orchestrator floors the two bonus components independently:

```text
floor(amount * 1 / 100) + floor(amount * 2 / 100)
```

The original display used one aggregate floor:

```text
floor(amount * 3 / 100)
```

For 67 base units, the protocol pays one bonus unit while the aggregate expression returns
two.

### Implemented fix

- `selfReferralPayout` performs the independent 1% and 2% divisions.
- The destination estimate uses `selfReferralPayout` when the bonus is active.
- The rate label remains the intentionally approximate `1.03`.
- Regression tests cover rounding-sensitive values including `67 -> 68` and
  `10_034 -> 10_334`.

## Re-review validation

The current working tree passed:

- TypeScript/Vue type checking;
- ESLint with zero warnings;
- 366 unit tests and configured coverage thresholds;
- production Vite build; and
- `git diff --check`.

These automated checks do not cover the remaining legacy-bonus-lock scenario described
above. The branch should not be considered to have fully resolved finding 2 until that
scenario is represented by a regression test and the unmarked-lock attribution is
removed, or until the residual behavior is explicitly accepted as a release risk.

