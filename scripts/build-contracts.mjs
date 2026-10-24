import { existsSync } from 'node:fs';
import { runForge } from './forge.mjs';

runForge(['build']);
for (const artifact of [
  'out/ERC5564Announcer.sol/ERC5564Announcer.json',
  'out/StealthPaymentRouter.sol/StealthPaymentRouter.json',
]) {
  if (!existsSync(artifact)) throw new Error(`Foundry did not produce ${artifact}`);
}
console.log('Contracts compiled.');
