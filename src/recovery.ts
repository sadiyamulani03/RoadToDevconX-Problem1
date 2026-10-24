import {
  assertAddress,
  assertCompressedPublicKey,
  assertPrivateKey,
  publicKeyFromPrivateKey,
  verifyPrivateKeyForAddress,
} from './crypto/secp.js';
import { computeStealthPrivateKey } from './crypto/stealth.js';
import type {
  Address,
  CompressedPublicKey,
  PrivateKey,
  RecipientIdentity,
} from './types.js';

export interface RecoveryParams {
  viewingPrivateKey: PrivateKey;
  spendingPrivateKey: PrivateKey;
  ephemeralPublicKey: CompressedPublicKey;
  expectedStealthAddress: Address;
  spendingPublicKey?: CompressedPublicKey;
}

export interface RecoveredPayment {
  stealthAddress: Address;
  stealthPrivateKey: PrivateKey;
  verified: true;
}

/**
 * Recovery path. This is the only module that accepts the spending private key.
 * It returns the one-time key in memory; callers must not log or serialize it.
 */
export function recoverStealthPrivateKey(params: RecoveryParams): RecoveredPayment {
  const spendingPrivateKey = assertPrivateKey(
    params.spendingPrivateKey,
    'spending private key',
  );
  const viewingPrivateKey = assertPrivateKey(
    params.viewingPrivateKey,
    'viewing private key',
  );
  assertCompressedPublicKey(params.ephemeralPublicKey, 'ephemeral public key');
  const expectedStealthAddress = assertAddress(
    params.expectedStealthAddress,
    'expected stealth address',
  );

  if (params.spendingPublicKey) {
    assertCompressedPublicKey(params.spendingPublicKey, 'spending public key');
    if (
      publicKeyFromPrivateKey(spendingPrivateKey) !== params.spendingPublicKey
    ) {
      throw new Error('Spending public key does not match the spending private key');
    }
  }

  const recovered = computeStealthPrivateKey({
    viewingPrivateKey,
    spendingPrivateKey,
    ephemeralPublicKey: params.ephemeralPublicKey,
  });

  if (recovered.stealthAddress !== expectedStealthAddress) {
    throw new Error(
      'Recovered stealth key does not correspond to the announced stealth address',
    );
  }
  if (!verifyPrivateKeyForAddress(recovered.stealthPrivateKey, expectedStealthAddress)) {
    throw new Error('Recovered stealth private key failed final address verification');
  }

  return {
    stealthAddress: recovered.stealthAddress,
    stealthPrivateKey: recovered.stealthPrivateKey,
    verified: true,
  };
}

export function recoverPayment(
  identity: RecipientIdentity,
  payment: { stealthAddress: Address; announcement: { ephemeralPublicKey: CompressedPublicKey } },
): RecoveredPayment {
  return recoverStealthPrivateKey({
    viewingPrivateKey: identity.viewingPrivateKey,
    spendingPrivateKey: identity.spendingPrivateKey,
    spendingPublicKey: identity.spendingPublicKey,
    ephemeralPublicKey: payment.announcement.ephemeralPublicKey,
    expectedStealthAddress: payment.stealthAddress,
  });
}
