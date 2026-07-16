# WalletConnect/Syrius Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Syrius wallet connect reliably over WalletConnect by adding the reference app's proven reliability layer, session restore, a Syrius-aware connect UX, and a fake-Syrius test harness with an automated integration test.

**Architecture:** All hardening lands inside the existing `ZenonWalletService` singleton (`src/core/zenon-wallet-service.ts`); pure helpers (timeout, delay, error classification, timing constants) live in a new `src/core/wc-reliability.ts`. A wallet-side WalletConnect client (`src/testing/fake-syrius-core.ts`) plays Syrius for both a CLI harness (`scripts/fake-syrius.ts`) and an opt-in integration test that runs over the real relay.

**Tech Stack:** Vue 3 + TypeScript + Vite, `@walletconnect/sign-client` v2 + `@walletconnect/modal` (deprecated, deliberately kept — Syrius interop is only proven on it), vitest (node env, mocked-boundary style), `tsx` (new devDependency, runs the CLI harness).

**Spec:** `docs/superpowers/specs/2026-07-16-walletconnect-completion-design.md`

## Global Constraints

- **FROZEN — never change:** the `zenon` namespace shape (`chains: ['zenon:1']`, methods `['znn_info','znn_sign','znn_send']`, events `['chainIdChange','addressChange']`) and the `znn_send` envelope `{fromAddress, accountBlock}` with `accountBlock` as a JSON **object**. These are proven against Syrius.
- Timing values (spec §1): request timeout **30 000 ms**; approval timeout **300 000 ms**; post-approval settle **5 000 ms**; relay-reconnect settle **2 000 ms**; max request attempts **3**.
- Code style: match the codebase — 2-space indent, no semicolons, single quotes, `{a, b}` import spacing. Target is ES2020 (no `Array.findLast`).
- Tests are co-located `src/**/*.test.ts`, node environment, mocked-boundary style (see `src/core/zenon-wallet-service.test.ts` — fakes via `vi.hoisted`, `vi.resetModules()` + dynamic import per test).
- **Unit-test env has no `VITE_WC_PROJECT_ID`**, so `config.ts` falls back to the placeholder. After Task 6 adds the placeholder guard, every test that calls `connect()` MUST first `vi.stubEnv('VITE_WC_PROJECT_ID', 'a'.repeat(32))` (done once in `beforeEach`). Task 6 includes that change; Tasks 2–5 don't need it because the guard doesn't exist yet.
- Out of scope: liquidity/staking/affiliate, Syrius browser-extension path, EVM-over-WC, MV3 extension context, AppKit migration, testnet.
- Work on branch `feature/walletconnect-syrius`. Run `npm run typecheck && npm run test` before every commit.

---

### Task 1: `wc-reliability` helper module

**Files:**
- Create: `src/core/wc-reliability.ts`
- Test: `src/core/wc-reliability.test.ts`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces (used by Tasks 2–6 and the service):
  - `WC_TIMING: {requestTimeoutMs: number; approvalTimeoutMs: number; settleMs: number; relaySettleMs: number; maxAttempts: number}` (mutable object — tests shrink values)
  - `withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T>`
  - `delay(ms: number): Promise<void>`
  - `type WalletErrorAction = 'reconnect' | 'retry' | 'locked' | 'rejected' | 'fatal'`
  - `classifyWalletError(e: unknown): WalletErrorAction`

- [ ] **Step 1: Write the failing test**

Create `src/core/wc-reliability.test.ts`:

```ts
import {describe, expect, it} from 'vitest'
import {classifyWalletError, delay, WC_TIMING, withTimeout} from './wc-reliability'

describe('withTimeout', () => {
  it('resolves with the value when the promise wins', async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, 'x')).resolves.toBe(42)
  })

  it('rejects with a labeled error when the timeout wins', async () => {
    const never = new Promise(() => {})
    await expect(withTimeout(never, 10, 'Syrius request (znn_info)')).rejects.toThrow(
      'Syrius request (znn_info) timed out — check that Syrius is open and responsive',
    )
  })

  it('propagates the original rejection', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000, 'x')).rejects.toThrow('boom')
  })
})

describe('delay', () => {
  it('resolves after the given time', async () => {
    const start = Date.now()
    await delay(20)
    expect(Date.now() - start).toBeGreaterThanOrEqual(15)
  })
})

describe('classifyWalletError', () => {
  const err = (code: number, message: string) => Object.assign(new Error(message), {code})

  it('classifies 5xxx as rejected', () => {
    expect(classifyWalletError(err(5000, 'User rejected'))).toBe('rejected')
    expect(classifyWalletError(err(5999, 'nope'))).toBe('rejected')
  })

  it('classifies 9000 wallet-locked as locked', () => {
    expect(classifyWalletError(err(9000, 'Wallet is locked'))).toBe('locked')
  })

  it('classifies -32602 "Bad state: No element" as reconnect', () => {
    expect(classifyWalletError(err(-32602, 'Bad state: No element'))).toBe('reconnect')
  })

  it('classifies -32602 "No matching key" as retry', () => {
    expect(classifyWalletError(err(-32602, 'No matching key. session topic doesn\'t exist'))).toBe('retry')
  })

  it('classifies everything else as fatal', () => {
    expect(classifyWalletError(err(-32602, 'something else'))).toBe('fatal')
    expect(classifyWalletError(new Error('plain'))).toBe('fatal')
    expect(classifyWalletError('string error')).toBe('fatal')
    expect(classifyWalletError(err(9000, 'other 9000'))).toBe('fatal')
  })
})

describe('WC_TIMING', () => {
  it('ships the spec values', () => {
    expect(WC_TIMING).toEqual({
      requestTimeoutMs: 30_000,
      approvalTimeoutMs: 300_000,
      settleMs: 5_000,
      relaySettleMs: 2_000,
      maxAttempts: 3,
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/wc-reliability.test.ts`
Expected: FAIL — "Cannot find module './wc-reliability'" (or equivalent resolve error).

- [ ] **Step 3: Write the implementation**

Create `src/core/wc-reliability.ts`:

```ts
// Reliability primitives for the Syrius/WalletConnect integration. The timing
// values and error taxonomy are inherited from the production reference dApp
// (github.com/0x3639/bridge-dapp), which accumulated them against real Syrius
// behavior. WC_TIMING is a mutable object so tests can shrink the waits.
export const WC_TIMING = {
  requestTimeoutMs: 30_000,
  approvalTimeoutMs: 300_000, // pairing approval is human-paced (manual URI paste)
  settleMs: 5_000, // SignClient's session store lags behind approval()
  relaySettleMs: 2_000,
  maxAttempts: 3,
}

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out — check that Syrius is open and responsive`)),
      ms,
    )
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

export type WalletErrorAction = 'reconnect' | 'retry' | 'locked' | 'rejected' | 'fatal'

// Known Syrius/WalletConnect failure modes and how to react to each.
export function classifyWalletError(e: unknown): WalletErrorAction {
  const code = (e as {code?: number})?.code
  const message = String((e as {message?: string})?.message ?? '')
  if (typeof code === 'number' && code >= 5000 && code < 6000) return 'rejected'
  if (code === 9000 && message.includes('Wallet is locked')) return 'locked'
  if (code === -32602 && message.includes('Bad state: No element')) return 'reconnect'
  if (code === -32602 && message.includes('No matching key')) return 'retry'
  return 'fatal'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/wc-reliability.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/wc-reliability.ts src/core/wc-reliability.test.ts
git commit -m "Add WalletConnect reliability primitives (timeout, delay, error taxonomy)"
```

---

### Task 2: Session-acquisition refactor, lazy modal, Syrius desktop entry, pairing-URI seam

**Files:**
- Modify: `src/core/zenon-wallet-service.ts`
- Test: `src/core/zenon-wallet-service.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (relied on by Tasks 3–6 and 9):
  - `ZenonWalletService.onPairingUri: ((uri: string) => void) | null` — when set, the modal is never constructed; the URI is handed to the callback (integration test / future custom UI).
  - private `findLiveZenonSession(client): SessionTypes.Struct | null`
  - private `ensureSession(): Promise<void>` — acquires a session (reuse or fresh pairing) WITHOUT calling `znn_info`. `connect()` becomes `ensureSession()` + `getInfo()`.
  - `@walletconnect/modal` becomes a **dynamic** import inside the fresh-pairing path only.

- [ ] **Step 1: Add failing tests for the modal config and the URI seam**

In `src/core/zenon-wallet-service.test.ts`, the modal mock must expose the constructor for assertions. Replace the existing modal mock line:

```ts
vi.mock('@walletconnect/modal', () => ({WalletConnectModal: vi.fn(() => h.modal)}))
```

with (add `modalCtor` to the hoisted block and reference it):

```ts
// inside vi.hoisted(() => { ... }) add:
//   modalCtor: vi.fn(() => modal),
// and change the mock to:
vi.mock('@walletconnect/modal', () => ({WalletConnectModal: h.modalCtor}))
```

Concretely, the hoisted block's return becomes:

```ts
  const modal = {openModal: vi.fn().mockResolvedValue(undefined), closeModal: vi.fn()}
  const modalCtor = vi.fn(() => modal)
  return {
    onHandlers,
    client,
    modal,
    modalCtor,
    initSpy: vi.fn(async () => client),
    fromJson: vi.fn((json: unknown) => ({fromJson: json})),
    addressParse: vi.fn((address: string) => address),
  }
```

Add `h.modalCtor.mockClear()` to the existing `beforeEach`.

Append to the `ZenonWalletService.connect — fresh pairing` describe block:

```ts
  it('configures the modal for Syrius: explorer off, syrius desktop deep-link', async () => {
    h.client.session.getAll.mockReturnValue([])
    h.client.connect.mockResolvedValue({
      uri: 'wc:deadbeef',
      approval: vi.fn().mockResolvedValue(zenonSession('topic-new', future())),
    })
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    await ZenonWalletService.getInstance().connect()

    expect(h.modalCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        enableExplorer: false,
        mobileWallets: [],
        desktopWallets: [
          expect.objectContaining({id: 'syrius', name: 'Syrius', links: expect.objectContaining({native: 'syrius:'})}),
        ],
      }),
    )
  })

  it('hands the uri to onPairingUri and skips the modal entirely when the seam is set', async () => {
    h.client.session.getAll.mockReturnValue([])
    h.client.connect.mockResolvedValue({
      uri: 'wc:seam',
      approval: vi.fn().mockResolvedValue(zenonSession('topic-seam', future())),
    })
    const {ZenonWalletService} = await import('./zenon-wallet-service')
    const service = ZenonWalletService.getInstance()
    const seen: string[] = []
    service.onPairingUri = uri => seen.push(uri)

    await service.connect()

    expect(seen).toEqual(['wc:seam'])
    expect(h.modalCtor).not.toHaveBeenCalled()
    expect(h.modal.openModal).not.toHaveBeenCalled()
  })
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run src/core/zenon-wallet-service.test.ts`
Expected: the two new tests FAIL (`onPairingUri` doesn't exist; modal config assertion mismatch). All pre-existing tests still PASS.

- [ ] **Step 3: Refactor the service**

In `src/core/zenon-wallet-service.ts`:

1. Remove the static modal import — delete line 2 (`import {WalletConnectModal} from '@walletconnect/modal'`).
2. Add the public seam field after `onInfoChange`:

```ts
  // When set, fresh pairings hand the URI to this callback instead of opening
  // the WalletConnect modal (used by the integration test harness).
  onPairingUri: ((uri: string) => void) | null = null
```

3. Replace the whole `connect()` method with:

```ts
  async connect(): Promise<ZenonWalletInfo> {
    await this.ensureSession()
    return this.getInfo()
  }

  private findLiveZenonSession(client: SignClientInstance): SessionTypes.Struct | null {
    // findLast over live zenon sessions (manual reverse scan — `Array.findLast`
    // needs lib ES2023, but this project targets ES2020).
    const sessions = client.session.getAll()
    for (let i = sessions.length - 1; i >= 0; i--) {
      const s = sessions[i]
      if (s.namespaces.zenon && s.expiry * 1000 > Date.now()) return s
    }
    return null
  }

  private async ensureSession(): Promise<void> {
    const client = await this.getClient()
    const existing = this.findLiveZenonSession(client)
    if (existing) {
      this.session = existing
      return
    }
    let modal: {openModal: (opts: {uri: string}) => Promise<unknown>; closeModal: () => void} | null = null
    try {
      const {uri, approval} = await client.connect({
        requiredNamespaces: {zenon: ZENON_NAMESPACE},
      })
      if (uri) {
        if (this.onPairingUri) {
          this.onPairingUri(uri)
        } else {
          const {WalletConnectModal} = await import('@walletconnect/modal')
          modal = new WalletConnectModal({
            projectId: WC_PROJECT_ID,
            chains: [ZENON_CHAIN],
            enableExplorer: false, // the WC explorer can never list Syrius
            mobileWallets: [],
            desktopWallets: [
              {
                id: 'syrius',
                name: 'Syrius',
                links: {native: 'syrius:', universal: 'https://zenon.network'},
              },
            ],
          })
          await modal.openModal({uri})
        }
      }
      this.session = await approval()
    } catch (e) {
      throw mapWcError(e)
    } finally {
      modal?.closeModal()
    }
  }
```

- [ ] **Step 4: Run the full unit suite**

Run: `npm run typecheck && npm run test`
Expected: typecheck clean; all tests PASS (the existing fresh-pairing/reuse/rejection tests exercise the refactored path unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/core/zenon-wallet-service.ts src/core/zenon-wallet-service.test.ts
git commit -m "Refactor session acquisition; Syrius-aware modal; pairing-URI seam"
```

---

### Task 3: Post-approval settle + session re-scan

**Files:**
- Modify: `src/core/zenon-wallet-service.ts` (inside `ensureSession`)
- Test: `src/core/zenon-wallet-service.test.ts`

**Interfaces:**
- Consumes: `delay`, `WC_TIMING` from `src/core/wc-reliability.ts` (Task 1); `findLiveZenonSession` (Task 2).
- Produces: after approval, `this.session` is the NEWEST live zenon session from a re-scan, falling back to the `approval()` result.

- [ ] **Step 1: Write the failing test**

Append a describe block to `src/core/zenon-wallet-service.test.ts`:

```ts
describe('ZenonWalletService.connect — post-approval settle', () => {
  it('re-scans the session store after approval and prefers the store copy', async () => {
    // First scan (reuse check): nothing. Post-approval scan: the store now has
    // the real session under a different topic than approval() returned.
    h.client.session.getAll
      .mockReturnValueOnce([])
      .mockReturnValue([zenonSession('topic-store', future())])
    h.client.connect.mockResolvedValue({
      uri: 'wc:settle',
      approval: vi.fn().mockResolvedValue(zenonSession('topic-approval', future())),
    })
    const {WC_TIMING} = await import('./wc-reliability')
    WC_TIMING.settleMs = 0
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    await ZenonWalletService.getInstance().connect()

    expect(h.client.request).toHaveBeenCalledWith(
      expect.objectContaining({topic: 'topic-store'}),
    )
  })

  it('falls back to the approval() session when the re-scan finds nothing', async () => {
    h.client.session.getAll.mockReturnValue([])
    h.client.connect.mockResolvedValue({
      uri: 'wc:settle2',
      approval: vi.fn().mockResolvedValue(zenonSession('topic-approval', future())),
    })
    const {WC_TIMING} = await import('./wc-reliability')
    WC_TIMING.settleMs = 0
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    await ZenonWalletService.getInstance().connect()

    expect(h.client.request).toHaveBeenCalledWith(
      expect.objectContaining({topic: 'topic-approval'}),
    )
  })
})
```

Note: `vi.resetModules()` in `beforeEach` gives each test a fresh `wc-reliability` module, so mutating `WC_TIMING` inside a test cannot leak into others. Import order matters: import `./wc-reliability` and mutate BEFORE importing `./zenon-wallet-service` is not required (both share the same module instance within a test), but mutate before calling `connect()`.

- [ ] **Step 2: Run to verify the first new test fails**

Run: `npx vitest run src/core/zenon-wallet-service.test.ts`
Expected: "re-scans the session store" FAILS (request went to `topic-approval`); fallback test passes already.

- [ ] **Step 3: Implement the settle**

In `ensureSession()` replace:

```ts
      this.session = await approval()
```

with:

```ts
      const approved = await approval()
      // The SignClient session store lags behind approval(); give it a moment,
      // then prefer the store's copy of the newest live zenon session.
      await delay(WC_TIMING.settleMs)
      this.session = this.findLiveZenonSession(client) ?? approved
```

Add to the imports at the top of the file:

```ts
import {delay, WC_TIMING, withTimeout, classifyWalletError} from './wc-reliability'
```

(`withTimeout`/`classifyWalletError` are used in Tasks 4–5; importing now avoids churn. If ESLint-style unused-import complaints arise from `vue-tsc`, import only `{delay, WC_TIMING}` here and extend in Task 4.)

- [ ] **Step 4: Run the full unit suite**

Run: `npm run test`
Expected: all PASS. If any pre-existing fresh-pairing test times out, it forgot the settle: those tests use the default `WC_TIMING.settleMs = 5000` — they still pass (vitest default timeout is 5 s per test; 5 s settle will be borderline). **Set `WC_TIMING.settleMs = 0` in the shared `beforeEach`** (after `vi.resetModules()` it must be re-imported and re-set inside each test that pairs freshly — simpler: add to the two existing fresh-pairing tests the same two lines used above). Expected final state: all PASS in <5 s.

- [ ] **Step 5: Commit**

```bash
git add src/core/zenon-wallet-service.ts src/core/zenon-wallet-service.test.ts
git commit -m "Settle and re-scan session store after pairing approval"
```

---

### Task 4: Request/approval timeouts + relay guard

**Files:**
- Modify: `src/core/zenon-wallet-service.ts`
- Test: `src/core/zenon-wallet-service.test.ts`

**Interfaces:**
- Consumes: `withTimeout`, `delay`, `WC_TIMING` (Task 1).
- Produces: every `request()` is preceded by a relay-connected check and raced against `WC_TIMING.requestTimeoutMs`; `approval()` raced against `WC_TIMING.approvalTimeoutMs`. The mock client grows `core: {relayer: {connected, transportOpen}}` — Tasks 5–6 tests rely on that fake existing.

- [ ] **Step 1: Extend the client fake and write failing tests**

In the hoisted block of `src/core/zenon-wallet-service.test.ts`, add a `core` property to the `client` fake:

```ts
  const client = {
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      onHandlers[event] = cb
    }),
    session: {getAll: vi.fn(() => [] as unknown[])},
    connect: vi.fn(),
    request: vi.fn(),
    disconnect: vi.fn().mockResolvedValue(undefined),
    core: {relayer: {connected: true, transportOpen: vi.fn().mockResolvedValue(undefined)}},
  }
```

In `beforeEach` add:

```ts
  h.client.core.relayer.connected = true
  h.client.core.relayer.transportOpen.mockClear()
```

Append a describe block:

```ts
describe('ZenonWalletService relay guard and timeouts', () => {
  it('reopens the relay transport before a request when disconnected', async () => {
    h.client.session.getAll.mockReturnValue([zenonSession('topic-A', future())])
    h.client.core.relayer.connected = false
    const {WC_TIMING} = await import('./wc-reliability')
    WC_TIMING.relaySettleMs = 0
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    await ZenonWalletService.getInstance().connect()

    expect(h.client.core.relayer.transportOpen).toHaveBeenCalled()
    const openOrder = h.client.core.relayer.transportOpen.mock.invocationCallOrder[0]
    const requestOrder = h.client.request.mock.invocationCallOrder[0]
    expect(openOrder).toBeLessThan(requestOrder)
  })

  it('does not touch the transport when the relay is connected', async () => {
    h.client.session.getAll.mockReturnValue([zenonSession('topic-A', future())])
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    await ZenonWalletService.getInstance().connect()

    expect(h.client.core.relayer.transportOpen).not.toHaveBeenCalled()
  })

  it('times out a hanging request with a Syrius-flavored error', async () => {
    h.client.session.getAll.mockReturnValue([zenonSession('topic-A', future())])
    h.client.request.mockReturnValue(new Promise(() => {}))
    const {WC_TIMING} = await import('./wc-reliability')
    WC_TIMING.requestTimeoutMs = 10
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    await expect(ZenonWalletService.getInstance().connect()).rejects.toThrow(
      'timed out — check that Syrius is open and responsive',
    )
  })

  it('times out a never-approved pairing', async () => {
    h.client.session.getAll.mockReturnValue([])
    h.client.connect.mockResolvedValue({
      uri: 'wc:hang',
      approval: vi.fn().mockReturnValue(new Promise(() => {})),
    })
    const {WC_TIMING} = await import('./wc-reliability')
    WC_TIMING.approvalTimeoutMs = 10
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    await expect(ZenonWalletService.getInstance().connect()).rejects.toThrow('timed out')
    expect(h.modal.closeModal).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run src/core/zenon-wallet-service.test.ts`
Expected: relay-guard test FAILS (`transportOpen` never called); both timeout tests FAIL (they hang until vitest's 5 s test timeout, reported as timeouts). The "does not touch" test passes vacuously.

- [ ] **Step 3: Implement**

In `src/core/zenon-wallet-service.ts`:

1. Ensure the import from Task 3 includes `withTimeout`:

```ts
import {classifyWalletError, delay, WC_TIMING, withTimeout} from './wc-reliability'
```

(`classifyWalletError` becomes used in Task 5; if `vue-tsc` flags it as unused now, defer adding it until Task 5.)

2. Add the relay guard method:

```ts
  private async ensureRelayConnected(client: SignClientInstance): Promise<void> {
    if (client.core.relayer.connected) return
    // A request sent into a dead relay (e.g. after laptop sleep) vanishes
    // silently; reopen the transport and let it settle first.
    await client.core.relayer.transportOpen()
    await delay(WC_TIMING.relaySettleMs)
  }
```

3. Replace the body of `request()`:

```ts
  private async request<T>(method: string, params: unknown): Promise<T> {
    const client = await this.getClient()
    if (!this.session) throw new Error('No active Zenon session')
    await this.ensureRelayConnected(client)
    try {
      return await withTimeout(
        client.request<T>({
          topic: this.session.topic,
          chainId: ZENON_CHAIN,
          request: {method, params},
        }),
        WC_TIMING.requestTimeoutMs,
        `Syrius request (${method})`,
      )
    } catch (e) {
      throw mapWcError(e)
    }
  }
```

4. In `ensureSession()` (Task 3 version), wrap the approval:

```ts
      const approved = await withTimeout(approval(), WC_TIMING.approvalTimeoutMs, 'Wallet approval')
```

- [ ] **Step 4: Run the full unit suite**

Run: `npm run typecheck && npm run test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/zenon-wallet-service.ts src/core/zenon-wallet-service.test.ts
git commit -m "Add request/approval timeouts and relay reconnect guard"
```

---

### Task 5: Retry loop with the Syrius error map

**Files:**
- Modify: `src/core/zenon-wallet-service.ts`
- Test: `src/core/zenon-wallet-service.test.ts`

**Interfaces:**
- Consumes: `classifyWalletError`, `WC_TIMING.maxAttempts` (Task 1); `ensureSession` (Task 2).
- Produces: private `requestWithRetry<T>(method, params): Promise<T>` used by `getInfo()` and `send()`. Error-message contract (UI copy relies on these exact strings):
  - locked → `'Your wallet is locked — please unlock Syrius'`
  - rejected → `'Request rejected in the wallet'` (unchanged)
  - after exhausted retries / fatal → whatever `mapWcError` yields.
  - `request()` now throws RAW WC errors; mapping happens in `requestWithRetry` and `ensureSession` only.

- [ ] **Step 1: Write failing tests**

Append to `src/core/zenon-wallet-service.test.ts`:

```ts
describe('ZenonWalletService retry + Syrius error map', () => {
  const wcError = (code: number, message: string) => Object.assign(new Error(message), {code})

  it('surfaces wallet-locked immediately without retrying', async () => {
    h.client.session.getAll.mockReturnValue([zenonSession('topic-A', future())])
    h.client.request.mockRejectedValue(wcError(9000, 'Wallet is locked'))
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    await expect(ZenonWalletService.getInstance().connect()).rejects.toThrow(
      'Your wallet is locked — please unlock Syrius',
    )
    expect(h.client.request).toHaveBeenCalledTimes(1)
  })

  it('surfaces rejection immediately without retrying', async () => {
    h.client.session.getAll.mockReturnValue([zenonSession('topic-A', future())])
    h.client.request.mockRejectedValue(wcError(5000, 'User rejected'))
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    await expect(ZenonWalletService.getInstance().connect()).rejects.toThrow(
      'Request rejected in the wallet',
    )
    expect(h.client.request).toHaveBeenCalledTimes(1)
  })

  it('retries after "No matching key" and succeeds', async () => {
    h.client.session.getAll.mockReturnValue([zenonSession('topic-A', future())])
    h.client.request
      .mockRejectedValueOnce(wcError(-32602, 'No matching key. session topic doesn\'t exist'))
      .mockResolvedValueOnce({address: 'z1addr', chainId: 1})
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    const info = await ZenonWalletService.getInstance().connect()

    expect(info.address).toBe('z1addr')
    expect(h.client.request).toHaveBeenCalledTimes(2)
  })

  it('re-acquires the session after "Bad state: No element" and retries', async () => {
    h.client.session.getAll.mockReturnValue([zenonSession('topic-A', future())])
    h.client.request
      .mockRejectedValueOnce(wcError(-32602, 'Bad state: No element'))
      .mockResolvedValueOnce({address: 'z1addr', chainId: 1})
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    const info = await ZenonWalletService.getInstance().connect()

    expect(info.address).toBe('z1addr')
    // reuse-scan on connect + re-acquire scan after the bad-state error
    expect(h.client.session.getAll.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(h.client.request).toHaveBeenCalledTimes(2)
  })

  it('gives up after maxAttempts retryable failures', async () => {
    h.client.session.getAll.mockReturnValue([zenonSession('topic-A', future())])
    h.client.request.mockRejectedValue(wcError(-32602, 'No matching key. nope'))
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    await expect(ZenonWalletService.getInstance().connect()).rejects.toThrow()
    expect(h.client.request).toHaveBeenCalledTimes(3)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/core/zenon-wallet-service.test.ts`
Expected: all five new tests FAIL (no retry loop exists; locked/rejected surface the generic mapped message; retry tests see only 1 call).

- [ ] **Step 3: Implement**

In `src/core/zenon-wallet-service.ts`:

1. `request()` throws raw — remove the try/catch added in Task 4 Step 3.3 so it becomes:

```ts
  private async request<T>(method: string, params: unknown): Promise<T> {
    const client = await this.getClient()
    if (!this.session) throw new Error('No active Zenon session')
    await this.ensureRelayConnected(client)
    return withTimeout(
      client.request<T>({
        topic: this.session.topic,
        chainId: ZENON_CHAIN,
        request: {method, params},
      }),
      WC_TIMING.requestTimeoutMs,
      `Syrius request (${method})`,
    )
  }
```

2. Add the retry wrapper below `request()`:

```ts
  private async requestWithRetry<T>(method: string, params: unknown): Promise<T> {
    let lastError: unknown = null
    for (let attempt = 1; attempt <= WC_TIMING.maxAttempts; attempt++) {
      try {
        return await this.request<T>(method, params)
      } catch (e) {
        lastError = e
        switch (classifyWalletError(e)) {
          case 'locked':
            throw new Error('Your wallet is locked — please unlock Syrius')
          case 'rejected':
            throw new Error('Request rejected in the wallet')
          case 'reconnect':
            // Known Syrius desync ("Bad state: No element"): drop the session
            // and re-acquire before the next attempt.
            this.session = null
            await this.ensureSession()
            break
          case 'retry':
            break
          case 'fatal':
            throw mapWcError(e)
        }
      }
    }
    throw mapWcError(lastError)
  }
```

3. Point `getInfo()` and `send()` at it:

```ts
  async getInfo(): Promise<ZenonWalletInfo> {
    const info = await this.requestWithRetry<ZenonWalletInfo>('znn_info', undefined)
    return validateZenonWalletInfo(info)
  }
```

and inside `send()` change `this.request<unknown>(…)` to `this.requestWithRetry<unknown>(…)`.

4. Ensure the wc-reliability import now includes `classifyWalletError`.

- [ ] **Step 4: Run the full unit suite**

Run: `npm run typecheck && npm run test`
Expected: all PASS, including all pre-existing tests (the 5xxx behavior is unchanged in wording; timeout errors classify as `fatal` and pass through `mapWcError` unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/core/zenon-wallet-service.ts src/core/zenon-wallet-service.test.ts
git commit -m "Retry znn_info/znn_send with Syrius error map (locked, bad-state reconnect)"
```

---

### Task 6: Placeholder project-ID guard + `restore()`

**Files:**
- Modify: `src/core/zenon-wallet-service.ts`
- Test: `src/core/zenon-wallet-service.test.ts`

**Interfaces:**
- Consumes: `WC_PROJECT_ID` from `@/config` (existing).
- Produces:
  - `connect()` throws `Error('WalletConnect is not configured — set VITE_WC_PROJECT_ID in .env (see .env.example)')` when the project ID is missing/placeholder.
  - `restore(): Promise<ZenonWalletInfo | null>` — non-interactive: returns `null` (never throws, never opens a modal) when unconfigured, no live session, or `znn_info` fails; otherwise adopts the session and returns the validated info. Task 7's composable calls this.

- [ ] **Step 1: Stub a real project ID for existing tests, then write failing tests**

The unit-test env has no `VITE_WC_PROJECT_ID`, so `config.ts` currently evaluates to the placeholder — the new guard would break every `connect()` test. In the existing `beforeEach`, BEFORE `vi.resetModules()` takes effect for the next import, add:

```ts
  vi.stubEnv('VITE_WC_PROJECT_ID', 'a'.repeat(32))
```

and in `afterEach` (alongside `vi.unstubAllGlobals()`):

```ts
  vi.unstubAllEnvs()
```

Then append:

```ts
describe('ZenonWalletService placeholder guard and restore', () => {
  it('connect() fails fast with setup instructions when the project id is the placeholder', async () => {
    vi.stubEnv('VITE_WC_PROJECT_ID', 'REPLACE_ME_WC_PROJECT_ID')
    vi.resetModules()
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    await expect(ZenonWalletService.getInstance().connect()).rejects.toThrow(
      'set VITE_WC_PROJECT_ID in .env',
    )
    expect(h.initSpy).not.toHaveBeenCalled()
  })

  it('restore() returns null when unconfigured, without initializing the client', async () => {
    vi.stubEnv('VITE_WC_PROJECT_ID', 'REPLACE_ME_WC_PROJECT_ID')
    vi.resetModules()
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    await expect(ZenonWalletService.getInstance().restore()).resolves.toBeNull()
    expect(h.initSpy).not.toHaveBeenCalled()
  })

  it('restore() returns null when there is no live session', async () => {
    h.client.session.getAll.mockReturnValue([])
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    await expect(ZenonWalletService.getInstance().restore()).resolves.toBeNull()
    expect(h.client.connect).not.toHaveBeenCalled()
  })

  it('restore() adopts a live session and returns wallet info', async () => {
    h.client.session.getAll.mockReturnValue([zenonSession('topic-A', future())])
    const {ZenonWalletService} = await import('./zenon-wallet-service')

    const info = await ZenonWalletService.getInstance().restore()

    expect(info).toEqual({address: 'z1addr', chainId: 1})
    expect(h.client.connect).not.toHaveBeenCalled()
    expect(h.modal.openModal).not.toHaveBeenCalled()
  })

  it('restore() swallows znn_info failures and returns null', async () => {
    h.client.session.getAll.mockReturnValue([zenonSession('topic-A', future())])
    h.client.request.mockRejectedValue(new Error('node unreachable'))
    const {WC_TIMING} = await import('./wc-reliability')
    WC_TIMING.maxAttempts = 1
    const {ZenonWalletService} = await import('./zenon-wallet-service')
    const service = ZenonWalletService.getInstance()

    await expect(service.restore()).resolves.toBeNull()
    // the dead session was dropped: nothing to request on afterwards
    await expect(service.getInfo()).rejects.toThrow('No active Zenon session')
  })
})
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run src/core/zenon-wallet-service.test.ts`
Expected: guard tests FAIL (connect proceeds), restore tests FAIL (`restore` is not a function). Pre-existing tests all PASS (they now see a stubbed real-looking id).

- [ ] **Step 3: Implement**

In `src/core/zenon-wallet-service.ts`:

1. Add a module-level helper below `ZENON_NAMESPACE`:

```ts
function isWcConfigured(): boolean {
  return Boolean(WC_PROJECT_ID) && WC_PROJECT_ID !== 'REPLACE_ME_WC_PROJECT_ID'
}
```

2. First line of `connect()`:

```ts
  async connect(): Promise<ZenonWalletInfo> {
    if (!isWcConfigured()) {
      throw new Error('WalletConnect is not configured — set VITE_WC_PROJECT_ID in .env (see .env.example)')
    }
    await this.ensureSession()
    return this.getInfo()
  }
```

3. Add `restore()` after `connect()`:

```ts
  // Non-interactive session restore for app startup: adopt a still-live
  // session so a page refresh doesn't show "disconnected". Never opens the
  // modal and never throws — absence of a session is a normal outcome.
  async restore(): Promise<ZenonWalletInfo | null> {
    if (!isWcConfigured()) return null
    try {
      const client = await this.getClient()
      const existing = this.findLiveZenonSession(client)
      if (!existing) return null
      this.session = existing
      return await this.getInfo()
    } catch {
      this.session = null
      return null
    }
  }
```

- [ ] **Step 4: Run the full unit suite**

Run: `npm run typecheck && npm run test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/zenon-wallet-service.ts src/core/zenon-wallet-service.test.ts
git commit -m "Fail fast on placeholder WC project id; add non-interactive restore()"
```

---

### Task 7: Restore-on-load in the composable, connect-button helper text, stale-comment cleanup

**Files:**
- Modify: `src/core/composables/useZenonWallet.ts`
- Modify: `src/components/ConnectZenonButton.vue`
- Modify: `src/core/zenon-wallet-service.ts` (comment only)
- Modify: `src/core/request-store.ts` (comment only)

**Interfaces:**
- Consumes: `service.restore()` (Task 6).
- Produces: `useZenonWallet().address` is populated on app load when a live WC session exists. No new API.

Note: there is no automated test for the module-level restore side effect (module init isn't re-runnable under the existing mock style, and `restore()` is already fully unit-tested at the service level in Task 6). In unit-test runs of OTHER suites that import the real composable, `restore()` is a synchronous `null` no-op because the test env has a placeholder project id — no mocking changes needed. Verification is the full-suite run plus the manual harness test in Task 9.

- [ ] **Step 1: Wire restore into the composable**

In `src/core/composables/useZenonWallet.ts`, after the `service.onInfoChange = …` block (line 16), add:

```ts
// Adopt a still-live WalletConnect session on app load so a page refresh
// doesn't present as "disconnected". No-op when nothing is restorable.
void service
  .restore()
  .then(info => {
    if (info && !address.value) address.value = info.address
  })
  .catch(() => {})
```

In the same file, delete the stale comment line 33:

```ts
  // WIRED now, first USED in Phase 3.
```

- [ ] **Step 2: Delete the remaining stale phase comments**

- `src/core/zenon-wallet-service.ts`: delete the line `// WIRED now, first USED in Phase 3. Do not call it this phase.` above `send()`.
- `src/core/request-store.ts` around line 52: delete the stale `Phase 5` comment line above `prune` (keep any part of the comment that still describes actual behavior; drop the phase reference).

- [ ] **Step 3: Add the helper text to the connect button**

In `src/components/ConnectZenonButton.vue`, replace the template with:

```vue
<template>
  <Button v-if="!address" :disabled="isConnecting" @click="connect().catch(() => {})">
    {{ isConnecting ? 'Connecting…' : 'Connect Zenon' }}
  </Button>
  <Button v-else variant="outline" @click="disconnect().catch(() => {})">
    <span class="mr-2 inline-block w-2 h-2 rounded-full bg-primary" />{{ truncate(address) }} · Disconnect
  </Button>
  <p v-if="!address && isConnecting" class="mt-1 text-xs text-muted-foreground">
    Approve in Syrius — if nothing opens, copy the link from the QR screen and paste it into Syrius's WalletConnect tab.
  </p>
</template>
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run test && npm run build`
Expected: all clean/passing. Then `npm run dev`, open the app: with no session the button reads "Connect Zenon"; clicking it opens the modal (QR + copy button) with no explorer wallet list; the helper line appears while connecting.

- [ ] **Step 5: Commit**

```bash
git add src/core/composables/useZenonWallet.ts src/components/ConnectZenonButton.vue src/core/zenon-wallet-service.ts src/core/request-store.ts
git commit -m "Restore WC session on load; Syrius pairing hint; drop stale phase comments"
```

---

### Task 8: Fake-Syrius wallet core + CLI harness

**Files:**
- Create: `src/testing/fake-syrius-core.ts`
- Create: `scripts/fake-syrius.ts`
- Modify: `package.json` (devDependency `tsx`, script `fake-wallet`)

**Interfaces:**
- Consumes: `@walletconnect/sign-client` (wallet role). Nothing from the app.
- Produces (Task 9's integration test imports these EXACT names):

```ts
export const FAKE_SYRIUS_ADDRESS: string
export interface FakeSyriusFlags {reject?: boolean; locked?: boolean; hang?: boolean; badState?: boolean}
export interface FakeSyrius {
  pair(uri: string): Promise<void>
  setFlags(flags: FakeSyriusFlags): void
  disconnectAll(): Promise<void>
  close(): Promise<void>
}
export function createFakeSyrius(options: {projectId: string} & FakeSyriusFlags): Promise<FakeSyrius>
```

- [ ] **Step 1: Add the tsx devDependency and npm script**

```bash
npm install -D tsx
```

In `package.json` scripts add:

```json
    "fake-wallet": "tsx scripts/fake-syrius.ts"
```

- [ ] **Step 2: Write the wallet core**

Create `src/testing/fake-syrius-core.ts`:

```ts
import {SignClient} from '@walletconnect/sign-client'
import {createHash} from 'node:crypto'

// A real, well-formed Zenon address (the plasma embedded contract) so the
// dApp's Address.parse validation passes. Node-only module: used by the CLI
// harness (scripts/fake-syrius.ts) and the integration test — never bundled
// into the app.
export const FAKE_SYRIUS_ADDRESS = 'z1qxemdeddedxplasmaxxxxxxxxxxxxxxxsctrp'

export interface FakeSyriusFlags {
  reject?: boolean
  locked?: boolean
  hang?: boolean
  badState?: boolean
}

export interface FakeSyrius {
  pair(uri: string): Promise<void>
  setFlags(flags: FakeSyriusFlags): void
  disconnectAll(): Promise<void>
  close(): Promise<void>
}

type WalletClient = Awaited<ReturnType<typeof SignClient.init>>

export async function createFakeSyrius(
  options: {projectId: string} & FakeSyriusFlags,
): Promise<FakeSyrius> {
  const flags: FakeSyriusFlags = {
    reject: options.reject,
    locked: options.locked,
    hang: options.hang,
    badState: options.badState,
  }
  let badStateFired = false

  const client: WalletClient = await SignClient.init({
    projectId: options.projectId,
    metadata: {
      name: 'Fake Syrius',
      description: 'Headless Syrius stand-in for NoM Bridge testing',
      url: 'https://example.invalid',
      icons: [],
    },
  })

  client.on('session_proposal', proposal => {
    void (async () => {
      const zenon = proposal.params.requiredNamespaces.zenon
      const chains = zenon?.chains ?? ['zenon:1']
      const {acknowledged} = await client.approve({
        id: proposal.id,
        namespaces: {
          zenon: {
            accounts: chains.map(chain => `${chain}:${FAKE_SYRIUS_ADDRESS}`),
            methods: zenon?.methods ?? ['znn_info', 'znn_sign', 'znn_send'],
            events: zenon?.events ?? ['chainIdChange', 'addressChange'],
          },
        },
      })
      await acknowledged()
      console.log('[fake-syrius] session approved')
    })()
  })

  client.on('session_request', event => {
    const {topic, id, params} = event
    const respond = (result: unknown) =>
      client.respond({topic, response: {id, jsonrpc: '2.0', result}})
    const respondError = (code: number, message: string) =>
      client.respond({topic, response: {id, jsonrpc: '2.0', error: {code, message}}})

    void (async () => {
      const method = params.request.method
      console.log(`[fake-syrius] ${method} requested`)
      if (flags.hang) return // exercise the dApp's request timeout
      if (flags.locked) return respondError(9000, 'Wallet is locked')
      if (flags.reject) return respondError(5000, 'User rejected')
      if (flags.badState && !badStateFired) {
        badStateFired = true
        return respondError(-32602, 'Bad state: No element')
      }
      if (method === 'znn_info') {
        return respond({address: FAKE_SYRIUS_ADDRESS, chainId: 1, nodeUrl: 'wss://fake.node.invalid'})
      }
      if (method === 'znn_send') {
        const block = (params.request.params as {accountBlock: Record<string, unknown>}).accountBlock
        // Echo the block back "published": deterministic fake hash, filled
        // publicKey/signature. No signing, no broadcast.
        const hash = createHash('sha256').update(JSON.stringify(block)).digest('hex')
        return respond({
          ...block,
          hash,
          publicKey: (block.publicKey as string) || 'ZmFrZS1wdWJrZXk=',
          signature: (block.signature as string) || 'ZmFrZS1zaWduYXR1cmU=',
        })
      }
      if (method === 'znn_sign') {
        return respond('ZmFrZS1zaWduYXR1cmU=')
      }
      return respondError(4001, `Unsupported method ${method}`)
    })()
  })

  return {
    async pair(uri: string): Promise<void> {
      await client.core.pairing.pair({uri})
    },
    setFlags(next: FakeSyriusFlags): void {
      Object.assign(flags, next)
      badStateFired = false
    },
    async disconnectAll(): Promise<void> {
      for (const session of client.session.getAll()) {
        await client.disconnect({
          topic: session.topic,
          reason: {code: 6000, message: 'Fake wallet disconnected'},
        })
      }
    },
    async close(): Promise<void> {
      await client.core.relayer.transportClose()
    },
  }
}
```

- [ ] **Step 3: Write the CLI wrapper**

Create `scripts/fake-syrius.ts`:

```ts
import {readFileSync} from 'node:fs'
import {createFakeSyrius, FAKE_SYRIUS_ADDRESS} from '../src/testing/fake-syrius-core'

function readProjectId(): string {
  if (process.env.VITE_WC_PROJECT_ID) return process.env.VITE_WC_PROJECT_ID
  try {
    const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
    const match = env.match(/^VITE_WC_PROJECT_ID=(.+)$/m)
    if (match) return match[1].trim()
  } catch {
    // no .env — fall through
  }
  return ''
}

const args = process.argv.slice(2)
const flags = {
  reject: args.includes('--reject'),
  locked: args.includes('--locked'),
  hang: args.includes('--hang'),
  badState: args.includes('--bad-state'),
}
const uri = args.find(a => a.startsWith('wc:'))

if (!uri) {
  console.error('Usage: npm run fake-wallet -- "<wc:… uri>" [--reject|--locked|--hang|--bad-state]')
  console.error('Copy the URI from the WalletConnect modal (QR screen → copy button).')
  process.exit(1)
}

const projectId = readProjectId()
if (!projectId || projectId === 'REPLACE_ME_WC_PROJECT_ID') {
  console.error('Set VITE_WC_PROJECT_ID in .env first.')
  process.exit(1)
}

const wallet = await createFakeSyrius({projectId, ...flags})
console.log(`[fake-syrius] acting as ${FAKE_SYRIUS_ADDRESS}`)
console.log('[fake-syrius] flags:', JSON.stringify(flags))
await wallet.pair(uri)
console.log('[fake-syrius] pairing initiated — leave this running; Ctrl-C to quit')
await new Promise(() => {}) // keep the relay connection alive
```

- [ ] **Step 4: Smoke-test the CLI**

Run: `npm run fake-wallet`
Expected: exits 1 with the usage message (no URI given).

Run: `npm run typecheck && npm run test`
Expected: clean — `src/testing/fake-syrius-core.ts` typechecks (uses `@types/node` for `node:crypto`); no test picks it up. Note: `scripts/` is outside the app graph; `vue-tsc` checks `fake-syrius-core.ts` because it's under `src/`, while `scripts/fake-syrius.ts` is only exercised by `tsx` at runtime.

- [ ] **Step 5: Commit**

```bash
git add src/testing/fake-syrius-core.ts scripts/fake-syrius.ts package.json package-lock.json
git commit -m "Add headless fake-Syrius WalletConnect harness"
```

---

### Task 9: Integration test over the real relay

**Files:**
- Create: `vitest.integration.config.ts`
- Create: `src/core/zenon-wallet-service.integration.test.ts`
- Modify: `vitest.config.ts` (exclude integration tests from the default run)
- Modify: `package.json` (script `test:integration`)

**Interfaces:**
- Consumes: `ZenonWalletService` (with `onPairingUri` from Task 2, `restore` from Task 6), `createFakeSyrius`/`FAKE_SYRIUS_ADDRESS` (Task 8).
- Produces: `npm run test:integration` — skips cleanly without a real `VITE_WC_PROJECT_ID`, otherwise exercises pairing → approval → `znn_info` → `znn_send` → rejection mapping → `session_delete` over the live relay.

- [ ] **Step 1: Exclude integration tests from the default run**

In `vitest.config.ts`, add an `exclude` to the `test` block:

```ts
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/*.integration.test.ts'],
  },
```

Create `vitest.integration.config.ts`:

```ts
import {defineConfig} from 'vitest/config'
import {loadEnv} from 'vite'
import {resolve} from 'path'

// Opt-in integration config: talks to the real WalletConnect relay. Loads
// VITE_* vars from .env so the project id is available as process.env inside
// the test (the default unit config deliberately loads nothing).
export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    env: loadEnv('', process.cwd(), 'VITE_'),
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
```

In `package.json` scripts add:

```json
    "test:integration": "vitest run --config vitest.integration.config.ts"
```

- [ ] **Step 2: Write the integration test**

Create `src/core/zenon-wallet-service.integration.test.ts`:

```ts
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest'
import {createFakeSyrius, FAKE_SYRIUS_ADDRESS, type FakeSyrius} from '../testing/fake-syrius-core'

// End-to-end over the REAL WalletConnect relay: the actual ZenonWalletService
// (dApp role) against the fake-Syrius harness (wallet role) in one process.
// Regression guard for the namespace shape and the znn_send envelope — if
// either drifts from what Syrius accepts, approval or the round-trips break.
const projectId = process.env.VITE_WC_PROJECT_ID
const configured = Boolean(projectId) && projectId !== 'REPLACE_ME_WC_PROJECT_ID'

// A syntactically complete AccountBlockTemplate JSON (the wallet fills the
// chain-state fields in real life; the fake echoes them back untouched).
const WRAP_BLOCK_JSON = {
  version: 1,
  chainIdentifier: 1,
  blockType: 2,
  hash: '0000000000000000000000000000000000000000000000000000000000000000',
  previousHash: '0000000000000000000000000000000000000000000000000000000000000000',
  height: 0,
  momentumAcknowledged: {
    hash: '0000000000000000000000000000000000000000000000000000000000000000',
    height: 0,
  },
  address: FAKE_SYRIUS_ADDRESS,
  toAddress: 'z1qxemdeddedxdrydgexxxxxxxxxxxxxxxmqgr0d',
  amount: '100000000',
  tokenStandard: 'zts1znnxxxxxxxxxxxxx9z4ulx',
  fromBlockHash: '0000000000000000000000000000000000000000000000000000000000000000',
  data: '',
  fusedPlasma: 0,
  difficulty: 0,
  nonce: '0000000000000000',
  publicKey: '',
  signature: '',
}

describe.skipIf(!configured)('ZenonWalletService ↔ fake Syrius over the live relay', () => {
  let wallet: FakeSyrius

  beforeAll(async () => {
    vi.stubGlobal('window', {location: {origin: 'http://localhost:5173'}})
    wallet = await createFakeSyrius({projectId: projectId as string})
  })

  afterAll(async () => {
    await wallet?.close()
    vi.unstubAllGlobals()
  })

  it('pairs, approves our exact namespace, and round-trips znn_info + znn_send', async () => {
    const {ZenonWalletService} = await import('./zenon-wallet-service')
    const {AccountBlockTemplate} = await import('znn-typescript-sdk')
    const service = ZenonWalletService.getInstance()
    const onDisconnect = vi.fn()
    service.onDisconnect = onDisconnect
    service.onPairingUri = uri => void wallet.pair(uri)

    // Pairing + approval: only succeeds if the wallet can approve our
    // requiredNamespaces verbatim.
    const info = await service.connect()
    expect(info.address).toBe(FAKE_SYRIUS_ADDRESS)
    expect(info.chainId).toBe(1)

    // znn_send round-trip through the real SDK types.
    const block = AccountBlockTemplate.fromJson(WRAP_BLOCK_JSON as never)
    const published = await service.send(FAKE_SYRIUS_ADDRESS, block)
    expect(published.hash.toString()).toMatch(/^[0-9a-f]{64}$/i)

    // Rejection mapping: flag the fake to reject, expect the friendly message.
    wallet.setFlags({reject: true})
    await expect(service.send(FAKE_SYRIUS_ADDRESS, block)).rejects.toThrow(
      'Request rejected in the wallet',
    )
    wallet.setFlags({reject: false})

    // Wallet-side disconnect propagates as session_delete → local state clears.
    await wallet.disconnectAll()
    await vi.waitFor(() => expect(onDisconnect).toHaveBeenCalled(), {timeout: 30_000})
    await expect(service.getInfo()).rejects.toThrow('No active Zenon session')
  })
})
```

- [ ] **Step 3: Run the unit suite (must not pick up the integration file)**

Run: `npm run test`
Expected: same test count as after Task 8 (the integration file is excluded), all PASS.

- [ ] **Step 4: Run the integration suite both ways**

Run: `VITE_WC_PROJECT_ID= npm run test:integration`
Expected: suite reported as skipped, exit 0.

Run: `npm run test:integration`
Expected (with the real `.env` project id): 1 test PASS in well under the 120 s timeout. If it fails with a relay/auth error, the project id in `.env` is not a live WalletConnect Cloud project — that itself is diagnostic (and the likely cause of the original Syrius connection failure); fix the id before proceeding.

- [ ] **Step 5: Commit**

```bash
git add vitest.config.ts vitest.integration.config.ts src/core/zenon-wallet-service.integration.test.ts package.json
git commit -m "Add live-relay integration test: dApp service vs fake Syrius"
```

---

### Task 10: Docs, full verification, manual test pass

**Files:**
- Modify: `docs/walletconnect-integration.md`
- Modify: `CLAUDE.md` (commands section — the two new scripts)

**Interfaces:** none (documentation + verification only).

- [ ] **Step 1: Document the dApp-side reliability behavior**

In `docs/walletconnect-integration.md`, extend §5 (Error semantics) with the new dApp-side behavior. Append after the existing 5xxx paragraph:

```markdown
### dApp-side reliability behavior (v2)

The bridge now enforces the following on its side; wallets should be aware:

- Every request is raced against a **30 s timeout**; pairing approval against
  **5 min** (the pairing-URI lifetime). A hung request surfaces to the user as
  a timeout — respond or error, never go silent.
- `znn_info`/`znn_send` are attempted up to **3 times**. Two error shapes get
  special handling, matching known Syrius behavior:
  - `code 9000` + message containing `Wallet is locked` → surfaced as
    "unlock your wallet", no retry.
  - `code -32602` + `Bad state: No element` → the bridge drops the session,
    re-pairs/reuses, and retries.
  - `code -32602` + `No matching key` → retried as-is.
- If the relay transport is down when a request is made, the bridge reopens it
  and waits ~2 s before sending.
- After session approval the bridge waits ~5 s and re-reads its session store
  (SignClient's store can lag behind approval).
```

In `CLAUDE.md`, add to the commands block:

```sh
npm run fake-wallet -- "<wc-uri>" [--reject|--locked|--hang|--bad-state]  # headless Syrius stand-in
npm run test:integration  # live-relay WC test; skips without VITE_WC_PROJECT_ID
```

- [ ] **Step 2: Full automated verification**

Run: `npm run typecheck && npm run test && npm run build && npm run test:integration`
Expected: everything green (integration test skips or passes depending on `.env`).

- [ ] **Step 3: Manual harness pass (happy path + each failure flag)**

1. `npm run dev`, open the app, click **Connect Zenon**, copy the URI from the modal.
2. `npm run fake-wallet -- "<uri>"` → the app should show the connected fake address (`z1qxemdedded…sctrp`) within ~10 s (5 s settle + info round-trip).
3. Refresh the page → the address reappears WITHOUT clicking Connect (restore-on-load).
4. Disconnect in the app; reconnect with each flag and confirm the UX:
   - `--reject` → toast "Request rejected in the wallet" (on connect's `znn_info`)
   - `--locked` → "Your wallet is locked — please unlock Syrius"
   - `--hang` → after 30 s, the timeout error (not an infinite spinner)
   - `--bad-state` → connects successfully anyway (one retry, invisible to the user)
5. If a real Syrius desktop wallet is available: pair with the QR/URI, connect, and (optionally, with real funds — costs a wrap fee) submit a small wrap.

- [ ] **Step 4: Commit**

```bash
git add docs/walletconnect-integration.md CLAUDE.md
git commit -m "Document dApp-side WC reliability contract and test tooling"
```

---

## Execution order & dependencies

Tasks 1→7 are strictly sequential (each edits the same service/test files). Task 8 is independent of 2–7 (only needs the repo). Task 9 needs 2, 6, 8. Task 10 is last.
