import { z } from 'zod';

/** Express may pass duplicate query keys as arrays. */
export function firstQueryValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

export function optionalTrimmedQueryString() {
  return z.preprocess(value => {
    const v = firstQueryValue(value);
    if (v === undefined || v === null) {
      return undefined;
    }
    if (typeof v !== 'string') {
      return v;
    }
    const trimmed = v.trim();
    return trimmed.length ? trimmed : undefined;
  }, z.string().optional());
}

export function queryBoolean(defaultValue = false) {
  return z.preprocess(value => {
    const v = firstQueryValue(value);
    if (v === undefined || v === null || v === '') {
      return defaultValue;
    }
    if (typeof v === 'boolean') {
      return v;
    }
    if (typeof v === 'string') {
      return ['true', '1', 'yes', 'on'].includes(v.toLowerCase());
    }
    return defaultValue;
  }, z.boolean());
}

export function queryInt(options: { default: number; min?: number; max?: number }) {
  const { default: defaultValue, min = 1, max } = options;
  let inner = z.coerce.number().int().min(min);
  if (max != null) {
    inner = inner.max(max);
  }
  return z.preprocess(value => {
    const v = firstQueryValue(value);
    if (v === undefined || v === null || v === '') {
      return defaultValue;
    }
    return v;
  }, inner);
}

export function optionalCoerceBoolean() {
  return z.preprocess(value => {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      return ['true', '1', 'yes', 'on'].includes(value.toLowerCase());
    }
    return value;
  }, z.boolean().optional());
}

export function optionalJsonRecord(
  valueSchema: z.ZodType<string | number> = z.union([z.string(), z.number()]),
) {
  return z.preprocess(value => {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }
    if (typeof value === 'string') {
      try {
        return JSON.parse(value) as unknown;
      } catch {
        return value;
      }
    }
    return value;
  }, z.record(z.string(), valueSchema).optional());
}

export function trimmedString(min = 1, max = 255) {
  return z.preprocess(value => {
    if (typeof value !== 'string') {
      return value;
    }
    return value.trim();
  }, z.string().min(min).max(max));
}
