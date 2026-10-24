import { encodeFunctionData, getAddress, parseEventLogs, type Address, type Hex } from 'viem';
import { ANNOUNCER_ABI, ROUTER_ABI } from './abi.js';
import {
  assertAddress,
  assertPrivateKey,
  isValidAddress,
} from './crypto/secp.js';
import { buildEthMetadata } from './crypto/metadata.js';
import {
  generateStealthAddress,
  parseStealthMetaAddress,
  SCHEME_ID,
} from './crypto/stealth.js';
import {
  assertContractDeployed,
  createPublicClientFor,
  createWalletClientFor,
  getAndCheckChainId,
  waitForSuccessfulReceipt,
} from './chain.js';
import { errorMessage, StealthError } from './errors.js';
import type { PaymentReceipt } from './types.js';

const MAX_UINT256 = (1n << 256n) - 1n;

export interface PayParams {
  rpcUrl: string;
  announcerAddress: Address;
  routerAddress: Address;
  metaAddress: string;
  amountWei: bigint;
  payerPrivateKey: Hex;
  chainId?: number;
}

export async function payToStealthAddress(params: PayParams): Promise<PaymentReceipt> {
  if (typeof params.amountWei !== 'bigint' || params.amountWei <= 0n) {
    throw new StealthError('INVALID_AMOUNT', 'Payment amount must be a positive bigint in wei');
  }
  if (params.amountWei > MAX_UINT256) {
    throw new StealthError('INVALID_AMOUNT', 'Payment amount exceeds uint256');
  }

  assertPrivateKey(params.payerPrivateKey, 'payer private key');
  const announcerAddress = assertAddress(params.announcerAddress, 'announcer address');
  const routerAddress = assertAddress(params.routerAddress, 'router address');
  const meta = parseStealthMetaAddress(params.metaAddress);

  // A fresh CSPRNG ephemeral key is generated inside this payment call.
  const { stealthAddress, ephemeralPublicKey, viewTag } =
    generateStealthAddress(meta);
  const metadata = buildEthMetadata(viewTag, params.amountWei);

  const publicClient = createPublicClientFor(params.rpcUrl);
  const walletClient = createWalletClientFor(params.rpcUrl, params.payerPrivateKey);
  const chainId = await getAndCheckChainId(publicClient, params.chainId);

  await assertContractDeployed(publicClient, announcerAddress, 'announcer');
  await assertContractDeployed(publicClient, routerAddress, 'router');

  const configuredAnnouncer = await publicClient.readContract({
    address: routerAddress,
    abi: ROUTER_ABI,
    functionName: 'announcer',
  });
  if (getAddress(configuredAnnouncer) !== announcerAddress) {
    throw new StealthError(
      'ROUTER_ANNOUNCER_MISMATCH',
      `Router ${routerAddress} announces to ${configuredAnnouncer}, not ${announcerAddress}`,
    );
  }

  const account = walletClient.account;
  if (!account) {
    throw new StealthError('WALLET_UNAVAILABLE', 'Payer wallet account is unavailable');
  }

  try {
    await publicClient.simulateContract({
      account,
      address: routerAddress,
      abi: ROUTER_ABI,
      functionName: 'pay',
      args: [SCHEME_ID, stealthAddress, ephemeralPublicKey, metadata],
      value: params.amountWei,
    });
  } catch (error) {
    throw new StealthError(
      'PAYMENT_SIMULATION_FAILED',
      `Payment simulation failed: ${errorMessage(error)}`,
    );
  }

  const data = encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: 'pay',
    args: [SCHEME_ID, stealthAddress, ephemeralPublicKey, metadata],
  });

  let txHash: Hex;
  try {
    txHash = await walletClient.sendTransaction({
      account,
      to: routerAddress,
      value: params.amountWei,
      data,
      chain: null,
    });
  } catch (error) {
    throw new StealthError('PAYMENT_SUBMISSION_FAILED', `Payment submission failed: ${errorMessage(error)}`);
  }

  const receipt = await waitForSuccessfulReceipt(publicClient, txHash);
  const announcementLogs = parseEventLogs({
    abi: ANNOUNCER_ABI,
    eventName: 'Announcement',
    logs: receipt.logs.filter(
      (log) => log.address.toLowerCase() === announcerAddress.toLowerCase(),
    ),
  }).filter((log) => log.transactionHash?.toLowerCase() === txHash.toLowerCase());

  if (announcementLogs.length !== 1) {
    throw new StealthError(
      'ANNOUNCEMENT_MISSING',
      `Expected exactly one Announcement event in ${txHash}, found ${announcementLogs.length}`,
    );
  }

  const log = announcementLogs[0];
  if (!log || !log.args) {
    throw new StealthError('ANNOUNCEMENT_MISSING', `Unable to decode Announcement event in ${txHash}`);
  }

  const args = log.args;
  if (
    args.schemeId !== SCHEME_ID ||
    !isValidAddress(args.stealthAddress) ||
    getAddress(args.stealthAddress) !== stealthAddress ||
    args.ephemeralPubKey?.toLowerCase() !== ephemeralPublicKey.toLowerCase() ||
    args.metadata?.toLowerCase() !== metadata.toLowerCase()
  ) {
    throw new StealthError(
      'ANNOUNCEMENT_MISMATCH',
      'The on-chain Announcement does not match the locally derived payment',
    );
  }

  return {
    version: 1,
    schemeId: SCHEME_ID,
    chainId,
    announcerAddress,
    routerAddress,
    payerAddress: account.address,
    stealthAddress,
    ephemeralPublicKey,
    viewTag,
    metadata,
    amountWei: params.amountWei,
    txHash,
    blockNumber: receipt.blockNumber,
    logIndex: log.logIndex,
  };
}
