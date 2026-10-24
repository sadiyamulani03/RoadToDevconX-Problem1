import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, getAddress, hexToBytes } from 'viem';
import {
  addScalarsModN,
  assertAddress,
  assertCompressedPublicKey,
  assertPrivateKey,
  bigIntToPrivateKey,
  isValidCompressedPublicKey,
  normalizeCompressedPublicKey,
  privateKeyToBigInt,
  publicKeyFromPrivateKey,
  publicKeyToAddress,
  randomSecretKey,
  scalarFromHash,
} from './secp.js';
import type {
  Address,
  CompressedPublicKey,
  Hex,
  PrivateKey,
  StealthAddressDerivation,
  StealthMetaAddress,
  StealthPrivateKeyResult,
  ViewTag,
} from './types.js';

export const SCHEME_ID = 1n;
export const META_ADDRESS_PREFIX = 'st:eth:';

const G = secp256k1.ProjectivePoint.BASE;

export function encodeStealthMetaAddress(
  spendingPublicKey: CompressedPublicKey,
  viewingPublicKey: CompressedPublicKey,
): string {
  const spending = normalizeCompressedPublicKey(spendingPublicKey);
  const viewing = normalizeCompressedPublicKey(viewingPublicKey);
  return `${META_ADDRESS_PREFIX}${spending}${viewing.slice(2)}`;
}

export function parseStealthMetaAddress(input: string): StealthMetaAddress {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error('Stealth meta-address is required');
  }

  let raw = input.trim();
  if (raw.startsWith('st:')) {
    if (!raw.startsWith(META_ADDRESS_PREFIX)) {
      throw new Error('Unsupported stealth meta-address chain prefix; expected st:eth:');
    }
    raw = raw.slice(META_ADDRESS_PREFIX.length);
  }

  if (!/^0x[0-9a-fA-F]+$/.test(raw)) {
    throw new Error('Stealth meta-address must contain only hexadecimal characters');
  }

  const body = raw.slice(2);
  if (body.length !== 66 && body.length !== 132) {
    throw new Error(
      'Invalid stealth meta-address length: expected one or two 33-byte compressed public keys',
    );
  }

  const spendingHex = `0x${body.slice(0, 66)}` as CompressedPublicKey;
  const viewingHex =
    body.length === 132
      ? (`0x${body.slice(66, 132)}` as CompressedPublicKey)
      : spendingHex;

  assertCompressedPublicKey(spendingHex, 'spending public key');
  assertCompressedPublicKey(viewingHex, 'viewing public key');

  const spendingPublicKey = normalizeCompressedPublicKey(spendingHex);
  const viewingPublicKey = normalizeCompressedPublicKey(viewingHex);

  return {
    spendingPublicKey,
    viewingPublicKey,
    encoded: encodeStealthMetaAddress(spendingPublicKey, viewingPublicKey),
  };
}

export function computeSharedSecret(
  privateKey: PrivateKey,
  publicKey: CompressedPublicKey,
): Uint8Array {
  assertPrivateKey(privateKey, 'ECDH private key');
  assertCompressedPublicKey(publicKey, 'ECDH public key');
  try {
    return secp256k1.getSharedSecret(hexToBytes(privateKey), hexToBytes(publicKey), true);
  } catch {
    throw new Error('Failed to compute secp256k1 ECDH shared secret');
  }
}

export function hashSharedSecret(sharedSecret: Uint8Array): Hex {
  if (!(sharedSecret instanceof Uint8Array) || sharedSecret.length !== 33) {
    throw new Error('Invalid shared secret: expected a 33-byte compressed point');
  }
  return bytesToHex(keccak_256(sharedSecret));
}

export function viewTagFromHash(hashedSharedSecret: Hex): ViewTag {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hashedSharedSecret)) {
    throw new Error('Invalid shared-secret hash: expected 32 bytes');
  }
  return `0x${hashedSharedSecret.slice(2, 4)}`;
}

export function deriveStealthPublicKey(
  spendingPublicKey: CompressedPublicKey,
  hashedSharedSecret: Hex,
): CompressedPublicKey {
  assertCompressedPublicKey(spendingPublicKey, 'spending public key');
  const hashedScalar = scalarFromHash(hashedSharedSecret);
  const spendingPoint = secp256k1.ProjectivePoint.fromHex(spendingPublicKey.slice(2));
  const stealthPoint = spendingPoint.add(G.multiply(hashedScalar));
  return bytesToHex(stealthPoint.toRawBytes(true));
}

export function deriveCandidateAddress(
  spendingPublicKey: CompressedPublicKey,
  hashedSharedSecret: Hex,
): Address {
  return publicKeyToAddress(deriveStealthPublicKey(spendingPublicKey, hashedSharedSecret));
}

export function deriveStealthAddress(
  metaAddress: string | StealthMetaAddress,
  ephemeralPrivateKey: PrivateKey,
): StealthAddressDerivation {
  const meta =
    typeof metaAddress === 'string' ? parseStealthMetaAddress(metaAddress) : metaAddress;

  assertPrivateKey(ephemeralPrivateKey, 'ephemeral private key');
  const ephemeralPublicKey = publicKeyFromPrivateKey(ephemeralPrivateKey);
  const sharedSecret = computeSharedSecret(ephemeralPrivateKey, meta.viewingPublicKey);
  const hashedSharedSecret = hashSharedSecret(sharedSecret);
  const viewTag = viewTagFromHash(hashedSharedSecret);
  const stealthAddress = deriveCandidateAddress(
    meta.spendingPublicKey,
    hashedSharedSecret,
  );

  return { stealthAddress, ephemeralPublicKey, viewTag };
}

export function generateStealthAddress(
  metaAddress: string | StealthMetaAddress,
): StealthAddressDerivation {
  const ephemeralPrivateKey = randomSecretKey();
  return deriveStealthAddress(metaAddress, ephemeralPrivateKey);
}

export function computeStealthPrivateKey(params: {
  viewingPrivateKey: PrivateKey;
  spendingPrivateKey: PrivateKey;
  ephemeralPublicKey: CompressedPublicKey;
}): StealthPrivateKeyResult {
  const viewingPrivateKey = assertPrivateKey(params.viewingPrivateKey, 'viewing private key');
  const spendingPrivateKey = assertPrivateKey(params.spendingPrivateKey, 'spending private key');
  assertCompressedPublicKey(params.ephemeralPublicKey, 'ephemeral public key');

  const sharedSecret = computeSharedSecret(viewingPrivateKey, params.ephemeralPublicKey);
  const hashedSharedSecret = hashSharedSecret(sharedSecret);
  const hashedScalar = scalarFromHash(hashedSharedSecret);
  const stealthScalar = addScalarsModN(
    privateKeyToBigInt(spendingPrivateKey),
    hashedScalar,
  );
  const stealthPrivateKey = bigIntToPrivateKey(stealthScalar);
  const stealthAddress = publicKeyToAddress(
    publicKeyFromPrivateKey(stealthPrivateKey),
  );

  return { stealthPrivateKey, stealthAddress };
}

export function verifyStealthPrivateKey(
  stealthPrivateKey: PrivateKey,
  expectedStealthAddress: Address,
): boolean {
  const expected = assertAddress(expectedStealthAddress, 'stealth address');
  try {
    return publicKeyToAddress(publicKeyFromPrivateKey(stealthPrivateKey)) === expected;
  } catch {
    return false;
  }
}

export function isCompressedPublicKey(value: unknown): value is CompressedPublicKey {
  return isValidCompressedPublicKey(value);
}

export function addressFromStealthPublicKey(publicKey: CompressedPublicKey): Address {
  return getAddress(publicKeyToAddress(publicKey));
}
