# Auto-affiliate self-referral on unwrap + direction-aware fee display

Date: 2026-07-18
Status: approved (design discussed and accepted in-session)
Branch: `feat/auto-affiliate-unwrap`

## Problem

1. **Fee display bug.** The Bridge form applies the pair's `feePercentage` (the
   node's **wrap** fee, ~3%) to both directions. On unwrap (wZNN → ZNN) it
   shows "1 wZNN ≈ 0.97 ZNN · 3% bridge fee", which is wrong: the bridge
   charges no unwrap fee. Display-only — on-chain amounts were never affected.

2. **Unclaimed bonus.** The bridge's affiliate program (live on Ethereum
   mainnet for wZNN and wQSR since block 17,678,862) pays, on any unwrap whose
   receiver string is `<zenonAddr>&<affiliateAddr>`: +1% to the receiver
   (folded into the main unwrap request) and a separate 2% unwrap request to
   the affiliate. nom-bridge sends a bare receiver, so its users forfeit 3%.

## Goal

On every unwrap, pass `<destinationZenonAddress>&<destinationZenonAddress>` so
the destination address collects both bonuses itself (103% total; round trip
≈ 99.9%). No referral links, no third parties, no new UI flows. Fix the fee
display to be direction-aware.

## Authoritative protocol facts (verified in HyperCore-Team/orchestrator, `network/evm.go:182-249`)

- Separator is `&` (`common.AffiliateProgramAddressSeparator`); part 0 is the
  beneficiary, part 1 the affiliate. Extra parts are ignored.
- Both parts must parse as non-embedded NoM addresses. An invalid affiliate
  part is **ignored** (the unwrap still processes normally) — malformed
  suffixes cannot strand funds.
- No check prevents affiliate == beneficiary. Self-referral is protocol-legal.
- Bonus applies only when the bridge metadata's
  `affiliateProgram.networks[<evmChainId>]` has `startingHeight > 0` and the
  per-token flag is true. For **EVM-side unwraps the flag is `wZNN`/`wQSR`**
  (keyed by ERC-20 token address in the orchestrator; `ZNN`/`QSR` gate the
  NoM-side verification of the same events).
- The affiliate payment materializes as a second unwrap request with the same
  EVM tx hash and `logIndex + 4_000_000_000`
  (`common.AffiliateLogIndexAddition`), redeemed on Zenon separately.
- go-zenon itself never sees the `&` string: the orchestrator submits clean
  `types.Address` values, so the Zenon-side redeem flow is unchanged.
- Live check (2026-07-18, `wss://node.zenonhub.io:35998` → `getBridgeInfo`):
  `affiliateProgram.networks["1"] = {startingHeight: 17678862, ZNN: true,
  QSR: true, wZNN: true, wQSR: true}`.

## Design

### 1. Bonus gating (`useBridge`)

Parse `getBridgeInfo().metadata` (JSON string) and derive, per resolved pair,
`unwrapBonusBps: number` on `TokenPairView`:

- `300` (1% + 2%) when the metadata's network entry for `config.evmChainId`
  has `startingHeight > 0` and the flag matching the pair (`wZNN` for the ZNN
  pair, `wQSR` for the QSR pair) is true;
- `0` otherwise, including when metadata is missing/malformed (fail-safe: no
  suffix appended, behavior identical to today).

The flag name is selected by the pair's pinned base symbol (`ZNN` → `wZNN`,
`QSR` → `wQSR`); unknown symbols get `0`. Metadata parsing is a pure function
(`parseAffiliateProgram(metadata: string, evmChainId: number)`) in a core
module so it is unit-testable.

### 2. Receiver string (`EvmService.unwrap` + `useUnwrap`)

`useUnwrap.unwrap` computes `receiver = bonusActive
? `${zenonAddress}&${zenonAddress}` : zenonAddress` and passes it through.
`EvmService.unwrap` stays receiver-agnostic (takes the final string). The
`Unwrapped` event's `to` is the exact string sent, so:

- `selectProvisionalLogIndex` matches against the exact receiver string that
  was passed (caller supplies it — no parsing).
- Replacement matching after a dropped hash (`matchesTrackedUnwrapEvent` /
  `findUnwrappedEvents` consumers) compares the **beneficiary part**:
  normalize `event.to.split('&')[0]` against the tracked `zenonToAddress`.
  This also keeps pre-change tracked requests matching post-change events and
  vice versa.

Tracked unwrap requests continue to store the clean `zenonToAddress` (the
node's authoritative requests carry clean addresses, so reconciliation is
unchanged).

### 3. Requests page (bonus rows)

No storage redesign: `getAllUnwrapTokenRequestsByToAddress` already returns
the bonus request (same recipient), so it appears as a second redeemable row
automatically.

- Label rows with `logIndex >= 4_000_000_000` as a bonus
  ("Bonus" badge; amount is 2% of the original) in `Requests.vue`.
- **Redeem-lock keying fix:** `setPendingZenonRedeem` /
  `clearPendingZenonRedeem` currently key by bare tx hash, which the main and
  bonus rows would share — redeeming one must not lock or unlock the other.
  Key by the full `txHash:logIndex` id. Backward compatibility: on read, fall
  back to the legacy bare-hash entry only for rows with
  `logIndex < 4_000_000_000` (pre-change persisted state can only refer to
  main rows); the store's rebuild-from-requests mirror
  (`request-store.ts:198`) follows the same rule.
- `useUnwrap.redeemZenon` (Zenon-side redeem) takes the full
  `UnwrapRequestView` — verify it passes the node's authoritative `logIndex`
  for the specific row (it must, since the two rows differ only by logIndex).

### 4. Direction-aware Bridge form display

- **Wrap:** unchanged — "1 ZNN ≈ 0.97 wZNN · 3% bridge fee"; estimate
  subtracts the fee.
- **Unwrap, bonus active:** "1 wZNN ≈ 1.03 ZNN · includes 3% bonus"; estimate
  multiplies by `1 + unwrapBonusBps/10000`. (Chosen over showing 101% + a
  separate 2% line; History shows the two-row reality.)
- **Unwrap, bonus inactive:** "1 wZNN = 1 ZNN · no bridge fee"; estimate 1:1.
- `destinationAmount`, `rateLabel`, `feePercentageLabel` in `Bridge.vue`
  become direction-aware; bigint math only (`amount * (10000n + bps) /
  10000n`).

### 5. Docs and tests

- `docs/security-model.md`: new subsection stating the receiver-string
  construction, the self-referral rationale, the fail-safe gating, and that a
  malformed suffix is ignored by the orchestrator (verified against source).
- Tests (all funds-critical files are pinned by per-file coverage floors):
  - `parseAffiliateProgram`: active/inactive/missing/malformed metadata,
    per-token flags, wrong chain id.
  - `useUnwrap`: receiver string with/without bonus; tracked request stores
    the clean address.
  - `evm-service`: `selectProvisionalLogIndex` with concatenated `to`;
    replacement matching splits on `&`.
  - `useRequests`: two same-hash rows render independently; redeem-lock
    isolation between main and bonus rows; legacy hash-keyed lock falls back
    to main row only; bonus badge threshold.
  - `Bridge.vue` display helpers (extract pure functions if needed to keep
    the node-environment test style).

## Non-goals

- No referral-link intake, no consent page, no third-party affiliate support.
- No change to wrap flow or Zenon-side signing (WalletConnect spec doc
  unaffected).
- No handling for other EVM chains (config pins Ethereum mainnet).

## Risks

- **Orchestrator behavior change:** if a future orchestrator release blocks
  self-referral, unwraps still process (invalid/ignored affiliate ⇒ normal
  100% unwrap); only the bonus disappears. Gating on live metadata limits
  exposure.
- **Estimate drift:** if the program is deactivated between form render and
  event processing, the user receives 100% instead of 103%; funds are never
  at risk. The form re-fetches bridge state before submission, narrowing the
  window.
