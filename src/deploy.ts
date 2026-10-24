import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Abi, Address, Hex } from 'viem';
import { ROUTER_ABI } from './abi.js';
import {
  assertAddress,
  assertPrivateKey,
} from './crypto/secp.js';
import {
  assertContractDeployed,
  createPublicClientFor,
  createWalletClientFor,
  getAndCheckChainId,
  waitForSuccessfulReceipt,
} from './chain.js';
import { writeJsonAtomic } from './fs.js';
import { toJsonSafe } from './json.js';
import type { DeployResult } from './types.js';

interface Artifact {
  abi: Abi;
  bytecode: Hex;
}

export interface DeployOptions {
  rpcUrl: string;
  deployerPrivateKey: Hex;
  chainId?: number;
  existingAnnouncer?: Address;
  outPath?: string;
  artifactDirectory?: string;
}

function loadArtifact(contractName: string, directory: string): Artifact {
  const path = join(directory, `${contractName}.sol`, `${contractName}.json`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`Missing ${path}; run "npm run build:contracts" first`);
  }
  const artifact = parsed as { abi?: unknown; bytecode?: { object?: unknown } };
  if (!Array.isArray(artifact.abi) || typeof artifact.bytecode?.object !== 'string') {
    throw new Error(`Invalid Foundry artifact at ${path}`);
  }
  if (!/^0x[0-9a-fA-F]+$/.test(artifact.bytecode.object)) {
    throw new Error(`Artifact at ${path} has no deployable bytecode`);
  }
  return { abi: artifact.abi as Abi, bytecode: artifact.bytecode.object as Hex };
}

export async function deployStealthContracts(options: DeployOptions): Promise<DeployResult> {
  assertPrivateKey(options.deployerPrivateKey, 'deployer private key');
  const artifactDirectory = options.artifactDirectory ?? 'out';
  const publicClient = createPublicClientFor(options.rpcUrl);
  const walletClient = createWalletClientFor(options.rpcUrl, options.deployerPrivateKey);
  const chainId = await getAndCheckChainId(publicClient, options.chainId);
  const account = walletClient.account;
  if (!account) throw new Error('Deployer wallet account is unavailable');

  let announcerAddress: Address;
  let announcerTxHash: Hex | undefined;
  let announcerBlock: bigint | undefined;

  if (options.existingAnnouncer) {
    announcerAddress = assertAddress(options.existingAnnouncer, 'existing announcer');
    await assertContractDeployed(publicClient, announcerAddress, 'existing announcer');
  } else {
    const artifact = loadArtifact('ERC5564Announcer', artifactDirectory);
    const txHash = await walletClient.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode,
      account,
      chain: null,
    });
    const receipt = await waitForSuccessfulReceipt(publicClient, txHash);
    if (!receipt.contractAddress) throw new Error('Announcer deployment returned no address');
    announcerAddress = assertAddress(receipt.contractAddress, 'deployed announcer');
    announcerTxHash = txHash;
    announcerBlock = receipt.blockNumber;
  }

  const routerArtifact = loadArtifact('StealthPaymentRouter', artifactDirectory);
  const routerTxHash = await walletClient.deployContract({
    abi: routerArtifact.abi,
    bytecode: routerArtifact.bytecode,
    args: [announcerAddress],
    account,
    chain: null,
  });
  const routerReceipt = await waitForSuccessfulReceipt(publicClient, routerTxHash);
  if (!routerReceipt.contractAddress) throw new Error('Router deployment returned no address');
  const routerAddress = assertAddress(routerReceipt.contractAddress, 'deployed router');

  const configuredAnnouncer = await publicClient.readContract({
    address: routerAddress,
    abi: ROUTER_ABI,
    functionName: 'announcer',
  });
  if (assertAddress(configuredAnnouncer) !== announcerAddress) {
    throw new Error(`Deployed router points at ${configuredAnnouncer}, expected ${announcerAddress}`);
  }

  const deployment: DeployResult = {
    version: 1,
    chainId,
    deployer: account.address,
    announcerAddress,
    routerAddress,
    announcerBlock: announcerBlock ?? routerReceipt.blockNumber,
    routerBlock: routerReceipt.blockNumber,
    announcerTxHash: announcerTxHash ?? null,
    routerTxHash,
    deployedAt: new Date().toISOString(),
  };

  const outPath = options.outPath ?? join('deployments', `${chainId}.json`);
  writeJsonAtomic(outPath, toJsonSafe(deployment));
  return { ...deployment, deploymentFile: outPath };
}
