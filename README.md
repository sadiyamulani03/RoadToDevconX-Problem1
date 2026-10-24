# ERC-5564 Scheme 1 stealth payments

A complete, locally verifiable ERC-5564 Scheme 1 stealth-payment system: Solidity contracts, a TypeScript/viem client, an encrypted identity keystore, a view-tag-first scanner, one-time-key recovery, gas-aware withdrawal, a CLI, and an Anvil end-to-end demo.

The design keeps the spending key out of the discovery path. A scanner can find and verify incoming payments with only the viewing private key and the spending **public** key. The spending private key is decrypted only on the explicit recovery/withdrawal path.

## Status

- Implemented and tested locally on Foundry 1.8.1, solc 0.8.30, Node 22, and Anvil 1.8.1.
- No public-testnet deployment or third-party audit has been performed.
- The repository is a standalone project directory; it has not been committed or pushed as part of this work.

## Architecture

```
contracts/
  interfaces/IERC5564Announcer.sol   exact ERC-5564 event/function interface
  ERC5564Announcer.sol               stateless announcer
  StealthPaymentRouter.sol           atomic ETH transfer + announcement

src/
  crypto/secp.ts                     secp256k1, addresses, scalar checks
  crypto/stealth.ts                  meta-address, ECDH, view tag, derivation/recovery
  crypto/metadata.ts                 57-byte ETH metadata
  identity.ts                        recipient identity generation
  keystore.ts                        AES-256-GCM + scrypt, separated key blobs
  scanner-identity.ts                narrow discovery loader
  scanner.ts                         paginated logs, view-tag-first filtering, reorg state
  payer.ts                           fresh ephemeral key, simulated router payment
  recovery.ts                        spending-key recovery with address verification
  withdrawal.ts                      gas-aware sweep from a stealth address
  cli.ts                             operator CLI
  demo.ts                            full local-chain demonstration

test/
  ERC5564Announcer.t.sol             Foundry contract tests
  reference_vectors.py               independent Python vector generator
  reference-vectors.json             generated deterministic vectors
  crypto.test.ts                     vectors, validation, fresh ephemeral keys
  identity-keystore.test.ts          keystore and key-boundary tests
  scanner.test.ts                    view-tag ordering, false positives, decoding
  recovery.test.ts                   modulo-n and invalid-key tests
  architecture.test.ts               source-level spending-key isolation
  e2e.test.ts                        Anvil payments, scans, recovery, withdrawal
  cli.test.ts                        CLI deploy/pay/scan/recover/withdraw flow
```

### Key boundary

```
Discovery path:   keystore viewing ciphertext ──decrypt──> viewing private key
                  keystore spending public key ───────────> spending public key
                  => ScannerIdentity { viewingPrivateKey, spendingPublicKey }

Recovery path:    keystore spending ciphertext ──decrypt──> spending private key
                  + viewing private key + announcement
                  => one-time stealth private key (in memory only)
```

`loadScannerIdentity` never decrypts the spending ciphertext. `loadIdentityForScanning` returns a two-field object. `scanner.ts` has no import of `keystore.ts`, `identity.ts`, or `recovery.ts`, and `architecture.test.ts` enforces those source-level constraints. The CLI `scan` command uses the narrow loader; only `recover`/`withdraw` load the full recipient identity.

### Atomic payment router

`StealthPaymentRouter.pay`:

1. Rejects zero value and the zero stealth address.
2. Transfers `msg.value` to the stealth address with a low-level call.
3. Reverts immediately if the transfer fails.
4. Calls the configured ERC-5564 announcer with the exact event parameters.

The transfer happens before the announcement. If either step fails, the entire transaction reverts and no announcement survives. `receive()` rejects direct ETH so funds cannot become stuck. The router exposes `announcer()` and verifies the binding at deployment. The announcer event/function signatures match ERC-5564 exactly; a deployment can point at the canonical announcer or at a local one.

## ERC-5564 Scheme 1 cryptography

- Meta-address: `st:eth:0x<P_spend compressed 33 bytes><P_view compressed 33 bytes>`.
- One-key form: `st:eth:0x<P>` uses the same key for spending and viewing.
- Ephemeral key: fresh CSPRNG secp256k1 scalar for every payment.
- Shared secret: `s = p_ephemeral * P_view`, compressed 33-byte point.
- Hash: `s_h = keccak256(s)`.
- Serialization note: ERC-5564 does not specify the point serialization before hashing. This implementation uses the compressed SEC1 encoding, matching ScopeLift and the published ephemeral.money vectors. The ERC notebook's uncompressed `x || y` convention is not interoperable with this implementation.
- View tag: first byte of `s_h`.
- Scalar: `h = int(s_h) mod n`, rejecting zero.
- Stealth public key: `P_stealth = P_spend + h*G`.
- Stealth address: Ethereum address of `P_stealth`.
- Recovery: `p_stealth = (p_spend + h) mod n`, rejecting zero.
- ETH metadata (57 bytes): `viewTag(1) || 0xeeeeeeee(4) || 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE(20) || amount(32)`.

The independent Python generator in `test/reference_vectors.py` uses textbook secp256k1 arithmetic and PyCryptodome Keccak-256, not the TypeScript code. It produces a normal vector and a boundary vector with `p_spend = n - 2`, where the scalar sum exceeds `n` and recovery must reduce modulo `n`.

## Requirements

- Node.js 22 or newer
- npm
- Foundry (`forge`, `anvil`, `cast`) 1.8.x or newer
- Python 3 with PyCryptodome only for regenerating reference vectors

If Foundry is not on `PATH`:

```bash
export PATH="$HOME/.foundry/bin:$PATH"
```

## Install and verify

```bash
npm ci
npm run build
npm run typecheck
npm run lint
npm run fmt:check
npm run test:contracts
npm run test:unit
npm run test:e2e
npm run secret-scan
```

Or run the full local pipeline:

```bash
npm test
```

`npm test` builds contracts and the client, runs the Foundry suite, then runs all Vitest suites. `test:e2e` starts an Anvil node on a free local port, deploys fresh contracts, funds random test accounts with `anvil_setBalance`, and exercises the complete flow. No hardcoded Anvil private keys are used.

## Demo

```bash
npm run demo
```

The demo starts a local Anvil chain, deploys the announcer and router, creates a fresh encrypted Mira identity, funds two independent random payers, sends two different amounts to Mira, scans with only Mira's viewing key, verifies both payments through the router, recovers both one-time keys, sweeps one stealth address to a fresh destination, and prints public evidence. It never prints private keys or the keystore password. Set `DEMO_PASSWORD` to choose the keystore password, or `DEMO_KEEP=1` to keep temporary artifacts; if you keep artifacts and did not set a password, the random password is not printed and the keystore is intentionally unusable afterward.

## CLI

Build the client first:

```bash
npm run build
node dist/cli.js help
```

Secrets are read from environment variables or files, never from command-line arguments:

- Keystore password: `STEALTH_KEYSTORE_PASSWORD`, or `--password-env NAME`, or `--password-file PATH`.
- Payer/deployer key: `PAYER_PRIVATE_KEY` / `DEPLOYER_PRIVATE_KEY`, or `--payer-key-env` / `--deployer-key-env`, or `--payer-key-file` / `--deployer-key-file`.
- RPC URL: `--rpc-url` or `RPC_URL`.
- Contract addresses: `--announcer` / `--router`, or `ANNOUNCER_ADDRESS` / `ROUTER_ADDRESS`.

### Identity

```bash
export STEALTH_KEYSTORE_PASSWORD='use-a-long-unique-password'
node dist/cli.js identity create --name Mira --out .stealth/mira.json
node dist/cli.js identity show --identity .stealth/mira.json
node dist/cli.js identity export-public --identity .stealth/mira.json
```

`identity create` writes a `0600` AES-256-GCM/scrypt keystore with separate spending and viewing ciphertexts. `show` and `export-public` never decrypt or print private keys.

### Deploy locally

Start Anvil in another terminal, then:

```bash
export RPC_URL=http://127.0.0.1:8545
export DEPLOYER_PRIVATE_KEY=...   # local test key only
node dist/cli.js deploy --out deployments/31337.json
```

For a chain with an existing canonical announcer, pass `--announcer 0x55649E01B5Df198D18D95b5cc5051630cfD45564`.

### Pay

```bash
export PAYER_PRIVATE_KEY=...      # local test key only
node dist/cli.js pay \
  --meta-address 'st:eth:0x...' \
  --amount 0.05 \
  --rpc-url "$RPC_URL" \
  --announcer "$ANNOUNCER_ADDRESS" \
  --router "$ROUTER_ADDRESS" \
  --out payment.json
```

The payer generates a fresh ephemeral key inside the call, simulates the router payment, sends it, and verifies that exactly one matching announcement is present in the receipt.

### Scan with the viewing key only

```bash
node dist/cli.js scan \
  --identity .stealth/mira.json \
  --rpc-url "$RPC_URL" \
  --announcer "$ANNOUNCER_ADDRESS" \
  --router "$ROUTER_ADDRESS" \
  --from-block 0 \
  --state .stealth/scan-state.json \
  --out scan.json
```

The scanner checks the view tag before deriving a candidate address, verifies the full stealth address only on a tag match, and (when `--router` is supplied) checks the transaction value, router calldata, caller, and receipt log. Progress is persisted with a reorg overlap window. Use `--no-verify` only when a trusted indexer has already verified the payments.

### Recover and withdraw

```bash
node dist/cli.js recover \
  --identity .stealth/mira.json \
  --payment payment.json

node dist/cli.js withdraw \
  --identity .stealth/mira.json \
  --payment payment.json \
  --to 0xFreshDestination... \
  --rpc-url "$RPC_URL"
```

`recover` verifies the view tag, derives the one-time key in memory, checks the announced address, and prints only a verification result (`privateKeyPrinted: false`). `withdraw` recovers the key again in memory, sweeps the balance minus the maximum gas cost, and prints the transaction result without the key. Withdraw to a fresh address that is not publicly linked to the recipient.

### Balance

```bash
node dist/cli.js balance --address 0x... --rpc-url "$RPC_URL"
```

## Test coverage against the scoring criteria

| # | Criterion | Evidence |
|---|---|---|
| 1 | Spending key never enters discovery | `identity-keystore.test.ts` corrupts the spending ciphertext and the scanner still works; `architecture.test.ts` enforces scanner imports/type fields; `e2e.test.ts` asserts the scanner object has only viewing private + spending public; `cli.test.ts` uses `loadIdentityForScanning`. |
| 2 | Fresh ephemeral key every payment | `crypto.test.ts` generates 64 payments and asserts 64 distinct ephemeral keys and addresses; `e2e.test.ts` pays twice and checks distinct on-chain keys. |
| 3 | Deterministic derivation vectors | `reference_vectors.py` independently generates `reference-vectors.json`; `crypto.test.ts` checks public keys, shared secret, hash, view tag, stealth public key/address, and recovered key. |
| 4 | Recovery modulo n, including sum > n | Vector 2 uses `p_spend = n - 2`; `crypto.test.ts` and `recovery.test.ts` assert `sumExceedsN`, the reduced key, and the recovered address. |
| 5 | View tag checked before derivation | `scanner.test.ts` injects a derivation spy that throws; a mismatched tag returns `view-tag-mismatch` and the spy is never called. |
| 6 | Unrelated announcements ignored | `scanner.test.ts` constructs an unrelated recipient announcement and proves it is skipped; `e2e.test.ts` pays Bob and confirms Mira finds only her two payments. |
| 7 | Two payments produce distinct stealth addresses | `e2e.test.ts` asserts distinct addresses and ephemeral keys for two payments to Mira. |
| 8 | Ephemeral public key is on-chain | `e2e.test.ts` decodes the `Announcement` logs from both payment receipts, checks scheme 1, the 33-byte compressed key, stealth address, and metadata. |
| 9 | No secrets tracked | `.gitignore` excludes `.env`, keystores, generated deployments, `node_modules`, and build output; `scripts/secret-scan.mjs` scans source/config files for private keys, PEM keys, RPC credentials, and common token formats. The test tree and public evidence files are allowlisted for deterministic vectors and public hashes; manual review found no real credentials. |

## Privacy analysis

### What each party learns

- **Payer**: knows the recipient's meta-address, the amount, the fresh ephemeral key, and the resulting stealth address. The payer can link the payment to the recipient; stealth addresses are not sender-anonymous.
- **Recipient / scanner**: with the viewing key, can test every announcement and identify payments belonging to the meta-address. The recipient can also recover one-time keys with the spending key. The scanner does not need the spending key and cannot spend funds.
- **RPC provider**: sees `eth_getLogs` calls for the announcer address, block ranges, and receipt/transaction lookups for matched payments. It does not receive the viewing key. Because the scanner only fetches receipts for full matches, the RPC provider can learn which announcements matched if it correlates requests, and it learns the requester's network metadata. A privacy-preserving deployment should use a trusted/private RPC or local node, and ideally fetch receipts in a way that does not reveal the match set.
- **Public observer**: sees the announcer event (`schemeId`, stealth address, caller/router, ephemeral public key, view tag, metadata) and the ETH transfer. Without the viewing key, the observer cannot compute the shared secret or link the stealth address to the recipient. The observer can still analyze amounts, timing, gas, and transaction graph patterns.

### Unlinkability and its limits

Two payments to the same meta-address produce independent ephemeral keys and independent stealth addresses. There is no on-chain field that directly links them. However, stealth payments provide unlinkability, not full anonymity:

- Equal or distinctive amounts and close timing can correlate payments.
- The payer's address is visible as `tx.from`, and the router address is visible as the announcement caller.
- Publishing one meta-address and receiving many payments creates a scanning relationship; if the meta-address is publicly tied to an identity, the recipient's payment set is linkable to that identity even though individual stealth addresses are not.
- Withdrawals create a public link between a stealth address and the withdrawal destination. Sweep to a fresh, unlinked address; funding that address from a known wallet or exchange can re-link it.
- The 1-byte view tag leaks one byte of the shared-secret hash, reducing the privacy margin from 128 to roughly 124 bits as described by ERC-5564. A 1/256 tag collision causes extra full-address checks but not false ownership.
- Metadata reveals the ETH amount and token identifier; there is no encrypted memo in this implementation.
- A stealth address that pays gas or interacts with a known contract can leak graph information.

### Key-handling properties

- Spending and viewing keys are encrypted in separate AES-256-GCM blobs with scrypt (N=2^15, r=8, p=1) and domain-separated AAD.
- The discovery loader decrypts only the viewing blob. A corrupted spending blob does not affect scanning, which is tested.
- The full identity loader decrypts both keys only for recovery/withdrawal.
- The CLI never accepts private keys or passwords as argv values and never prints recovered private keys.
- Keystores are written atomically with `0600` permissions where the filesystem supports them.
- The demo and tests use fresh random keys and `anvil_setBalance`; no default Anvil mnemonic keys are embedded.

### Operational limitations

- No ERC-6538 registry integration; meta-addresses must be exchanged out of band.
- ETH only; ERC-20/ERC-721 metadata layouts are not implemented.
- No relayer, gas sponsorship, or private transaction submission. Withdrawal gas is paid from the stealth address, which can affect the swept amount.
- No light client or proof-based log verification; the scanner trusts the configured RPC's chain and logs. Chain ID and contract bytecode are checked, and router payments are verified against receipts.
- Reorg handling is a configurable overlap window, not a finality proof. State is keyed by chain and announcer/router addresses.
- The implementation has not been audited. Do not use it with real funds without an independent review.

## Environment variables

See `.env.example`. Never commit a populated `.env`, a keystore, or a generated deployment file.

| Variable | Purpose |
|---|---|
| `RPC_URL` | JSON-RPC endpoint |
| `CHAIN_ID` | Optional expected chain ID |
| `ANNOUNCER_ADDRESS` / `ROUTER_ADDRESS` | Deployed contract addresses |
| `STEALTH_KEYSTORE_PASSWORD` | Keystore password (prefer `--password-file`) |
| `PAYER_PRIVATE_KEY` | Local payer key (test only) |
| `DEPLOYER_PRIVATE_KEY` | Local deployer key (test only) |
| `DEMO_PASSWORD` | Optional demo keystore password |
| `DEMO_KEEP` | Set to `1` to keep demo artifacts |
| `FORGE_BIN` / `ANVIL_BIN` | Optional explicit Foundry binaries |

## Troubleshooting

- `forge: command not found`: add `$HOME/.foundry/bin` to `PATH`.
- `anvil: command not found`: install Foundry and ensure `anvil` is on `PATH` or set `ANVIL_BIN`.
- `Missing out/...`: run `npm run build:contracts`.
- `Missing dist/cli.js`: run `npm run build:client` or `npm run build`.
- npm cleanup/EACCES on a WSL `/mnt/d` checkout: install dependencies from a Linux-native directory and symlink `node_modules`, or move the checkout to the Linux filesystem. The project itself does not require that workaround.

## License

MIT
