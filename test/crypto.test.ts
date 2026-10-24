import { readFileSync } from 'node:fs';
import { getAddress } from 'viem';
import { describe, expect, test } from 'vitest';
import {
  addScalarsModN,
  assertPrivateKey,
  bigIntToPrivateKey,
  CURVE_ORDER,
  isValidCompressedPublicKey,
  publicKeyFromPrivateKey,
  publicKeyToAddress,
  scalarFromHash,
  verifyPrivateKeyForAddress,
} from '../src/crypto/secp.js';
import {
  buildEthMetadata,
  extractViewTag,
  parseEthMetadata,
} from '../src/crypto/metadata.js';
import {
  computeSharedSecret,
  computeStealthPrivateKey,
  deriveCandidateAddress,
  deriveStealthAddress,
  encodeStealthMetaAddress,
  generateStealthAddress,
  hashSharedSecret,
  parseStealthMetaAddress,
  viewTagFromHash,
} from '../src/crypto/stealth.js';
import type { Hex, PrivateKey } from '../src/crypto/types.js';

interface ReferenceVector {
  inputs: {
    spendingPrivateKey: PrivateKey;
    viewingPrivateKey: PrivateKey;
    ephemeralPrivateKey: PrivateKey;
  };
  expected: {
    spendingPublicKey: Hex;
    viewingPublicKey: Hex;
    metaAddress: string;
    ephemeralPublicKey: Hex;
    sharedSecretCompressed: Hex;
    hashedSharedSecret: Hex;
    hashedScalarModN: Hex;
    stealthPublicKey: Hex;
    stealthAddress: Hex;
    stealthPrivateKey: PrivateKey;
    viewTag: Hex;
    sumExceedsN: boolean;
  };
}

const vectors = JSON.parse(
  readFileSync(new URL('./reference-vectors.json', import.meta.url), 'utf8'),
) as { vectors: ReferenceVector[] };

const [first, second] = vectors.vectors;
if (!first || !second) throw new Error('Reference vectors missing');

describe('ERC-5564 Scheme 1 deterministic reference vectors', () => {
  test('derives public keys, meta-address, shared secret, view tag, stealth address, and key', () => {
    const { inputs, expected } = first;

    expect(publicKeyFromPrivateKey(inputs.spendingPrivateKey)).toBe(
      expected.spendingPublicKey,
    );
    expect(publicKeyFromPrivateKey(inputs.viewingPrivateKey)).toBe(
      expected.viewingPublicKey,
    );
    expect(
      encodeStealthMetaAddress(expected.spendingPublicKey, expected.viewingPublicKey),
    ).toBe(expected.metaAddress);

    const meta = parseStealthMetaAddress(expected.metaAddress);
    expect(meta.spendingPublicKey).toBe(expected.spendingPublicKey);
    expect(meta.viewingPublicKey).toBe(expected.viewingPublicKey);

    const shared = computeSharedSecret(
      inputs.ephemeralPrivateKey,
      expected.viewingPublicKey,
    );
    expect(`0x${Buffer.from(shared).toString('hex')}`).toBe(
      expected.sharedSecretCompressed,
    );

    const hash = hashSharedSecret(shared);
    expect(hash).toBe(expected.hashedSharedSecret);
    expect(viewTagFromHash(hash)).toBe(expected.viewTag);

    const derived = deriveStealthAddress(expected.metaAddress, inputs.ephemeralPrivateKey);
    expect(derived.ephemeralPublicKey).toBe(expected.ephemeralPublicKey);
    expect(derived.viewTag).toBe(expected.viewTag);
    expect(derived.stealthAddress).toBe(getAddress(expected.stealthAddress));
    expect(deriveCandidateAddress(expected.spendingPublicKey, hash)).toBe(
      getAddress(expected.stealthAddress),
    );

    const recovered = computeStealthPrivateKey({
      viewingPrivateKey: inputs.viewingPrivateKey,
      spendingPrivateKey: inputs.spendingPrivateKey,
      ephemeralPublicKey: expected.ephemeralPublicKey,
    });
    expect(recovered.stealthPrivateKey).toBe(expected.stealthPrivateKey);
    expect(recovered.stealthAddress).toBe(getAddress(expected.stealthAddress));
    expect(
      verifyPrivateKeyForAddress(recovered.stealthPrivateKey, expected.stealthAddress),
    ).toBe(true);
    expect(expected.sumExceedsN).toBe(false);
  });

  test('recovers a key reduced modulo n when k_spend + h exceeds the group order', () => {
    const { inputs, expected } = second;
    const meta = parseStealthMetaAddress(expected.metaAddress);
    const derived = deriveStealthAddress(meta, inputs.ephemeralPrivateKey);

    expect(derived.stealthAddress).toBe(getAddress(expected.stealthAddress));
    expect(expected.sumExceedsN).toBe(true);
    expect(
      BigInt(inputs.spendingPrivateKey) + BigInt(expected.hashedScalarModN),
    ).toBeGreaterThan(CURVE_ORDER);

    const recovered = computeStealthPrivateKey({
      viewingPrivateKey: inputs.viewingPrivateKey,
      spendingPrivateKey: inputs.spendingPrivateKey,
      ephemeralPublicKey: expected.ephemeralPublicKey,
    });

    expect(BigInt(recovered.stealthPrivateKey)).toBeLessThan(CURVE_ORDER);
    expect(BigInt(recovered.stealthPrivateKey)).toBeGreaterThan(0n);
    expect(recovered.stealthPrivateKey).toBe(expected.stealthPrivateKey);
    expect(recovered.stealthAddress).toBe(getAddress(expected.stealthAddress));
    expect(
      publicKeyFromPrivateKey(recovered.stealthPrivateKey),
    ).toBe(expected.stealthPublicKey);
  });

  test('known private key 1 produces the canonical Ethereum address', () => {
    const privateKey = `0x${'0'.repeat(63)}1` as PrivateKey;
    expect(publicKeyToAddress(publicKeyFromPrivateKey(privateKey))).toBe(
      '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf',
    );
  });
});

describe('fresh ephemeral keys', () => {
  test('every call to generateStealthAddress uses a different random ephemeral key', () => {
    const meta = first.expected.metaAddress;
    const ephemeral = new Set<string>();
    const addresses = new Set<string>();

    for (let index = 0; index < 64; index += 1) {
      const payment = generateStealthAddress(meta);
      ephemeral.add(payment.ephemeralPublicKey.toLowerCase());
      addresses.add(payment.stealthAddress.toLowerCase());
      expect(payment.ephemeralPublicKey).not.toBe(first.expected.ephemeralPublicKey);
    }

    expect(ephemeral.size).toBe(64);
    expect(addresses.size).toBe(64);
  });
});

describe('scalar and point validation', () => {
  test('rejects zero, curve-order, and malformed private keys', () => {
    expect(() => assertPrivateKey(`0x${'0'.repeat(64)}`)).toThrow();
    expect(() => assertPrivateKey(bigIntToPrivateKey(CURVE_ORDER))).toThrow();
    expect(() => assertPrivateKey('0x1234')).toThrow();
    expect(() => assertPrivateKey(`0x${'f'.repeat(64)}`)).toThrow();
  });

  test('scalar addition is modulo n and rejects zero results', () => {
    expect(addScalarsModN(1n, 2n)).toBe(3n);
    expect(() => addScalarsModN(CURVE_ORDER - 1n, 1n)).toThrow();
    expect(() => addScalarsModN(0n, 1n)).toThrow();
    expect(() => addScalarsModN(1n, CURVE_ORDER)).toThrow();
    expect(addScalarsModN(CURVE_ORDER - 2n, 5n)).toBe(3n);
  });

  test('rejects a zero hashed scalar and invalid hash encoding', () => {
    expect(() => scalarFromHash(`0x${'0'.repeat(64)}`)).toThrow();
    expect(() => scalarFromHash('0x1234')).toThrow();
  });

  test('rejects malformed meta-addresses, invalid points, and wrong chain prefixes', () => {
    expect(() => parseStealthMetaAddress('')).toThrow();
    expect(() => parseStealthMetaAddress('st:btc:0x1234')).toThrow();
    expect(() => parseStealthMetaAddress('0x1234')).toThrow();
    expect(() => parseStealthMetaAddress(`0x02${'00'.repeat(32)}`)).toThrow();
    expect(() =>
      parseStealthMetaAddress(
        `st:eth:0x03${'00'.repeat(32)}` +
          '02466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27',
      ),
    ).toThrow();
    expect(isValidCompressedPublicKey('0x02')).toBe(false);
    expect(
      isValidCompressedPublicKey(first.expected.spendingPublicKey),
    ).toBe(true);
  });

  test('single-key meta-addresses reuse the key for both roles', () => {
    const single = `st:eth:${first.expected.spendingPublicKey}`;
    const parsed = parseStealthMetaAddress(single);
    expect(parsed.spendingPublicKey).toBe(first.expected.spendingPublicKey);
    expect(parsed.viewingPublicKey).toBe(first.expected.spendingPublicKey);
  });

  test('recovery rejects a mismatched viewing key and invalid ephemeral key', () => {
    const { inputs, expected } = first;
    const wrongViewingKey = bigIntToPrivateKey(0x999n);
    expect(
      computeStealthPrivateKey({
        viewingPrivateKey: wrongViewingKey,
        spendingPrivateKey: inputs.spendingPrivateKey,
        ephemeralPublicKey: expected.ephemeralPublicKey,
      }).stealthAddress,
    ).not.toBe(expected.stealthAddress);
    expect(() =>
      computeStealthPrivateKey({
        viewingPrivateKey: inputs.viewingPrivateKey,
        spendingPrivateKey: inputs.spendingPrivateKey,
        ephemeralPublicKey: '0x02',
      }),
    ).toThrow();
  });
});

describe('ERC-5564 ETH metadata', () => {
  test('builds and parses the 57-byte ETH metadata layout', () => {
    const viewTag = first.expected.viewTag;
    const amountWei = 1_234_567_890_000_000_000n;
    const metadata = buildEthMetadata(viewTag, amountWei);

    expect(metadata).toHaveLength(2 + 57 * 2);
    expect(extractViewTag(metadata)).toBe(viewTag);
    expect(parseEthMetadata(metadata)).toEqual({
      viewTag,
      tokenIdentifier: '0xeeeeeeee',
      tokenAddress: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
      amountWei,
    });
  });

  test('rejects invalid metadata', () => {
    expect(() => buildEthMetadata('0x12' as Hex, 0n)).toThrow();
    expect(() => buildEthMetadata('0x1234' as Hex, 1n)).toThrow();
    expect(() => buildEthMetadata(first.expected.viewTag, -1n)).toThrow();
    expect(() => extractViewTag('0x')).toThrow();
    expect(parseEthMetadata('0x12')).toBeNull();
    expect(
      parseEthMetadata(
        buildEthMetadata(first.expected.viewTag, 1n).replace(
          'eeeeeeee',
          'aaaaaaaa',
        ) as Hex,
      ),
    ).toBeNull();
  });
});
