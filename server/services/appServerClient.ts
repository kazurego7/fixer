import { spawn, type ChildProcess } from 'node:child_process';
import WebSocket from 'ws';
import type { RequestId } from '../../shared/types';
import { asObject, asString, type JsonRecord } from '../json';

interface RpcPendingEntry {
  resolve: (value: any) => void;
  reject: (reason?: unknown) => void;
}

interface AppServerClientOptions {
  wsUrl: string;
  startCommand: string;
  startupTimeoutMs: number;
  onMessage?: (msg: unknown) => void;
  onLog?: (entry: { level: 'info' | 'error'; event: string; [key: string]: unknown }) => void;
}

export interface AppServerClient {
  isConnected(): boolean;
  connect(): Promise<void>;
  ensureServerRunning(): Promise<void>;
  rpcRequestRaw<T = unknown>(method: string, params?: JsonRecord): Promise<T>;
  rpcRequest<T = unknown>(method: string, params?: JsonRecord): Promise<T>;
  sendClientNotification(method: string, params?: JsonRecord): void;
  sendJsonRpcResponse(id: RequestId, result: JsonRecord): void;
}

export function createAppServerClient(options: AppServerClientOptions): AppServerClient {
  let codexServerProcess: ChildProcess | null = null;
  let codexStartPromise: Promise<void> | null = null;
  let appServerWs: WebSocket | null = null;
  let wsConnectPromise: Promise<void> | null = null;
  let rpcSeq = 1;
  const rpcPending = new Map<number, RpcPendingEntry>();

  function log(entry: { level: 'info' | 'error'; event: string; [key: string]: unknown }): void {
    options.onLog?.(entry);
  }

  function isConnected(): boolean {
    return Boolean(appServerWs && appServerWs.readyState === WebSocket.OPEN);
  }

  function waitForOpen(ws: WebSocket, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws_open_timeout')), timeoutMs);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  function attachWsHandlers(ws: WebSocket): void {
    ws.on('message', (buf) => {
      let msg: unknown = null;
      try {
        msg = JSON.parse(String(buf));
      } catch {
        return;
      }
      const record = asObject(msg);
      if (!record) return;

      if (
        Object.prototype.hasOwnProperty.call(record, 'id') &&
        !Object.prototype.hasOwnProperty.call(record, 'method') &&
        typeof record.id === 'number' &&
        rpcPending.has(record.id)
      ) {
        const pending = rpcPending.get(record.id);
        rpcPending.delete(record.id);
        if (!pending) return;
        const error = asObject(record.error);
        if (error) {
          pending.reject(new Error(`app_server_error:${asString(error.code) || 'unknown'}:${asString(error.message) || 'unknown'}`));
        } else {
          pending.resolve(record.result);
        }
        return;
      }

      options.onMessage?.(record);
    });

    ws.on('close', () => {
      if (appServerWs === ws) appServerWs = null;
      for (const pending of rpcPending.values()) pending.reject(new Error('app_server_socket_closed'));
      rpcPending.clear();
    });

    ws.on('error', (error: Error) => {
      log({ level: 'error', event: 'app_server_ws_error', message: error.message });
    });
  }

  async function connect(): Promise<void> {
    if (isConnected()) return;
    if (wsConnectPromise) {
      await wsConnectPromise;
      return;
    }

    wsConnectPromise = (async () => {
      const ws = new WebSocket(options.wsUrl);
      await waitForOpen(ws, 2000);
      attachWsHandlers(ws);
      appServerWs = ws;
      await rpcRequestRaw('initialize', {
        clientInfo: { name: 'fixer-mobile-ui', version: '0.1.0' },
        capabilities: {
          experimentalApi: true
        }
      });
      sendClientNotification('initialized');
    })();

    try {
      await wsConnectPromise;
    } finally {
      wsConnectPromise = null;
    }
  }

  async function isAppServerReady(): Promise<boolean> {
    try {
      await connect();
      return true;
    } catch {
      return false;
    }
  }

  async function waitUntilAppServerReady(timeoutMs: number): Promise<boolean> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (await isAppServerReady()) return true;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return false;
  }

  async function ensureServerRunning(): Promise<void> {
    if (await isAppServerReady()) return;

    if (codexStartPromise) {
      await codexStartPromise;
      return;
    }

    codexStartPromise = (async () => {
      log({
        level: 'info',
        event: 'codex_server_autostart_begin',
        command: options.startCommand
      });

      const child = spawn('bash', ['-lc', options.startCommand], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true
      });
      codexServerProcess = child;
      child.unref();

      child.stdout?.on('data', (chunk: Buffer) => {
        log({
          level: 'info',
          event: 'codex_server_stdout',
          message: chunk.toString('utf8').slice(0, 500)
        });
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        log({
          level: 'error',
          event: 'codex_server_stderr',
          message: chunk.toString('utf8').slice(0, 500)
        });
      });
      child.on('exit', (code, signal) => {
        log({
          level: code === 0 ? 'info' : 'error',
          event: 'codex_server_exit',
          code,
          signal
        });
      });

      const ready = await waitUntilAppServerReady(options.startupTimeoutMs);
      if (!ready) throw new Error(`codex_server_start_timeout_${options.startupTimeoutMs}ms`);

      log({
        level: 'info',
        event: 'codex_server_autostart_ready',
        wsUrl: options.wsUrl
      });
    })();

    try {
      await codexStartPromise;
    } finally {
      codexStartPromise = null;
    }
  }

  function sendClientNotification(method: string, params?: JsonRecord): void {
    if (!appServerWs || appServerWs.readyState !== WebSocket.OPEN) {
      throw new Error('app_server_not_connected');
    }
    const payload: JsonRecord = { jsonrpc: '2.0', method };
    if (params && typeof params === 'object') payload.params = params;
    appServerWs.send(JSON.stringify(payload));
  }

  function sendJsonRpcResponse(id: RequestId, result: JsonRecord): void {
    if (!appServerWs || appServerWs.readyState !== WebSocket.OPEN) {
      throw new Error('app_server_not_connected');
    }
    const payload: JsonRecord = { jsonrpc: '2.0', id, result };
    appServerWs.send(JSON.stringify(payload));
  }

  function rpcRequestRaw<T = unknown>(method: string, params?: JsonRecord): Promise<T> {
    const ws = appServerWs;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('app_server_not_connected'));
    }

    const id = rpcSeq++;
    const payload = { jsonrpc: '2.0', id, method, params: params || {} };

    return new Promise<T>((resolve, reject) => {
      rpcPending.set(id, { resolve, reject });
      ws.send(JSON.stringify(payload), (err) => {
        if (err) {
          rpcPending.delete(id);
          reject(err);
        }
      });
    });
  }

  async function rpcRequest<T = unknown>(method: string, params?: JsonRecord): Promise<T> {
    await ensureServerRunning();
    await connect();
    return rpcRequestRaw<T>(method, params);
  }

  return {
    isConnected,
    connect,
    ensureServerRunning,
    rpcRequestRaw,
    rpcRequest,
    sendClientNotification,
    sendJsonRpcResponse
  };
}
