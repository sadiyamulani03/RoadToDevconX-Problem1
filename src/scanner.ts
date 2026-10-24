import {
  decodeEventLog,
  decodeFunctionData,
  getAddress,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from 'viem';
import { existsSync } from 'node:fs';
import { ANNOUNCEMENT_EVENT, ANNOUNCER_ABI, ROUTER_ABI } from './abi.js';
import { createPublicClientFor, getAndCheckChainId } from './chain.js';
import { extractViewTag, parseEthMetadata } from './crypto/metadata.js';
import {
  assertAddress,
  assertCompressedPublicKey,
  assertPrivateKey,
  isValidCompressedPublicKey,
} from './crypto/secp.js';
import {
  computeSharedSecret,
  deriveCandidateAddress,
  hashSharedSecret,
  SCHEME_ID,
  viewTagFromHash,
} from './crypto/stealth.js';
import { errorMessage, StealthError } from './errors.js';
import { readJsonFile, writeJsonAtomic } from './fs.js';
import type {
  Announcement,
  CompressedPublicKey,
  DiscoveredPayment,
  ScanProgress,
  ScanResult,
  ScanWarning,
  ScannerIdentity,
} from './types.js';

const DEFAULT_PAGE_SIZE = 2_000n;
const DEFAULT_REORG_WINDOW = 12n;

export interface EvaluationDependencies {
  deriveCandidateAddress: (
    spendingPublicKey: CompressedPublicKey,
    hashedSharedSecret: Hex,
  ) => Address;
}

export type AnnouncementEvaluation =
  | {
      status: 'match';
      amountWei?: bigint;
      asset: 'ETH' | 'unknown';
    }
  | { status: 'view-tag-mismatch' }
  | { status: 'address-mismatch' };

const defaultDependencies: EvaluationDependencies = { deriveCandidateAddress };

function validateAnnouncement(announcement: Announcement): void {
  if (announcement.schemeId !== SCHEME_ID) {
    throw new Error(`Unsupported announcement schemeId: ${announcement.schemeId}`);
  }
  assertAddress(announcement.stealthAddress, 'announcement stealth address');
  assertAddress(announcement.caller, 'announcement caller');
  assertCompressedPublicKey(announcement.ephemeralPublicKey, 'ephemeral public key');
  if (!/^0x([0-9a-fA-F]{2})+$/.test(announcement.metadata)) {
    throw new Error('Announcement metadata must be non-empty, even-length hex');
  }
  const metadataViewTag = extractViewTag(announcement.metadata);
  if (metadataViewTag !== announcement.viewTag.toLowerCase()) {
    throw new Error('Announcement view tag does not match the first metadata byte');
  }
}

/**
 * Pure announcement evaluation. The view-tag check is deliberately performed
 * before the injected candidate-address derivation, so a mismatched tag cannot
 * trigger point addition or address recovery work.
 */
export function evaluateAnnouncement(
  announcement: Announcement,
  identity: ScannerIdentity,
  dependencies: EvaluationDependencies = defaultDependencies,
): AnnouncementEvaluation {
  validateAnnouncement(announcement);
  assertPrivateKey(identity.viewingPrivateKey, 'viewing private key');
  assertCompressedPublicKey(identity.spendingPublicKey, 'spending public key');

  const sharedSecret = computeSharedSecret(
    identity.viewingPrivateKey,
    announcement.ephemeralPublicKey,
  );
  const hashedSharedSecret = hashSharedSecret(sharedSecret);
  const expectedViewTag = viewTagFromHash(hashedSharedSecret);

  if (expectedViewTag.toLowerCase() !== announcement.viewTag.toLowerCase()) {
    return { status: 'view-tag-mismatch' };
  }

  const candidateAddress = dependencies.deriveCandidateAddress(
    identity.spendingPublicKey,
    hashedSharedSecret,
  );
  if (getAddress(candidateAddress) !== getAddress(announcement.stealthAddress)) {
    return { status: 'address-mismatch' };
  }

  const parsedMetadata = parseEthMetadata(announcement.metadata);
  return parsedMetadata
    ? { status: 'match', asset: 'ETH', amountWei: parsedMetadata.amountWei }
    : { status: 'match', asset: 'unknown' };
}

export function decodeAnnouncementLog(
  log: Log,
  expectedAnnouncerAddress?: Address,
): Announcement {
  if (
    expectedAnnouncerAddress &&
    log.address.toLowerCase() !== expectedAnnouncerAddress.toLowerCase()
  ) {
    throw new Error('Log was not emitted by the configured announcer');
  }
  if (!log.topics || log.topics.length === 0) {
    throw new Error('Announcement log has no topics');
  }
  if (log.blockNumber === null || log.blockNumber === undefined) {
    throw new Error('Announcement log is missing a block number');
  }
  if (!log.transactionHash) {
    throw new Error('Announcement log is missing a transaction hash');
  }
  if (log.logIndex === null || log.logIndex === undefined) {
    throw new Error('Announcement log is missing a log index');
  }

  let decoded;
  try {
    decoded = decodeEventLog({
      abi: ANNOUNCER_ABI,
      eventName: 'Announcement',
      data: log.data,
      topics: log.topics as [Hex, ...Hex[]],
    });
  } catch {
    throw new Error('Malformed Announcement event data');
  }

  const args = decoded.args;
  if (!args) {
    throw new Error('Announcement event has no decoded arguments');
  }

  if (args.schemeId !== SCHEME_ID) {
    throw new Error(`Unsupported announcement schemeId: ${args.schemeId}`);
  }
  if (!isValidCompressedPublicKey(args.ephemeralPubKey)) {
    throw new Error('Announcement ephemeral public key is not a valid compressed point');
  }

  const stealthAddress = assertAddress(args.stealthAddress, 'announcement stealth address');
  const caller = assertAddress(args.caller, 'announcement caller');
  const viewTag = extractViewTag(args.metadata);

  return {
    schemeId: args.schemeId,
    stealthAddress,
    caller,
    ephemeralPublicKey: args.ephemeralPubKey,
    metadata: args.metadata,
    viewTag,
    blockNumber: log.blockNumber,
    ...(log.blockHash ? { blockHash: log.blockHash } : {}),
    transactionHash: log.transactionHash,
    logIndex: log.logIndex,
    announcerAddress: getAddress(log.address),
  };
}

export interface ScanOptions {
  rpcUrl: string;
  announcerAddress: Address;
  routerAddress?: Address;
  fromBlock?: bigint;
  toBlock?: bigint;
  pageSize?: number;
  reorgWindow?: number;
  statePath?: string;
  verifyTransactions?: boolean;
  onProgress?: (progress: {
    fromBlock: bigint;
    toBlock: bigint;
    payments: number;
  }) => void;
}

function parseScanProgress(value: unknown): ScanProgress {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid scan state: expected an object');
  }
  const state = value as Record<string, unknown>;
  if (state.version !== 1) {
    throw new Error('Invalid scan state: unsupported version');
  }
  if (typeof state.chainId !== 'number') {
    throw new Error('Invalid scan state: missing chain ID');
  }
  if (typeof state.announcerAddress !== 'string') {
    throw new Error('Invalid scan state: missing announcer address');
  }
  if (typeof state.lastScannedBlock !== 'string' || !/^\d+$/.test(state.lastScannedBlock)) {
    throw new Error('Invalid scan state: bad lastScannedBlock');
  }
  return {
    version: 1,
    chainId: state.chainId,
    announcerAddress: getAddress(state.announcerAddress),
    ...(typeof state.routerAddress === 'string'
      ? { routerAddress: getAddress(state.routerAddress) }
      : {}),
    lastScannedBlock: state.lastScannedBlock,
    updatedAt: typeof state.updatedAt === 'string' ? state.updatedAt : '',
  };
}

function readScanProgress(path: string): ScanProgress | undefined {
  if (!existsSync(path)) return undefined;
  return parseScanProgress(readJsonFile(path));
}

function isBlockRangeError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return [
    'block range',
    'range too',
    'too many',
    'more than',
    'exceed',
    'query timeout',
    'response size',
    'limit',
  ].some((needle) => message.includes(needle));
}

async function fetchLogsPage(
  publicClient: PublicClient,
  announcerAddress: Address,
  cursor: bigint,
  requestedEnd: bigint,
): Promise<{ logs: Log[]; end: bigint }> {
  let end = requestedEnd;
  let attempt = 0;

  for (;;) {
    try {
      const logs = await publicClient.getLogs({
        address: announcerAddress,
        fromBlock: cursor,
        toBlock: end,
        event: ANNOUNCEMENT_EVENT,
      });
      return { logs, end };
    } catch (error) {
      attempt += 1;
      if (isBlockRangeError(error) && end > cursor) {
        end = cursor + (end - cursor) / 2n;
        attempt = 0;
        continue;
      }
      if (attempt >= 3) {
        throw new StealthError(
          'SCAN_FAILED',
          `Unable to fetch announcements for blocks ${cursor}-${end}: ${errorMessage(error)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** (attempt - 1)));
    }
  }
}

type RouterVerification =
  | { status: 'verified'; amountWei: bigint; payerAddress: Address }
  | { status: 'address-match'; warning: string }
  | { status: 'invalid'; warning: string };

async function verifyRouterPayment(
  publicClient: PublicClient,
  announcement: Announcement,
  routerAddress: Address,
): Promise<RouterVerification> {
  let receipt;
  let transaction;
  try {
    receipt = await publicClient.getTransactionReceipt({
      hash: announcement.transactionHash,
    });
    transaction = await publicClient.getTransaction({
      hash: announcement.transactionHash,
    });
  } catch {
    return { status: 'invalid', warning: 'Unable to fetch transaction or receipt' };
  }

  if (!receipt || receipt.status !== 'success') {
    return { status: 'invalid', warning: 'Payment transaction did not succeed' };
  }

  const logPresent = receipt.logs.some(
    (log) =>
      log.address.toLowerCase() === announcement.announcerAddress.toLowerCase() &&
      log.transactionHash?.toLowerCase() === announcement.transactionHash.toLowerCase() &&
      log.logIndex === announcement.logIndex,
  );
  if (!logPresent) {
    return { status: 'invalid', warning: 'Announcement log is not present in the receipt' };
  }

  if (!transaction.to || getAddress(transaction.to) !== getAddress(routerAddress)) {
    return {
      status: 'address-match',
      warning:
        'Announcement was not emitted through the configured payment router; ETH transfer not verified',
    };
  }

  if (getAddress(announcement.caller) !== getAddress(routerAddress)) {
    return {
      status: 'invalid',
      warning: 'Router transaction caller does not match the announcement caller',
    };
  }

  let decoded;
  try {
    decoded = decodeFunctionData({ abi: ROUTER_ABI, data: transaction.input });
  } catch {
    return { status: 'invalid', warning: 'Unable to decode router calldata' };
  }

  if (decoded.functionName !== 'pay' || !Array.isArray(decoded.args)) {
    return { status: 'invalid', warning: 'Router transaction did not call pay' };
  }

  const [schemeId, stealthAddress, ephemeralPubKey, metadata] = decoded.args;
  if (
    schemeId !== SCHEME_ID ||
    typeof stealthAddress !== 'string' ||
    getAddress(stealthAddress) !== getAddress(announcement.stealthAddress) ||
    typeof ephemeralPubKey !== 'string' ||
    ephemeralPubKey.toLowerCase() !== announcement.ephemeralPublicKey.toLowerCase() ||
    typeof metadata !== 'string' ||
    metadata.toLowerCase() !== announcement.metadata.toLowerCase()
  ) {
    return { status: 'invalid', warning: 'Router calldata does not match the announcement' };
  }

  const parsedMetadata = parseEthMetadata(announcement.metadata);
  if (!parsedMetadata || parsedMetadata.amountWei !== transaction.value) {
    return {
      status: 'invalid',
      warning: 'Announced ETH amount does not match the transaction value',
    };
  }

  return {
    status: 'verified',
    amountWei: transaction.value,
    payerAddress: transaction.from,
  };
}

export async function scanAnnouncements(
  identity: ScannerIdentity,
  options: ScanOptions,
): Promise<ScanResult> {
  assertPrivateKey(identity.viewingPrivateKey, 'viewing private key');
  assertCompressedPublicKey(identity.spendingPublicKey, 'spending public key');
  const announcerAddress = assertAddress(options.announcerAddress, 'announcer address');
  const routerAddress = options.routerAddress
    ? assertAddress(options.routerAddress, 'router address')
    : undefined;

  const publicClient = createPublicClientFor(options.rpcUrl);
  const chainId = await getAndCheckChainId(publicClient);

  const toBlock = options.toBlock ?? (await publicClient.getBlockNumber());
  const pageSize = BigInt(Math.max(1, Math.floor(options.pageSize ?? Number(DEFAULT_PAGE_SIZE))));
  const reorgWindow = BigInt(
    Math.max(0, Math.floor(options.reorgWindow ?? Number(DEFAULT_REORG_WINDOW))),
  );
  const verifyTransactions = options.verifyTransactions ?? true;

  const state = options.statePath ? readScanProgress(options.statePath) : undefined;
  if (state) {
    if (state.chainId !== chainId) {
      throw new StealthError(
        'SCAN_STATE_MISMATCH',
        `Scan state chain ID ${state.chainId} does not match RPC chain ID ${chainId}`,
      );
    }
    if (getAddress(state.announcerAddress) !== announcerAddress) {
      throw new StealthError(
        'SCAN_STATE_MISMATCH',
        'Scan state announcer address does not match the configured announcer',
      );
    }
    if (
      state.routerAddress &&
      routerAddress &&
      getAddress(state.routerAddress) !== routerAddress
    ) {
      throw new StealthError(
        'SCAN_STATE_MISMATCH',
        'Scan state router address does not match the configured router',
      );
    }
  }

  const resumeStart = state
    ? BigInt(state.lastScannedBlock) - reorgWindow + 1n
    : 0n;
  const requestedStart = options.fromBlock ?? 0n;
  const start = [requestedStart, resumeStart, 0n].reduce((a, b) => (a > b ? a : b));

  if (requestedStart > toBlock) {
    throw new StealthError('INVALID_BLOCK_RANGE', 'fromBlock is greater than toBlock');
  }

  const payments: DiscoveredPayment[] = [];
  const warnings: ScanWarning[] = [];
  const seen = new Set<string>();
  let announcementsSeen = 0;
  let malformedAnnouncements = 0;
  let viewTagMisses = 0;
  let addressMisses = 0;
  let duplicateAnnouncements = 0;
  let lastScannedBlock = state ? BigInt(state.lastScannedBlock) : 0n;

  let cursor = start;
  while (cursor <= toBlock) {
    const requestedEnd = [cursor + pageSize - 1n, toBlock].reduce((a, b) => (a < b ? a : b));
    const { logs, end } = await fetchLogsPage(
      publicClient,
      announcerAddress,
      cursor,
      requestedEnd,
    );

    for (const log of logs) {
      announcementsSeen += 1;
      let announcement: Announcement;
      try {
        announcement = decodeAnnouncementLog(log, announcerAddress);
      } catch (error) {
        malformedAnnouncements += 1;
        warnings.push({
          ...(log.transactionHash ? { transactionHash: log.transactionHash } : {}),
          ...(log.logIndex !== null ? { logIndex: log.logIndex } : {}),
          reason: errorMessage(error),
        });
        continue;
      }

      const key = `${announcement.transactionHash.toLowerCase()}:${announcement.logIndex}`;
      if (seen.has(key)) {
        duplicateAnnouncements += 1;
        continue;
      }
      seen.add(key);

      let evaluation;
      try {
        evaluation = evaluateAnnouncement(announcement, identity);
      } catch (error) {
        malformedAnnouncements += 1;
        warnings.push({
          transactionHash: announcement.transactionHash,
          logIndex: announcement.logIndex,
          reason: errorMessage(error),
        });
        continue;
      }

      if (evaluation.status === 'view-tag-mismatch') {
        viewTagMisses += 1;
        continue;
      }
      if (evaluation.status === 'address-mismatch') {
        addressMisses += 1;
        warnings.push({
          transactionHash: announcement.transactionHash,
          logIndex: announcement.logIndex,
          reason: 'View tag matched but the derived stealth address did not; ignored',
        });
        continue;
      }

      let verification: DiscoveredPayment['verification'] = 'address-match';
      let amountWei = evaluation.amountWei;
      let payerAddress: Address | undefined;

      if (verifyTransactions && routerAddress) {
        const verified = await verifyRouterPayment(
          publicClient,
          announcement,
          routerAddress,
        );
        if (verified.status === 'invalid') {
          warnings.push({
            transactionHash: announcement.transactionHash,
            logIndex: announcement.logIndex,
            reason: verified.warning,
          });
          continue;
        }
        if (verified.status === 'address-match') {
          warnings.push({
            transactionHash: announcement.transactionHash,
            logIndex: announcement.logIndex,
            reason: verified.warning,
          });
        } else {
          verification = 'transaction-verified';
          amountWei = verified.amountWei;
          payerAddress = verified.payerAddress;
        }
      }

      payments.push({
        announcement,
        stealthAddress: announcement.stealthAddress,
        ...(amountWei !== undefined ? { amountWei } : {}),
        asset: evaluation.asset,
        verification,
        txHash: announcement.transactionHash,
        blockNumber: announcement.blockNumber,
        logIndex: announcement.logIndex,
        ...(payerAddress ? { payerAddress } : {}),
      });
    }

    lastScannedBlock = end;
    if (options.statePath) {
      const progress: ScanProgress = {
        version: 1,
        chainId,
        announcerAddress,
        ...(routerAddress ? { routerAddress } : {}),
        lastScannedBlock: end.toString(),
        updatedAt: new Date().toISOString(),
      };
      writeJsonAtomic(options.statePath, progress);
    }
    options.onProgress?.({
      fromBlock: cursor,
      toBlock: end,
      payments: payments.length,
    });

    cursor = end + 1n;
  }

  payments.sort((a, b) => {
    if (a.blockNumber === b.blockNumber) return a.logIndex - b.logIndex;
    return a.blockNumber < b.blockNumber ? -1 : 1;
  });

  return {
    payments,
    scannedFromBlock: start,
    scannedToBlock: toBlock,
    announcementsSeen,
    malformedAnnouncements,
    viewTagMisses,
    addressMisses,
    duplicateAnnouncements,
    warnings,
    ...(options.statePath
      ? {
          progress: {
            version: 1 as const,
            chainId,
            announcerAddress,
            ...(routerAddress ? { routerAddress } : {}),
            lastScannedBlock: lastScannedBlock.toString(),
            updatedAt: new Date().toISOString(),
          },
        }
      : {}),
  };
}
