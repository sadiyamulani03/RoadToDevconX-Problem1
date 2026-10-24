import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAddress, parseEther } from 'viem';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createPublicClientFor } from '../src/chain.js';
import { createRecipientIdentity } from '../src/identity.js';
import {
  createKeystoreFile,
  loadRecipientIdentity,
  writeKeystoreFile,
} from '../src/keystore.js';
import { loadIdentityForScanning } from '../src/scanner-identity.js';
import { payToStealthAddress } from '../src/payer.js';
import { decodeAnnouncementLog, scanAnnouncements } from '../src/scanner.js';
import { recoverStealthPrivateKey } from '../src/recovery.js';
import { withdrawFromStealthAddress } from '../src/withdrawal.js';
import type { PaymentReceipt } from '../src/types.js';
import {
  createFundedAccount,
  createTestEnvironment,
  type TestEnvironment,
} from './helpers/chain.js';

let environment: TestEnvironment;
let directory: string;
let miraFile: string;
let bobFile: string;
const password = 'e2e test password';
let miraPayments: PaymentReceipt[] = [];
let bobPayment: PaymentReceipt;

beforeAll(async () => {
  environment = await createTestEnvironment();
  directory = mkdtempSync(join(tmpdir(), 'erc5564-e2e-identities-'));

  const mira = createRecipientIdentity('Mira');
  const bob = createRecipientIdentity('Bob');
  miraFile = join(directory, 'mira.json');
  bobFile = join(directory, 'bob.json');
  writeKeystoreFile(miraFile, createKeystoreFile(mira, password));
  writeKeystoreFile(bobFile, createKeystoreFile(bob, password));

  const payerA = await environment.createFundedAccount('5');
  const payerB = await environment.createFundedAccount('5');
  const payerC = await environment.createFundedAccount('5');

  miraPayments = [
    await payToStealthAddress({
      rpcUrl: environment.chain.rpcUrl,
      announcerAddress: environment.deployment.announcerAddress,
      routerAddress: environment.deployment.routerAddress,
      metaAddress: mira.encodedMetaAddress,
      amountWei: parseEther('0.05'),
      payerPrivateKey: payerA.privateKey,
      chainId: environment.deployment.chainId,
    }),
    await payToStealthAddress({
      rpcUrl: environment.chain.rpcUrl,
      announcerAddress: environment.deployment.announcerAddress,
      routerAddress: environment.deployment.routerAddress,
      metaAddress: mira.encodedMetaAddress,
      amountWei: parseEther('0.03'),
      payerPrivateKey: payerB.privateKey,
      chainId: environment.deployment.chainId,
    }),
  ];
  bobPayment = await payToStealthAddress({
    rpcUrl: environment.chain.rpcUrl,
    announcerAddress: environment.deployment.announcerAddress,
    routerAddress: environment.deployment.routerAddress,
    metaAddress: bob.encodedMetaAddress,
    amountWei: parseEther('0.01'),
    payerPrivateKey: payerC.privateKey,
    chainId: environment.deployment.chainId,
  });
}, 120_000);

afterAll(async () => {
  await environment?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe('on-chain ERC-5564 Scheme 1 flow', () => {
  test('publishes fresh ephemeral public keys on-chain', async () => {
    const publicClient = createPublicClientFor(environment.chain.rpcUrl);
    const announcements = [] as ReturnType<typeof decodeAnnouncementLog>[];

    for (const payment of [...miraPayments, bobPayment]) {
      const receipt = await publicClient.getTransactionReceipt({ hash: payment.txHash });
      const logs = receipt.logs
        .filter(
          (log) =>
            log.address.toLowerCase() ===
            environment.deployment.announcerAddress.toLowerCase(),
        )
        .map((log) => decodeAnnouncementLog(log, environment.deployment.announcerAddress));
      expect(logs).toHaveLength(1);
      const announcement = logs[0]!;
      expect(announcement.schemeId).toBe(1n);
      expect(announcement.ephemeralPublicKey).toMatch(/^0x(02|03)[0-9a-fA-F]{64}$/);
      expect(announcement.stealthAddress).toBe(getAddress(payment.stealthAddress));
      expect(announcement.metadata.toLowerCase()).toBe(payment.metadata.toLowerCase());
      announcements.push(announcement);
    }

    expect(announcements[0]!.ephemeralPublicKey).not.toBe(
      announcements[1]!.ephemeralPublicKey,
    );
    expect(announcements[0]!.stealthAddress).not.toBe(
      announcements[1]!.stealthAddress,
    );
    expect(miraPayments[0]!.stealthAddress).not.toBe(miraPayments[1]!.stealthAddress);
  });

  test('scans with the viewing key only and finds exactly the two Mira payments', async () => {
    const scanner = loadIdentityForScanning(miraFile, password);
    expect(Object.keys(scanner).sort()).toEqual([
      'spendingPublicKey',
      'viewingPrivateKey',
    ]);
    expect('spendingPrivateKey' in scanner).toBe(false);

    const statePath = join(environment.directory, 'mira-scan-state.json');
    const result = await scanAnnouncements(scanner, {
      rpcUrl: environment.chain.rpcUrl,
      announcerAddress: environment.deployment.announcerAddress,
      routerAddress: environment.deployment.routerAddress,
      fromBlock: 0n,
      statePath,
    });

    expect(result.payments).toHaveLength(2);
    expect(result.payments.map((payment) => payment.amountWei)).toEqual([
      parseEther('0.05'),
      parseEther('0.03'),
    ]);
    expect(result.payments.every((payment) => payment.verification === 'transaction-verified')).toBe(
      true,
    );
    expect(result.payments.map((payment) => payment.stealthAddress)).toEqual(
      miraPayments.map((payment) => payment.stealthAddress),
    );
    expect(result.announcementsSeen).toBeGreaterThanOrEqual(3);
    expect(result.viewTagMisses).toBeGreaterThanOrEqual(1);

    const resumed = await scanAnnouncements(scanner, {
      rpcUrl: environment.chain.rpcUrl,
      announcerAddress: environment.deployment.announcerAddress,
      routerAddress: environment.deployment.routerAddress,
      statePath,
    });
    expect(resumed.payments).toHaveLength(2);
    expect(resumed.progress?.lastScannedBlock).toBe(result.progress?.lastScannedBlock);

    const stored = JSON.parse(readFileSync(statePath, 'utf8')) as {
      lastScannedBlock: string;
    };
    expect(stored.lastScannedBlock).toBe(result.progress?.lastScannedBlock);
  });

  test('an unrelated recipient sees only their own payment', async () => {
    const scanner = loadIdentityForScanning(bobFile, password);
    const result = await scanAnnouncements(scanner, {
      rpcUrl: environment.chain.rpcUrl,
      announcerAddress: environment.deployment.announcerAddress,
      routerAddress: environment.deployment.routerAddress,
      fromBlock: 0n,
      statePath: join(environment.directory, 'bob-scan-state.json'),
    });

    expect(result.payments).toHaveLength(1);
    expect(result.payments[0]!.stealthAddress).toBe(bobPayment.stealthAddress);
    expect(result.payments[0]!.txHash).toBe(bobPayment.txHash);
  });

  test('recovers both one-time keys with the full identity and withdraws one', async () => {
    const identity = loadRecipientIdentity(miraFile, password);
    const recovered = miraPayments.map((payment) =>
      recoverStealthPrivateKey({
        viewingPrivateKey: identity.viewingPrivateKey,
        spendingPrivateKey: identity.spendingPrivateKey,
        spendingPublicKey: identity.spendingPublicKey,
        ephemeralPublicKey: payment.ephemeralPublicKey,
        expectedStealthAddress: payment.stealthAddress,
      }),
    );

    expect(recovered[0]!.verified).toBe(true);
    expect(recovered[1]!.verified).toBe(true);
    expect(recovered[0]!.stealthPrivateKey).not.toBe(recovered[1]!.stealthPrivateKey);
    expect(recovered.map((entry) => entry.stealthAddress)).toEqual(
      miraPayments.map((payment) => getAddress(payment.stealthAddress)),
    );

    const destination = await createFundedAccount(environment.chain.rpcUrl, '1');
    const publicClient = createPublicClientFor(environment.chain.rpcUrl);
    const destinationBefore = await publicClient.getBalance({ address: destination.address });

    const withdrawal = await withdrawFromStealthAddress({
      rpcUrl: environment.chain.rpcUrl,
      stealthPrivateKey: recovered[0]!.stealthPrivateKey,
      to: destination.address,
      chainId: environment.deployment.chainId,
      expectedStealthAddress: recovered[0]!.stealthAddress,
    });
    const destinationAfter = await publicClient.getBalance({ address: destination.address });
    const stealthAfter = await publicClient.getBalance({ address: recovered[0]!.stealthAddress });

    expect(withdrawal.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(destinationAfter - destinationBefore).toBe(withdrawal.amountWei);
    expect(stealthAfter).toBeLessThan(parseEther('0.0001'));
  });
});
