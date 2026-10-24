import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, getAddress, hexToBytes, isAddress } from 'viem';
import type { Address, CompressedPublicKey, Hex, PrivateKey } from './types.js';

export const CURVE_ORDER = secp256k1.CURVE.n;
const G = secp256k1.ProjectivePoint.BASE;

export function randomSecretKey(): PrivateKey {
  const key = secp256k1.utils.randomPrivateKey();
  if (!secp256k1.utils.isValidPrivateKey(key)) {
    throw new Error('CSPRNG produced an invalid secp256k1 private key');
  }
  return bytesToHex(key);
}

export function isValidPrivateKey(value: unknown): value is PrivateKey {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) return false;
  try {
    return secp256k1.utils.isValidPrivateKey(hexToBytes(value as Hex));
  } catch {
    return false;
  }
}

export function assertPrivateKey(value: unknown, label = 'private key'): PrivateKey {
  if (!isValidPrivateKey(value)) {
    throw new Error(`Invalid ${label}: expected a 32-byte secp256k1 scalar in [1, n-1]`);
  }
  return value;
}

export function publicKeyFromPrivateKey(
  privateKey: PrivateKey,
  compressed = true,
): CompressedPublicKey {
  assertPrivateKey(privateKey);
  return bytesToHex(secp256k1.getPublicKey(hexToBytes(privateKey), compressed));
}

export function isValidCompressedPublicKey(value: unknown): value is CompressedPublicKey {
  if (typeof value !== 'string' || !/^0x(02|03)[0-9a-fA-F]{64}$/.test(value)) return false;
  try {
    secp256k1.ProjectivePoint.fromHex(value.slice(2));
    return true;
  } catch {
    return false;
  }
}

export function assertCompressedPublicKey(
  value: unknown,
  label = 'public key',
): CompressedPublicKey {
  if (!isValidCompressedPublicKey(value)) {
    throw new Error(
      `Invalid ${label}: expected a 33-byte compressed secp256k1 public key`,
    );
  }
  return value;
}

export function normalizeCompressedPublicKey(publicKey: CompressedPublicKey): CompressedPublicKey {
  assertCompressedPublicKey(publicKey);
  return bytesToHex(secp256k1.ProjectivePoint.fromHex(publicKey.slice(2)).toRawBytes(true));
}

export function isValidAddress(value: unknown): value is Address {
  return typeof value === 'string' && isAddress(value);
}

export function assertAddress(value: unknown, label = 'address'): Address {
  if (!isValidAddress(value)) {
    throw new Error(`Invalid ${label}: expected a 20-byte Ethereum address`);
  }
  return getAddress(value);
}

export function publicKeyToAddress(publicKey: CompressedPublicKey | Hex): Address {
  const point = secp256k1.ProjectivePoint.fromHex(publicKey.slice(2));
  const uncompressed = point.toRawBytes(false);
  const hash = keccak_256(uncompressed.slice(1));
  return getAddress(bytesToHex(hash.slice(-20)));
}

export function scalarFromHash(hash: Hex): bigint {
  if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new Error('Invalid shared-secret hash: expected 32 bytes');
  }
  const scalar = BigInt(hash) % CURVE_ORDER;
  if (scalar === 0n) {
    throw new Error('Invalid shared-secret hash: derived scalar is zero');
  }
  return scalar;
}

export function addScalarsModN(spendingScalar: bigint, hashedScalar: bigint): bigint {
  if (spendingScalar <= 0n || spendingScalar >= CURVE_ORDER) {
    throw new Error('Invalid spending scalar: expected a value in [1, n-1]');
  }
  if (hashedScalar < 0n || hashedScalar >= CURVE_ORDER) {
    throw new Error('Invalid hashed shared-secret scalar: expected a value in [0, n-1]');
  }
  const sum = (spendingScalar + hashedScalar) % CURVE_ORDER;
  if (sum === 0n) {
    throw new Error('Invalid stealth private key: scalar sum is zero');
  }
  return sum;
}

export function privateKeyToBigInt(privateKey: PrivateKey): bigint {
  assertPrivateKey(privateKey);
  return BigInt(privateKey);
}

export function bigIntToPrivateKey(value: bigint): PrivateKey {
  if (value <= 0n || value >= CURVE_ORDER) {
    throw new Error('Invalid private-key scalar: expected a value in [1, n-1]');
  }
  return `0x${value.toString(16).padStart(64, '0')}`;
}

export function multiplyBase(scalar: bigint): CompressedPublicKey {
  if (scalar <= 0n || scalar >= CURVE_ORDER) {
    throw new Error('Invalid scalar for base multiplication');
  }
  return bytesToHex(G.multiply(scalar).toRawBytes(true));
}

export function verifyPrivateKeyForAddress(
  privateKey: PrivateKey,
  expectedAddress: Address,
): boolean {
  assertPrivateKey(privateKey);
  assertAddress(expectedAddress);
  return publicKeyToAddress(publicKeyFromPrivateKey(privateKey)) === getAddress(expectedAddress);
}
