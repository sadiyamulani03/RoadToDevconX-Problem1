import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress } from 'viem';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createPublicClientFor } from '../src/chain.js';
import { randomSecretKey } from '../src/crypto/secp.js';
import { ROUTER_ABI } from '../src/abi.js';
import {
  addressOf,
  createTestEnvironment,
  type TestEnvironment,
} from './helpers/chain.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const cliEntry = join(root, 'dist', 'cli.js');
const password = 'cli test password';

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out: ${args.join(' ')}\n${stderr}`));
    }, 90_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function parseJson(result: CliResult): Record<string, unknown> {
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

let environment: TestEnvironment;
let directory: string;
let identityFile: string;
let payer: { privateKey: `0x${string}`; address: `0x${string}` };
let deployment: {
  announcerAddress: `0x${string}`;
  routerAddress: `0x${string}`;
  chainId: number;
};

beforeAll(async () => {
  if (!existsSync(cliEntry)) throw new Error('Run npm run build:client before CLI tests');
  environment = await createTestEnvironment();
  directory = mkdtempSync(join(tmpdir(), 'erc5564-cli-'));
  identityFile = join(directory, 'mira.json');
  payer = await environment.createFundedAccount('10');
  const deployer = await environment.createFundedAccount('1000');

  const result = await runCli(
    [
      'deploy',
      '--rpc-url',
      environment.chain.rpcUrl,
      '--deployer-key-env',
      'TEST_DEPLOYER_KEY',
      '--out',
      join(directory, 'deployment.json'),
    ],
    { TEST_DEPLOYER_KEY: deployer.privateKey },
  );
  deployment = parseJson(result) as typeof deployment;
}, 180_000);

afterAll(async () => {
  await environment?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe('CLI', () => {
  test('prints help and creates a public-only identity export', { timeout: 120_000 }, async () => {
    const help = await runCli(['help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('ERC-5564 Scheme 1 stealth payments');

    const created = parseJson(
      await runCli(
        ['identity', 'create', '--out', identityFile, '--name', 'Mira'],
        { STEALTH_KEYSTORE_PASSWORD: password },
      ),
    );
    expect(created.identityFile).toBe(identityFile);
    const raw = readFileSync(identityFile, 'utf8');
    expect(raw).not.toMatch(/"spendingPrivateKey"/);
    expect(raw).not.toMatch(/"viewingPrivateKey"/);

    const exported = parseJson(
      await runCli(['identity', 'export-public', '--identity', identityFile]),
    );
    expect(exported.name).toBe('Mira');
    expect(String(exported.encodedMetaAddress)).toMatch(/^st:eth:0x[0-9a-fA-F]{132}$/);
    expect(exported).not.toHaveProperty('spendingPrivateKey');
    expect(exported).not.toHaveProperty('viewingPrivateKey');

    const shown = parseJson(
      await runCli(['identity', 'show', '--identity', identityFile]),
    );
    expect(shown).not.toHaveProperty('spendingPrivateKey');
    expect(JSON.stringify(shown)).not.toContain('ciphertext');
  });

  test('deploys contracts and verifies the router announcer binding', async () => {
    const publicClient = createPublicClientFor(environment.chain.rpcUrl);
    const announcerCode = await publicClient.getCode({
      address: deployment.announcerAddress,
    });
    const routerCode = await publicClient.getCode({ address: deployment.routerAddress });
    expect(announcerCode).not.toBe('0x');
    expect(routerCode).not.toBe('0x');
    const configured = await publicClient.readContract({
      address: deployment.routerAddress,
      abi: ROUTER_ABI,
      functionName: 'announcer',
    });
    expect(getAddress(configured)).toBe(getAddress(deployment.announcerAddress));
  });

  test('pays, scans, recovers, and withdraws through the CLI', { timeout: 180_000 }, async () => {
    const paymentFile = join(directory, 'payment.json');
    const payment = parseJson(
      await runCli(
        [
          'pay',
          '--meta-address',
          String(
            parseJson(
              await runCli(['identity', 'export-public', '--identity', identityFile]),
            ).encodedMetaAddress,
          ),
          '--amount',
          '0.05',
          '--rpc-url',
          environment.chain.rpcUrl,
          '--announcer',
          deployment.announcerAddress,
          '--router',
          deployment.routerAddress,
          '--chain-id',
          String(deployment.chainId),
          '--payer-key-env',
          'TEST_PAYER_KEY',
          '--out',
          paymentFile,
        ],
        { TEST_PAYER_KEY: payer.privateKey },
      ),
    );
    expect(payment.stealthAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(payment.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(JSON.stringify(payment)).not.toContain(payer.privateKey);

    const scanFile = join(directory, 'scan.json');
    const scan = parseJson(
      await runCli(
        [
          'scan',
          '--identity',
          identityFile,
          '--password-env',
          'TEST_PASSWORD',
          '--rpc-url',
          environment.chain.rpcUrl,
          '--announcer',
          deployment.announcerAddress,
          '--router',
          deployment.routerAddress,
          '--from-block',
          '0',
          '--state',
          join(directory, 'scan-state.json'),
          '--out',
          scanFile,
        ],
        { TEST_PASSWORD: password },
      ),
    );
    const payments = scan.payments as Array<Record<string, unknown>>;
    expect(payments).toHaveLength(1);
    expect(payments[0]!.stealthAddress).toBe(payment.stealthAddress);
    expect(payments[0]!.verification).toBe('transaction-verified');
    expect(JSON.stringify(scan)).not.toContain('spendingPrivateKey');
    expect(JSON.parse(readFileSync(scanFile, 'utf8'))).toMatchObject({
      payments: [{ txHash: payment.txHash }],
    });

    const recovered = parseJson(
      await runCli(
        [
          'recover',
          '--identity',
          identityFile,
          '--password-env',
          'TEST_PASSWORD',
          '--payment',
          paymentFile,
        ],
        { TEST_PASSWORD: password },
      ),
    );
    expect(recovered.verified).toBe(true);
    expect(recovered.stealthAddress).toBe(payment.stealthAddress);
    expect(recovered.privateKeyPrinted).toBe(false);
    expect(recovered).not.toHaveProperty('stealthPrivateKey');

    const destination = addressOf(randomSecretKey());
    const publicClient = createPublicClientFor(environment.chain.rpcUrl);
    const before = await publicClient.getBalance({ address: destination });
    const withdrawal = parseJson(
      await runCli(
        [
          'withdraw',
          '--identity',
          identityFile,
          '--password-env',
          'TEST_PASSWORD',
          '--payment',
          paymentFile,
          '--to',
          destination,
          '--rpc-url',
          environment.chain.rpcUrl,
        ],
        { TEST_PASSWORD: password },
      ),
    );
    expect(withdrawal.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    const after = await publicClient.getBalance({ address: destination });
    expect(after - before).toBe(BigInt(String(withdrawal.amountWei)));
  });
});
