import { createHash } from 'node:crypto';

const notSerialisable = (value: unknown): never => {
  throw new Error(`canonicalJson: value is not serialisable deterministically: ${String(value)}`);
};

/**
 * Returns a human-readable type name for an object that failed the
 * plain-object check, so a thrown error can say what was actually passed
 * (e.g. "Date", "Map", "RegExp", "Widget") instead of just "[object Object]".
 */
const describeNonPlainObject = (value: object): string => {
  const ctorName = (value as { constructor?: { name?: string } }).constructor?.name;
  if (ctorName) return ctorName;
  const tag = Object.prototype.toString.call(value);
  return tag.slice(8, -1);
};

const isPlainObject = (value: object): boolean => {
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
};

/**
 * Deterministic JSON: object keys sorted, arrays left in order, undefined
 * dropped from objects and nulled in arrays. Two structurally equal values
 * always produce byte-identical output, which is what makes hashing stable
 * across processes and Node versions.
 *
 * Only plain objects and arrays are traversed. Anything else with own
 * enumerable properties collapsing to nothing (Date, Map, Set, RegExp,
 * class instances, boxed primitives, ...) is rejected explicitly rather
 * than silently serialising to `{}`, which would hash-collide with an
 * actual empty object.
 */
export const canonicalJson = (value: unknown): string => canonicalJsonInner(value, new Set());

const canonicalJsonInner = (value: unknown, ancestors: Set<unknown>): string => {
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

  const obj = value as object;

  if (!Array.isArray(obj) && !isPlainObject(obj)) {
    throw new Error(
      `canonicalJson: value is not serialisable deterministically: instance of ${describeNonPlainObject(obj)} is not a plain object or array`,
    );
  }

  if (ancestors.has(obj)) {
    throw new Error(
      'canonicalJson: value is not serialisable deterministically: circular reference detected',
    );
  }
  ancestors.add(obj);

  try {
    if (Array.isArray(obj)) {
      const parts = obj.map((entry) =>
        entry === undefined ? 'null' : canonicalJsonInner(entry, ancestors),
      );
      return `[${parts.join(',')}]`;
    }

    const record = obj as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const entry = record[key];
      if (entry === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${canonicalJsonInner(entry, ancestors)}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    ancestors.delete(obj);
  }
};

export const sha256Hex = (input: string): string =>
  createHash('sha256').update(input, 'utf8').digest('hex');
