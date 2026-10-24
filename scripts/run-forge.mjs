import { runForge } from './forge.mjs';

const args = process.argv.slice(2);
runForge(args.length > 0 ? args : ['test']);
