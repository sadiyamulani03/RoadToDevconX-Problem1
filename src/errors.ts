export class StealthError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'StealthError';
    this.code = code;
  }
}

export function redactSensitive(input: string): string {
  return input
    .replace(/0x[0-9a-fA-F]{64}/g, '0x[redacted-private-material]')
    .replace(/https?:\/\/[^@\s/]+@[^\s]+/g, 'https://[redacted-rpc-credentials]')
    .replace(/([?&](?:api[_-]?key|key|token)=)[^&\s]+/gi, '$1[redacted]');
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const shortMessage = (error as Error & { shortMessage?: string }).shortMessage;
    return redactSensitive(shortMessage || error.message);
  }
  return redactSensitive(String(error));
}
