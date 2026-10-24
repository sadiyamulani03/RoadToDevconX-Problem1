import { loadScannerIdentity } from './keystore.js';
import type { ScannerIdentity } from './types.js';

/**
 * Discovery-side adapter. The scanner itself never imports this module or the
 * keystore; this function returns a value containing only the viewing private
 * key and the spending public key.
 */
export function loadIdentityForScanning(path: string, password: string): ScannerIdentity {
  const identity = loadScannerIdentity(path, password);
  return {
    viewingPrivateKey: identity.viewingPrivateKey,
    spendingPublicKey: identity.spendingPublicKey,
  };
}
