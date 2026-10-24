import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const root = process.cwd();
const skipDirectories = new Set([
  '.git',
  '.stealth',
  'node_modules',
  'out',
  'cache',
  'dist',
  'coverage',
  'lib',
  'deployments',
]);
const skipFiles = new Set(['package-lock.json']);
const textExtensions = new Set([
  '',
  '.ts',
  '.js',
  '.mjs',
  '.json',
  '.sol',
  '.md',
  '.yml',
  '.yaml',
  '.toml',
  '.txt',
  '.py',
  '.example',
]);
const allowlistedTestVectors = new Set([
  'test/reference-vectors.json',
  'test/reference_vectors.py',
]);
const allowlistedPublicEvidence = new Set(['README.md', 'REPORT.md']);
const patterns = [
  { name: 'raw secp256k1 private key', regex: /0x[0-9a-fA-F]{64}/g },
  { name: 'PEM private key', regex: /-----BEGIN (?:EC |RSA |OPENSSH )?PRIVATE KEY-----/g },
  { name: 'RPC URL with embedded credentials', regex: /https?:\/\/[^/\s:@]+:[^/\s@]+@[^\s]+/g },
  { name: 'GitHub token', regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { name: 'AWS access key', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'Google API key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'Slack token', regex: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
  { name: 'Stripe live key', regex: /\bsk_live_[0-9A-Za-z]{16,}\b/g },
  { name: 'assigned private key env', regex: /^(?:PRIVATE_KEY|PAYER_PRIVATE_KEY|DEPLOYER_PRIVATE_KEY|STEALTH_KEYSTORE_PASSWORD)\s*=\s*(?!your-|replace-|change-|example-|<|\$\{)(\S+)/gm },
];

const findings = [];
let filesScanned = 0;

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    const rel = relative(root, absolute).replaceAll('\\', '/');
    if (entry.isDirectory()) {
      if (!skipDirectories.has(entry.name)) walk(absolute);
      continue;
    }
    if (!entry.isFile() || skipFiles.has(rel)) continue;
    if (rel === '.env') {
      findings.push(`${rel}: committed .env file`);
      continue;
    }
    if (statSync(absolute).size > 2 * 1024 * 1024) continue;
    const ext = extname(entry.name);
    if (!textExtensions.has(ext) && !entry.name.startsWith('.env')) continue;
    let text;
    try {
      text = readFileSync(absolute, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\u0000')) continue;
    filesScanned += 1;
    for (const pattern of patterns) {
      if (
        pattern.name === 'raw secp256k1 private key' &&
        (allowlistedTestVectors.has(rel) ||
          allowlistedPublicEvidence.has(rel) ||
          rel.startsWith('test/'))
      ) {
        continue;
      }
      pattern.regex.lastIndex = 0;
      const match = pattern.regex.exec(text);
      if (match) {
        const line = text.slice(0, match.index).split('\n').length;
        findings.push(`${rel}:${line}: ${pattern.name}`);
      }
    }
  }
}

walk(root);

if (findings.length > 0) {
  console.error('Secret scan failed:');
  for (const finding of findings) console.error(`  ${finding}`);
  process.exit(1);
}
console.log(`Secret scan passed: ${filesScanned} text files scanned.`);
