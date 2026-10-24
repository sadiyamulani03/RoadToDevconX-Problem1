# ERC-5564 Scheme 1 stealth payments — implementation report

- Date: 2026-10-24
- Project directory: `/mnt/d/SY/RoadToDevcon/RoadToDevconX-Problem1`
- Target repository: `https://github.com/sadiyamulani03/RoadToDevconX-Problem1` (the remote was empty when inspected)
- Status: complete and verified locally, including a 2026-10-24 audit pass; **not** deployed to a public network, **not** independently audited by a third party, and **not** committed or pushed.

## A. Deliverables

- ERC-5564-compatible `ERC5564Announcer` with the exact event and `announce` signature.
- `StealthPaymentRouter` that atomically transfers ETH and announces through the announcer.
- Scheme 1 cryptography: canonical `st:eth:0x...` meta-addresses, compressed secp256k1 ECDH, Keccak-256, view tags, stealth address derivation, and modulo-`n` one-time-key recovery.
- Encrypted identity keystore with separate spending/viewing AES-256-GCM ciphertexts and scrypt KDF.
- Discovery path that receives only `{viewingPrivateKey, spendingPublicKey}`.
- Payer, paginated scanner with reorg state, recovery, and gas-aware withdrawal.
- Operator CLI and a complete Anvil demo.
- Foundry, TypeScript unit, architecture, end-to-end, and CLI tests.
- Independent Python reference-vector generator, README, CI workflow, secret scan, and this report.

## B. Security design

The central invariant is key separation:

```text
scan/recover?  input                         can spend?
scan           viewing private + spend public   no
recover        viewing private + spend private  yes, one-time key only
```

- `keystore.ts` stores spending and viewing keys in separate authenticated ciphertexts. `loadScannerIdentity` decrypts only the viewing blob; a deliberately corrupted spending blob does not break scanning (tested).
- `scanner-identity.ts` exposes only the two discovery fields.
- `scanner.ts` has no imports of the keystore, identity, or recovery modules; `architecture.test.ts` enforces this.
- The CLI `scan` command uses `loadIdentityForScanning`; only `recover`/`withdraw` call `loadRecipientIdentity`.
- Every payment calls `generateStealthAddress` with a fresh CSPRNG ephemeral scalar. No caller can inject an ephemeral key.
- The router transfers ETH first and announces second. A failed transfer reverts before any event is emitted; the Foundry test checks that no logs are recorded.
- Recovery verifies the derived stealth address and the final private-key/address relation. The CLI never prints the recovered private key.
- Keystores are written atomically with `0600` permissions where supported; passwords and keys are read from environment variables or files, not argv.

## C. Commands and actual results

All commands were run in the project directory.

```text
$ npm run typecheck
> tsc --noEmit
exit 0

$ npm run lint
> eslint .
exit 0

$ npm run fmt:check
> node scripts/run-forge.mjs fmt --check
exit 0

$ npm run test:contracts
Ran 7 tests for test/ERC5564Announcer.t.sol:ERC5564AnnouncerTest
[PASS] testAnnouncerEmitsExactERC5564Event() (gas: 55737)
[PASS] testRouterAtomicallyPaysAndAnnounces() (gas: 106563)
[PASS] testRouterConstructorRejectsZeroAnnouncer() (gas: 3832)
[PASS] testRouterRejectsDirectEthTransfer() (gas: 14639)
[PASS] testRouterRejectsZeroStealthAddress() (gas: 52363)
[PASS] testRouterRejectsZeroValue() (gas: 45730)
[PASS] testRouterRevertsAndDropsAnnouncementWhenTransferFails() (gas: 174968)
7 passed; 0 failed; 0 skipped

$ npm test
7 Foundry tests passed
Test Files  7 passed (7)
Tests       44 passed (44)
exit 0

$ npm run secret-scan
Secret scan passed: 54 text files scanned.
exit 0

$ npm run demo
exit 0 (public evidence below)
```

A second audit run of `npm run demo` on 2026-10-24 also exited 0 with fresh random contracts, identities, and payments; its values necessarily differ from Section E because the demo is randomized.

Foundry also prints non-fatal lint notes/warnings: the router's intentional low-level ETH transfer (`low-level-calls`, `arbitrary-send-eth`), test-file lint notes, and environment warnings about sibling Foundry projects missing from a parent `foundry.lock`. There were no compilation or test failures.

## D. Scoring criteria

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | Spending key never enters discovery | **PASS** | Corrupted spending ciphertext still scans (`identity-keystore.test.ts`); source/import/type checks (`architecture.test.ts`); scanner object has exactly two fields (`e2e.test.ts`, `cli.test.ts`). |
| 2 | Fresh ephemeral key every payment | **PASS** | 64 generated payments produced 64 distinct ephemeral keys and addresses (`crypto.test.ts`); two on-chain payments produced distinct keys (`e2e.test.ts`). |
| 3 | Deterministic derivation vectors | **PASS** | Independent Python generator (`test/reference_vectors.py`) produced `test/reference-vectors.json`; `crypto.test.ts` checks public keys, shared secret, hash, view tag, stealth public key/address, and recovered key. |
| 4 | Recovery modulo `n`, including sum > `n` | **PASS** | Vector 2 uses `p_spend = n - 2`; `sumExceedsN` is true; reduced key and address are verified (`crypto.test.ts`, `recovery.test.ts`). |
| 5 | View tag checked before derivation | **PASS** | Injected derivation spy throws if called; a tag mismatch returns `view-tag-mismatch` and the spy is never called (`scanner.test.ts`). |
| 6 | Unrelated announcements ignored | **PASS** | Unrelated recipient vector is skipped (`scanner.test.ts`); Bob's payment is found only by Bob, while Mira finds exactly her two payments (`e2e.test.ts`). |
| 7 | Two payments produce distinct stealth addresses | **PASS** | `e2e.test.ts` asserts distinct addresses and ephemeral keys for two payments to Mira. |
| 8 | Ephemeral public key is on-chain | **PASS** | `e2e.test.ts` decodes the `Announcement` logs from both receipts and checks scheme 1, 33-byte compressed key, stealth address, and metadata. |
| 9 | No secrets tracked | **PASS** | `.gitignore` excludes `.env`, keystores, deployments, dependencies, and build output; secret scan passes. Deterministic test vectors are explicitly allowlisted. |

## E. Demo evidence (one run)

The demo is randomized, so these values identify one successful run only:

- Chain: `31337`
- Announcer: `0x4FC1409D4269081d4b01444dbB9a80436AA90069`
- Router: `0x8511307bca301152Bfd4EF16850981EB69BFb759`
- Announcer deployment tx: `0x7043bad5f92fcb1cef80cc206a6c6d068518dd90286beb9e9d610a67c84f4d89`
- Router deployment tx: `0x4e0f24b8e719dbd9b763c001e0d3184ff8d7bf37e1acbec496e633d24f7f129a`
- Mira payment 1: `0.05 ETH` to `0x9F442d42d80E6768c7a6F3555F5115C67D176FfA`, tx `0xa1657d9421134f139bf553f500c923380c9fd34d6c7f269c305e5d2de50c1979`
- Mira payment 2: `0.03 ETH` to `0x7EAb1AA4b0E3121a863Df2D87572c5bBDf5AA303`, tx `0x5684d8564b3919db432f974b3fd87f2ddd2834a448fdc0758c434e72f839d402`
- Distinct ephemeral keys: true
- Distinct stealth addresses: true
- Scanner: 2 payments, 2 announcements seen, 0 malformed
- Recovery: both verified
- Withdrawal tx: `0xca66907a7067aeca8d8f21a0b8d9cd62cf4b4def070818539e3499b1745fa508`
- Withdrawal amount: `49945335652119200 wei`; destination balance matches
- Keystore password printed: false; private keys printed: none

The CLI test independently performs deploy, pay, scan, recover, and withdraw through the compiled CLI and passes.

## F. Privacy analysis

Detailed analysis is in `README.md`. Summary:

- **Payer** knows the recipient meta-address and can link the payment; stealth addresses are not sender-anonymous.
- **Recipient/scanner** can identify all payments for the meta-address with the viewing key, but cannot spend without the spending key.
- **Public observer** sees the stealth address, ephemeral public key, view tag, metadata/amount, router caller, and payer transaction graph, but cannot test ownership without the viewing key.
- **RPC provider** sees announcer log queries and receipt lookups. The scanner sends no viewing key, but a provider that correlates requests can learn the match set and network metadata; use a private/local RPC for stronger privacy.
- **Unlinkability** holds across payments at the address level (fresh ephemeral keys and addresses), but amount/timing correlation, meta-address publication, and withdrawal destination links remain. This is unlinkability, not anonymity.
- The one-byte view tag leaks one byte of the shared-secret hash (roughly 124-bit margin per ERC-5564) and creates 1/256 false-positive checks, never false ownership.
- Metadata reveals the ETH amount; there is no encrypted memo. ETH only.

## G. Audit notes and limitations

No critical or high-severity fund-loss defect was found in this local review. One interoperability caveat and several residual risks remain:

- **Shared-secret serialization interoperability** (medium): ERC-5564 Scheme 1 defines the ECDH point but not its byte serialization before hashing. This implementation hashes the compressed 33-byte point, matching ScopeLift SDK `1.0.0-beta.5` and the published ephemeral.money vectors. The ERC's reference notebook instead hashes uncompressed `x || y` (64 bytes, no `0x04` prefix), and its cell 23 also references `stP` rather than the newly derived `P_stealth`. Clients that follow the notebook convention will not interoperate. Treat the serialization convention as part of the deployment profile and do not mix client implementations without a compatibility test.
- **RPC trust / match-set leakage** (privacy): scanner trusts the RPC for chain ID, logs, receipts, and gas data. Use a local/private RPC or add proof-based log verification.
- **Inherent metadata leakage**: amounts, timing, payer address, router caller, and withdrawal destination are public.
- **Router low-level call**: intentional and necessary to send ETH to a fresh stealth address; the router is stateless, so reentrancy cannot corrupt stored state or fabricate a different announcement. Transfer-before-announce is deliberate.
- **No canonical deployment**: local deployments use a local announcer. For a public chain, pass the canonical announcer (`0x55649E01B5Df198D18D95b5cc5051630cfD45564`) to the deployer/router.
- **No ERC-6538 registry, ERC-20 support, relayer, gas sponsorship, encrypted memo, or light client.**
- **Reorg handling** is a configurable overlap window, not a finality proof.
- **Keystore security** depends on password strength; scrypt raises offline guessing cost but does not eliminate it.
- **Withdrawal** pays gas from the stealth address and may leave dust; sweep to a fresh unlinked address.
- **Not audited**: do not use with real funds without independent review.

## H. Repository and commit status

- The project was created as a standalone directory under the existing parent workspace `/mnt/d/SY/RoadToDevcon`.
- The parent is a separate git repository with unrelated modifications; those were not touched.
- The target GitHub repository was empty at inspection time. No commit, push, tag, or PR was created because no such action was requested.
- The project has no local `.git` directory of its own; all source files are present and untracked from the parent's perspective.
- A dry-run `git add -n .` lists 128 project files and no `node_modules`, `out`, `dist`, or `cache` paths. The local `node_modules` symlink is ignored by the `node_modules` pattern.
- The lockfile was validated with a clean `npm ci --ignore-scripts` in a temporary directory (173 packages installed, exit 0).
- Suggested next steps: initialize/commit the standalone project, deploy to a public testnet with the canonical announcer, and commission an independent security/privacy audit.
