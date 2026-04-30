import { asObject, asString } from './json';

export function getErrorMessage(error: unknown, fallback = 'unknown_error'): string {
  if (error instanceof Error && error.message) return error.message;
  const record = asObject(error);
  const message = asString(record?.message);
  return message || fallback;
}

export function getErrorCode(error: unknown): string | null {
  if (error instanceof Error && typeof (error as Error & { code?: unknown }).code === 'string') {
    return (error as Error & { code?: string }).code || null;
  }
  const record = asObject(error);
  return asString(record?.code);
}
