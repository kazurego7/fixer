import type { RequestId } from '../../shared/types';

export type JsonRecord = Record<string, unknown>;

export function asObject(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

export function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function asRequestId(value: unknown): RequestId | null {
  if (typeof value === 'string' && value) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}
