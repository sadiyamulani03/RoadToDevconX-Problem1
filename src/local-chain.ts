import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createAnvilTestClient, createPublicClientFor } from './chain.js';
import { errorMessage } from './errors.js';
import type { Address } from './types.js';

export interface LocalChain {
  rpcUrl: string;
  port: number;
  chainId: number;
  process: ChildProcess;
  stop: () => Promise<void>;
}

function resolveAnvilBinary(): string {
  if (process.env.ANVIL_BIN) return process.env.ANVIL_BIN;
  const homeBinary = join(homedir(), '.foundry', 'bin', 'anvil');
  if (existsSync(homeBinary)) return homeBinary;
  return 'anvil';
}

export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Unable to allocate a local TCP port'));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function waitForRpc(rpcUrl: string, child: ChildProcess, logs: string[]): Promise<void> {
  const publicClient = createPublicClientFor(rpcUrl);
  const deadline = Date.now() + 30_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Anvil exited before RPC became ready: ${logs.join('').slice(-2_000)}`);
    }
    try {
      await publicClient.getChainId();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw new Error(`Timed out waiting for Anvil at ${rpcUrl}: ${errorMessage(lastError)}`);
}

export async function startAnvil(options: { chainId?: number; port?: number } = {}): Promise<LocalChain> {
  const port = options.port ?? (await getFreePort());
  const chainId = options.chainId ?? 31337;
  const rpcUrl = `http://127.0.0.1:${port}`;
  const binary = resolveAnvilBinary();
  const logs: string[] = [];

  const child = spawn(
    binary,
    [
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--chain-id',
      String(chainId),
      '--silent',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout?.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => logs.push(chunk.toString()));

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
        resolve();
      }, 5_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };

  try {
    await waitForRpc(rpcUrl, child, logs);
  } catch (error) {
    await stop();
    throw error;
  }

  return { rpcUrl, port, chainId, process: child, stop };
}

export async function setBalance(
  rpcUrl: string,
  address: Address,
  valueWei: bigint,
): Promise<void> {
  const testClient = createAnvilTestClient(rpcUrl);
  await testClient.setBalance({ address, value: valueWei });
}

export async function mineBlocks(rpcUrl: string, blocks = 1): Promise<void> {
  const testClient = createAnvilTestClient(rpcUrl);
  await testClient.mine({ blocks });
}
