import { privateKeyToAccount } from 'viem/accounts';
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from 'viem';
import { assertAddress, assertPrivateKey } from './crypto/secp.js';
import { StealthError } from './errors.js';

const TRANSPORT_OPTIONS = {
  retryCount: 3,
  retryDelay: 250,
  timeout: 30_000,
} as const;

export function validateRpcUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new StealthError('INVALID_RPC_URL', 'An RPC URL is required');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new StealthError('INVALID_RPC_URL', 'RPC URL must be a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new StealthError('INVALID_RPC_URL', 'RPC URL must use http or https');
  }
  return url.toString();
}

export function redactRpcUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname === '/' ? '' : '/[redacted-path]'}`;
  } catch {
    return '[invalid-rpc-url]';
  }
}

export function createPublicClientFor(rpcUrl: string): PublicClient {
  return createPublicClient({
    transport: http(validateRpcUrl(rpcUrl), TRANSPORT_OPTIONS),
  });
}

export function createWalletClientFor(rpcUrl: string, privateKey: Hex): WalletClient {
  assertPrivateKey(privateKey, 'payer private key');
  const account = privateKeyToAccount(privateKey);
  return createWalletClient({
    account,
    transport: http(validateRpcUrl(rpcUrl), TRANSPORT_OPTIONS),
  });
}

export function createAnvilTestClient(rpcUrl: string) {
  return createTestClient({
    mode: 'anvil',
    transport: http(validateRpcUrl(rpcUrl), TRANSPORT_OPTIONS),
  });
}

export async function assertContractDeployed(
  publicClient: PublicClient,
  address: Address,
  label: string,
): Promise<void> {
  assertAddress(address, label);
  const code = await publicClient.getCode({ address });
  if (!code || code === '0x') {
    throw new StealthError('CONTRACT_NOT_DEPLOYED', `${label} has no contract code at ${address}`);
  }
}

export async function getAndCheckChainId(
  publicClient: PublicClient,
  expectedChainId?: number,
): Promise<number> {
  const chainId = await publicClient.getChainId();
  if (expectedChainId !== undefined && chainId !== expectedChainId) {
    throw new StealthError(
      'CHAIN_ID_MISMATCH',
      `RPC chain ID ${chainId} does not match expected chain ID ${expectedChainId}`,
    );
  }
  return chainId;
}

export async function waitForSuccessfulReceipt(
  publicClient: PublicClient,
  txHash: Hex,
): Promise<TransactionReceipt> {
  let receipt: TransactionReceipt;
  try {
    receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      confirmations: 1,
      timeout: 90_000,
      pollingInterval: 250,
    });
  } catch {
    throw new StealthError('RECEIPT_TIMEOUT', `Timed out waiting for transaction receipt ${txHash}`);
  }
  if (receipt.status !== 'success') {
    throw new StealthError('TX_REVERTED', `Transaction ${txHash} reverted`);
  }
  return receipt;
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: { attempts?: number; baseDelayMs?: number; label?: string } = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 300;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch {
      if (attempt === attempts) break;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)));
    }
  }

  const label = options.label ? `${options.label}: ` : '';
  throw new StealthError(
    'RPC_FAILURE',
    `${label}RPC operation failed after ${attempts} attempts`,
  );
}

export function weiToEth(value: bigint): string {
  const whole = value / 10n ** 18n;
  const fraction = (value % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
