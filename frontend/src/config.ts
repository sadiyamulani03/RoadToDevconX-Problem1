// Quadratic Funding contract configuration
// Sepolia (chainId 11155111). Replace `address` with the actual deployed contract
// address after a verified Sepolia deployment. Never commit private keys here.

import {http, createConfig} from "wagmi";
import {sepolia, localhost} from "wagmi/chains";

export const QUADRATIC_FUNDING_ABI = [
    // Placeholder ABI — regenerate from `out/QuadraticFunding.sol/QuadraticFunding.json`
    // after `forge build` and keep this in sync with the deployed bytecode.
    {
        type: "constructor",
        inputs: [{ name: "roundDuration", type: "uint256", internalType: "uint256" }],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "projectCount",
        inputs: [],
        outputs: [{ name: "", type: "uint256" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "currentRound",
        inputs: [],
        outputs: [{ name: "", type: "uint256" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "rounds",
        inputs: [{ name: "roundId", type: "uint256" }],
        outputs: [
            { name: "matchingPool", type: "uint256" },
            { name: "active", type: "bool" },
            { name: "startTime", type: "uint256" },
            { name: "endTime", type: "uint256" },
            { name: "matchingDistributed", type: "bool" },
            { name: "allocationRoot", type: "bytes32" },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "projects",
        inputs: [{ name: "projectId", type: "uint256" }],
        outputs: [
            { name: "owner", type: "address" },
            { name: "title", type: "string" },
            { name: "description", type: "string" },
            { name: "totalDonations", type: "uint256" },
            { name: "active", type: "bool" },
            { name: "matchingAllocated", type: "uint256" },
            { name: "matchingClaimed", type: "bool" },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "contribution",
        inputs: [{ name: "projectId", type: "uint256" }, { name: "donor", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "donorCount",
        inputs: [{ name: "projectId", type: "uint256" }],
        outputs: [{ name: "", type: "uint256" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "donors",
        inputs: [{ name: "projectId", type: "uint256" }, { name: "index", type: "uint256" }],
        outputs: [{ name: "", type: "address" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "eligibilityRoot",
        inputs: [],
        outputs: [{ name: "", type: "bytes32" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "isEligible",
        inputs: [{ name: "account", type: "address" }],
        outputs: [{ name: "", type: "bool" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "registerProject",
        inputs: [{ name: "title", type: "string" }, { name: "description", type: "string" }],
        outputs: [{ name: "", type: "uint256" }],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "donate",
        inputs: [{ name: "projectId", type: "uint256" }],
        outputs: [],
        stateMutability: "payable",
    },
    {
        type: "function",
        name: "sponsor",
        inputs: [],
        outputs: [],
        stateMutability: "payable",
    },
    {
        type: "function",
        name: "createRound",
        inputs: [],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "distributeMatching",
        inputs: [],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "claimMatching",
        inputs: [{ name: "projectId", type: "uint256" }],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "setEligibilityRoot",
        inputs: [{ name: "root", type: "bytes32" }],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "addEligible",
        inputs: [{ name: "account", type: "address" }],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "removeEligible",
        inputs: [{ name: "account", type: "address" }],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "event",
        name: "ProjectRegistered",
        inputs: [
            { name: "projectId", type: "uint256", indexed: true },
            { name: "owner", type: "address", indexed: true },
            { name: "title", type: "string", indexed: false },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "Donated",
        inputs: [
            { name: "projectId", type: "uint256", indexed: true },
            { name: "donor", type: "address", indexed: true },
            { name: "amount", type: "uint256", indexed: false },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "MatchingSponsored",
        inputs: [
            { name: "sponsor", type: "address", indexed: true },
            { name: "amount", type: "uint256", indexed: false },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "RoundCreated",
        inputs: [
            { name: "roundId", type: "uint256", indexed: true },
            { name: "startTime", type: "uint256", indexed: false },
            { name: "endTime", type: "uint256", indexed: false },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "MatchingDistributed",
        inputs: [
            { name: "roundId", type: "uint256", indexed: true },
            { name: "totalMatching", type: "uint256", indexed: false },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "MatchingClaimed",
        inputs: [
            { name: "projectId", type: "uint256", indexed: true },
            { name: "owner", type: "address", indexed: true },
            { name: "amount", type: "uint256", indexed: false },
        ],
        anonymous: false,
    },
] as const;

// Sepolia deployment address — set after verified deployment.
// Example placeholder only; NOT a real deployment.
export const QUADRATIC_FUNDING_ADDRESS_SEPOLIA = "0x0000000000000000000000000000000000000000" as `0x${string}`;

export const chains = [sepolia, localhost];

export const config = createConfig({
    chains,
    transports: {
        [sepolia.id]: http(import.meta.env.VITE_SEPOLIA_RPC_URL),
        [localhost.id]: http("http://127.0.0.1:8545"),
    },
});
