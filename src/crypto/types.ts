export type Hex = `0x${string}`;
export type Address = `0x${string}`;
export type PrivateKey = Hex;
export type CompressedPublicKey = Hex;
export type ViewTag = Hex;

export interface StealthMetaAddress {
  spendingPublicKey: CompressedPublicKey;
  viewingPublicKey: CompressedPublicKey;
  encoded: string;
}

export interface StealthAddressDerivation {
  stealthAddress: Address;
  ephemeralPublicKey: CompressedPublicKey;
  viewTag: ViewTag;
}

export interface StealthPrivateKeyResult {
  stealthPrivateKey: PrivateKey;
  stealthAddress: Address;
}
