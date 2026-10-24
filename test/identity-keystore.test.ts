import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createRecipientIdentity, toPublicIdentity } from '../src/identity.js';
import {
  createKeystoreFile,
  loadRecipientIdentity,
  loadScannerIdentity,
  parseKeystoreFile,
  publicIdentityFromKeystore,
  readKeystoreFile,
  summarizeKeystore,
  writeKeystoreFile,
} from '../src/keystore.js';
import { loadIdentityForScanning } from '../src/scanner-identity.js';
import { publicKeyFromPrivateKey } from '../src/crypto/secp.js';
import { encodeStealthMetaAddress } from '../src/crypto/stealth.js';

const directories: string[] = [];
const password = 'correct horse battery staple';

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'erc5564-keystore-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('identity generation', () => {
  test('generates independent spending and viewing keys and a reusable meta-address', () => {
    const identity = createRecipientIdentity('Mira');
    expect(identity.spendingPrivateKey).not.toBe(identity.viewingPrivateKey);
    expect(identity.spendingPublicKey).toBe(
      publicKeyFromPrivateKey(identity.spendingPrivateKey),
    );
    expect(identity.viewingPublicKey).toBe(
      publicKeyFromPrivateKey(identity.viewingPrivateKey),
    );
    expect(identity.encodedMetaAddress).toBe(
      encodeStealthMetaAddress(identity.spendingPublicKey, identity.viewingPublicKey),
    );
    expect(identity.encodedMetaAddress.startsWith('st:eth:0x')).toBe(true);
  });

  test('public export contains only public identity material', () => {
    const identity = createRecipientIdentity('Mira');
    const publicIdentity = toPublicIdentity(identity);
    expect(publicIdentity).toEqual({
      name: 'Mira',
      spendingPublicKey: identity.spendingPublicKey,
      viewingPublicKey: identity.viewingPublicKey,
      encodedMetaAddress: identity.encodedMetaAddress,
    });
    const serialized = JSON.stringify(publicIdentity);
    expect(serialized).not.toContain(identity.spendingPrivateKey);
    expect(serialized).not.toContain(identity.viewingPrivateKey);
    expect(serialized).not.toContain('PrivateKey');
  });
});

describe('encrypted keystore', () => {
  test('stores encrypted key blobs and loader boundaries are enforced', () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'mira.json');
    const identity = createRecipientIdentity('Mira');
    const keystore = createKeystoreFile(identity, password);
    writeKeystoreFile(path, keystore);

    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain(identity.spendingPrivateKey);
    expect(raw).not.toContain(identity.viewingPrivateKey);
    expect(raw).not.toContain(identity.spendingPrivateKey.slice(2));
    expect(raw).not.toContain(identity.viewingPrivateKey.slice(2));
    expect(statSync(path).mode & 0o777).toBe(0o600);

    const parsed = readKeystoreFile(path);
    expect(parsed.spending.ciphertext).not.toBe(parsed.viewing.ciphertext);
    expect(summarizeKeystore(parsed).encodedMetaAddress).toBe(
      identity.encodedMetaAddress,
    );

    const scanner = loadScannerIdentity(path, password);
    expect(scanner).toEqual({
      viewingPrivateKey: identity.viewingPrivateKey,
      spendingPublicKey: identity.spendingPublicKey,
    });
    expect('spendingPrivateKey' in scanner).toBe(false);
    expect(scanner).not.toHaveProperty('spendingPrivateKey');

    const narrow = loadIdentityForScanning(path, password);
    expect(Object.keys(narrow).sort()).toEqual([
      'spendingPublicKey',
      'viewingPrivateKey',
    ]);

    const recipient = loadRecipientIdentity(path, password);
    expect(recipient.spendingPrivateKey).toBe(identity.spendingPrivateKey);
    expect(recipient.viewingPrivateKey).toBe(identity.viewingPrivateKey);
    expect(recipient.encodedMetaAddress).toBe(identity.encodedMetaAddress);

    const publicIdentity = publicIdentityFromKeystore(parsed);
    expect(publicIdentity).not.toHaveProperty('spendingPrivateKey');
    expect(publicIdentity).not.toHaveProperty('viewingPrivateKey');
  });

  test('scanner path never decrypts the spending key', () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'mira.json');
    const identity = createRecipientIdentity('Mira');
    writeKeystoreFile(path, createKeystoreFile(identity, password));

    const parsed = readKeystoreFile(path);
    parsed.spending.ciphertext = `0x${'00'.repeat(32)}`;
    parsed.spending.authTag = `0x${'00'.repeat(16)}`;
    writeFileSync(path, JSON.stringify(parsed), { mode: 0o600 });

    expect(() => loadScannerIdentity(path, password)).not.toThrow();
    expect(() => loadRecipientIdentity(path, password)).toThrow(
      'Invalid password or corrupted keystore',
    );
  });

  test('scanner path still authenticates the viewing key', () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'mira.json');
    const identity = createRecipientIdentity('Mira');
    writeKeystoreFile(path, createKeystoreFile(identity, password));

    const parsed = readKeystoreFile(path);
    parsed.viewing.ciphertext = `0x${'00'.repeat(32)}`;
    writeFileSync(path, JSON.stringify(parsed), { mode: 0o600 });

    expect(() => loadScannerIdentity(path, password)).toThrow(
      'Invalid password or corrupted keystore',
    );
  });

  test('rejects wrong passwords, short passwords, and unsafe overwrites', () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'mira.json');
    const identity = createRecipientIdentity('Mira');
    expect(() => createKeystoreFile(identity, 'short')).toThrow();
    writeKeystoreFile(path, createKeystoreFile(identity, password));
    expect(() => loadScannerIdentity(path, 'wrong password')).toThrow();
    expect(() => writeKeystoreFile(path, createKeystoreFile(identity, password))).toThrow(
      'already exists',
    );
    expect(() =>
      writeKeystoreFile(path, createKeystoreFile(identity, password), { force: true }),
    ).not.toThrow();
  });

  test('rejects malformed keystore documents and tampered public keys', () => {
    expect(() => parseKeystoreFile({})).toThrow();
    const identity = createRecipientIdentity('Mira');
    const keystore = createKeystoreFile(identity, password);
    const tampered = {
      ...keystore,
      encodedMetaAddress: encodeStealthMetaAddress(
        identity.viewingPublicKey,
        identity.spendingPublicKey,
      ),
    };
    expect(() => parseKeystoreFile(tampered)).toThrow(
      'meta-address does not match public keys',
    );
    const badKdf = { ...keystore, kdf: { ...keystore.kdf, N: 1 } };
    expect(() => parseKeystoreFile(badKdf)).toThrow('unsafe KDF parameters');
  });
});
