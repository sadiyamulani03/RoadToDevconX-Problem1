import { pad, toHex } from 'viem';
import type { Address, Hex, ViewTag } from './types.js';

export const ETH_TOKEN_IDENTIFIER: Hex = '0xeeeeeeee';
export const ETH_TOKEN_ADDRESS: Address = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
export const ETH_METADATA_LENGTH = 57;
const MAX_UINT256 = (1n << 256n) - 1n;

export function validateViewTag(value: unknown): ViewTag {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{2}$/.test(value)) {
    throw new Error('View tag must be exactly one byte (0x followed by two hex characters)');
  }
  return value.toLowerCase() as ViewTag;
}

export function extractViewTag(metadata: Hex): ViewTag {
  if (typeof metadata !== 'string' || !/^0x[0-9a-fA-F]*$/.test(metadata)) {
    throw new Error('Metadata must be a hex string');
  }
  if (metadata.length < 4) {
    throw new Error('Metadata is missing the mandatory one-byte view tag');
  }
  return `0x${metadata.slice(2, 4)}`.toLowerCase() as ViewTag;
}

export function buildEthMetadata(viewTag: ViewTag, amountWei: bigint): Hex {
  const tag = validateViewTag(viewTag);
  if (typeof amountWei !== 'bigint') {
    throw new Error('Amount must be provided as a bigint in wei');
  }
  if (amountWei <= 0n || amountWei > MAX_UINT256) {
    throw new Error('Amount must be a positive uint256 value in wei');
  }

  const amount = pad(toHex(amountWei), { size: 32 });
  return `0x${tag.slice(2)}${ETH_TOKEN_IDENTIFIER.slice(2)}${ETH_TOKEN_ADDRESS.slice(
    2,
  )}${amount.slice(2)}` as Hex;
}

export interface EthMetadata {
  viewTag: ViewTag;
  tokenIdentifier: Hex;
  tokenAddress: Address;
  amountWei: bigint;
}

export function parseEthMetadata(metadata: Hex): EthMetadata | null {
  if (typeof metadata !== 'string' || !/^0x[0-9a-fA-F]*$/.test(metadata)) return null;
  if (metadata.length !== 2 + ETH_METADATA_LENGTH * 2) return null;

  const body = metadata.slice(2);
  const viewTag = `0x${body.slice(0, 2)}`.toLowerCase() as ViewTag;
  const tokenIdentifier = `0x${body.slice(2, 10)}`.toLowerCase() as Hex;
  const tokenAddress = `0x${body.slice(10, 50)}`.toLowerCase();
  const amountWei = BigInt(`0x${body.slice(50, 114)}`);

  if (tokenIdentifier !== ETH_TOKEN_IDENTIFIER) return null;
  if (tokenAddress !== ETH_TOKEN_ADDRESS.toLowerCase()) return null;

  return {
    viewTag,
    tokenIdentifier,
    tokenAddress: ETH_TOKEN_ADDRESS,
    amountWei,
  };
}
