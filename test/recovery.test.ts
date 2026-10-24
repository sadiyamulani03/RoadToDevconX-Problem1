import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { getAddress } from 'viem';
import { CURVE_ORDER } from '../src/crypto/secp.js';
import {
  computeStealthPrivateKey,
  verifyStealthPrivateKey,
} from '../src/crypto/stealth.js';
import { recoverStealthPrivateKey } from '../src/recovery.js';
import type { Hex, PrivateKey } from '../src/crypto/types.js';

interface ReferenceVector {
  inputs: {
    spendingPrivateKey: PrivateKey;
    viewingPrivateKey: PrivateKey;
    ephemeralPrivateKey: PrivateKey;
  };
  expected: {
    spendingPublicKey: Hex;
    ephemeralPublicKey: Hex;
    stealthAddress: Hex;
    stealthPrivateKey: PrivateKey;
    sumExceedsN: boolean;
  };
}

const vectors = JSON.parse(
  readFileSync(new URL('./reference-vectors.json', import.meta.url), 'utf8'),
) as { vectors: ReferenceVector[] };
const first = vectors.vectors[0]!;
const second = vectors.vectors[1]!;

describe('one-time spending-key recovery', () => {
  test('recovers and verifies the exact stealth private key', () => {
    const recovered = recoverStealthPrivateKey({
      viewingPrivateKey: first.inputs.viewingPrivateKey,
      spendingPrivateKey: first.inputs.spendingPrivateKey,
      spendingPublicKey: first.expected.spendingPublicKey,
      ephemeralPublicKey: first.expected.ephemeralPublicKey,
      expectedStealthAddress: first.expected.stealthAddress,
    });

    expect(recovered.verified).toBe(true);
    expect(recovered.stealthPrivateKey).toBe(first.expected.stealthPrivateKey);
    expect(recovered.stealthAddress).toBe(getAddress(first.expected.stealthAddress));
    expect(
      verifyStealthPrivateKey(
        recovered.stealthPrivateKey,
        first.expected.stealthAddress,
      ),
    ).toBe(true);
  });

  test('reduces the recovered key modulo n for a boundary vector whose sum exceeds n', () => {
    expect(second.expected.sumExceedsN).toBe(true);

    const recovered = recoverStealthPrivateKey({
      viewingPrivateKey: second.inputs.viewingPrivateKey,
      spendingPrivateKey: second.inputs.spendingPrivateKey,
      spendingPublicKey: second.expected.spendingPublicKey,
      ephemeralPublicKey: second.expected.ephemeralPublicKey,
      expectedStealthAddress: second.expected.stealthAddress,
    });

    expect(BigInt(recovered.stealthPrivateKey)).toBeLessThan(CURVE_ORDER);
    expect(BigInt(recovered.stealthPrivateKey)).toBeGreaterThan(0n);
    expect(recovered.stealthPrivateKey).toBe(second.expected.stealthPrivateKey);
    expect(recovered.stealthAddress).toBe(getAddress(second.expected.stealthAddress));
  });

  test('rejects a key that does not derive the announced address', () => {
    expect(() =>
      recoverStealthPrivateKey({
        viewingPrivateKey: first.inputs.viewingPrivateKey,
        spendingPrivateKey: first.inputs.spendingPrivateKey,
        ephemeralPublicKey: first.expected.ephemeralPublicKey,
        expectedStealthAddress: second.expected.stealthAddress,
      }),
    ).toThrow('does not correspond');
  });

  test('rejects mismatched public keys, invalid scalars, and malformed points', () => {
    expect(() =>
      recoverStealthPrivateKey({
        viewingPrivateKey: first.inputs.viewingPrivateKey,
        spendingPrivateKey: first.inputs.spendingPrivateKey,
        spendingPublicKey: second.expected.spendingPublicKey,
        ephemeralPublicKey: first.expected.ephemeralPublicKey,
        expectedStealthAddress: first.expected.stealthAddress,
      }),
    ).toThrow('does not match');

    expect(() =>
      recoverStealthPrivateKey({
        viewingPrivateKey: first.inputs.viewingPrivateKey,
        spendingPrivateKey: `0x${'0'.repeat(64)}` as PrivateKey,
        ephemeralPublicKey: first.expected.ephemeralPublicKey,
        expectedStealthAddress: first.expected.stealthAddress,
      }),
    ).toThrow('Invalid spending private key');

    expect(() =>
      recoverStealthPrivateKey({
        viewingPrivateKey: first.inputs.viewingPrivateKey,
        spendingPrivateKey: first.inputs.spendingPrivateKey,
        ephemeralPublicKey: '0x02',
        expectedStealthAddress: first.expected.stealthAddress,
      }),
    ).toThrow('Invalid ephemeral public key');

    expect(() =>
      computeStealthPrivateKey({
        viewingPrivateKey: `0x${'0'.repeat(64)}` as PrivateKey,
        spendingPrivateKey: first.inputs.spendingPrivateKey,
        ephemeralPublicKey: first.expected.ephemeralPublicKey,
      }),
    ).toThrow('Invalid viewing private key');
  });

});
