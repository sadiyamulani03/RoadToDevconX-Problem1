import { type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  assertAddress,
  assertPrivateKey,
  publicKeyToAddress,
  publicKeyFromPrivateKey,
} from './crypto/secp.js';
import {
  createPublicClientFor,
  createWalletClientFor,
  getAndCheckChainId,
  waitForSuccessfulReceipt,
} from './chain.js';
import { errorMessage, StealthError } from './errors.js';

export interface WithdrawParams {
  rpcUrl: string;
  stealthPrivateKey: Hex;
  to: Address;
  amountWei?: bigint;
  chainId?: number;
  expectedStealthAddress?: Address;
}

export interface WithdrawResult {
  from: Address;
  to: Address;
  txHash: Hex;
  blockNumber: bigint;
  amountWei: bigint;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  balanceBefore: bigint;
  balanceAfter: bigint;
}

export async function withdrawFromStealthAddress(
  params: WithdrawParams,
): Promise<WithdrawResult> {
  const stealthPrivateKey = assertPrivateKey(
    params.stealthPrivateKey,
    'stealth private key',
  );
  const to = assertAddress(params.to, 'withdrawal destination');
  if (to === '0x0000000000000000000000000000000000000000') {
    throw new StealthError('INVALID_DESTINATION', 'Withdrawal destination cannot be the zero address');
  }

  const account = privateKeyToAccount(stealthPrivateKey);
  const derivedAddress = publicKeyToAddress(publicKeyFromPrivateKey(stealthPrivateKey));
  if (account.address !== derivedAddress) {
    throw new StealthError('KEY_MISMATCH', 'Stealth private key does not derive the expected address');
  }
  if (
    params.expectedStealthAddress &&
    account.address !== assertAddress(params.expectedStealthAddress, 'expected stealth address')
  ) {
    throw new StealthError(
      'KEY_MISMATCH',
      'Recovered key does not match the expected stealth address',
    );
  }
  if (account.address === to) {
    throw new StealthError('INVALID_DESTINATION', 'Withdrawal destination must differ from the stealth address');
  }

  const publicClient = createPublicClientFor(params.rpcUrl);
  const walletClient = createWalletClientFor(params.rpcUrl, stealthPrivateKey);
  await getAndCheckChainId(publicClient, params.chainId);

  const balanceBefore = await publicClient.getBalance({ address: account.address });
  if (balanceBefore === 0n) {
    throw new StealthError(
      'INSUFFICIENT_BALANCE',
      `Stealth address ${account.address} has no ETH to withdraw`,
    );
  }

  let gasEstimate: bigint;
  try {
    gasEstimate = await publicClient.estimateGas({
      account: account.address,
      to,
      value: 1n,
    });
  } catch (error) {
    throw new StealthError(
      'GAS_ESTIMATION_FAILED',
      `Unable to estimate withdrawal gas: ${errorMessage(error)}`,
    );
  }
  const gasLimit = (gasEstimate * 120n) / 100n;

  let maxFeePerGas: bigint;
  let maxPriorityFeePerGas: bigint | undefined;
  let gasPrice: bigint | undefined;
  try {
    const fees = await publicClient.estimateFeesPerGas();
    if (fees.maxFeePerGas !== undefined) {
      maxFeePerGas = (fees.maxFeePerGas * 120n) / 100n;
      maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? 1_000_000_000n;
    } else if (fees.gasPrice !== undefined) {
      gasPrice = (fees.gasPrice * 120n) / 100n;
      maxFeePerGas = gasPrice;
    } else {
      throw new Error('no fee data');
    }
  } catch {
    const price = await publicClient.getGasPrice();
    gasPrice = (price * 120n) / 100n;
    maxFeePerGas = gasPrice;
  }

  const maximumFee = gasLimit * maxFeePerGas;
  let amountWei: bigint;
  if (params.amountWei !== undefined) {
    if (typeof params.amountWei !== 'bigint' || params.amountWei <= 0n) {
      throw new StealthError('INVALID_AMOUNT', 'Withdrawal amount must be a positive bigint in wei');
    }
    amountWei = params.amountWei;
    if (balanceBefore < amountWei + maximumFee) {
      throw new StealthError(
        'INSUFFICIENT_BALANCE',
        `Balance ${balanceBefore} wei is insufficient for amount ${amountWei} wei plus maximum gas ${maximumFee} wei`,
      );
    }
  } else {
    if (balanceBefore <= maximumFee) {
      throw new StealthError(
        'INSUFFICIENT_BALANCE',
        `Balance ${balanceBefore} wei does not cover the maximum gas cost ${maximumFee} wei`,
      );
    }
    amountWei = balanceBefore - maximumFee;
  }

  let txHash: Hex;
  try {
    const base = { account, to, value: amountWei, gas: gasLimit, chain: null };
    const request =
      maxPriorityFeePerGas !== undefined
        ? { ...base, maxFeePerGas, maxPriorityFeePerGas }
        : { ...base, gasPrice: gasPrice ?? maxFeePerGas };
    txHash = await walletClient.sendTransaction(request);
  } catch (error) {
    throw new StealthError(
      'WITHDRAWAL_FAILED',
      `Withdrawal transaction failed: ${errorMessage(error)}`,
    );
  }

  const receipt = await waitForSuccessfulReceipt(publicClient, txHash);
  const balanceAfter = await publicClient.getBalance({ address: account.address });

  return {
    from: account.address,
    to,
    txHash,
    blockNumber: receipt.blockNumber,
    amountWei,
    gasUsed: receipt.gasUsed,
    effectiveGasPrice: receipt.effectiveGasPrice,
    balanceBefore,
    balanceAfter,
  };
}
