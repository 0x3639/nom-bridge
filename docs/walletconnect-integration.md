# Zenon Wallet — WalletConnect Requirements for the NoM Bridge

**Audience:** developers of the Zenon wallet (the WalletConnect *wallet* side).
**Purpose:** define exactly what your WalletConnect integration must expose so the
NoM Bridge dApp can connect to it and submit bridge transactions.

The bridge is a WalletConnect **v2 Sign** dApp (`@walletconnect/sign-client` +
`@walletconnect/modal`). Everything below is derived from the bridge's actual
client code (`src/core/zenon-wallet-service.ts`), not a wish-list.

---

## 1. Session namespace

The bridge requests a single namespace keyed **`zenon`** in
`requiredNamespaces`. Because these are *required*, your wallet **must declare
support for all of the methods, events, and chains below**, or it will be unable
to approve the session.

```jsonc
{
  "zenon": {
    "chains":  ["zenon:1"],                          // 1 = mainnet, 3 = testnet
    "methods": ["znn_info", "znn_sign", "znn_send"],
    "events":  ["chainIdChange", "addressChange"]
  }
}
```

### Chain identifier (CAIP-2)
- Format: **`zenon:<chainId>`** where `<chainId>` is the numeric Zenon chain id.
  - `zenon:1` — mainnet
  - `zenon:3` — testnet
- Accounts in the approved session namespace must use the CAIP-10 form
  **`zenon:<chainId>:<z-address>`** (e.g. `zenon:1:z1qq...`).
- Every JSON-RPC request the bridge sends is scoped to `chainId: "zenon:1"`
  (or `:3`). Your wallet must accept requests on the chain it approved.

---

## 2. Methods your wallet must implement

Three methods are declared. **Two are actively called today** (`znn_info`,
`znn_send`); `znn_sign` must still be *supported/declared* so session approval
succeeds (see §5), even though the current bridge flow does not call it.

### 2.1 `znn_info` — read the connected account

Called immediately after connect to learn which address/chain the user picked.

- **Params:** none (`undefined`).
- **Result:**
  ```jsonc
  {
    "address": "z1qq...",   // the connected Zenon (z1) address — required
    "chainId": 1,           // numeric chain id (1 mainnet / 3 testnet) — required
    "nodeUrl": "wss://..."  // optional; the node the wallet is using
  }
  ```
The bridge keys all of its state off `address`. It must be the bech32 `z1…`
address, not a public key.

### 2.2 `znn_send` — sign, plasma/PoW, broadcast, return the published block

This is the core of the integration. The bridge constructs an **unsigned**
`AccountBlockTemplate` (a contract call to the embedded **Bridge** contract) and
hands it to the wallet. The wallet owns everything required to make it a valid,
broadcast block.

- **Params:**
  ```jsonc
  {
    "fromAddress": "z1qq...",      // the sending account
    "accountBlock": { /* see shape below */ }
  }
  ```

- **`accountBlock` shape** (this is `AccountBlockTemplate.toJson()` from
  `znn-typescript-sdk`; fields are strings/base64 as noted):
  ```jsonc
  {
    "version": 1,
    "chainIdentifier": 1,
    "blockType": 2,                 // user-send / contract call
    "hash": "",                     // empty on the way in
    "previousHash": "…",
    "height": 0,
    "momentumAcknowledged": { "hash": "…", "height": 0 },
    "address": "z1qq…",             // == fromAddress
    "toAddress": "z1q...bridge",    // the embedded Bridge contract address
    "amount": "0",                  // string; decimal-shifted token amount
    "tokenStandard": "zts1…",       // ZTS of the token being wrapped (or ZNN for redeem)
    "fromBlockHash": "…",
    "data": "<base64>",             // ABI-encoded bridge call (wrapToken / redeem)
    "fusedPlasma": 0,
    "difficulty": 0,
    "nonce": "0000000000000000",
    "publicKey": "",                // base64; empty on the way in
    "signature": ""                 // base64; empty on the way in
  }
  ```

- **What the wallet is responsible for** (the bridge sends these as zero/empty
  and expects the wallet to fill them):
  - `previousHash`, `height`, `momentumAcknowledged`, `fromBlockHash` — derive
    from the account chain head.
  - **Plasma or PoW** — fuse plasma or generate PoW; populate `fusedPlasma`,
    `difficulty`, `nonce`. The bridge does **no** PoW.
  - `publicKey`, `signature` — sign the block with the account key.
  - **Broadcast** the completed block to the network.

- **Result:** the **finalized, published** `AccountBlockTemplate` as JSON,
  **including the computed `hash`**. The bridge does:
  ```ts
  const published = AccountBlockTemplate.fromJson(result)
  const id = published.hash.toString()   // used as the request id + for tracking
  ```
  If the returned block is missing a valid `hash`, the bridge cannot track the
  request. Return the block *after* it has been hashed/broadcast.

- **Do not alter** `toAddress`, `tokenStandard`, `amount`, or `data` — those
  encode the bridge operation and must be signed as received. The wallet should,
  however, **display** them to the user (it's a contract call moving funds).

`znn_send` carries **both** bridge operations the user can initiate; there is no
separate method:
| Bridge action | Block the wallet receives |
|---|---|
| **Wrap** (ZNN → EVM) | `embedded.bridge.wrapToken(...)` contract call |
| **Redeem** an unwrap (EVM → ZNN) | `embedded.bridge.redeem(...)` contract call |

### 2.3 `znn_sign` — declared, not yet called

Listed in the required methods so the session can be approved, but the current
bridge flow does **not** invoke it. Implement/declare it for forward
compatibility; it is not on the critical path today. If you implement it, follow
the standard "sign arbitrary message, return signature" shape.

---

## 3. Events

Declared in the namespace: **`chainIdChange`** and **`addressChange`**. Emit
these when the user switches network or active account inside the wallet so
sessions stay consistent. (The bridge declares them as required; emit them per
the WalletConnect session-event mechanism.)

---

## 4. Session lifecycle

- The bridge subscribes to **`session_delete`** and **`session_expire`** and
  clears its local connection state when either fires. Your wallet must emit a
  proper session delete when the user disconnects on the wallet side.
- The bridge initiates disconnect with reason code **6000** (`"User
  disconnected"`); handle the teardown cleanly.
- The bridge reuses the most recent **non-expired** `zenon` session if one
  exists, so honor session `expiry` correctly.

---

## 5. Error semantics

The bridge interprets WalletConnect JSON-RPC error codes:

- **Codes `5000`–`5999`** → treated as a **user/wallet rejection** and shown as
  *"Request rejected in the wallet."* Use a code in this range (e.g. `5000`)
  when the user declines a `znn_send`/`znn_sign` prompt.
- Any other error code or thrown error → generic *"WalletConnect request
  failed."*

Returning the conventional rejection codes gives the user the correct,
specific message instead of a generic failure.

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

---

## 6. dApp metadata you'll receive

For display in your connection UI:

```jsonc
{
  "name": "NoM Bridge",
  "description": "Zenon <-> EVM bridge",
  "url": "<origin of the bridge deployment>",
  "icons": ["<origin>/logo.svg"]
}
```

---

## 7. Acceptance checklist

A wallet is bridge-ready when:

- [ ] It approves a session for the **`zenon`** namespace on **`zenon:1`**
      (and `zenon:3` for testnet), declaring methods
      `znn_info`, `znn_sign`, `znn_send` and events
      `chainIdChange`, `addressChange`.
- [ ] Approved-session accounts use **`zenon:<chainId>:<z1-address>`**.
- [ ] **`znn_info`** returns `{ address, chainId }` (address = `z1…`).
- [ ] **`znn_send`** fills previousHash/height/momentumAcknowledged, does
      **plasma/PoW**, **signs**, **broadcasts**, and returns the finalized block
      **with its `hash`** — without modifying `toAddress`/`tokenStandard`/
      `amount`/`data`.
- [ ] User rejections return a **5xxx** error code.
- [ ] **`session_delete`** is emitted on wallet-side disconnect; `expiry` is
      honored.

---

### Source of truth
All of the above is implemented dApp-side in
`src/core/zenon-wallet-service.ts` (connect/namespace, `znn_info`, `znn_send`,
error mapping, session handling). The block payload shape is
`AccountBlockTemplate.toJson()` from `znn-typescript-sdk`.
