import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function resolveForge() {
  if (process.env.FORGE_BIN) return process.env.FORGE_BIN;
  const probe = spawnSync('forge', ['--version'], { encoding: 'utf8' });
  if (probe.status === 0) return 'forge';
  const homeForge = join(homedir(), '.foundry', 'bin', 'forge');
  if (existsSync(homeForge)) return homeForge;
  return 'forge';
}

export function runForge(args, options = {}) {
  const result = spawnSync(resolveForge(), args, {
    stdio: 'inherit',
    env: { ...process.env, FOUNDRY_DISABLE_NIGHTLY_WARNING: '1' },
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`forge ${args.join(' ')} exited with status ${result.status}`);
  }
}
