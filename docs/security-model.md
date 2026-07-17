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
