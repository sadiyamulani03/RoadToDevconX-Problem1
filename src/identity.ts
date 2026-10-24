import { encodeStealthMetaAddress } from './crypto/stealth.js';
import {
  assertPrivateKey,
  isValidCompressedPublicKey,
  publicKeyFromPrivateKey,
  randomSecretKey,
} from './crypto/secp.js';
import type { RecipientIdentity, RecipientPublicIdentity } from './types.js';

export function createRecipientIdentity(name?: string): RecipientIdentity {
  const spendingPrivateKey = randomSecretKey();
  const viewingPrivateKey = randomSecretKey();
  const spendingPublicKey = publicKeyFromPrivateKey(spendingPrivateKey);
  const viewingPublicKey = publicKeyFromPrivateKey(viewingPrivateKey);
  const encodedMetaAddress = encodeStealthMetaAddress(
    spendingPublicKey,
    viewingPublicKey,
  );

  return {
    ...(name ? { name } : {}),
    spendingPrivateKey,
    viewingPrivateKey,
    spendingPublicKey,
    viewingPublicKey,
    encodedMetaAddress,
  };
}

export function toPublicIdentity(
  identity: RecipientPublicIdentity,
): RecipientPublicIdentity {
  if (!isValidCompressedPublicKey(identity.spendingPublicKey)) {
    throw new Error('Identity has an invalid spending public key');
  }
  if (!isValidCompressedPublicKey(identity.viewingPublicKey)) {
    throw new Error('Identity has an invalid viewing public key');
  }
  if (
    encodeStealthMetaAddress(
      identity.spendingPublicKey,
      identity.viewingPublicKey,
    ) !== identity.encodedMetaAddress
  ) {
    throw new Error('Encoded meta-address does not match the identity public keys');
  }
  return {
    ...(identity.name ? { name: identity.name } : {}),
    spendingPublicKey: identity.spendingPublicKey,
    viewingPublicKey: identity.viewingPublicKey,
    encodedMetaAddress: identity.encodedMetaAddress,
  };
}

export function assertRecipientIdentity(identity: RecipientIdentity): void {
  assertPrivateKey(identity.spendingPrivateKey, 'spending private key');
  assertPrivateKey(identity.viewingPrivateKey, 'viewing private key');
  if (
    publicKeyFromPrivateKey(identity.spendingPrivateKey) !== identity.spendingPublicKey
  ) {
    throw new Error('Spending public key does not match the spending private key');
  }
  if (publicKeyFromPrivateKey(identity.viewingPrivateKey) !== identity.viewingPublicKey) {
    throw new Error('Viewing public key does not match the viewing private key');
  }
  if (
    encodeStealthMetaAddress(
      identity.spendingPublicKey,
      identity.viewingPublicKey,
    ) !== identity.encodedMetaAddress
  ) {
    throw new Error('Encoded meta-address does not match the identity public keys');
  }
}
