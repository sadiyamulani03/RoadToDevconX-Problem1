import { readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import {
  decodeAnnouncementLog,
  evaluateAnnouncement,
} from '../src/scanner.js';
import {
  ANNOUNCER_ABI,
} from '../src/abi.js';
import { buildEthMetadata } from '../src/crypto/metadata.js';
import {
  computeSharedSecret,
  deriveStealthAddress,
  encodeStealthMetaAddress,
  hashSharedSecret,
  viewTagFromHash,
} from '../src/crypto/stealth.js';
import {
  bigIntToPrivateKey,
  publicKeyFromPrivateKey,
} from '../src/crypto/secp.js';
import type { Address, Announcement, Hex, PrivateKey, ScannerIdentity } from '../src/types.js';
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  type Log,
} from 'viem';

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
    stealthAddress: Address;
    viewTag: Hex;
  };
}

const vectors = JSON.parse(
  readFileSync(new URL('./reference-vectors.json', import.meta.url), 'utf8'),
) as { vectors: ReferenceVector[] };
const vector = vectors.vectors[0]!;

const announcerAddress: Address = '0x55649E01B5Df198D18D95b5cc5051630cfD45564';
const callerAddress: Address = '0x1111111111111111111111111111111111111111';
const otherAddress: Address = '0x2222222222222222222222222222222222222222';
const thirdAddress: Address = '0x3333333333333333333333333333333333333333';
const transactionHash: Hex = `0x${'ab'.repeat(32)}`;
const blockHash: Hex = `0x${'cd'.repeat(32)}`;

const identity: ScannerIdentity = {
  viewingPrivateKey: vector.inputs.viewingPrivateKey,
  spendingPublicKey: vector.expected.spendingPublicKey,
};

function announcement(overrides: Partial<Announcement> = {}): Announcement {
  return {
    schemeId: 1n,
    stealthAddress: vector.expected.stealthAddress,
    caller: callerAddress,
    ephemeralPublicKey: vector.expected.ephemeralPublicKey,
    metadata: buildEthMetadata(vector.expected.viewTag, 1_000_000_000_000_000n),
    viewTag: vector.expected.viewTag,
    blockNumber: 1n,
    blockHash,
    transactionHash,
    logIndex: 0,
    announcerAddress,
    ...overrides,
  };
}

function makeLog(overrides: {
  schemeId?: bigint;
  stealthAddress?: Address;
  caller?: Address;
  ephemeralPubKey?: Hex;
  metadata?: Hex;
} = {}): Log {
  const topics = encodeEventTopics({
    abi: ANNOUNCER_ABI,
    eventName: 'Announcement',
    args: {
      schemeId: overrides.schemeId ?? 1n,
      stealthAddress: overrides.stealthAddress ?? vector.expected.stealthAddress,
      caller: overrides.caller ?? callerAddress,
    },
  });
  const data = encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes' }],
    [
      overrides.ephemeralPubKey ?? vector.expected.ephemeralPublicKey,
      overrides.metadata ?? buildEthMetadata(vector.expected.viewTag, 1n),
    ],
  );
  return {
    address: announcerAddress,
    topics: topics as [Hex, ...Hex[]],
    data,
    blockNumber: 1n,
    blockHash,
    transactionHash,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  };
}

describe('view-tag filtering and full address verification', () => {
  test('reports a complete match only after tag and address verification', () => {
    const result = evaluateAnnouncement(announcement(), identity);
    expect(result).toEqual({
      status: 'match',
      asset: 'ETH',
      amountWei: 1_000_000_000_000_000n,
    });
  });

  test('mismatched view tag skips candidate address derivation entirely', () => {
    const derive = vi.fn(() => {
      throw new Error('address derivation must not run');
    });
    const mismatched = announcement({
      viewTag: '0x00',
      metadata: buildEthMetadata('0x00', 1n),
    });

    const result = evaluateAnnouncement(mismatched, identity, {
      deriveCandidateAddress: derive,
    });

    expect(result).toEqual({ status: 'view-tag-mismatch' });
    expect(derive).not.toHaveBeenCalled();
  });

  test('a matching tag with the wrong stealth address is not reported', () => {
    const derive = vi.fn(() => thirdAddress);
    const falsePositive = announcement({ stealthAddress: otherAddress });

    const result = evaluateAnnouncement(falsePositive, identity, {
      deriveCandidateAddress: derive,
    });

    expect(result).toEqual({ status: 'address-mismatch' });
    expect(derive).toHaveBeenCalledTimes(1);
  });

  test('malformed announcements fail validation before derivation', () => {
    const derive = vi.fn(() => vector.expected.stealthAddress);

    expect(() =>
      evaluateAnnouncement(announcement({ schemeId: 2n }), identity, {
        deriveCandidateAddress: derive,
      }),
    ).toThrow('Unsupported announcement schemeId');
    expect(() =>
      evaluateAnnouncement(announcement({ metadata: '0x' }), identity, {
        deriveCandidateAddress: derive,
      }),
    ).toThrow();
    expect(() =>
      evaluateAnnouncement(
        announcement({
          metadata: buildEthMetadata('0x20', 1n),
          viewTag: '0x21',
        }),
        identity,
        { deriveCandidateAddress: derive },
      ),
    ).toThrow('view tag does not match');
    expect(derive).not.toHaveBeenCalled();
  });

  test('an unrelated recipient announcement is ignored without address derivation', () => {
    const bob = createOtherIdentity();
    const expectedTag = viewTagFromHash(
      hashSharedSecret(
        computeSharedSecret(identity.viewingPrivateKey, bob.ephemeralPublicKey),
      ),
    );

    const result = evaluateAnnouncement(
      {
        ...announcement(),
        stealthAddress: bob.stealthAddress,
        ephemeralPublicKey: bob.ephemeralPublicKey,
        viewTag: bob.viewTag,
        metadata: buildEthMetadata(bob.viewTag, 1n),
      },
      identity,
      {
        deriveCandidateAddress: vi.fn(() => {
          throw new Error('must not derive');
        }),
      },
    );

    expect(bob.viewTag).not.toBe(expectedTag);
    expect(result).toEqual({ status: 'view-tag-mismatch' });
  });
});

function createOtherIdentity(): {
  stealthAddress: Address;
  ephemeralPublicKey: Hex;
  viewTag: Hex;
} {
  const bobSpendingPublic = publicKeyFromPrivateKey(bigIntToPrivateKey(0x777n));
  const bobViewingPublic = publicKeyFromPrivateKey(bigIntToPrivateKey(0x888n));
  const bobMeta = encodeStealthMetaAddress(bobSpendingPublic, bobViewingPublic);

  for (let attempt = 0; attempt < 256; attempt += 1) {
    const candidateKey = bigIntToPrivateKey(0x3333400n + BigInt(attempt));
    const candidate = deriveStealthAddress(bobMeta, candidateKey);
    const miraTagForCandidate = viewTagFromHash(
      hashSharedSecret(
        computeSharedSecret(
          identity.viewingPrivateKey,
          candidate.ephemeralPublicKey,
        ),
      ),
    );
    if (miraTagForCandidate !== candidate.viewTag) {
      return {
        stealthAddress: candidate.stealthAddress,
        ephemeralPublicKey: candidate.ephemeralPublicKey,
        viewTag: candidate.viewTag,
      };
    }
  }
  throw new Error('Unable to construct unrelated announcement');
}

describe('announcement log decoding', () => {
  test('decodes a valid ERC-5564 log', () => {
    const decoded = decodeAnnouncementLog(makeLog(), announcerAddress);
    expect(decoded.schemeId).toBe(1n);
    expect(decoded.stealthAddress).toBe(getAddress(vector.expected.stealthAddress));
    expect(decoded.ephemeralPublicKey).toBe(vector.expected.ephemeralPublicKey);
    expect(decoded.caller).toBe(callerAddress);
    expect(decoded.viewTag).toBe(vector.expected.viewTag);
    expect(decoded.blockNumber).toBe(1n);
  });

  test('rejects malformed logs without throwing unexpected internal errors', () => {
    expect(() =>
      decodeAnnouncementLog({ ...makeLog(), topics: [] }, announcerAddress),
    ).toThrow('no topics');
    expect(() =>
      decodeAnnouncementLog({ ...makeLog(), data: '0x' }, announcerAddress),
    ).toThrow('Malformed');
    expect(() =>
      decodeAnnouncementLog(
        makeLog({ ephemeralPubKey: `0x02${'00'.repeat(32)}` }),
        announcerAddress,
      ),
    ).toThrow('not a valid compressed point');
    expect(() =>
      decodeAnnouncementLog(makeLog({ metadata: '0x' }), announcerAddress),
    ).toThrow('view tag');
    expect(() =>
      decodeAnnouncementLog(makeLog({ schemeId: 2n }), announcerAddress),
    ).toThrow('Unsupported announcement schemeId');
    expect(() =>
      decodeAnnouncementLog(makeLog(), otherAddress),
    ).toThrow('not emitted by the configured announcer');
  });
});
