import type {
  AssistantOutputItem,
  IssueItem,
  ModelOption,
  OutputItem,
  TurnStreamEvent,
  UserOutputItem
} from '../../shared/types';

export function getClientErrorMessage(error: unknown, fallback = 'unknown_error'): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return fallback;
}

export function isAssistantItem(item: OutputItem): item is AssistantOutputItem {
  return item.role === 'assistant';
}

export function isUserItem(item: OutputItem): item is UserOutputItem {
  return item.role === 'user';
}

export function parseTurnStreamEvent(rawLine: string): TurnStreamEvent | null {
  try {
    const parsed = JSON.parse(rawLine) as { type?: string } | null;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') return null;
    return parsed as TurnStreamEvent;
  } catch {
    return null;
  }
}

export function formatFileSize(size: number | string | null | undefined): string {
  const bytes = Number(size || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatIssueStatus(status: IssueItem['status']): string {
  if (status === 'open') return '未対応';
  if (status === 'summarizing') return '要約中';
  if (status === 'failed') return '失敗';
  if (status === 'resolved') return '解決済み';
  return '待機中';
}

export function outputItemTurnId(item: OutputItem | null | undefined): string {
  const id = String(item?.id || '').trim();
  const idx = id.indexOf(':');
  return idx > 0 ? id.slice(0, idx) : '';
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('file_read_failed'));
    reader.readAsDataURL(file);
  });
}

export function decodeBase64UrlToUint8Array(base64Url: string): Uint8Array {
  const normalized = String(base64Url || '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const pad = '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
  const base64 = normalized + pad;
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export function threadMessagesKey(threadId: string): string {
  return `fx:threadMessages:${threadId}`;
}

export function loadJsonFromStorage<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function loadThreadMessages(threadId: string | null): OutputItem[] {
  if (!threadId || typeof window === 'undefined') return [];
  const items = loadJsonFromStorage(threadMessagesKey(threadId), []);
  return Array.isArray(items) ? items : [];
}

export function normalizeModelOptions(models: unknown): ModelOption[] {
  const src = Array.isArray(models) ? models : [];
  const out: ModelOption[] = [];
  const seen = new Set();
  for (const item of src) {
    if (!item || typeof item !== 'object') continue;
    const record = item as { id?: unknown; name?: unknown; description?: unknown };
    const id = String(record.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: String(record.name || id),
      description: String(record.description || '')
    });
  }
  return out;
}
