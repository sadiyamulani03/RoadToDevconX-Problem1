import {
  assertAddress,
  assertCompressedPublicKey,
  isValidAddress,
} from './crypto/secp.js';
import { extractViewTag } from './crypto/metadata.js';
import type {
  Address,
  CompressedPublicKey,
  DiscoveredPayment,
  Hex,
  PaymentReceipt,
  ViewTag,
} from './types.js';

export interface PaymentReference {
  version: 1;
  chainId?: number;
  announcerAddress?: Address;
  routerAddress?: Address;
  schemeId: bigint;
  stealthAddress: Address;
  ephemeralPublicKey: CompressedPublicKey;
  viewTag?: ViewTag;
  metadata?: Hex;
  amountWei?: bigint;
  payerAddress?: Address;
  txHash?: Hex;
  blockNumber?: bigint;
  logIndex?: number;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function maybeAddress(value: unknown, label: string): Address | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (!isValidAddress(value)) throw new Error(`${label} is not a valid Ethereum address`);
  return value;
}

function maybeBigInt(value: unknown, label: string): bigint | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  throw new Error(`${label} must be a non-negative integer`);
}

function maybeNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new Error(`${label} must be a safe integer`);
}

export function paymentReferenceFromReceipt(receipt: PaymentReceipt): PaymentReference {
  return {
    version: 1,
    chainId: receipt.chainId,
    announcerAddress: receipt.announcerAddress,
    routerAddress: receipt.routerAddress,
    schemeId: receipt.schemeId,
    stealthAddress: receipt.stealthAddress,
    ephemeralPublicKey: receipt.ephemeralPublicKey,
    viewTag: receipt.viewTag,
    metadata: receipt.metadata,
    amountWei: receipt.amountWei,
    payerAddress: receipt.payerAddress,
    txHash: receipt.txHash,
    blockNumber: receipt.blockNumber,
    logIndex: receipt.logIndex,
  };
}

export function paymentReferenceFromDiscovered(
  payment: DiscoveredPayment,
): PaymentReference {
  return {
    version: 1,
    announcerAddress: payment.announcement.announcerAddress,
    schemeId: payment.announcement.schemeId,
    stealthAddress: payment.stealthAddress,
    ephemeralPublicKey: payment.announcement.ephemeralPublicKey,
    viewTag: payment.announcement.viewTag,
    metadata: payment.announcement.metadata,
    ...(payment.amountWei !== undefined ? { amountWei: payment.amountWei } : {}),
    ...(payment.payerAddress ? { payerAddress: payment.payerAddress } : {}),
    txHash: payment.txHash,
    blockNumber: payment.blockNumber,
    logIndex: payment.logIndex,
  };
}

function parseOne(value: unknown): PaymentReference {
  const record = asRecord(value, 'Payment record');
  const announcement = record.announcement
    ? asRecord(record.announcement, 'Payment announcement')
    : record;

  const stealthAddress = maybeAddress(
    record.stealthAddress ?? announcement.stealthAddress,
    'stealthAddress',
  );
  const ephemeralPublicKey = assertCompressedPublicKey(
    announcement.ephemeralPublicKey ?? record.ephemeralPublicKey,
    'payment ephemeral public key',
  );
  if (!stealthAddress) throw new Error('Payment record is missing stealthAddress');

  const metadataValue = announcement.metadata ?? record.metadata;
  if (metadataValue !== undefined && (typeof metadataValue !== 'string' || !/^0x[0-9a-fA-F]*$/.test(metadataValue))) {
    throw new Error('Payment metadata must be a hex string');
  }
  const metadata = metadataValue as Hex | undefined;
  const viewTagValue = announcement.viewTag ?? record.viewTag;
  if (viewTagValue !== undefined && (typeof viewTagValue !== 'string' || !/^0x[0-9a-fA-F]{2}$/.test(viewTagValue))) {
    throw new Error('Payment viewTag must be one byte');
  }
  const viewTag = (viewTagValue as ViewTag | undefined) ?? (metadata ? extractViewTag(metadata) : undefined);
  if (viewTag && metadata && extractViewTag(metadata) !== viewTag.toLowerCase()) {
    throw new Error('Payment viewTag does not match metadata');
  }

  const schemeId = maybeBigInt(record.schemeId ?? announcement.schemeId, 'schemeId') ?? 1n;
  if (schemeId !== 1n) throw new Error('Only ERC-5564 Scheme 1 payment records are supported');

  const txHashValue = record.txHash ?? announcement.txHash;
  const txHash =
    typeof txHashValue === 'string' && /^0x[0-9a-fA-F]{64}$/.test(txHashValue)
      ? (txHashValue as Hex)
      : undefined;

  return {
    version: 1,
    ...(maybeNumber(record.chainId, 'chainId') !== undefined
      ? { chainId: maybeNumber(record.chainId, 'chainId') }
      : {}),
    ...(maybeAddress(record.announcerAddress ?? announcement.announcerAddress, 'announcerAddress')
      ? {
          announcerAddress: maybeAddress(
            record.announcerAddress ?? announcement.announcerAddress,
            'announcerAddress',
          ),
        }
      : {}),
    ...(maybeAddress(record.routerAddress, 'routerAddress')
      ? { routerAddress: maybeAddress(record.routerAddress, 'routerAddress') }
      : {}),
    schemeId,
    stealthAddress: assertAddress(stealthAddress, 'stealthAddress'),
    ephemeralPublicKey,
    ...(viewTag ? { viewTag } : {}),
    ...(metadata ? { metadata } : {}),
    ...(maybeBigInt(record.amountWei, 'amountWei') !== undefined
      ? { amountWei: maybeBigInt(record.amountWei, 'amountWei') }
      : {}),
    ...(maybeAddress(record.payerAddress, 'payerAddress')
      ? { payerAddress: maybeAddress(record.payerAddress, 'payerAddress') }
      : {}),
    ...(txHash ? { txHash } : {}),
    ...(maybeBigInt(record.blockNumber, 'blockNumber') !== undefined
      ? { blockNumber: maybeBigInt(record.blockNumber, 'blockNumber') }
      : {}),
    ...(maybeNumber(record.logIndex, 'logIndex') !== undefined
      ? { logIndex: maybeNumber(record.logIndex, 'logIndex') }
      : {}),
  };
}

export function parsePaymentReference(value: unknown, index = 0): PaymentReference {
  if (Array.isArray(value)) {
    if (!Number.isInteger(index) || index < 0 || index >= value.length) {
      throw new Error(`Payment index ${index} is out of range (${value.length} records)`);
    }
    return parseOne(value[index]);
  }
  const record = asRecord(value, 'Payment file');
  if (Array.isArray(record.payments)) {
    if (!Number.isInteger(index) || index < 0 || index >= record.payments.length) {
      throw new Error(
        `Payment index ${index} is out of range (${record.payments.length} records)`,
      );
    }
    return parseOne(record.payments[index]);
  }
  return parseOne(record);
}

export function paymentKey(payment: { txHash?: Hex; logIndex?: number; stealthAddress: Address }): string {
  return payment.txHash
    ? `${payment.txHash.toLowerCase()}:${payment.logIndex ?? 0}`
    : payment.stealthAddress.toLowerCase();
}

