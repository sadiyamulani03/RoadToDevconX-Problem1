#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { parseEther, type Address, type Hex } from 'viem';
import {
  assertAddress,
  assertPrivateKey,
  isValidAddress,
  isValidPrivateKey,
} from './crypto/secp.js';
import {
  computeSharedSecret,
  hashSharedSecret,
  viewTagFromHash,
} from './crypto/stealth.js';
import { printJson, toJsonSafe } from './json.js';
import { writeJsonAtomic } from './fs.js';
import { errorMessage } from './errors.js';
import {
  loadIdentityForScanning,
} from './scanner-identity.js';
import {
  createRecipientIdentity,
  toPublicIdentity,
} from './identity.js';
import {
  createKeystoreFile,
  loadRecipientIdentity,
  publicIdentityFromKeystore,
  readKeystoreFile,
  summarizeKeystore,
  writeKeystoreFile,
} from './keystore.js';
import { payToStealthAddress } from './payer.js';
import { scanAnnouncements } from './scanner.js';
import { recoverStealthPrivateKey } from './recovery.js';
import { withdrawFromStealthAddress } from './withdrawal.js';
import {
  createPublicClientFor,
  getAndCheckChainId,
  validateRpcUrl,
  weiToEth,
} from './chain.js';
import {
  parsePaymentReference,
  paymentReferenceFromReceipt,
} from './payment-file.js';
import { readJsonFile } from './fs.js';
import { deployStealthContracts } from './deploy.js';

const DEFAULT_IDENTITY_PATH = '.stealth/identity.json';
const DEFAULT_PAYER_KEY_ENV = 'PAYER_PRIVATE_KEY';

const USAGE = `ERC-5564 Scheme 1 stealth payments

Usage: stealth <command> [options]

Commands:
  identity create      Create an encrypted identity keystore
  identity show        Show public identity and keystore metadata
  identity export-public
                       Print only the shareable public identity
  pay                  Derive a one-time address and pay through the router
  scan                 Scan Announcement logs using only the viewing key
  recover              Verify a payment and recover its one-time key (not printed)
  withdraw             Sweep a recovered stealth address to a safe address
  balance              Read an address balance
  deploy               Deploy the announcer and payment router
  help                 Show this help

Run "stealth <command> --help" for command options.

Secrets are read from environment variables or files, never from argv:
  STEALTH_KEYSTORE_PASSWORD / --password-env / --password-file
  PAYER_PRIVATE_KEY / --payer-key-env / --payer-key-file
`;

class UsageError extends Error {}

type Values = Record<string, string | boolean | undefined>;

function parseCommand(
  args: string[],
  options: Record<string, { type: 'string' | 'boolean' }>,
): Values {
  try {
    const parsed = parseArgs({ args, options, allowPositionals: false, strict: true });
    if (parsed.values.help === true) {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    return parsed.values as Values;
  } catch (error) {
    throw new UsageError(errorMessage(error));
  }
}

function optionalString(values: Values, key: string): string | undefined {
  const value = values[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new UsageError(`--${key} requires a non-empty value`);
  }
  return value;
}

function requiredString(values: Values, key: string): string {
  const value = optionalString(values, key);
  if (!value) throw new UsageError(`Missing required option --${key}`);
  return value;
}

function integerOption(
  values: Values,
  key: string,
  options: { min?: number; max?: number } = {},
): number | undefined {
  const raw = optionalString(values, key);
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw new UsageError(`--${key} must be a non-negative integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new UsageError(`--${key} is too large`);
  if (options.min !== undefined && parsed < options.min) {
    throw new UsageError(`--${key} must be at least ${options.min}`);
  }
  if (options.max !== undefined && parsed > options.max) {
    throw new UsageError(`--${key} must be at most ${options.max}`);
  }
  return parsed;
}

function bigintOption(values: Values, key: string): bigint | undefined {
  const raw = optionalString(values, key);
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw new UsageError(`--${key} must be a non-negative integer`);
  return BigInt(raw);
}

function addressOption(
  values: Values,
  key: string,
  envName?: string,
  required = true,
): Address | undefined {
  const raw = optionalString(values, key) ?? (envName ? process.env[envName] : undefined);
  if (!raw) {
    if (!required) return undefined;
    throw new UsageError(
      `Missing --${key}${envName ? ` (or ${envName})` : ''}`,
    );
  }
  if (!isValidAddress(raw)) throw new UsageError(`--${key} must be a valid Ethereum address`);
  return assertAddress(raw);
}

function rpcUrlOption(values: Values): string {
  const raw = optionalString(values, 'rpc-url') ?? process.env.RPC_URL;
  if (!raw) throw new UsageError('Missing --rpc-url (or RPC_URL)');
  try {
    return validateRpcUrl(raw);
  } catch (error) {
    throw new UsageError(errorMessage(error));
  }
}

function passwordOption(values: Values): string {
  const file = optionalString(values, 'password-file');
  if (file) return readFileSync(file, 'utf8').replace(/\r?\n$/, '');
  const envName = optionalString(values, 'password-env') ?? 'STEALTH_KEYSTORE_PASSWORD';
  const value = process.env[envName];
  if (!value) {
    throw new UsageError(
      `Keystore password not provided. Set ${envName} or pass --password-file.`,
    );
  }
  return value;
}

function privateKeyOption(
  values: Values,
  prefix: 'payer' | 'deployer',
): Hex {
  const file = optionalString(values, `${prefix}-key-file`);
  const envOption = optionalString(values, `${prefix}-key-env`);
  const envName =
    envOption ?? (prefix === 'payer' ? DEFAULT_PAYER_KEY_ENV : 'DEPLOYER_PRIVATE_KEY');
  const raw = file ? readFileSync(file, 'utf8').replace(/\r?\n$/, '') : process.env[envName];
  if (!raw) {
    throw new UsageError(
      `${prefix === 'payer' ? 'Payer' : 'Deployer'} private key not provided. ` +
        `Set ${envName} or pass --${prefix}-key-file.`,
    );
  }
  if (!isValidPrivateKey(raw)) throw new UsageError('Private key is not a valid secp256k1 scalar');
  return assertPrivateKey(raw);
}

function identityPath(values: Values): string {
  return optionalString(values, 'identity') ?? DEFAULT_IDENTITY_PATH;
}

function writeOptionalJson(path: string | undefined, value: unknown): void {
  if (path) writeJsonAtomic(path, toJsonSafe(value));
}

function amountOption(values: Values): bigint {
  const raw = requiredString(values, 'amount');
  let amount: bigint;
  try {
    amount = parseEther(raw);
  } catch {
    throw new UsageError('--amount must be a decimal ETH amount, for example 0.05');
  }
  if (amount <= 0n) throw new UsageError('--amount must be greater than zero');
  return amount;
}


async function commandIdentityCreate(args: string[]): Promise<void> {
  const values = parseCommand(args, {
    name: { type: 'string' },
    out: { type: 'string' },
    force: { type: 'boolean' },
    'password-env': { type: 'string' },
    'password-file': { type: 'string' },
    help: { type: 'boolean' },
  });
  const name = optionalString(values, 'name');
  const out = optionalString(values, 'out') ?? DEFAULT_IDENTITY_PATH;
  const password = passwordOption(values);
  const identity = createRecipientIdentity(name);
  const keystore = createKeystoreFile(identity, password);
  writeKeystoreFile(out, keystore, { force: values.force === true });

  printJson({
    identityFile: out,
    publicIdentity: toPublicIdentity(identity),
    createdAt: keystore.createdAt,
    kdf: keystore.kdf.name,
    cipher: keystore.cipher,
    warning: 'Back up the keystore and password; the spending key cannot be recovered from the meta-address.',
  });
}

async function commandIdentityShow(args: string[]): Promise<void> {
  const values = parseCommand(args, {
    identity: { type: 'string' },
    help: { type: 'boolean' },
  });
  const path = identityPath(values);
  const file = readKeystoreFile(path);
  printJson({
    identityFile: path,
    publicIdentity: publicIdentityFromKeystore(file),
    keystore: summarizeKeystore(file),
  });
}

async function commandIdentityExportPublic(args: string[]): Promise<void> {
  const values = parseCommand(args, {
    identity: { type: 'string' },
    help: { type: 'boolean' },
  });
  printJson(publicIdentityFromKeystore(readKeystoreFile(identityPath(values))));
}

async function commandPay(args: string[]): Promise<void> {
  const values = parseCommand(args, {
    'meta-address': { type: 'string' },
    amount: { type: 'string' },
    'rpc-url': { type: 'string' },
    announcer: { type: 'string' },
    router: { type: 'string' },
    'chain-id': { type: 'string' },
    'payer-key-env': { type: 'string' },
    'payer-key-file': { type: 'string' },
    out: { type: 'string' },
    help: { type: 'boolean' },
  });

  const receipt = await payToStealthAddress({
    rpcUrl: rpcUrlOption(values),
    announcerAddress: addressOption(values, 'announcer', 'ANNOUNCER_ADDRESS')!,
    routerAddress: addressOption(values, 'router', 'ROUTER_ADDRESS')!,
    metaAddress: requiredString(values, 'meta-address'),
    amountWei: amountOption(values),
    payerPrivateKey: privateKeyOption(values, 'payer'),
    ...(integerOption(values, 'chain-id') !== undefined
      ? { chainId: integerOption(values, 'chain-id') }
      : {}),
  });

  const out = optionalString(values, 'out');
  const reference = paymentReferenceFromReceipt(receipt);
  writeOptionalJson(out, reference);
  printJson(reference);
}

async function commandScan(args: string[]): Promise<void> {
  const values = parseCommand(args, {
    identity: { type: 'string' },
    'rpc-url': { type: 'string' },
    announcer: { type: 'string' },
    router: { type: 'string' },
    'from-block': { type: 'string' },
    'to-block': { type: 'string' },
    'page-size': { type: 'string' },
    'reorg-window': { type: 'string' },
    state: { type: 'string' },
    out: { type: 'string' },
    'no-verify': { type: 'boolean' },
    'password-env': { type: 'string' },
    'password-file': { type: 'string' },
    help: { type: 'boolean' },
  });
  const path = identityPath(values);
  const identity = loadIdentityForScanning(path, passwordOption(values));
  const router = addressOption(values, 'router', 'ROUTER_ADDRESS', false);
  const statePath =
    optionalString(values, 'state') ?? join(dirname(path), 'scan-state.json');

  const result = await scanAnnouncements(identity, {
    rpcUrl: rpcUrlOption(values),
    announcerAddress: addressOption(values, 'announcer', 'ANNOUNCER_ADDRESS')!,
    ...(router ? { routerAddress: router } : {}),
    ...(bigintOption(values, 'from-block') !== undefined
      ? { fromBlock: bigintOption(values, 'from-block') }
      : {}),
    ...(bigintOption(values, 'to-block') !== undefined
      ? { toBlock: bigintOption(values, 'to-block') }
      : {}),
    ...(integerOption(values, 'page-size', { min: 1, max: 100_000 }) !== undefined
      ? { pageSize: integerOption(values, 'page-size', { min: 1, max: 100_000 }) }
      : {}),
    ...(integerOption(values, 'reorg-window', { min: 0, max: 10_000 }) !== undefined
      ? { reorgWindow: integerOption(values, 'reorg-window', { min: 0, max: 10_000 }) }
      : {}),
    statePath,
    verifyTransactions: values['no-verify'] !== true,
    onProgress: (progress) => {
      process.stderr.write(
        `Scanned ${progress.fromBlock}-${progress.toBlock}: ${progress.payments} match(es)\n`,
      );
    },
  });

  const out = optionalString(values, 'out');
  if (out) {
    writeJsonAtomic(out, toJsonSafe(result));
  }
  printJson(result);
}

async function commandRecover(args: string[]): Promise<void> {
  const values = parseCommand(args, {
    identity: { type: 'string' },
    payment: { type: 'string' },
    index: { type: 'string' },
    'password-env': { type: 'string' },
    'password-file': { type: 'string' },
    help: { type: 'boolean' },
  });
  const identity = loadRecipientIdentity(identityPath(values), passwordOption(values));
  const reference = parsePaymentReference(
    readJsonFile(requiredString(values, 'payment')),
    integerOption(values, 'index', { min: 0 }) ?? 0,
  );

  if (reference.viewTag) {
    const expectedTag = viewTagFromHash(
      hashSharedSecret(
        computeSharedSecret(identity.viewingPrivateKey, reference.ephemeralPublicKey),
      ),
    );
    if (expectedTag.toLowerCase() !== reference.viewTag.toLowerCase()) {
      throw new Error('Payment record view tag does not match the viewing key');
    }
  }

  const recovered = recoverStealthPrivateKey({
    viewingPrivateKey: identity.viewingPrivateKey,
    spendingPrivateKey: identity.spendingPrivateKey,
    spendingPublicKey: identity.spendingPublicKey,
    ephemeralPublicKey: reference.ephemeralPublicKey,
    expectedStealthAddress: reference.stealthAddress,
  });

  printJson({
    stealthAddress: recovered.stealthAddress,
    verified: recovered.verified,
    ephemeralPublicKey: reference.ephemeralPublicKey,
    ...(reference.viewTag ? { viewTag: reference.viewTag } : {}),
    ...(reference.amountWei !== undefined ? { amountWei: reference.amountWei } : {}),
    ...(reference.txHash ? { txHash: reference.txHash } : {}),
    privateKeyPrinted: false,
  });
}

async function commandWithdraw(args: string[]): Promise<void> {
  const values = parseCommand(args, {
    identity: { type: 'string' },
    payment: { type: 'string' },
    index: { type: 'string' },
    to: { type: 'string' },
    amount: { type: 'string' },
    'rpc-url': { type: 'string' },
    'chain-id': { type: 'string' },
    'password-env': { type: 'string' },
    'password-file': { type: 'string' },
    help: { type: 'boolean' },
  });
  const identity = loadRecipientIdentity(identityPath(values), passwordOption(values));
  const reference = parsePaymentReference(
    readJsonFile(requiredString(values, 'payment')),
    integerOption(values, 'index', { min: 0 }) ?? 0,
  );
  const recovered = recoverStealthPrivateKey({
    viewingPrivateKey: identity.viewingPrivateKey,
    spendingPrivateKey: identity.spendingPrivateKey,
    spendingPublicKey: identity.spendingPublicKey,
    ephemeralPublicKey: reference.ephemeralPublicKey,
    expectedStealthAddress: reference.stealthAddress,
  });

  const chainId =
    integerOption(values, 'chain-id') ?? reference.chainId ?? undefined;
  const result = await withdrawFromStealthAddress({
    rpcUrl: rpcUrlOption(values),
    stealthPrivateKey: recovered.stealthPrivateKey,
    to: addressOption(values, 'to')!,
    ...(optionalString(values, 'amount') ? { amountWei: amountOption(values) } : {}),
    ...(chainId !== undefined ? { chainId } : {}),
    expectedStealthAddress: recovered.stealthAddress,
  });
  printJson(result);
}

async function commandBalance(args: string[]): Promise<void> {
  const values = parseCommand(args, {
    address: { type: 'string' },
    'rpc-url': { type: 'string' },
    help: { type: 'boolean' },
  });
  const address = addressOption(values, 'address')!;
  const publicClient = createPublicClientFor(rpcUrlOption(values));
  const chainId = await getAndCheckChainId(publicClient);
  const [balanceWei, blockNumber] = await Promise.all([
    publicClient.getBalance({ address }),
    publicClient.getBlockNumber(),
  ]);
  printJson({
    address,
    chainId,
    balanceWei,
    balanceEth: weiToEth(balanceWei),
    blockNumber,
  });
}


async function commandDeploy(args: string[]): Promise<void> {
  const values = parseCommand(args, {
    'rpc-url': { type: 'string' },
    announcer: { type: 'string' },
    'chain-id': { type: 'string' },
    'deployer-key-env': { type: 'string' },
    'deployer-key-file': { type: 'string' },
    out: { type: 'string' },
    help: { type: 'boolean' },
  });
  const existingAnnouncer = addressOption(
    values,
    'announcer',
    'ANNOUNCER_ADDRESS',
    false,
  );
  const chainId = integerOption(values, 'chain-id');
  const outPath = optionalString(values, 'out');
  const result = await deployStealthContracts({
    rpcUrl: rpcUrlOption(values),
    deployerPrivateKey: privateKeyOption(values, 'deployer'),
    ...(chainId !== undefined ? { chainId } : {}),
    ...(existingAnnouncer ? { existingAnnouncer } : {}),
    ...(outPath ? { outPath } : {}),
  });
  printJson(result);
}

async function dispatch(command: string, subcommand: string | undefined, args: string[]): Promise<void> {
  switch (`${command}${subcommand ? ` ${subcommand}` : ''}`) {
    case 'identity create':
      return commandIdentityCreate(args);
    case 'identity show':
      return commandIdentityShow(args);
    case 'identity export-public':
      return commandIdentityExportPublic(args);
    case 'pay':
      return commandPay(args);
    case 'scan':
      return commandScan(args);
    case 'recover':
      return commandRecover(args);
    case 'withdraw':
      return commandWithdraw(args);
    case 'balance':
      return commandBalance(args);
    case 'deploy':
      return commandDeploy(args);
    case 'help':
      process.stdout.write(USAGE);
      return;
    default:
      throw new UsageError(`Unknown command: ${command}${subcommand ? ` ${subcommand}` : ''}`);
  }
}

async function main(argv: string[]): Promise<void> {
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help') {
    process.stdout.write(USAGE);
    return;
  }
  const command = argv[0]!;
  const subcommand = command === 'identity' ? argv[1] : undefined;
  const rest = command === 'identity' ? argv.slice(2) : argv.slice(1);
  try {
    await dispatch(command, subcommand, rest);
  } catch (error) {
    process.stderr.write(`Error: ${errorMessage(error)}\n`);
    if (error instanceof UsageError) {
      process.stderr.write(`\n${USAGE}`);
      process.exitCode = 2;
    } else {
      if (process.env.STEALTH_DEBUG === '1' && error instanceof Error) {
        process.stderr.write(`${error.stack ?? ''}\n`);
      }
      process.exitCode = 1;
    }
  }
}

await main(process.argv.slice(2));
