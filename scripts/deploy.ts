import { printJson } from '../src/json.js';
import { deployStealthContracts } from '../src/deploy.js';
import { assertPrivateKey } from '../src/crypto/secp.js';
import { errorMessage } from '../src/errors.js';
import type { Address } from '../src/types.js';

async function main(): Promise<void> {
  const rpcUrl = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!privateKey) throw new Error('Set DEPLOYER_PRIVATE_KEY before deploying');
  const result = await deployStealthContracts({
    rpcUrl,
    deployerPrivateKey: assertPrivateKey(privateKey, 'deployer private key'),
    ...(process.env.CHAIN_ID ? { chainId: Number(process.env.CHAIN_ID) } : {}),
    ...(process.env.ANNOUNCER_ADDRESS
      ? { existingAnnouncer: process.env.ANNOUNCER_ADDRESS as Address }
      : {}),
    ...(process.env.DEPLOYMENT_FILE ? { outPath: process.env.DEPLOYMENT_FILE } : {}),
  });
  printJson(result);
}

main().catch((error) => {
  console.error(`Deploy failed: ${errorMessage(error)}`);
  process.exitCode = 1;
});
