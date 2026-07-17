# Bridge approval UX handoff

**Status:** reviewed and ready for implementation  
**Date:** 2026-07-16  
**Scope:** token bridging only. Liquidity management, staking, referrals, and affiliate routing remain out of scope.

## Executive summary

The NoM Bridge transaction logic already supports every protocol step required to move tokens between Zenon and Ethereum. The main gap is communication: the UI does not tell users how many wallet approvals remain, and several distinct transactions share generic labels such as `Submitting…` or `Redeem`.

The approval counts are not completely symmetric:

| Direction | Wallet approvals | Total |
| --- | --- | ---: |
| Zenon → Ethereum (`wrap`) | Submit wrap in Syrius; first EVM claim in MetaMask; final EVM claim after the security delay | 3 |
| Ethereum → Zenon (`unwrap`), insufficient allowance | Approve ERC-20 in MetaMask; submit unwrap in MetaMask; redeem in Syrius after signing/delay | 3 |
| Ethereum → Zenon (`unwrap`), sufficient allowance | Submit unwrap in MetaMask; redeem in Syrius after signing/delay | 2 |

For Zenon → Ethereum there are always **two additional EVM approvals after the initial Syrius transaction**. For Ethereum → Zenon, the ERC-20 approval is conditional because NoM Bridge checks the existing allowance first.

## Terminology

- **Wrap:** Zenon → Ethereum, for example ZNN → wZNN.
- **Unwrap:** Ethereum → Zenon, for example wZNN → ZNN.
- **Approval:** a user-confirmed wallet transaction, not a read-only RPC request or bridge/orchestrator signature.
- **Claim phase 1 / phase 2:** the two EVM `redeem` transactions required after a wrap request is signed.
- **Bridge signatures:** orchestrator/TSS work. This is a wait state and does not require a user wallet approval.
- **Security delay:** the EVM or Zenon protocol delay between an initial redemption/request and final redemption.

## Current NoM Bridge behavior

### Zenon → Ethereum

1. The primary CTA says `Bridge to Ethereum`.
2. The app builds a Zenon embedded-contract `wrapToken` block and sends it through WalletConnect/Syrius.
3. After publication, the request is persisted and shown as `Signing` while bridge participants produce the TSS signature.
4. When the first EVM claim is ready, the request badge says `Redeem`; the button also says `Redeem`.
5. The user confirms an EVM `redeem` transaction in MetaMask.
6. During the security delay, the request shows a countdown.
7. When the final claim is ready, the badge says `Redeem (2/2)`, but the button still says `Redeem`.
8. The user confirms the second EVM `redeem` transaction in MetaMask.

Relevant code:

- Initial Zenon submission: [`src/core/composables/useWrap.ts`](../src/core/composables/useWrap.ts)
- EVM claim operation and progress reads: [`src/core/evm-service.ts`](../src/core/evm-service.ts)
- Status derivation and polling: [`src/core/composables/useRequests.ts`](../src/core/composables/useRequests.ts)
- Request labels and actions: [`src/components/WrapRequestItem.vue`](../src/components/WrapRequestItem.vue)
- Page-level submission and redemption handlers: [`src/pages/Bridge.vue`](../src/pages/Bridge.vue)

### Ethereum → Zenon

1. The primary CTA says `Bridge to Zenon`.
2. The UI changes to the single generic label `Submitting…`.
3. The app reads the ERC-20 allowance.
4. If allowance is below the requested amount, the user confirms an exact-amount `approve` transaction in MetaMask and the app waits for a successful receipt.
5. The user then confirms the bridge `unwrap` transaction in MetaMask and the app waits for a successful receipt.
6. The request is persisted and moves through `Pending`, `Signing`, and a security-delay countdown.
7. When ready, the request badge and button both say `Redeem`.
8. The user confirms the final Zenon embedded-contract `redeem` block in Syrius.

Relevant code:

- Allowance then unwrap sequencing: [`src/core/composables/useUnwrap.ts`](../src/core/composables/useUnwrap.ts)
- Exact allowance, receipt checks, and unwrap transaction: [`src/core/evm-service.ts`](../src/core/evm-service.ts)
- Request status and final action: [`src/components/UnwrapRequestItem.vue`](../src/components/UnwrapRequestItem.vue)
- Page-level submission and redemption handlers: [`src/pages/Bridge.vue`](../src/pages/Bridge.vue)

### Existing strengths to preserve

- The ERC-20 allowance is checked and an unnecessary approval is skipped.
- Approval is for the exact requested amount, not an unlimited allowance.
- Every Ethereum write is simulated and requires a successful receipt.
- Requests are persisted and reconstructed from authoritative chain/node state.
- The final Zenon redeem uses the node's authoritative unwrap log index.
- Bridge halt, key-generation, direction-enabled, chain, minimum, and balance gates remain enforced.
- Wallet errors and rejected requests are surfaced through toasts.

## Findings from `0x3639/bridge-dapp`

Reviewed commit: [`038bf7f21f6342703fe2b90d16ef4e7c5a304214`](https://github.com/0x3639/bridge-dapp/tree/038bf7f21f6342703fe2b90d16ef4e7c5a304214)

### Useful behavior

The comparison app explicitly distinguishes the two post-wrap EVM transactions:

- `Request 1/2`
- security-delay countdown with an explanation
- `Redeem 2/2`

Source: [`wrapRequestItemComponent.tsx`](https://github.com/0x3639/bridge-dapp/blob/038bf7f21f6342703fe2b90d16ef4e7c5a304214/src/components/wrapRequestItemComponent/wrapRequestItemComponent.tsx#L300-L350)

It also moves submitted operations into a dedicated history/request workflow, making unfinished work more prominent than an inline list tied to the selected direction.

### Behavior not to copy

For a non-native Ethereum token, the comparison app always sends an ERC-20 `approve` transaction and then sends `unwrap`, even if allowance may already be sufficient.

Source: [`swapStep.tsx`](https://github.com/0x3639/bridge-dapp/blob/038bf7f21f6342703fe2b90d16ef4e7c5a304214/src/pages/wizardSteps/swapStep/swapStep.tsx#L1165-L1243)

Both MetaMask prompts are hidden beneath the generic message `Waiting approval from wallet`, so the user is not told why the wallet opens twice or which transaction is currently being signed.

Source: [`swapStep.tsx`](https://github.com/0x3639/bridge-dapp/blob/038bf7f21f6342703fe2b90d16ef4e7c5a304214/src/pages/wizardSteps/swapStep/swapStep.tsx#L1333-L1371)

The useful lesson is its explicit post-wrap numbering, not its unconditional approval or generic submission spinner.

## UX and safety gaps

### P0 — prevent duplicate redemption submissions

Wrap and unwrap redemption handlers do not maintain per-request pending state. A request remains clickable while its wallet prompt or receipt is pending, allowing repeated clicks and duplicate wallet prompts.

Required behavior:

- Track pending work by stable request ID.
- Disable only the request currently being submitted.
- Change its action label to `Waiting for MetaMask…`, `Confirming on Ethereum…`, `Waiting for Syrius…`, or `Confirming on Zenon…`.
- Clear pending state in `finally`.
- Preserve the request and allow a safe retry after rejection or failure.

### P0 — keep required actions visible across direction changes and reloads

The bridge page only renders wrap requests while `direction === 'wrap'` and unwrap requests while `direction === 'unwrap'`. The default direction is unwrap. After a reload, an unfinished wrap can disappear from the primary page until the user switches direction or opens History.

Required behavior:

- Show an `Action required` summary independent of the current transfer direction.
- Include redeemable wrap and unwrap requests from both directions.
- Keep History as the full durable request view.
- Consider a badge on the History icon with the number of actionable requests.

### P1 — disclose the complete approval plan before submission

Suggested copy beneath the CTA:

**Zenon → Ethereum**

> 3 wallet approvals: submit on Zenon, claim on Ethereum, then complete the claim after the security delay.

**Ethereum → Zenon before the allowance check**

> Up to 3 wallet approvals: token approval if needed, bridge transfer on Ethereum, then redeem on Zenon.

After the allowance check, display an exact count:

- Allowance required: `3 approvals`
- Allowance sufficient: `2 approvals · token approval already complete`

### P1 — expose live transaction phases

Replace the single `Submitting…` state with an explicit operation phase.

Recommended unwrap phases:

1. `Checking token allowance…` — read only; no wallet prompt.
2. `Approve wZNN in MetaMask · 1/3` — only when required.
3. `Confirming token approval…`
4. `Confirm bridge transfer in MetaMask · 2/3` (or `1/2` when approval was skipped).
5. `Confirming bridge transfer…`
6. `Waiting for bridge signatures…`
7. `Redeem on Zenon in Syrius · 3/3` (or `2/2`).

Recommended wrap phases:

1. `Approve wrap in Syrius · 1/3`.
2. `Waiting for bridge signatures…`.
3. `Claim on Ethereum in MetaMask · 2/3`.
4. `Security delay · <countdown>`.
5. `Complete claim in MetaMask · 3/3`.

### P1 — rename request actions

Recommended wrap request copy:

| Status | Badge / description | Action |
| --- | --- | --- |
| `signing` | `Waiting for bridge signatures` | none |
| `redeemable` | `Claim 1 of 2 ready` | `Claim on Ethereum · Step 2/3` |
| `waiting-delay` | `Security delay · <countdown>` | none |
| `redeemable-2` | `Final claim ready` | `Complete claim · Step 3/3` |
| `redeemed` | `Bridge complete` | none |

Recommended unwrap request copy:

| Status | Badge / description | Action |
| --- | --- | --- |
| `pending` | `Waiting for Ethereum event indexing` | none |
| `signing` | `Waiting for bridge signatures` | none |
| `waiting` | `Security delay · <countdown>` | none |
| `redeemable` | `Final redemption ready` | `Redeem on Zenon · Final step` |
| `redeemed` | `Bridge complete` | none |
| `revoked` | `Request revoked` | none |
| `broken` | `Bridge request needs support` | none |

Use **claim** for the two EVM wrap redemptions and **redeem on Zenon** for the final unwrap action. This prevents three unrelated wallet prompts from all being called `Redeem`.

### P1 — foreground the next action after submission

After the source transaction confirms:

- Clear the amount as today.
- Show a success toast with the source explorer link.
- Scroll or focus the new request card.
- Display the full remaining timeline.
- If the user leaves the page, the History action badge must still show that work remains.

Do not call the bridge complete after only the source transaction. Completion means the final destination redemption has confirmed.

## Proposed implementation shape

### 1. Add operation-phase state

Introduce explicit discriminated phase types rather than more booleans.

Example:

```ts
type UnwrapPhase =
  | {kind: 'idle'}
  | {kind: 'checking-allowance'}
  | {kind: 'approving-token'; step: 1; total: 3}
  | {kind: 'confirming-approval'; step: 1; total: 3; hash: Hex}
  | {kind: 'submitting-unwrap'; step: 1 | 2; total: 2 | 3}
  | {kind: 'confirming-unwrap'; step: 1 | 2; total: 2 | 3; hash: Hex}
```

Keep transaction hashes in the phase once known so the UI can expose an explorer link while waiting for confirmation.

### 2. Separate allowance reads from approval writes

Refactor `ensureAllowance` into testable stages, for example:

- `getAllowance(token, bridge, account)`
- `approveAllowance(token, bridge, amount)`
- orchestration in `useUnwrap`

This allows the UI to know the exact approval count before the first wallet write. Continue approving only the exact amount.

### 3. Add per-request redemption state

At page/composable level, track:

```ts
const pendingRedeems = ref<Record<string, 'wallet' | 'confirming'>>({})
```

Pass `pending` and an explicit action label to request items. Disable a request action from the first click until success, rejection, or error.

### 4. Add an actionable-request projection

Derive actionable requests independent of transfer direction:

- Wrap: `redeemable`, `redeemable-2`
- Unwrap: `redeemable`

Render this projection near the bridge card and expose its count on History. Do not duplicate transaction execution logic; actions should call the existing page handlers.

### 5. Keep request polling authoritative

The UI phase is transient presentation state. Chain/node polling remains authoritative for durable request status, especially across reloads, account changes, or transactions completed from another browser.

## Acceptance criteria

### Zenon → Ethereum

- [ ] Before submission, the UI states that three wallet approvals are required.
- [ ] The first prompt is identified as a Syrius wrap submission, step 1 of 3.
- [ ] After source confirmation, the request remains visible and says it is waiting for bridge signatures.
- [ ] The first EVM claim is labeled step 2 of 3 / claim 1 of 2.
- [ ] The first claim action cannot be submitted twice while pending.
- [ ] The security delay explains why no action is currently available.
- [ ] The final EVM claim is labeled step 3 of 3 / claim 2 of 2.
- [ ] Completion is shown only after the final EVM receipt is successful.

### Ethereum → Zenon, insufficient allowance

- [ ] The allowance check is shown as a read-only phase.
- [ ] Token approval is labeled step 1 of 3.
- [ ] The app waits for a successful approval receipt before requesting unwrap.
- [ ] Unwrap is labeled step 2 of 3.
- [ ] Rejecting unwrap after approving leaves a safe, retryable state and does not request approval again unnecessarily.
- [ ] The final Syrius redemption is labeled step 3 of 3.
- [ ] Completion is shown only after the Zenon block publishes successfully.

### Ethereum → Zenon, sufficient allowance

- [ ] No approval transaction is requested.
- [ ] The UI says the token approval is already complete.
- [ ] Unwrap is labeled step 1 of 2.
- [ ] The final Syrius redemption is labeled step 2 of 2.

### Cross-cutting

- [ ] Actionable requests remain visible after swapping direction.
- [ ] Actionable wrap requests are visible after reloading into the default unwrap direction.
- [ ] Per-request wallet actions are disabled while a prompt or receipt is pending.
- [ ] Rejection and timeout messages identify the phase that failed.
- [ ] Wrong-chain, bridge-halted, key-generation, minimum, and balance gates remain intact.
- [ ] No liquidity-management code or copy is introduced.
- [ ] All status and countdown changes are announced accessibly (`aria-live` without excessive repetition).

## Test plan

### Unit tests

- Allowance below amount → `approve` then `unwrap` phase sequence.
- Allowance equal to or above amount → approval skipped and two-step count used.
- Approval rejection → unwrap is not submitted.
- Approval receipt revert → unwrap is not submitted.
- Unwrap rejection after successful approval → retry skips approval when allowance is now sufficient.
- Wrap request label mapping for `redeemable` and `redeemable-2`.
- Unwrap request label mapping for `redeemable`.
- Pending request action is disabled and cannot emit twice.
- Action-required projection includes both directions regardless of selected direction.

### Integration tests

- Existing WalletConnect fake-Syrius live-relay test still passes.
- Wrap source submission persists a request and exposes step 2 when signed.
- Two EVM redeem calls advance `redeemable → waiting-delay → redeemable-2 → redeemed`.
- Unwrap with and without allowance produces the correct transaction count.
- Final Zenon redeem uses the authoritative node log index.

### Manual UX verification

- Desktop and mobile layouts.
- MetaMask prompts appear in the same order as the displayed phases.
- Syrius prompts identify wrap versus final redeem.
- Direction swap and reload do not hide required actions.
- Explorer links appear as soon as each transaction hash is known.
- Browser console remains clean.

## Recommended implementation order for tomorrow

1. Create a feature branch from synchronized `main`.
2. Add failing tests for conditional allowance phase/count behavior.
3. Refactor allowance read/write orchestration and expose unwrap phases.
4. Add per-request redemption pending state and double-click protection.
5. Update wrap and unwrap request labels.
6. Add the direction-independent `Action required` projection/count.
7. Add preflight approval-plan copy and live phase UI to the bridge card.
8. Run typecheck, unit tests, live WalletConnect integration, and production build.
9. Perform desktop/mobile wallet-flow verification before opening a PR.

## Definition of done

The work is complete when a first-time user can tell, before signing anything:

- how many wallet approvals the selected direction requires,
- which wallet and network will prompt next,
- why the bridge is waiting,
- whether another manual action is still required,
- and when the destination funds are actually final.

