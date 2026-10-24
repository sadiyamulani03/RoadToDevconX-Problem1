export function toJsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map((item) => toJsonSafe(item));
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = toJsonSafe(entry);
    }
    return result;
  }
  return value;
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(toJsonSafe(value), null, 2)}\n`);
}
