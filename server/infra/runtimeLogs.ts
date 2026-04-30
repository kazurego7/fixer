export type RuntimeLogLevel = 'info' | 'error';

export interface RuntimeLogEntry {
  timestamp: string;
  level: RuntimeLogLevel;
  event: string;
  [key: string]: unknown;
}

const runtimeLogs: RuntimeLogEntry[] = [];
const MAX_RUNTIME_LOGS = 2000;

export function pushRuntimeLog(entry: { level: RuntimeLogLevel; event: string; [key: string]: unknown }): void {
  runtimeLogs.push({ timestamp: new Date().toISOString(), ...entry });
  if (runtimeLogs.length > MAX_RUNTIME_LOGS) runtimeLogs.splice(0, runtimeLogs.length - MAX_RUNTIME_LOGS);
}

export function listRuntimeLogs(options: { level?: string; limit?: number } = {}): {
  total: number;
  count: number;
  items: RuntimeLogEntry[];
} {
  const limitRaw = Number(options.limit || 200);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(1000, limitRaw)) : 200;
  const level = String(options.level || '').trim();
  const logs = level ? runtimeLogs.filter((entry) => entry.level === level) : runtimeLogs;
  const items = logs.slice(-limit);
  return { total: logs.length, count: items.length, items };
}
