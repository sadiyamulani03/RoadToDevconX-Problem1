import type {
  Address,
  CompressedPublicKey,
  Hex,
  PrivateKey,
  ViewTag,
} from './crypto/types.js';

export type {
  Address,
  CompressedPublicKey,
  Hex,
  PrivateKey,
  ViewTag,
} from './crypto/types.js';

export interface RecipientPublicIdentity {
  name?: string;
  spendingPublicKey: CompressedPublicKey;
  viewingPublicKey: CompressedPublicKey;
  encodedMetaAddress: string;
}

export interface RecipientIdentity extends RecipientPublicIdentity {
  spendingPrivateKey: PrivateKey;
  viewingPrivateKey: PrivateKey;
}

/**
 * The complete input to the discovery path. It intentionally contains no spending
 * private key and no object that can decrypt one.
 */
export interface ScannerIdentity {
  viewingPrivateKey: PrivateKey;
  spendingPublicKey: CompressedPublicKey;
}

export interface Announcement {
  schemeId: bigint;
  stealthAddress: Address;
  caller: Address;
  ephemeralPublicKey: CompressedPublicKey;
  metadata: Hex;
  viewTag: ViewTag;
  blockNumber: bigint;
  blockHash?: Hex;
  transactionHash: Hex;
  logIndex: number;
  announcerAddress: Address;
}

export interface PaymentReceipt {
  version: 1;
  schemeId: bigint;
  chainId: number;
  announcerAddress: Address;
  routerAddress: Address;
  payerAddress: Address;
  stealthAddress: Address;
  ephemeralPublicKey: CompressedPublicKey;
  viewTag: ViewTag;
  metadata: Hex;
  amountWei: bigint;
  txHash: Hex;
  blockNumber: bigint;
  logIndex: number;
}

export type PaymentVerification = 'address-match' | 'transaction-verified';

export interface DiscoveredPayment {
  announcement: Announcement;
  stealthAddress: Address;
  amountWei?: bigint;
  asset: 'ETH' | 'unknown';
  verification: PaymentVerification;
  txHash: Hex;
  blockNumber: bigint;
  logIndex: number;
  payerAddress?: Address;
}

export interface ScanWarning {
  transactionHash?: Hex;
  logIndex?: number;
  reason: string;
}

export interface ScanProgress {
  version: 1;
  chainId: number;
  announcerAddress: Address;
  routerAddress?: Address;
  lastScannedBlock: string;
  updatedAt: string;
}

export interface DeployResult {
  version: 1;
  chainId: number;
  deployer: Address;
  announcerAddress: Address;
  routerAddress: Address;
  announcerBlock: bigint;
  routerBlock: bigint;
  announcerTxHash: Hex | null;
  routerTxHash: Hex;
  deployedAt: string;
  deploymentFile?: string;
}

export interface ScanResult {
  payments: DiscoveredPayment[];
  scannedFromBlock: bigint;
  scannedToBlock: bigint;
  announcementsSeen: number;
  malformedAnnouncements: number;
  viewTagMisses: number;
  addressMisses: number;
  duplicateAnnouncements: number;
  warnings: ScanWarning[];
  progress?: ScanProgress;
}
