import { createHash } from 'node:crypto';

const notSerialisable = (value: unknown): never => {
  throw new Error(`canonicalJson: value is not serialisable deterministically: ${String(value)}`);
};

/**
 * Deterministic JSON: object keys sorted, arrays left in order, undefined
 * dropped from objects and nulled in arrays. Two structurally equal values
 * always produce byte-identical output, which is what makes hashing stable
 * across processes and Node versions.
 */
export const canonicalJson = (value: unknown): string => {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : notSerialisable(value);
    case 'string':
      return JSON.stringify(value);
    case 'bigint':
      return JSON.stringify(value.toString());
    case 'undefined':
    case 'function':
    case 'symbol':
      return notSerialisable(value);
    default:
      break;
  }

  if (Array.isArray(value)) {
    const parts = value.map((entry) => (entry === undefined ? 'null' : canonicalJson(entry)));
    return `[${parts.join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const entry = record[key];
    if (entry === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJson(entry)}`);
  }
  return `{${parts.join(',')}}`;
};

export const sha256Hex = (input: string): string =>
  createHash('sha256').update(input, 'utf8').digest('hex');
