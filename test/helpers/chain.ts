import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEther } from 'viem';
import {
  publicKeyFromPrivateKey,
  publicKeyToAddress,
  randomSecretKey,
} from '../../src/crypto/secp.js';
import { deployStealthContracts } from '../../src/deploy.js';
import { startAnvil, setBalance, type LocalChain } from '../../src/local-chain.js';
import type { Address, DeployResult, PrivateKey } from '../../src/types.js';

export interface FundedAccount {
  privateKey: PrivateKey;
  address: Address;
}

export interface TestEnvironment {
  chain: LocalChain;
  deployment: DeployResult;
  directory: string;
  createFundedAccount: (eth?: string) => Promise<FundedAccount>;
  close: () => Promise<void>;
}

export function addressOf(privateKey: PrivateKey): Address {
  return publicKeyToAddress(publicKeyFromPrivateKey(privateKey));
}

export async function createFundedAccount(
  rpcUrl: string,
  eth = '10',
): Promise<FundedAccount> {
  const privateKey = randomSecretKey();
  const address = addressOf(privateKey);
  await setBalance(rpcUrl, address, parseEther(eth));
  return { privateKey, address };
}

export async function createTestEnvironment(): Promise<TestEnvironment> {
  const directory = await mkdtemp(join(tmpdir(), 'erc5564-e2e-'));
  const chain = await startAnvil();
  try {
    const deployer = await createFundedAccount(chain.rpcUrl, '1000');
    const deployment = await deployStealthContracts({
      rpcUrl: chain.rpcUrl,
      deployerPrivateKey: deployer.privateKey,
      outPath: join(directory, 'deployment.json'),
    });
    return {
      chain,
      deployment,
      directory,
      createFundedAccount: (eth = '10') => createFundedAccount(chain.rpcUrl, eth),
      close: async () => {
        await chain.stop();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await chain.stop();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
