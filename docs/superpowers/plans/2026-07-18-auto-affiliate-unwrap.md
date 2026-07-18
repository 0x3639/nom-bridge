# Auto-Affiliate Self-Referral Unwrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On every unwrap, pass `<zenonAddr>&<zenonAddr>` as the bridge receiver so the destination address collects the 1% + 2% affiliate bonuses itself, and make the Bridge form's fee display direction-aware.

**Architecture:** A new pure module `src/core/affiliate.ts` owns all affiliate protocol knowledge (metadata gating, receiver construction, bonus log-index detection). `useBridge` stamps each `TokenPairView` with `unwrapBonusBps` from live bridge metadata; `useUnwrap` builds the receiver string; the request store's Zenon-redeem locks move from bare-tx-hash keys to full `txHash:logIndex` keys (with legacy fallback) so the main and bonus rows redeem independently.

**Tech Stack:** Vue 3 + TypeScript, vitest (plain `node` env, no component rendering), bigint-only amount math.

**Spec:** `docs/superpowers/specs/2026-07-18-auto-affiliate-unwrap-design.md`

## Global Constraints

- Amounts are `bigint` everywhere in core; never floating point for token math.
- Tests co-located as `src/**/*.test.ts`, plain node env, mock wallet/storage/network boundaries.
- Coverage is gated: aggregate thresholds + per-file floors on `request-store`, `evm-service`, wrap/unwrap composables (`vitest.config.ts`). Every touched funds-critical file needs tests for its new branches.
- Affiliate separator is `&`; bonus request logIndex offset is `4_000_000_000`; bonus total is 300 bps (1% folded into main request + 2% separate request).
- Fail-safe rule: missing/malformed metadata ⇒ bonus off ⇒ bare receiver (today's behavior).
- Commit after each task; run `npm run check` before the final commit.

---

### Task 1: Pure affiliate module

**Files:**
- Create: `src/core/affiliate.ts`
- Test: `src/core/affiliate.test.ts`

**Interfaces:**
- Produces (used by every later task):
  - `AFFILIATE_BONUS_BPS: number` = 300
  - `AFFILIATE_LOG_INDEX_THRESHOLD: number` = 4_000_000_000
  - `parseUnwrapBonusBps(metadata: string | null | undefined, evmChainId: number, baseSymbol: string): number` → 300 or 0
  - `selfReferralReceiver(zenonAddress: string): string` → `` `${a}&${a}` ``
  - `beneficiaryOf(receiver: string): string` → part before first `&`
  - `isAffiliateBonusLogIndex(logIndex: number): boolean`

- [ ] **Step 1: Write the failing tests**

```ts
// src/core/affiliate.test.ts
import {describe, expect, it} from 'vitest'
import {
  AFFILIATE_BONUS_BPS,
  AFFILIATE_LOG_INDEX_THRESHOLD,
  beneficiaryOf,
  isAffiliateBonusLogIndex,
  parseUnwrapBonusBps,
  selfReferralReceiver,
} from './affiliate'

const ACTIVE_METADATA = JSON.stringify({
  affiliateProgram: {
    networks: {'1': {startingHeight: 17678862, ZNN: true, QSR: true, wZNN: true, wQSR: true}},
  },
})

describe('parseUnwrapBonusBps', () => {
  it('returns 300 for ZNN when the wZNN flag is active', () => {
    expect(parseUnwrapBonusBps(ACTIVE_METADATA, 1, 'ZNN')).toBe(AFFILIATE_BONUS_BPS)
  })
  it('returns 300 for QSR when the wQSR flag is active', () => {
    expect(parseUnwrapBonusBps(ACTIVE_METADATA, 1, 'QSR')).toBe(AFFILIATE_BONUS_BPS)
  })
  it('returns 0 when the token flag is false', () => {
    const metadata = JSON.stringify({
      affiliateProgram: {networks: {'1': {startingHeight: 17678862, wZNN: false, wQSR: true}}},
    })
    expect(parseUnwrapBonusBps(metadata, 1, 'ZNN')).toBe(0)
  })
  it('returns 0 when startingHeight is 0 or missing', () => {
    const zeroHeight = JSON.stringify({
      affiliateProgram: {networks: {'1': {startingHeight: 0, wZNN: true}}},
    })
    expect(parseUnwrapBonusBps(zeroHeight, 1, 'ZNN')).toBe(0)
    const noHeight = JSON.stringify({affiliateProgram: {networks: {'1': {wZNN: true}}}})
    expect(parseUnwrapBonusBps(noHeight, 1, 'ZNN')).toBe(0)
  })
  it('returns 0 for a chain id with no entry', () => {
    expect(parseUnwrapBonusBps(ACTIVE_METADATA, 5, 'ZNN')).toBe(0)
  })
  it('returns 0 for an unknown base symbol', () => {
    expect(parseUnwrapBonusBps(ACTIVE_METADATA, 1, 'FOO')).toBe(0)
  })
  it('returns 0 for malformed, empty, null, or non-object metadata', () => {
    expect(parseUnwrapBonusBps('not json', 1, 'ZNN')).toBe(0)
    expect(parseUnwrapBonusBps('', 1, 'ZNN')).toBe(0)
    expect(parseUnwrapBonusBps(null, 1, 'ZNN')).toBe(0)
    expect(parseUnwrapBonusBps(undefined, 1, 'ZNN')).toBe(0)
    expect(parseUnwrapBonusBps('"just a string"', 1, 'ZNN')).toBe(0)
    expect(parseUnwrapBonusBps('{"affiliateProgram":{}}', 1, 'ZNN')).toBe(0)
  })
})

describe('selfReferralReceiver / beneficiaryOf', () => {
  const addr = 'z1qqjnwjjpnue8xmmpanz6csze6tcmtzzdtfsww7'
  it('builds addr&addr', () => {
    expect(selfReferralReceiver(addr)).toBe(`${addr}&${addr}`)
  })
  it('beneficiaryOf extracts the part before the first &', () => {
    expect(beneficiaryOf(`${addr}&${addr}`)).toBe(addr)
    expect(beneficiaryOf(addr)).toBe(addr)
    expect(beneficiaryOf(`${addr}&other&extra`)).toBe(addr)
    expect(beneficiaryOf('')).toBe('')
  })
})

describe('isAffiliateBonusLogIndex', () => {
  it('threshold boundary', () => {
    expect(isAffiliateBonusLogIndex(AFFILIATE_LOG_INDEX_THRESHOLD)).toBe(true)
    expect(isAffiliateBonusLogIndex(AFFILIATE_LOG_INDEX_THRESHOLD - 1)).toBe(false)
    expect(isAffiliateBonusLogIndex(0)).toBe(false)
    expect(isAffiliateBonusLogIndex(-1)).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/affiliate.test.ts`
Expected: FAIL — `Cannot find module './affiliate'` (or equivalent resolve error).

- [ ] **Step 3: Write the implementation**

```ts
// src/core/affiliate.ts
// Protocol facts verified against HyperCore-Team/orchestrator
// (network/evm.go:182-249, common/constants.go:32-33): the EVM `Unwrapped.to`
// string may be `<beneficiary>&<affiliate>`; when the bridge metadata's
// affiliate program is active for the token, the orchestrator adds 1% to the
// beneficiary's unwrap request and creates a separate 2% request for the
// affiliate at logIndex + 4e9. Self-referral is not rejected; an invalid
// affiliate part is ignored (the unwrap still processes at 100%).

export const AFFILIATE_BONUS_BPS = 300

export const AFFILIATE_LOG_INDEX_THRESHOLD = 4_000_000_000

const AFFILIATE_SEPARATOR = '&'

// Flag names in the bridge metadata keyed by the pair's native symbol. For
// EVM-side unwraps the orchestrator gates on the wrapped-token flags.
const UNWRAP_FLAG_BY_SYMBOL: Record<string, 'wZNN' | 'wQSR'> = {
  ZNN: 'wZNN',
  QSR: 'wQSR',
}

// Total bonus (in basis points of the unwrapped amount) the destination
// address collects on an unwrap when it is its own affiliate. 0 whenever the
// program is off or the metadata cannot be understood (fail-safe: callers
// then send a bare receiver, which is today's behavior).
export function parseUnwrapBonusBps(
  metadata: string | null | undefined,
  evmChainId: number,
  baseSymbol: string,
): number {
  const flag = UNWRAP_FLAG_BY_SYMBOL[baseSymbol]
  if (!flag || !metadata) return 0
  let parsed: unknown
  try {
    parsed = JSON.parse(metadata)
  } catch {
    return 0
  }
  if (typeof parsed !== 'object' || parsed === null) return 0
  const networks = (parsed as {affiliateProgram?: {networks?: Record<string, unknown>}})
    .affiliateProgram?.networks
  if (typeof networks !== 'object' || networks === null) return 0
  const network = networks[String(evmChainId)]
  if (typeof network !== 'object' || network === null) return 0
  const entry = network as {startingHeight?: unknown} & Record<string, unknown>
  if (typeof entry.startingHeight !== 'number' || entry.startingHeight <= 0) return 0
  return entry[flag] === true ? AFFILIATE_BONUS_BPS : 0
}

export function selfReferralReceiver(zenonAddress: string): string {
  return `${zenonAddress}${AFFILIATE_SEPARATOR}${zenonAddress}`
}

export function beneficiaryOf(receiver: string): string {
  return receiver.split(AFFILIATE_SEPARATOR)[0]
}

export function isAffiliateBonusLogIndex(logIndex: number): boolean {
  return logIndex >= AFFILIATE_LOG_INDEX_THRESHOLD
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/affiliate.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Export from the core barrel if applicable, then commit**

Check `src/core/index.ts` (the `@/core` barrel): if it re-exports core modules individually, add `export * from './affiliate'`. Then:

```bash
git add src/core/affiliate.ts src/core/affiliate.test.ts src/core/index.ts
git commit -m "feat: add pure affiliate protocol module"
```

---

### Task 2: `unwrapBonusBps` on TokenPairView via bridge metadata

**Files:**
- Modify: `src/types/bridge.ts:18-31` (TokenPairView)
- Modify: `src/core/composables/useBridge.ts` (`resolvePair`, `load`)
- Test: `src/core/composables/useBridge.test.ts`

**Interfaces:**
- Consumes: `parseUnwrapBonusBps` from Task 1.
- Produces: `TokenPairView.unwrapBonusBps: number` — 300 when the bonus is live for that pair, else 0. Later tasks read it from `selectedPair` / `getTokenPairsFn`.

- [ ] **Step 1: Add the field to the type**

In `src/types/bridge.ts`, extend `TokenPairView`:

```ts
  unwrapEnabled: boolean
  owned: boolean
  unwrapBonusBps: number // 300 when the unwrap affiliate self-bonus is live, else 0
```

- [ ] **Step 2: Write the failing test**

Open `src/core/composables/useBridge.test.ts` and follow its existing mocking pattern (it mocks `BridgeService`/`EvmService` singletons). Add a test that drives `load()` with the existing happy-path fixtures, but sets the mocked `getBridgeInfo()` result's `metadata` to:

```ts
JSON.stringify({affiliateProgram: {networks: {'1': {startingHeight: 17678862, wZNN: true, wQSR: true, ZNN: true, QSR: true}}}})
```

and asserts every resolved pair has `unwrapBonusBps === 300`. Add a second case with `metadata: ''` asserting `unwrapBonusBps === 0`. Reuse the file's existing fixture helpers verbatim — only the metadata value and the new assertions differ. Existing tests whose fixtures leave `metadata` unset must keep passing (they will get `0`).

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/core/composables/useBridge.test.ts`
Expected: FAIL — `unwrapBonusBps` is `undefined` (and possibly a type error from Step 1 surfacing in fixtures; fix fixtures by adding the field where TokenPairView objects are literal).

- [ ] **Step 4: Implement**

In `src/core/composables/useBridge.ts`:

1. Import: `import {parseUnwrapBonusBps} from '../affiliate'`
2. `resolvePair` gains a third parameter and passes it through:

```ts
async function resolvePair(
  pair: TokenPair,
  bridgeAddress: Address,
  bridgeMetadata: string,
): Promise<TokenPairView> {
```

and in its return object (after `owned: pair.owned,`):

```ts
    unwrapBonusBps: parseUnwrapBonusBps(bridgeMetadata, config.evmChainId, native.symbol),
```

3. In `load()` (line ~103), pass the metadata from the already-fetched `info` (BridgeInfo has `metadata: string`):

```ts
    const resolvedPairs = await Promise.all(
      supportedPairs.map(pair => resolvePair(pair, network.contractAddress as Address, info.metadata)),
    )
```

- [ ] **Step 5: Run tests, typecheck**

Run: `npx vitest run src/core/composables/useBridge.test.ts && npm run typecheck`
Expected: PASS. Typecheck will flag every other test fixture that builds a literal `TokenPairView` — add `unwrapBonusBps: 0` to those fixtures.

- [ ] **Step 6: Commit**

```bash
git add src/types/bridge.ts src/core/composables/useBridge.ts src/core/composables/useBridge.test.ts $(git diff --name-only)
git commit -m "feat: derive per-pair unwrap bonus from live bridge metadata"
```

---

### Task 3: Redeem-lock keying by full request id

**Files:**
- Modify: `src/core/request-store.ts:196-201` (migration mirror), `:397-410` (set/clear)
- Modify: `src/core/composables/useRequests.ts:433,545` (reads)
- Test: `src/core/request-store.test.ts`

**Interfaces:**
- Consumes: `AFFILIATE_LOG_INDEX_THRESHOLD` (Task 1).
- Produces:
  - `requestStore.setPendingZenonRedeem(id: string, hash: string)` — now keys by normalized full id.
  - `requestStore.clearPendingZenonRedeem(id: string)` — clears the id key and, for main rows, the legacy bare-hash key.
  - New export from `request-store.ts`: `pendingZenonRedeemFor(zenonRedeems: Record<string, {hash: string}>, id: string): string | undefined` — read helper with legacy fallback.

Rationale (from spec): main and bonus rows share a tx hash; a redeem lock on one must not lock or unlock the other. Legacy persisted state (bare-hash keys) can only refer to main rows, so the fallback applies only when the id's logIndex part is below the affiliate threshold.

- [ ] **Step 1: Write the failing tests**

In `src/core/request-store.test.ts`, following the file's existing setup pattern (storage mocked), add:

```ts
describe('zenon redeem lock keying', () => {
  const HASH = '0x' + 'ab'.repeat(32)
  const MAIN_ID = `${HASH}:7`
  const BONUS_ID = `${HASH}:4000000007`

  it('keys pending redeems by full id so same-hash rows are independent', async () => {
    await requestStore.setPendingZenonRedeem(MAIN_ID, 'zhash-main')
    const snapshot = await requestStore.getSnapshot()
    expect(pendingZenonRedeemFor(snapshot.zenonRedeems, MAIN_ID)).toBe('zhash-main')
    expect(pendingZenonRedeemFor(snapshot.zenonRedeems, BONUS_ID)).toBeUndefined()
  })

  it('clearing one row leaves the other row locked', async () => {
    await requestStore.setPendingZenonRedeem(MAIN_ID, 'zhash-main')
    await requestStore.setPendingZenonRedeem(BONUS_ID, 'zhash-bonus')
    await requestStore.clearPendingZenonRedeem(MAIN_ID)
    const snapshot = await requestStore.getSnapshot()
    expect(pendingZenonRedeemFor(snapshot.zenonRedeems, MAIN_ID)).toBeUndefined()
    expect(pendingZenonRedeemFor(snapshot.zenonRedeems, BONUS_ID)).toBe('zhash-bonus')
  })

  it('falls back to a legacy bare-hash entry for main rows only', () => {
    const legacy = {[HASH]: {hash: 'zhash-legacy'}}
    expect(pendingZenonRedeemFor(legacy, MAIN_ID)).toBe('zhash-legacy')
    expect(pendingZenonRedeemFor(legacy, `${HASH}:-1`)).toBe('zhash-legacy')
    expect(pendingZenonRedeemFor(legacy, BONUS_ID)).toBeUndefined()
  })

  it('clearPendingZenonRedeem on a main row also clears the legacy key', async () => {
    // Seed a legacy-style entry through the public API shape: write directly
    // via setPendingZenonRedeem then simulate legacy by asserting clear
    // removes both the id key and the bare-hash key.
    await requestStore.setPendingZenonRedeem(MAIN_ID, 'zhash-main')
    await requestStore.clearPendingZenonRedeem(MAIN_ID)
    const snapshot = await requestStore.getSnapshot()
    expect(Object.keys(snapshot.zenonRedeems)).toHaveLength(0)
  })
})
```

Import `pendingZenonRedeemFor` from `./request-store`. Match the surrounding tests' storage-reset/beforeEach conventions exactly.

Note: if the existing suite asserts the OLD bare-hash keying (search it for `zenonRedeems`), update those assertions to the new full-id keys as part of this task — that behavior change is the point.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/request-store.test.ts`
Expected: FAIL — `pendingZenonRedeemFor` not exported; independence assertions fail under bare-hash keying.

- [ ] **Step 3: Implement in `request-store.ts`**

Add near the other pure helpers (uses the module's existing `normalizeEvmHash` import):

```ts
// Zenon redeem locks are keyed by the full `txHash:logIndex` id: an affiliate
// bonus request shares its tx hash with the main unwrap, and redeeming one
// must not lock or unlock the other. Entries persisted before this keying
// used the bare tx hash; those can only refer to main rows (bonus rows did
// not exist), so the legacy fallback is limited to logIndex below the
// affiliate threshold.
function normalizeUnwrapLockKey(id: string): string {
  const [hash, index] = id.split(':')
  return `${normalizeEvmHash(hash)}:${index}`
}

export function pendingZenonRedeemFor(
  zenonRedeems: Record<string, {hash: string; updatedAt?: number}>,
  id: string,
): string | undefined {
  const direct = zenonRedeems[normalizeUnwrapLockKey(id)]?.hash
  if (direct) return direct
  const [hash, index] = id.split(':')
  if (Number(index) >= AFFILIATE_LOG_INDEX_THRESHOLD) return undefined
  return zenonRedeems[normalizeEvmHash(hash)]?.hash
}
```

Import `AFFILIATE_LOG_INDEX_THRESHOLD` from `./affiliate`.

Replace `setPendingZenonRedeem`/`clearPendingZenonRedeem` (lines 397-410):

```ts
  async setPendingZenonRedeem(id: string, hash: string): Promise<boolean> {
    const key = normalizeUnwrapLockKey(id)
    await mutateLocks(() => [
      {scope: 'zenonRedeems', op: 'set', key, value: {hash, updatedAt: Date.now()}},
    ])
    return true
  },

  async clearPendingZenonRedeem(id: string): Promise<void> {
    const key = normalizeUnwrapLockKey(id)
    const [rawHash, index] = id.split(':')
    const legacyKey = normalizeEvmHash(rawHash)
    const clearLegacy = Number(index) < AFFILIATE_LOG_INDEX_THRESHOLD
    await mutateLocks(locks => {
      const ops: Array<{scope: 'zenonRedeems'; op: 'delete'; key: string}> = []
      if (locks.zenonRedeems[key]) ops.push({scope: 'zenonRedeems', op: 'delete', key})
      if (clearLegacy && locks.zenonRedeems[legacyKey]) {
        ops.push({scope: 'zenonRedeems', op: 'delete', key: legacyKey})
      }
      return ops
    })
  },
```

(Adapt the ops array's type to whatever `mutateLocks` actually expects — mirror the existing call sites.)

In the migration mirror (line ~196-201), key by full id:

```ts
      if (request.kind === 'unwrap' && request.pendingZenonRedeemHash) {
        locksMirror.zenonRedeems[normalizeUnwrapLockKey(request.id)] ??=
          {hash: request.pendingZenonRedeemHash}
        delete request.pendingZenonRedeemHash
        migrated = true
      }
```

- [ ] **Step 4: Update the reads in `useRequests.ts`**

Import `pendingZenonRedeemFor` from `../request-store`. Line ~433:

```ts
        let pendingZenonRedeemHash: string | undefined = pendingZenonRedeemFor(zenonRedeems, id)
```

Line ~545 (tracked-only rows, where `hash` and the tracked id are in scope — use the tracked request's full id):

```ts
          pendingZenonRedeemHash: pendingZenonRedeemFor(zenonRedeems, t.id),
```

(Verify variable names at the call site; the tracked request variable may be named differently — use its `.id`.)

- [ ] **Step 5: Run the full affected suites**

Run: `npx vitest run src/core/request-store.test.ts src/core/composables/useRequests.test.ts && npm run typecheck`
Expected: PASS. If `useRequests.test.ts` asserts bare-hash lock reads, update those fixtures to full-id keys (legacy-fallback behavior is covered by the new tests).

- [ ] **Step 6: Commit**

```bash
git add src/core/request-store.ts src/core/request-store.test.ts src/core/composables/useRequests.ts src/core/composables/useRequests.test.ts
git commit -m "fix: key zenon redeem locks by full request id for bonus-row independence"
```

---

### Task 4: Receiver string through `useUnwrap` and `EvmService.unwrap`

**Files:**
- Modify: `src/core/evm-service.ts:518-572` (`unwrap`), `:192-221` (`selectProvisionalLogIndex` doc/param rename only)
- Modify: `src/core/composables/useUnwrap.ts:61-162` (`unwrap`, `unwrapLocked`)
- Modify: `src/pages/Bridge.vue` `onUnwrapSubmit` (line ~694, the `doUnwrap(...)` call)
- Test: `src/core/evm-service.test.ts`, `src/core/composables/useUnwrap.test.ts`

**Interfaces:**
- Consumes: `selfReferralReceiver` (Task 1), `TokenPairView.unwrapBonusBps` (Task 2).
- Produces:
  - `useUnwrap.unwrap(token, amount, zenonAddress, bridge, zts, decimals, symbol, evmFromAddress, bonusActive: boolean)` — new trailing parameter, default `false`.
  - `EvmService.unwrap(bridge, token, amount, receiver, onSubmitted?)` — 4th param renamed `zenonAddress` → `receiver`; it is passed verbatim on-chain and matched verbatim against the event's `to`. No behavior change for bare addresses.

- [ ] **Step 1: Write the failing tests**

In `src/core/evm-service.test.ts` (find the existing `selectProvisionalLogIndex` tests and add alongside):

```ts
it('matches the exact concatenated self-referral receiver', () => {
  const receiver = 'z1qaddr&z1qaddr'
  const logs = [
    {logIndex: 3, args: {from: ACCOUNT, to: 'z1qaddr', token: TOKEN, amount: 5n}},
    {logIndex: 4, args: {from: ACCOUNT, to: receiver, token: TOKEN, amount: 5n}},
  ]
  expect(selectProvisionalLogIndex(logs, ACCOUNT, receiver, TOKEN, 5n)).toBe(4)
})
```

(Reuse the file's existing `ACCOUNT`/`TOKEN` fixtures; if named differently, use those names.)

In `src/core/composables/useUnwrap.test.ts`, find the test that drives a successful `unwrap(...)` against the mocked `EvmService` and add two cases:

1. `bonusActive: true` ⇒ the mocked `EvmService.unwrap` was called with receiver `` `${zenonAddress}&${zenonAddress}` `` **and** the tracked request (`requestStore.trackUnwrap` mock/spy) stored `zenonToAddress === zenonAddress` (the clean address).
2. `bonusActive` omitted ⇒ receiver is the bare `zenonAddress` (existing behavior pinned).

Follow the file's existing mock wiring exactly — only the new argument and assertions differ.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/evm-service.test.ts src/core/composables/useUnwrap.test.ts`
Expected: the evm-service case PASSES already (exact-match logic is unchanged — it documents the contract); the useUnwrap bonus case FAILS (no such parameter yet).

- [ ] **Step 3: Implement**

`src/core/evm-service.ts` — rename for honesty (mechanical): in `unwrap`, rename the `zenonAddress` parameter to `receiver` and update its two uses (`args: [token, amount, receiver]`, `selectProvisionalLogIndex(..., receiver, ...)`). Update the `selectProvisionalLogIndex` doc comment's "exact Zenon recipient" to "exact receiver string as sent (may be `addr&addr` for self-referral)"; rename its `zenonAddress` param to `receiver`.

`src/core/composables/useUnwrap.ts`:

1. Import: `import {selfReferralReceiver} from '../affiliate'`
2. `unwrap(...)` signature (line 61) gains trailing `bonusActive = false`; pass it to `unwrapLocked`.
3. `unwrapLocked(...)` gains trailing `bonusActive: boolean`; before the `evm.unwrap` call (line ~138):

```ts
    const receiver = bonusActive ? selfReferralReceiver(zenonAddress) : zenonAddress
    const {hash, provisionalLogIndex, eventMatched} = await evm.unwrap(
      bridge,
      token,
      amount,
      receiver,
      submittedHash => {
```

The `trackUnwrap` payload keeps `zenonToAddress: zenonAddress` (clean address) — do not change it.

`src/pages/Bridge.vue` `onUnwrapSubmit` — add the argument to the `doUnwrap` call:

```ts
    const result = await doUnwrap(
      pair.tokenAddress as Address,
      base,
      zenonAddress.value,
      bridge as Address,
      pair.zts,
      pair.decimals,
      pair.symbol,
      evmFrom,
      pair.unwrapBonusBps > 0,
    )
```

(The call currently ends after `evmFrom` — check the exact closing.)

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run src/core/evm-service.test.ts src/core/composables/useUnwrap.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/evm-service.ts src/core/evm-service.test.ts src/core/composables/useUnwrap.ts src/core/composables/useUnwrap.test.ts src/pages/Bridge.vue
git commit -m "feat: send self-referral receiver on unwrap when bonus is active"
```

---

### Task 5: Beneficiary-aware replacement matching

**Files:**
- Modify: `src/core/composables/useRequests.ts:84-95` (`matchesTrackedUnwrapEvent`)
- Test: `src/core/composables/useRequests.test.ts`

**Interfaces:**
- Consumes: `beneficiaryOf` (Task 1).
- Produces: `matchesTrackedUnwrapEvent` now matches when the event's `to` is either the bare tracked address or `tracked&anything` — pre-change tracked requests match post-change events and vice versa.

- [ ] **Step 1: Write the failing test**

Alongside the existing `matchesTrackedUnwrapEvent` tests:

```ts
it('matches a self-referral event by its beneficiary part', () => {
  const tracked = {zts: ZTS, amount: '5', zenonToAddress: 'z1qaddr'}
  const event = makeEvent({to: 'z1qaddr&z1qaddr', amount: 5n, token: TOKEN})
  expect(matchesTrackedUnwrapEvent(tracked, TOKEN, event)).toBe(true)
})

it('does not match when only the affiliate part equals the tracked address', () => {
  const tracked = {zts: ZTS, amount: '5', zenonToAddress: 'z1qaddr'}
  const event = makeEvent({to: 'z1qother&z1qaddr', amount: 5n, token: TOKEN})
  expect(matchesTrackedUnwrapEvent(tracked, TOKEN, event)).toBe(false)
})
```

(Use the file's existing event fixture helper; if none exists, build the `UnwrappedEventRecord` literal the same way neighboring tests do.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/composables/useRequests.test.ts`
Expected: first new case FAIL (`event.to === tracked.zenonToAddress` is strict equality).

- [ ] **Step 3: Implement**

```ts
  return (
    beneficiaryOf(event.to) === tracked.zenonToAddress &&
    event.amount.toString() === tracked.amount &&
    event.token.toLowerCase() === pairTokenAddress.toLowerCase()
  )
```

Import `beneficiaryOf` from `../affiliate`. Update the function's doc comment: "Requires the exact Zenon destination" → "Requires the exact Zenon beneficiary (the part of `to` before any `&` affiliate suffix)".

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/core/composables/useRequests.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/composables/useRequests.ts src/core/composables/useRequests.test.ts
git commit -m "fix: match replacement unwrap events by beneficiary part of receiver"
```

---

### Task 6: Direction-aware fee/bonus display on the Bridge form

**Files:**
- Modify: `src/pages/Bridge.vue:145-155` (`destinationAmount`), `:356-364` (`feePercentageLabel`, `rateLabel`), `:1173-1177` (template)

No dedicated unit tests: components aren't rendered in this suite, and the underlying math (bps gating) is covered by Task 1. Keep all math in `bigint`.

- [ ] **Step 1: Replace `destinationAmount`**

```ts
const destinationAmount = computed(() => {
  const pair = selectedPair.value
  if (!pair || !amount.value) return '0'
  try {
    const base = parseAmount(amount.value, pair.decimals)
    if (direction.value === 'wrap') {
      const fee = (base * BigInt(pair.feePercentage)) / FEE_DENOMINATOR
      return formatAmount(base - fee, pair.decimals)
    }
    const bonus = (base * BigInt(pair.unwrapBonusBps)) / FEE_DENOMINATOR
    return formatAmount(base + bonus, pair.decimals)
  } catch {
    return '0'
  }
})
```

- [ ] **Step 2: Replace the two label computeds with direction-aware ones**

```ts
const rateLabel = computed(() => {
  const pair = selectedPair.value
  const basisPoints = direction.value === 'wrap'
    ? -(pair?.feePercentage ?? 0)
    : (pair?.unwrapBonusBps ?? 0)
  const rate = (1 + basisPoints / Number(FEE_DENOMINATOR)).toFixed(4)
  return rate.replace(/0+$/, '').replace(/\.$/, '')
})
const feeSummaryLabel = computed(() => {
  const pair = selectedPair.value
  const formatBps = (bps: number) =>
    (bps / 100).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')
  if (direction.value === 'wrap') return `${formatBps(pair?.feePercentage ?? 0)}% bridge fee`
  const bonus = pair?.unwrapBonusBps ?? 0
  return bonus > 0 ? `includes ${formatBps(bonus)}% bonus` : 'no bridge fee'
})
```

Remove the old `feePercentageLabel` (its only consumer is the template line below).

- [ ] **Step 3: Update the template (lines ~1173-1177)**

```html
              1 {{ fromSide.symbol }} ≈ {{ rateLabel }} {{ toSide.symbol }} ·
              {{ feeSummaryLabel }}
```

(Keep surrounding markup untouched; only the second line changes from `{{ feePercentageLabel }}% bridge fee`.)

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npx vitest run`
Expected: PASS (no component tests exist; typecheck catches template/computed mismatches via vue-tsc).

Manual spot-check (optional but recommended): `npm run dev`, flip direction — wrap shows "≈ 0.97 · 3% bridge fee", unwrap shows "≈ 1.03 · includes 3% bonus".

- [ ] **Step 5: Commit**

```bash
git add src/pages/Bridge.vue
git commit -m "fix: direction-aware fee and bonus display on bridge form"
```

---

### Task 7: Bonus badge on unwrap rows

**Files:**
- Modify: `src/components/UnwrapRequestItem.vue:43-46`
- Modify: `src/pages/Requests.vue:97-100`

**Interfaces:**
- Consumes: `isAffiliateBonusLogIndex` (Task 1); `UnwrapRequestView.logIndex` (existing).

- [ ] **Step 1: UnwrapRequestItem.vue**

In the script block add:

```ts
import {isAffiliateBonusLogIndex} from '@/core/affiliate'

const isBonus = computed(() => isAffiliateBonusLogIndex(props.request.logIndex))
```

In `ItemTitle` (line ~43-46), after the amount/symbol text and before the status badge:

```html
        <Badge v-if="isBonus" variant="outline">Bonus</Badge>
```

- [ ] **Step 2: Requests.vue**

Import `isAffiliateBonusLogIndex` (extend the existing `@/core`-style imports; use the same path form the file already uses). In the unwrap row (line ~97-99), after the amount span:

```html
            <span class="block font-mono">
              {{ formatAmount(request.amount, request.decimals) }} {{ request.symbol }}
              <Badge v-if="isAffiliateBonusLogIndex(request.logIndex)" variant="outline">Bonus</Badge>
            </span>
```

- [ ] **Step 3: Verify and commit**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

```bash
git add src/components/UnwrapRequestItem.vue src/pages/Requests.vue
git commit -m "feat: label affiliate bonus rows in request lists"
```

---

### Task 8: Docs, full verification, wrap-up

**Files:**
- Modify: `docs/security-model.md`
- Modify: `CLAUDE.md` (bridge flows section, one sentence)

- [ ] **Step 1: security-model.md**

Add a subsection under the bridge-flow/safety material (match the doc's existing heading style):

```markdown
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
  program as active for the pair (`wZNN`/`wQSR` flags, `startingHeight > 0`);
  missing or malformed metadata fails safe to a bare receiver
  (`src/core/affiliate.ts#parseUnwrapBonusBps`).
- Tracked requests store the clean beneficiary address; the node's
  authoritative unwrap requests carry parsed clean addresses, so Zenon-side
  redeem and reconciliation are unchanged. Zenon redeem locks are keyed by
  `txHash:logIndex` because the bonus request shares the main request's tx
  hash.
```

- [ ] **Step 2: CLAUDE.md**

In the **Bridge flows** unwrap bullet, after "(simulated first, receipt required)", insert:

```
The unwrap receiver string is `zenonAddr&zenonAddr` (self-referral) whenever the bridge metadata's affiliate program is active for the pair, which yields a 1% + 2% bonus to the destination address (the 2% arrives as a separate unwrap request at logIndex + 4e9); see `src/core/affiliate.ts` and docs/security-model.md.
```

- [ ] **Step 3: Full verification**

Run: `npm run check`
Expected: lint, typecheck, coverage (aggregate + per-file floors), and production build all pass. If a per-file floor fails, add tests for the uncovered new branches — do not lower a floor.

- [ ] **Step 4: Commit**

```bash
git add docs/security-model.md CLAUDE.md
git commit -m "docs: document unwrap self-referral bonus and safety properties"
```
