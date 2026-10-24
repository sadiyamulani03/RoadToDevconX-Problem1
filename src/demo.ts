import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEther } from 'viem';
import { createPublicClientFor } from './chain.js';
import {
  publicKeyFromPrivateKey,
  publicKeyToAddress,
  randomSecretKey,
} from './crypto/secp.js';
import { deployStealthContracts } from './deploy.js';
import {
  createRecipientIdentity,
  toPublicIdentity,
} from './identity.js';
import {
  createKeystoreFile,
  loadRecipientIdentity,
  writeKeystoreFile,
} from './keystore.js';
import { loadIdentityForScanning } from './scanner-identity.js';
import { startAnvil, setBalance } from './local-chain.js';
import { payToStealthAddress } from './payer.js';
import {
  paymentReferenceFromReceipt,
  type PaymentReference,
} from './payment-file.js';
import { recoverStealthPrivateKey } from './recovery.js';
import { scanAnnouncements } from './scanner.js';
import type {
  DeployResult,
  RecipientPublicIdentity,
} from './types.js';
import { withdrawFromStealthAddress } from './withdrawal.js';

export interface DemoOptions {
  keepArtifacts?: boolean;
  password?: string;
}

export interface DemoSummary {
  chainId: number;
  deployment: DeployResult;
  identity: RecipientPublicIdentity;
  identityFile?: string;
  keystorePasswordPrinted: false;
  payments: PaymentReference[];
  distinctEphemeralKeys: true;
  distinctStealthAddresses: true;
  scan: {
    payments: number;
    announcementsSeen: number;
    viewTagMisses: number;
    addressMisses: number;
    malformedAnnouncements: number;
    duplicateAnnouncements: number;
  };
  recovery: Array<{ stealthAddress: string; verified: true }>;
  withdrawal: {
    txHash: string;
    from: string;
    to: string;
    amountWei: string;
    destinationBalanceWei: string;
    gasUsed: string;
  };
  artifactsDirectory?: string;
}

function addressOf(privateKey: `0x${string}`) {
  return publicKeyToAddress(publicKeyFromPrivateKey(privateKey));
}

export async function runDemo(options: DemoOptions = {}): Promise<DemoSummary> {
  const directory = await mkdtemp(join(tmpdir(), 'erc5564-demo-'));
  const chain = await startAnvil();
  try {
    const deployerKey = randomSecretKey();
    const payerAKey = randomSecretKey();
    const payerBKey = randomSecretKey();
    const payerAAddress = addressOf(payerAKey);
    const payerBAddress = addressOf(payerBKey);

    await Promise.all([
      setBalance(chain.rpcUrl, addressOf(deployerKey), parseEther('1000')),
      setBalance(chain.rpcUrl, payerAAddress, parseEther('10')),
      setBalance(chain.rpcUrl, payerBAddress, parseEther('10')),
    ]);

    const deployment = await deployStealthContracts({
      rpcUrl: chain.rpcUrl,
      deployerPrivateKey: deployerKey,
      outPath: join(directory, 'deployment.json'),
    });

    const password =
      options.password ??
      process.env.DEMO_PASSWORD ??
      randomBytes(24).toString('hex');
    const mira = createRecipientIdentity('Mira');
    const identityFile = join(directory, 'mira.json');
    writeKeystoreFile(identityFile, createKeystoreFile(mira, password));

    const scanner = loadIdentityForScanning(identityFile, password);
    if ('spendingPrivateKey' in scanner) {
      throw new Error('Discovery loader leaked a spending private key');
    }

    const paymentA = await payToStealthAddress({
      rpcUrl: chain.rpcUrl,
      announcerAddress: deployment.announcerAddress,
      routerAddress: deployment.routerAddress,
      metaAddress: mira.encodedMetaAddress,
      amountWei: parseEther('0.05'),
      payerPrivateKey: payerAKey,
      chainId: deployment.chainId,
    });
    const paymentB = await payToStealthAddress({
      rpcUrl: chain.rpcUrl,
      announcerAddress: deployment.announcerAddress,
      routerAddress: deployment.routerAddress,
      metaAddress: mira.encodedMetaAddress,
      amountWei: parseEther('0.03'),
      payerPrivateKey: payerBKey,
      chainId: deployment.chainId,
    });

    if (paymentA.stealthAddress === paymentB.stealthAddress) {
      throw new Error('Two payments reused the same stealth address');
    }
    if (paymentA.ephemeralPublicKey === paymentB.ephemeralPublicKey) {
      throw new Error('Two payments reused the same ephemeral public key');
    }

    const scan = await scanAnnouncements(scanner, {
      rpcUrl: chain.rpcUrl,
      announcerAddress: deployment.announcerAddress,
      routerAddress: deployment.routerAddress,
      fromBlock: 0n,
      statePath: join(directory, 'scan-state.json'),
    });
    if (scan.payments.length !== 2) {
      throw new Error(`Expected 2 discovered payments, found ${scan.payments.length}`);
    }
    if (scan.payments.some((payment) => payment.verification !== 'transaction-verified')) {
      throw new Error('Not every discovered payment passed router verification');
    }

    const fullIdentity = loadRecipientIdentity(identityFile, password);
    const recoveries = scan.payments.map((payment) =>
      recoverStealthPrivateKey({
        viewingPrivateKey: fullIdentity.viewingPrivateKey,
        spendingPrivateKey: fullIdentity.spendingPrivateKey,
        spendingPublicKey: fullIdentity.spendingPublicKey,
        ephemeralPublicKey: payment.announcement.ephemeralPublicKey,
        expectedStealthAddress: payment.stealthAddress,
      }),
    );
    if (recoveries[0]?.stealthPrivateKey === recoveries[1]?.stealthPrivateKey) {
      throw new Error('Two stealth addresses recovered the same private key');
    }

    const firstPayment = scan.payments[0];
    const firstRecovery = recoveries[0];
    if (!firstPayment || !firstRecovery) throw new Error('Demo payment missing');

    const destinationKey = randomSecretKey();
    const destination = addressOf(destinationKey);
    const withdrawal = await withdrawFromStealthAddress({
      rpcUrl: chain.rpcUrl,
      stealthPrivateKey: firstRecovery.stealthPrivateKey,
      to: destination,
      chainId: deployment.chainId,
      expectedStealthAddress: firstRecovery.stealthAddress,
    });
    const publicClient = createPublicClientFor(chain.rpcUrl);
    const destinationBalance = await publicClient.getBalance({ address: destination });

    return {
      chainId: deployment.chainId,
      deployment: { ...deployment, deploymentFile: undefined },
      identity: toPublicIdentity(mira),
      ...(options.keepArtifacts ? { identityFile } : {}),
      keystorePasswordPrinted: false,
      payments: [
        paymentReferenceFromReceipt(paymentA),
        paymentReferenceFromReceipt(paymentB),
      ],
      distinctEphemeralKeys: true,
      distinctStealthAddresses: true,
      scan: {
        payments: scan.payments.length,
        announcementsSeen: scan.announcementsSeen,
        viewTagMisses: scan.viewTagMisses,
        addressMisses: scan.addressMisses,
        malformedAnnouncements: scan.malformedAnnouncements,
        duplicateAnnouncements: scan.duplicateAnnouncements,
      },
      recovery: recoveries.map((recovery) => ({
        stealthAddress: recovery.stealthAddress,
        verified: recovery.verified,
      })),
      withdrawal: {
        txHash: withdrawal.txHash,
        from: withdrawal.from,
        to: withdrawal.to,
        amountWei: withdrawal.amountWei.toString(),
        destinationBalanceWei: destinationBalance.toString(),
        gasUsed: withdrawal.gasUsed.toString(),
      },
      ...(options.keepArtifacts ? { artifactsDirectory: directory } : {}),
    };
  } finally {
    await chain.stop();
    if (!options.keepArtifacts) {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
