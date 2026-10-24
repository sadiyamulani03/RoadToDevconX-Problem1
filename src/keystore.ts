import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import {
  assertPrivateKey,
  isValidCompressedPublicKey,
  publicKeyFromPrivateKey,
} from './crypto/secp.js';
import { encodeStealthMetaAddress } from './crypto/stealth.js';
import { writeJsonAtomic } from './fs.js';
import type {
  Hex,
  PrivateKey,
  RecipientIdentity,
  RecipientPublicIdentity,
  ScannerIdentity,
} from './types.js';

const KEYSTORE_VERSION = 1;
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const CIPHER = 'aes-256-gcm';
const AAD_SPENDING = 'erc5564-keystore:v1:spending';
const AAD_VIEWING = 'erc5564-keystore:v1:viewing';

interface EncryptedBlob {
  iv: Hex;
  ciphertext: Hex;
  authTag: Hex;
}

interface KdfParams {
  name: 'scrypt';
  N: number;
  r: number;
  p: number;
  salt: Hex;
}

export interface KeystoreFile {
  version: 1;
  name?: string;
  createdAt: string;
  spendingPublicKey: Hex;
  viewingPublicKey: Hex;
  encodedMetaAddress: string;
  kdf: KdfParams;
  cipher: 'aes-256-gcm';
  spending: EncryptedBlob;
  viewing: EncryptedBlob;
}

export interface KeystoreSummary {
  version: 1;
  name?: string;
  createdAt: string;
  spendingPublicKey: Hex;
  viewingPublicKey: Hex;
  encodedMetaAddress: string;
  cipher: 'aes-256-gcm';
  kdf: { name: 'scrypt'; N: number; r: number; p: number };
}

export function assertPassword(password: string): string {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('Keystore password must be at least 8 characters');
  }
  return password;
}

function deriveEncryptionKey(
  password: string,
  kdf: Pick<KdfParams, 'N' | 'r' | 'p' | 'salt'>,
): Buffer {
  return scryptSync(assertPassword(password), Buffer.from(kdf.salt.slice(2), 'hex'), 32, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: SCRYPT_MAXMEM,
  });
}

function encryptPrivateKey(
  privateKey: PrivateKey,
  key: Buffer,
  aad: string,
): EncryptedBlob {
  assertPrivateKey(privateKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv(CIPHER, key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(privateKey.slice(2), 'hex')),
    cipher.final(),
  ]);
  return {
    iv: `0x${iv.toString('hex')}`,
    ciphertext: `0x${ciphertext.toString('hex')}`,
    authTag: `0x${cipher.getAuthTag().toString('hex')}`,
  };
}

function decryptPrivateKey(
  blob: EncryptedBlob,
  key: Buffer,
  aad: string,
  label: string,
): PrivateKey {
  if (
    !blob ||
    !/^0x[0-9a-fA-F]{24}$/.test(blob.iv) ||
    !/^0x[0-9a-fA-F]{64}$/.test(blob.ciphertext) ||
    !/^0x[0-9a-fA-F]{32}$/.test(blob.authTag)
  ) {
    throw new Error(`Corrupted keystore: invalid ${label} ciphertext`);
  }

  try {
    const decipher = createDecipheriv(CIPHER, key, Buffer.from(blob.iv.slice(2), 'hex'));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(blob.authTag.slice(2), 'hex'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(blob.ciphertext.slice(2), 'hex')),
      decipher.final(),
    ]);
    if (plaintext.length !== 32) {
      throw new Error('unexpected plaintext length');
    }
    const privateKey = `0x${plaintext.toString('hex')}` as PrivateKey;
    return assertPrivateKey(privateKey, label);
  } catch {
    throw new Error('Invalid password or corrupted keystore');
  }
}

export function createKeystoreFile(
  identity: RecipientIdentity,
  password: string,
): KeystoreFile {
  assertPrivateKey(identity.spendingPrivateKey, 'spending private key');
  assertPrivateKey(identity.viewingPrivateKey, 'viewing private key');
  if (publicKeyFromPrivateKey(identity.spendingPrivateKey) !== identity.spendingPublicKey) {
    throw new Error('Spending public key does not match the spending private key');
  }
  if (publicKeyFromPrivateKey(identity.viewingPrivateKey) !== identity.viewingPublicKey) {
    throw new Error('Viewing public key does not match the viewing private key');
  }
  if (
    encodeStealthMetaAddress(identity.spendingPublicKey, identity.viewingPublicKey) !==
    identity.encodedMetaAddress
  ) {
    throw new Error('Encoded meta-address does not match the identity public keys');
  }

  const salt = `0x${randomBytes(16).toString('hex')}` as Hex;
  const kdf = { name: 'scrypt' as const, N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, salt };
  const encryptionKey = deriveEncryptionKey(password, kdf);

  return {
    version: KEYSTORE_VERSION,
    ...(identity.name ? { name: identity.name } : {}),
    createdAt: new Date().toISOString(),
    spendingPublicKey: identity.spendingPublicKey,
    viewingPublicKey: identity.viewingPublicKey,
    encodedMetaAddress: identity.encodedMetaAddress,
    kdf,
    cipher: CIPHER,
    spending: encryptPrivateKey(identity.spendingPrivateKey, encryptionKey, AAD_SPENDING),
    viewing: encryptPrivateKey(identity.viewingPrivateKey, encryptionKey, AAD_VIEWING),
  };
}

export function writeKeystoreFile(
  path: string,
  keystore: KeystoreFile,
  options: { force?: boolean } = {},
): void {
  if (!options.force && existsSync(path)) {
    throw new Error(`Keystore already exists at ${path}; pass --force to overwrite`);
  }
  writeJsonAtomic(path, keystore);
}

function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid keystore: ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function parseKeystoreFile(value: unknown): KeystoreFile {
  const file = assertObject(value, 'root');
  if (file.version !== KEYSTORE_VERSION) {
    throw new Error(`Unsupported keystore version: ${String(file.version)}`);
  }
  if (typeof file.spendingPublicKey !== 'string' || !isValidCompressedPublicKey(file.spendingPublicKey)) {
    throw new Error('Invalid keystore: bad spending public key');
  }
  if (typeof file.viewingPublicKey !== 'string' || !isValidCompressedPublicKey(file.viewingPublicKey)) {
    throw new Error('Invalid keystore: bad viewing public key');
  }
  if (typeof file.encodedMetaAddress !== 'string') {
    throw new Error('Invalid keystore: missing encoded meta-address');
  }
  if (file.cipher !== CIPHER) {
    throw new Error('Invalid keystore: unsupported cipher');
  }
  const kdf = assertObject(file.kdf, 'kdf');
  if (kdf.name !== 'scrypt') {
    throw new Error('Invalid keystore: unsupported KDF');
  }
  if (
    typeof kdf.N !== 'number' ||
    typeof kdf.r !== 'number' ||
    typeof kdf.p !== 'number' ||
    kdf.N < (1 << 14) ||
    kdf.N > (1 << 20) ||
    kdf.r < 1 ||
    kdf.r > 16 ||
    kdf.p < 1 ||
    kdf.p > 4
  ) {
    throw new Error('Invalid keystore: unsafe KDF parameters');
  }
  if (typeof kdf.salt !== 'string' || !/^0x[0-9a-fA-F]{32}$/.test(kdf.salt)) {
    throw new Error('Invalid keystore: invalid KDF salt');
  }

  const spending = assertObject(file.spending, 'spending');
  const viewing = assertObject(file.viewing, 'viewing');
  for (const [label, blob] of [
    ['spending', spending],
    ['viewing', viewing],
  ] as const) {
    if (
      typeof blob.iv !== 'string' ||
      typeof blob.ciphertext !== 'string' ||
      typeof blob.authTag !== 'string'
    ) {
      throw new Error(`Invalid keystore: malformed ${label} ciphertext`);
    }
  }

  if (
    encodeStealthMetaAddress(
      file.spendingPublicKey as Hex,
      file.viewingPublicKey as Hex,
    ) !== file.encodedMetaAddress
  ) {
    throw new Error('Invalid keystore: meta-address does not match public keys');
  }

  return {
    version: 1,
    ...(typeof file.name === 'string' ? { name: file.name } : {}),
    createdAt: typeof file.createdAt === 'string' ? file.createdAt : '',
    spendingPublicKey: file.spendingPublicKey as Hex,
    viewingPublicKey: file.viewingPublicKey as Hex,
    encodedMetaAddress: file.encodedMetaAddress,
    kdf: {
      name: 'scrypt',
      N: kdf.N,
      r: kdf.r,
      p: kdf.p,
      salt: kdf.salt as Hex,
    },
    cipher: CIPHER,
    spending: spending as unknown as EncryptedBlob,
    viewing: viewing as unknown as EncryptedBlob,
  };
}

export function readKeystoreFile(path: string): KeystoreFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`Unable to read keystore at ${path}`);
  }
  return parseKeystoreFile(parsed);
}

export function summarizeKeystore(file: KeystoreFile): KeystoreSummary {
  return {
    version: 1,
    ...(file.name ? { name: file.name } : {}),
    createdAt: file.createdAt,
    spendingPublicKey: file.spendingPublicKey,
    viewingPublicKey: file.viewingPublicKey,
    encodedMetaAddress: file.encodedMetaAddress,
    cipher: CIPHER,
    kdf: { name: 'scrypt', N: file.kdf.N, r: file.kdf.r, p: file.kdf.p },
  };
}

export function publicIdentityFromKeystore(file: KeystoreFile): RecipientPublicIdentity {
  return {
    ...(file.name ? { name: file.name } : {}),
    spendingPublicKey: file.spendingPublicKey,
    viewingPublicKey: file.viewingPublicKey,
    encodedMetaAddress: file.encodedMetaAddress,
  };
}

/**
 * Discovery loader. It decrypts only the viewing key and reads the spending
 * *public* key. The spending ciphertext is never decrypted on this path.
 */
export function loadScannerIdentity(path: string, password: string): ScannerIdentity {
  const file = readKeystoreFile(path);
  const encryptionKey = deriveEncryptionKey(password, file.kdf);
  const viewingPrivateKey = decryptPrivateKey(
    file.viewing,
    encryptionKey,
    AAD_VIEWING,
    'viewing private key',
  );

  if (
    publicKeyFromPrivateKey(viewingPrivateKey) !== file.viewingPublicKey
  ) {
    throw new Error('Keystore viewing public key does not match the decrypted key');
  }

  return {
    viewingPrivateKey,
    spendingPublicKey: file.spendingPublicKey as Hex,
  };
}

export function loadRecipientIdentity(path: string, password: string): RecipientIdentity {
  const file = readKeystoreFile(path);
  const encryptionKey = deriveEncryptionKey(password, file.kdf);
  const spendingPrivateKey = decryptPrivateKey(
    file.spending,
    encryptionKey,
    AAD_SPENDING,
    'spending private key',
  );
  const viewingPrivateKey = decryptPrivateKey(
    file.viewing,
    encryptionKey,
    AAD_VIEWING,
    'viewing private key',
  );

  if (publicKeyFromPrivateKey(spendingPrivateKey) !== file.spendingPublicKey) {
    throw new Error('Keystore spending public key does not match the decrypted key');
  }
  if (publicKeyFromPrivateKey(viewingPrivateKey) !== file.viewingPublicKey) {
    throw new Error('Keystore viewing public key does not match the decrypted key');
  }

  return {
    ...(file.name ? { name: file.name } : {}),
    spendingPrivateKey,
    viewingPrivateKey,
    spendingPublicKey: file.spendingPublicKey as Hex,
    viewingPublicKey: file.viewingPublicKey as Hex,
    encodedMetaAddress: file.encodedMetaAddress,
  };
}
