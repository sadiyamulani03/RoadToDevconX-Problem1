import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

function source(path: string): string {
  return readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
}

const scanner = source('scanner.ts');
const scannerIdentity = source('scanner-identity.ts');
const payer = source('payer.ts');
const recovery = source('recovery.ts');
const cli = source('cli.ts');
const types = source('types.ts');

describe('key-separation architecture', () => {
  test('scanner module has no access to the spending private key', () => {
    expect(scanner).not.toMatch(/spendingPrivateKey/);
    expect(scanner).not.toMatch(/from ['"]\.\/(keystore|recovery|identity|scanner-identity)\.js['"]/);
    expect(scanner).toMatch(/identity:\s*ScannerIdentity/);
    expect(scanner).toMatch(/scanAnnouncements\(\s*identity:\s*ScannerIdentity/);
    expect(scanner).toMatch(/evaluateAnnouncement\(\s*announcement:\s*Announcement,\s*identity:\s*ScannerIdentity/);
  });

  test('scanner identity type contains only viewing private and spending public material', () => {
    const match = types.match(
      /export interface ScannerIdentity \{([\s\S]*?)\n\}/,
    );
    expect(match).not.toBeNull();
    const body = match?.[1] ?? '';
    expect(body).toMatch(/viewingPrivateKey/);
    expect(body).toMatch(/spendingPublicKey/);
    expect(body).not.toMatch(/spendingPrivateKey/);
    expect(body).not.toMatch(/viewingPublicKey/);
  });

  test('discovery adapter returns only the two scanner fields', () => {
    expect(scannerIdentity).toMatch(/loadScannerIdentity/);
    expect(scannerIdentity).toMatch(/spendingPublicKey:\s*identity\.spendingPublicKey/);
    expect(scannerIdentity).toMatch(/viewingPrivateKey:\s*identity\.viewingPrivateKey/);
    expect(scannerIdentity).not.toMatch(/spendingPrivateKey/);
  });

  test('CLI scan path uses the narrow discovery loader, not full recovery identity', () => {
    const scanStart = cli.indexOf('async function commandScan');
    const withdrawStart = cli.indexOf('async function commandRecover');
    expect(scanStart).toBeGreaterThan(-1);
    expect(withdrawStart).toBeGreaterThan(scanStart);
    const scanBlock = cli.slice(scanStart, withdrawStart);
    expect(scanBlock).toMatch(/loadIdentityForScanning/);
    expect(scanBlock).not.toMatch(/loadRecipientIdentity/);
    expect(scanBlock).not.toMatch(/recoverStealthPrivateKey/);
  });

  test('recovery is isolated from discovery and only recovery/withdrawal consume private keys', () => {
    expect(recovery).toMatch(/recoverStealthPrivateKey\(/);
    expect(recovery).toMatch(/spendingPrivateKey/);
    expect(recovery).not.toMatch(/from ['"]\.\/scanner/);
    expect(scanner).not.toMatch(/recoverStealthPrivateKey/);
  });
});

describe('payer cryptography constraints', () => {
  test('payment derivation generates the ephemeral key inside the call and never accepts one from callers', () => {
    const deriveStart = payer.indexOf('generateStealthAddress(meta)');
    expect(deriveStart).toBeGreaterThan(-1);
    expect(payer).not.toMatch(/ephemeralPrivateKey/);
    expect(payer).not.toMatch(/Math\.random/);
    expect(payer).toMatch(/buildEthMetadata\(viewTag, params\.amountWei\)/);
  });

  test('no source module uses Math.random for cryptographic material', () => {
    for (const file of [
      'scanner.ts',
      'payer.ts',
      'identity.ts',
      'keystore.ts',
      'recovery.ts',
      'withdrawal.ts',
      'crypto/secp.ts',
      'crypto/stealth.ts',
    ]) {
      expect(source(file)).not.toMatch(/Math\.random/);
    }
  });
});
