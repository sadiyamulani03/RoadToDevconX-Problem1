# Quadratic Funding DApp

A decentralized quadratic funding platform on Ethereum Sepolia.

## Mechanism

- Multiple community projects register for funding.
- Contributors donate ETH to projects they support.
- A sponsor deposits ETH into a matching pool.
- Matching allocations use quadratic funding: each project's raw match is
  `(sum of sqrt(contributions))^2`, then normalized against the matching pool.
- Matching is distributed per-round and claimed by project owners (pull-based).

## Repository

- `contracts/` — Solidity (Foundry 1.8.x, solc 0.8.30)
- `test/` — Foundry test suite
- `script/` — Foundry deployment scripts
- `frontend/` — React + TypeScript + Vite + viem/wagmi

## Smart contracts

`QuadraticFunding.sol` — Ownable + ReentrancyGuard
- `registerProject(title, description)` — register a project
- `donate(projectId)` payable — contribute ETH
- `sponsor()` payable — add to the current round matching pool
- `createRound()` — owner opens a new funding round
- `distributeMatching()` — owner computes and allocates quadratic matching
- `claimMatching(projectId)` — project owner pulls allocated matching
- `setEligibilityRoot` / `addEligible` / `removeEligible` — Merkle-based eligibility
- `isEligible(account)` — eligibility check

## Frontend

React + TypeScript scaffold configured for Sepolia (chainId 11155111).
Contract address and ABI live in `frontend/src/config.ts` and must be updated
after a verified Sepolia deployment.

## Security

- Reentrancy guard on state-changing entry points
- Checks-effects-interactions ordering
- Pull-based matching claims (no push loop / DoS)
- Owner-restricted administrative functions
- No credentials committed; `.env` is gitignored

## Commands

```
forge build
forge test -vv
forge fmt --check
```

Deploy to Sepolia (no credentials in repo):

```
forge script script/Deploy.s.sol --rpc-url $SEPOLIA_RPC_URL --broadcast
```

## Credentials

Never commit `.env`, private keys, or funded deployer keys. See `.gitignore`.
