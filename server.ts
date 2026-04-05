import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from 'node:child_process';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest
} from 'fastify';
import fastifyStatic from '@fastify/static';
import WebSocket from 'ws';
import webPush, { type PushSubscription } from 'web-push';
import { extractDisplayReasoningText } from './shared/reasoning';
import type {
  CloneState,
  CollaborationMode,
  CollaborationModeOverride,
  GitRepoStatus,
  ModelOption,
  OutputItem,
  ParsedLegacyTurnNotification,
  ParsedV2TurnNotification,
  PendingUserInputRequest,
  RepoFileChangeKind,
  RepoFileListItem,
  RepoFileListResponse,
  RepoFileTreeItem,
  RepoFileTreeResponse,
  RepoFileViewResponse,
  RepoSummary,
  RequestId,
  SelectTurnStreamState,
  SelectTurnStreamUpdateResult,
  TurnStartOverrides,
  TurnStreamEvent,
  TurnTerminalNotification,
  UserInputAnswerMap,
  UserInputQuestion
} from './shared/types';

declare module 'fastify' {
  interface FastifyRequest {
    startTime?: bigint;
  }
}

type JsonRecord = Record<string, unknown>;
type RuntimeLogLevel = 'info' | 'error';

interface RuntimeLogEntry {
  timestamp: string;
  level: RuntimeLogLevel;
  event: string;
  [key: string]: unknown;
}

interface PushSubscriptionRecord {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  currentThreadId: string | null;
  userAgent: string;
  updatedAt: string;
}

interface CloneJobState {
  status: CloneState['status'];
  error?: string;
}

interface RpcPendingEntry {
  resolve: (value: any) => void;
  reject: (reason?: unknown) => void;
}

interface StartTurnRetryPayload {
  attempt: number;
  message: string;
}

interface TurnInputTextItem {
  type: 'text';
  text: string;
}

interface TurnInputImageItem {
  type: 'image';
  url: string;
}

type TurnInputItem = TurnInputTextItem | TurnInputImageItem;

interface ThreadMessageContentPart {
  type?: string;
  text?: string;
  url?: string;
}

interface ThreadMessageTurnItem {
  id?: string;
  type?: string;
  text?: string;
  phase?: string | null;
  summary?: string[];
  content?: ThreadMessageContentPart[];
}

interface ThreadMessageTurn {
  id?: string;
  input?: Array<{ type?: string; text?: string }>;
  items?: ThreadMessageTurnItem[];
  status?: string;
}

interface ThreadMessageReadResult {
  thread?: {
    model?: string;
    turns?: ThreadMessageTurn[];
  };
}

interface LiveTurnState {
  threadId: string;
  turnId: string;
  items: ThreadMessageTurnItem[];
  itemOrder: string[];
  latestSeq: number;
  renderItems: OutputItem[];
  liveReasoningRaw: string;
  liveReasoningText: string;
  buffer: Array<{ seq: number; event: TurnStreamEvent }>;
}

interface GithubUserResponse {
  login?: string;
}

interface GithubRepoApiItem {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  clone_url: string;
  default_branch: string;
  updated_at: string;
}

function getErrorMessage(error: unknown, fallback = 'unknown_error'): string {
  if (error instanceof Error && error.message) return error.message;
  const record = asObject(error);
  const message = asString(record?.message);
  return message || fallback;
}

function getErrorCode(error: unknown): string | null {
  if (error instanceof Error && typeof (error as Error & { code?: unknown }).code === 'string') {
    return (error as Error & { code?: string }).code || null;
  }
  const record = asObject(error);
  return asString(record?.code);
}

const PORT = Number(process.env.PORT || 3000);
const CODEX_APP_SERVER_WS_URL = 'ws://127.0.0.1:39080';
const CODEX_APP_SERVER_START_CMD = `codex app-server --listen ${CODEX_APP_SERVER_WS_URL}`;
const CODEX_APP_SERVER_STARTUP_TIMEOUT_MS = 15000;

function resolveWorkspaceRoot(): string {
  const preferred = path.join(os.homedir(), '.fixer', 'workspace');
  if (!fs.existsSync(preferred)) {
    try {
      fs.mkdirSync(preferred, { recursive: true });
      return preferred;
    } catch {
      const fallback = path.join(process.cwd(), 'workspace');
      fs.mkdirSync(fallback, { recursive: true });
      return fallback;
    }
  }
  return preferred;
}

const WORKSPACE_ROOT = resolveWorkspaceRoot();
const PUSH_SUBSCRIPTIONS_PATH = path.join(WORKSPACE_ROOT, 'push-subscriptions.json');
const PUSH_VAPID_PATH = path.join(WORKSPACE_ROOT, 'push-vapid.json');
const DEFAULT_PUSH_SUBJECT = 'mailto:fixer@example.com';
const cloneJobs = new Map<string, CloneJobState>();
const runtimeLogs: RuntimeLogEntry[] = [];
const MAX_RUNTIME_LOGS = 2000;
const runningTurnByThreadId = new Map<string, string>();
const threadModelByThreadId = new Map<string, string>();
const pendingUserInputRequestById = new Map<string, PendingUserInputRequest & { createdAt: string }>();
const handledTerminalTurnKeys = new Set<string>();
const handledPushTurnKeys = new Set<string>();
const liveTurnStateByThreadId = new Map<string, LiveTurnState>();
let liveTurnSeq = 1;
const DEFAULT_MODEL_FALLBACK = 'gpt-5-codex';
const DEFAULT_REASONING_SUMMARY = 'concise';

let codexServerProcess: ChildProcess | null = null;
let codexStartPromise: Promise<void> | null = null;
let appServerWs: WebSocket | null = null;
let wsConnectPromise: Promise<void> | null = null;
let rpcSeq = 1;
const rpcPending = new Map<number, RpcPendingEntry>();
const wsSubscribers = new Set<(msg: unknown) => void>();
const liveTurnSubscribers = new Set<
  (payload: { threadId: string; turnId: string; seq: number; event: TurnStreamEvent }) => void
>();
let pushSubscriptions: PushSubscriptionRecord[] = [];
let pushPublicKey = '';
let pushPrivateKey = '';
let pushEnabled = false;

function pushRuntimeLog(entry: { level: RuntimeLogLevel; event: string; [key: string]: unknown }): void {
  runtimeLogs.push({ timestamp: new Date().toISOString(), ...entry });
  if (runtimeLogs.length > MAX_RUNTIME_LOGS) runtimeLogs.shift();
}

function rememberBounded(set: Set<string>, key: string | null | undefined, max = 5000): void {
  if (!key) return;
  set.add(key);
  if (set.size <= max) return;
  const first = set.values().next().value;
  if (first !== undefined) set.delete(first);
}

function loadPushSubscriptions(): PushSubscriptionRecord[] {
  try {
    if (!fs.existsSync(PUSH_SUBSCRIPTIONS_PATH)) return [];
    const raw = fs.readFileSync(PUSH_SUBSCRIPTIONS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item) =>
        item &&
        typeof item === 'object' &&
        typeof item.endpoint === 'string' &&
        item.endpoint &&
        item.keys &&
        typeof item.keys.p256dh === 'string' &&
        typeof item.keys.auth === 'string'
    );
  } catch {
    return [];
  }
}

function savePushSubscriptions(): void {
  const tmp = `${PUSH_SUBSCRIPTIONS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(pushSubscriptions, null, 2));
  fs.renameSync(tmp, PUSH_SUBSCRIPTIONS_PATH);
}

function loadOrCreateVapidKeys(): { publicKey: string; privateKey: string } {
  try {
    if (fs.existsSync(PUSH_VAPID_PATH)) {
      const raw = fs.readFileSync(PUSH_VAPID_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof parsed.publicKey === 'string' &&
        typeof parsed.privateKey === 'string' &&
        parsed.publicKey &&
        parsed.privateKey
      ) {
        return {
          publicKey: parsed.publicKey,
          privateKey: parsed.privateKey
        };
      }
    }
  } catch {
    // 読み込み失敗時は再生成する。
  }

  const generated = webPush.generateVAPIDKeys();
  const payload = {
    publicKey: String(generated.publicKey),
    privateKey: String(generated.privateKey),
    createdAt: new Date().toISOString()
  };
  const tmp = `${PUSH_VAPID_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, PUSH_VAPID_PATH);
  return {
    publicKey: payload.publicKey,
    privateKey: payload.privateKey
  };
}

function upsertPushSubscription({
  endpoint,
  keys,
  currentThreadId = null,
  userAgent = ''
}: {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  currentThreadId?: string | null;
  userAgent?: string;
}): PushSubscriptionRecord {
  const now = new Date().toISOString();
  const record = {
    endpoint,
    keys: {
      p256dh: String(keys.p256dh),
      auth: String(keys.auth)
    },
    currentThreadId: currentThreadId ? String(currentThreadId) : null,
    userAgent: String(userAgent || ''),
    updatedAt: now
  };
  const idx = pushSubscriptions.findIndex((item) => item.endpoint === endpoint);
  if (idx >= 0) pushSubscriptions[idx] = { ...pushSubscriptions[idx], ...record };
  else pushSubscriptions.push(record);
  savePushSubscriptions();
  return record;
}

function removePushSubscription(endpoint: string): boolean {
  const before = pushSubscriptions.length;
  pushSubscriptions = pushSubscriptions.filter((item) => item.endpoint !== endpoint);
  if (pushSubscriptions.length !== before) savePushSubscriptions();
  return before !== pushSubscriptions.length;
}

function setPushContext(endpoint: string, currentThreadId: string | null = null): PushSubscriptionRecord | null {
  const idx = pushSubscriptions.findIndex((item) => item.endpoint === endpoint);
  if (idx < 0) return null;
  const current = pushSubscriptions[idx];
  if (!current) return null;
  pushSubscriptions[idx] = {
    ...current,
    currentThreadId: currentThreadId ? String(currentThreadId) : null,
    updatedAt: new Date().toISOString()
  };
  savePushSubscriptions();
  return pushSubscriptions[idx];
}

async function notifyPushSubscribersForThread(
  threadId: string
): Promise<{ sent: number; staleRemoved: number; skipped?: string }> {
  if (!pushEnabled) return { sent: 0, staleRemoved: 0, skipped: 'push_not_configured' };
  const targets = pushSubscriptions.filter((sub) => sub.currentThreadId === threadId);
  if (targets.length === 0) return { sent: 0, staleRemoved: 0 };

  const payload = JSON.stringify({
    title: 'Fixer',
    body: '返答が完了しました',
    threadId,
    url: '/chat/'
  });

  let sent = 0;
  let staleRemoved = 0;

  for (const sub of targets) {
    try {
      await webPush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.keys.p256dh,
            auth: sub.keys.auth
          }
        },
        payload,
        { TTL: 60 }
      );
      sent += 1;
    } catch (error) {
      const errorRecord = asObject(error);
      const statusCode = Number(errorRecord?.statusCode || 0);
      if (statusCode === 404 || statusCode === 410) {
        if (removePushSubscription(sub.endpoint)) staleRemoved += 1;
      }
      pushRuntimeLog({
        level: 'error',
        event: 'push_send_failed',
        threadId,
        endpoint: sub.endpoint,
        statusCode: statusCode || null,
        message: getErrorMessage(error)
      });
    }
  }

  return { sent, staleRemoved };
}

function addWsSubscriber(handler: (msg: unknown) => void): () => boolean {
  wsSubscribers.add(handler);
  return () => wsSubscribers.delete(handler);
}

function addLiveTurnSubscriber(
  handler: (payload: { threadId: string; turnId: string; seq: number; event: TurnStreamEvent }) => void
): () => boolean {
  liveTurnSubscribers.add(handler);
  return () => liveTurnSubscribers.delete(handler);
}

function nextLiveTurnSeq(): number {
  const seq = liveTurnSeq;
  liveTurnSeq += 1;
  return seq;
}

function trimLiveTurnBuffer(state: LiveTurnState, max = 300): void {
  if (state.buffer.length <= max) return;
  state.buffer.splice(0, state.buffer.length - max);
}

function toThreadMessageTurnItem(item: unknown): ThreadMessageTurnItem | null {
  const record = asObject(item);
  if (!record) return null;
  const type = asString(record.type);
  const id = asString(record.id);
  if (!type || !id) return null;
  const normalized: ThreadMessageTurnItem = {
    id,
    type
  };
  if (typeof record.text === 'string') normalized.text = record.text;
  if (typeof record.phase === 'string') normalized.phase = record.phase;
  if (Array.isArray(record.summary)) normalized.summary = record.summary.map((part) => String(part || ''));
  if (Array.isArray(record.content)) {
    normalized.content = record.content
      .filter((part) => part && typeof part === 'object')
      .map((part) => {
        const contentPart = asObject(part) || {};
        return {
          type: asString(contentPart.type) || undefined,
          text: asString(contentPart.text) || undefined,
          url: asString(contentPart.url) || asString((contentPart as JsonRecord).image_url) || undefined
        };
      });
  }
  return normalized;
}

function ensureLiveTurnState(threadId: string, turnId: string): LiveTurnState {
  const existing = liveTurnStateByThreadId.get(threadId);
  if (existing && existing.turnId === turnId) return existing;
  const created: LiveTurnState = {
    threadId,
    turnId,
    items: [],
    itemOrder: [],
    latestSeq: 0,
    renderItems: [],
    liveReasoningRaw: '',
    liveReasoningText: '',
    buffer: []
  };
  liveTurnStateByThreadId.set(threadId, created);
  return created;
}

function findLiveTurnItem(state: LiveTurnState, itemId: string): ThreadMessageTurnItem | null {
  const idx = state.itemOrder.indexOf(itemId);
  if (idx < 0) return null;
  return state.items[idx] || null;
}

function upsertLiveTurnItem(state: LiveTurnState, item: ThreadMessageTurnItem): ThreadMessageTurnItem {
  const itemId = asString(item.id);
  if (!itemId) return item;
  const idx = state.itemOrder.indexOf(itemId);
  const cloned = {
    ...item,
    summary: Array.isArray(item.summary) ? [...item.summary] : item.summary,
    content: Array.isArray(item.content) ? item.content.map((part) => ({ ...part })) : item.content
  };
  if (idx >= 0) {
    state.items[idx] = cloned;
    return state.items[idx] as ThreadMessageTurnItem;
  }
  state.itemOrder.push(itemId);
  state.items.push(cloned);
  return state.items[state.items.length - 1] as ThreadMessageTurnItem;
}

function ensureLiveTurnItemByType(state: LiveTurnState, itemId: string, type: string): ThreadMessageTurnItem {
  const found = findLiveTurnItem(state, itemId);
  if (found) return found;
  const created: ThreadMessageTurnItem = { id: itemId, type };
  if (type === 'reasoning') {
    created.summary = [];
    created.content = [];
  }
  if (type === 'agentMessage' || type === 'plan') {
    created.text = '';
  }
  return upsertLiveTurnItem(state, created);
}

function appendLiveTurnBoundary(state: LiveTurnState, boundaryId: string): void {
  if (!boundaryId) return;
  const last = state.items[state.items.length - 1];
  if (last?.id === boundaryId) return;
  state.itemOrder.push(boundaryId);
  state.items.push({ id: boundaryId, type: 'request_user_input' });
}

function extractReasoningRawFromItem(item: ThreadMessageTurnItem | null): string {
  if (!item || item.type !== 'reasoning') return '';
  const summaryText = Array.isArray(item.summary) ? item.summary.join('\n').trim() : '';
  if (summaryText) return summaryText;
  const contentText = Array.isArray(item.content)
    ? item.content
        .map((part) => String(part?.text || ''))
        .filter(Boolean)
        .join('\n')
        .trim()
    : '';
  return contentText;
}

function rebuildLiveTurnStateRender(state: LiveTurnState): void {
  const turn: ThreadMessageTurn = {
    id: state.turnId,
    input: [],
    items: state.items.map((item) => ({
      id: item.id,
      type: item.type,
      text: item.text,
      phase: item.phase ?? null,
      summary: Array.isArray(item.summary) ? [...item.summary] : undefined,
      content: Array.isArray(item.content)
        ? item.content.map((part) => ({ type: part.type, text: part.text, url: part.url }))
        : undefined
      }))
  };
  state.renderItems = normalizeTurnMessages(turn);
  state.liveReasoningText = extractDisplayReasoningText(state.liveReasoningRaw);
}

function emitLiveTurnEvent(state: LiveTurnState, event: TurnStreamEvent): number {
  const seq = nextLiveTurnSeq();
  state.latestSeq = seq;
  const normalizedEvent =
    event.type === 'turn_state'
      ? {
          ...event,
          seq
        }
      : event;
  state.buffer.push({ seq, event: normalizedEvent });
  trimLiveTurnBuffer(state);
  for (const subscriber of liveTurnSubscribers) {
    subscriber({
      threadId: state.threadId,
      turnId: state.turnId,
      seq,
      event: normalizedEvent
    });
  }
  return seq;
}

function emitLiveTurnStateSnapshot(state: LiveTurnState): void {
  rebuildLiveTurnStateRender(state);
  emitLiveTurnEvent(state, {
    type: 'turn_state',
    seq: state.latestSeq,
    turnId: state.turnId,
    items: state.renderItems,
    liveReasoningText: state.liveReasoningText
  });
}

function parseV2ItemLifecycleNotification(
  msg: unknown
): { method: 'item/started' | 'item/completed'; threadId: string; turnId: string; item: ThreadMessageTurnItem } | null {
  const record = asObject(msg);
  if (!record) return null;
  const method = asString(record.method);
  if (method !== 'item/started' && method !== 'item/completed') return null;
  const params = asObject(record.params);
  const threadId = asString(params?.threadId);
  const turnId = asString(params?.turnId);
  const item = toThreadMessageTurnItem(params?.item);
  if (!threadId || !turnId || !item) return null;
  return { method, threadId, turnId, item };
}

function parseV2RetryableErrorNotification(
  msg: unknown
): { threadId: string; turnId: string; message: string } | null {
  const parsed = parseV2TurnNotification(msg);
  if (!parsed || parsed.method !== 'error' || !parsed.willRetry || !parsed.threadId || !parsed.turnId) return null;
  return {
    threadId: parsed.threadId,
    turnId: parsed.turnId,
    message: parsed.errorMessage || 'reconnecting'
  };
}

function parseTurnPlanUpdateNotification(
  msg: unknown
): { threadId: string; turnId: string; itemId: string; text: string } | null {
  const record = asObject(msg);
  if (!record || asString(record.method) !== 'turn/plan/updated') return null;
  const params = asObject(record.params);
  const threadId = asString(params?.threadId);
  const turnId = asString(params?.turnId);
  if (!threadId || !turnId) return null;
  const itemId = asString(params?.itemId) || `plan:${turnId}`;
  return {
    threadId,
    turnId,
    itemId,
    text: buildTurnPlanText(params?.explanation, params?.plan)
  };
}

function hydrateLiveTurnStateFromTurn(turnId: string, threadId: string, turn: ThreadMessageTurn | null | undefined): LiveTurnState {
  const state = ensureLiveTurnState(threadId, turnId);
  state.items = [];
  state.itemOrder = [];
  state.buffer = [];
  state.latestSeq = 0;
  state.liveReasoningRaw = '';
  const items = Array.isArray(turn?.items) ? turn.items : [];
  for (const rawItem of items) {
    const normalized = toThreadMessageTurnItem(rawItem);
    if (!normalized) continue;
    upsertLiveTurnItem(state, normalized);
    const reasoningRaw = extractReasoningRawFromItem(normalized);
    if (reasoningRaw) state.liveReasoningRaw = reasoningRaw;
  }
  rebuildLiveTurnStateRender(state);
  return state;
}

async function ensureLiveTurnStateSnapshot(threadId: string, turnId: string): Promise<LiveTurnState | null> {
  const existing = liveTurnStateByThreadId.get(threadId);
  if (existing && existing.turnId === turnId) return existing;
  try {
    await rpcRequest('thread/resume', { threadId });
    const read = await rpcRequest<ThreadMessageReadResult>('thread/read', { threadId, includeTurns: true });
    const turns = Array.isArray(read?.thread?.turns) ? read.thread.turns : [];
    const turn = turns.find((entry) => entry?.id === turnId) || null;
    if (!turn) return null;
    return hydrateLiveTurnStateFromTurn(turnId, threadId, turn);
  } catch {
    return null;
  }
}

function buildCurrentTurnStateEvent(state: LiveTurnState): TurnStreamEvent {
  return {
    type: 'turn_state',
    seq: state.latestSeq,
    turnId: state.turnId,
    items: state.renderItems,
    liveReasoningText: state.liveReasoningText
  };
}

function replayLiveTurnEvents(
  state: LiveTurnState,
  afterSeq: number,
  writeEvent: (event: TurnStreamEvent) => void
): number {
  let lastSentSeq = afterSeq;
  const buffered = state.buffer.filter((entry) => entry.seq > afterSeq);
  if (buffered.length === 0) {
    if (state.latestSeq > afterSeq) {
      writeEvent(buildCurrentTurnStateEvent(state));
      return state.latestSeq;
    }
    return lastSentSeq;
  }
  for (const entry of buffered) {
    writeEvent(entry.event);
    lastSentSeq = entry.seq;
  }
  return lastSentSeq;
}

function applyLiveTurnNotification(msg: unknown): void {
  const lifecycle = parseV2ItemLifecycleNotification(msg);
  if (lifecycle) {
    const state = ensureLiveTurnState(lifecycle.threadId, lifecycle.turnId);
    upsertLiveTurnItem(state, lifecycle.item);
    const reasoningRaw = extractReasoningRawFromItem(lifecycle.item);
    if (reasoningRaw) state.liveReasoningRaw = reasoningRaw;
    emitLiveTurnStateSnapshot(state);
    return;
  }

  const planUpdate = parseTurnPlanUpdateNotification(msg);
  if (planUpdate) {
    const state = ensureLiveTurnState(planUpdate.threadId, planUpdate.turnId);
    const planItem = ensureLiveTurnItemByType(state, planUpdate.itemId, 'plan');
    planItem.text = planUpdate.text;
    emitLiveTurnStateSnapshot(state);
    return;
  }

  const request = parseToolRequestUserInput(msg);
  if (request) {
    const state = ensureLiveTurnState(request.threadId, request.turnId);
    appendLiveTurnBoundary(state, `request_user_input:${String(request.requestId)}`);
    emitLiveTurnStateSnapshot(state);
    emitLiveTurnEvent(state, {
      type: 'request_user_input',
      requestId: request.requestId,
      turnId: request.turnId,
      itemId: request.itemId,
      questions: request.questions
    });
    return;
  }

  const v2 = parseV2TurnNotification(msg);
  if (v2?.threadId && v2.turnId) {
    const state = ensureLiveTurnState(v2.threadId, v2.turnId);
    if (v2.method === 'item/agentMessage/delta' && v2.itemId && v2.delta) {
      const item = ensureLiveTurnItemByType(state, v2.itemId, 'agentMessage');
      item.text = `${String(item.text || '')}${v2.delta}`;
      emitLiveTurnStateSnapshot(state);
      return;
    }
    if (v2.method === 'item/plan/delta' && v2.itemId && v2.delta) {
      const item = ensureLiveTurnItemByType(state, v2.itemId, 'plan');
      item.text = `${String(item.text || '')}${v2.delta}`;
      emitLiveTurnStateSnapshot(state);
      return;
    }
    if (
      (v2.method === 'item/reasoning/summaryTextDelta' || v2.method === 'item/reasoning/textDelta') &&
      v2.itemId &&
      v2.delta
    ) {
      const item = ensureLiveTurnItemByType(state, v2.itemId, 'reasoning');
      if (v2.method === 'item/reasoning/summaryTextDelta') {
        const summary = Array.isArray(item.summary) ? item.summary : [];
        if (summary.length === 0) summary.push('');
        summary[summary.length - 1] = `${String(summary[summary.length - 1] || '')}${v2.delta}`;
        item.summary = summary;
      } else {
        const content = Array.isArray(item.content) ? item.content : [];
        if (content.length === 0) content.push({ type: 'text', text: '' });
        const last = content[content.length - 1] || { type: 'text', text: '' };
        last.text = `${String(last.text || '')}${v2.delta}`;
        content[content.length - 1] = last;
        item.content = content;
      }
      state.liveReasoningRaw = `${state.liveReasoningRaw}${v2.delta}`;
      emitLiveTurnStateSnapshot(state);
      return;
    }
  }

  const retryableError = parseV2RetryableErrorNotification(msg);
  if (retryableError) {
    const state = ensureLiveTurnState(retryableError.threadId, retryableError.turnId);
    emitLiveTurnEvent(state, {
      type: 'status',
      phase: 'reconnecting',
      message: retryableError.message
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

    const terminal = parseTurnTerminalNotification(record);
    if (terminal) handleTurnTerminalNotification(terminal);
    const userInputRequest = parseToolRequestUserInput(record);
    if (userInputRequest) rememberPendingUserInputRequest(userInputRequest);
    applyLiveTurnNotification(record);

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

    for (const cb of wsSubscribers) cb(record);
  });

  ws.on('close', () => {
    if (appServerWs === ws) appServerWs = null;
    for (const pending of rpcPending.values()) pending.reject(new Error('app_server_socket_closed'));
    rpcPending.clear();
  });

  ws.on('error', (error: Error) => {
    pushRuntimeLog({ level: 'error', event: 'app_server_ws_error', message: error.message });
  });
}

async function connectWs(): Promise<void> {
  if (appServerWs && appServerWs.readyState === WebSocket.OPEN) return;
  if (wsConnectPromise) {
    await wsConnectPromise;
    return;
  }

  wsConnectPromise = (async () => {
    const ws = new WebSocket(CODEX_APP_SERVER_WS_URL);
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

function sendClientNotification(method: string, params?: JsonRecord): void {
  if (!appServerWs || appServerWs.readyState !== WebSocket.OPEN) {
    throw new Error('app_server_not_connected');
  }
  const payload: JsonRecord = { jsonrpc: '2.0', method };
  if (params && typeof params === 'object') payload.params = params;
  appServerWs.send(JSON.stringify(payload));
}

async function rpcRequest<T = unknown>(method: string, params?: JsonRecord): Promise<T> {
  await ensureCodexServerRunning();
  await connectWs();
  return rpcRequestRaw<T>(method, params);
}

function buildTurnInput(prompt: string, attachments: Array<{ type?: string; dataUrl?: string }> | null | undefined): TurnInputItem[] {
  const input: TurnInputItem[] = [{ type: 'text', text: String(prompt || '') }];
  const list = Array.isArray(attachments) ? attachments : [];
  for (const att of list) {
    if (!att || att.type !== 'image' || !att.dataUrl) continue;
    input.push({ type: 'image', url: String(att.dataUrl) });
  }
  return input;
}

function normalizeModelId(value: unknown): string {
  const model = String(value || '').trim();
  return model || '';
}

function normalizeModelListResponse(payload: JsonRecord | null | undefined): ModelOption[] {
  const src = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : [];
  const out = [];
  const seen = new Set();
  for (const item of src) {
    if (!item || typeof item !== 'object') continue;
    const id = normalizeModelId(item.id || item.model || item.name);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: String(item.name || item.display_name || id),
      description: String(item.description || item.summary || '')
    });
  }
  return out;
}

function normalizeCollaborationMode(value: unknown): CollaborationMode | null {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  if (normalized === 'plan') return 'plan';
  if (normalized === 'default' || normalized === 'normal') return 'default';
  return null;
}

function buildCollaborationMode(mode: CollaborationMode, model: string): CollaborationModeOverride {
  return {
    mode,
    settings: {
      model: String(model || DEFAULT_MODEL_FALLBACK),
      reasoning_effort: null,
      developer_instructions: null
    }
  };
}

async function buildTurnStartOverrides(
  threadId: string,
  options: { selectedModel?: string; collaborationMode?: CollaborationMode | null } = {}
): Promise<TurnStartOverrides> {
  const selectedModel = normalizeModelId(options.selectedModel);
  const collaborationMode = normalizeCollaborationMode(options.collaborationMode);
  const overrides: TurnStartOverrides = {
    summary: DEFAULT_REASONING_SUMMARY
  };

  if (selectedModel) {
    overrides.model = selectedModel;
  }

  if (collaborationMode) {
    const effectiveModel = selectedModel || (await resolveThreadModel(threadId));
    overrides.collaborationMode = buildCollaborationMode(collaborationMode, effectiveModel);
  }

  return overrides;
}

async function resolveThreadModel(threadId: string): Promise<string> {
  const cached = threadModelByThreadId.get(threadId);
  if (cached) return cached;

  try {
    const read = await rpcRequest<ThreadMessageReadResult>('thread/read', { threadId, includeTurns: false });
    const model = typeof read?.thread?.model === 'string' ? read.thread.model : '';
    if (model) {
      threadModelByThreadId.set(threadId, model);
      return model;
    }
  } catch {
    // 取得に失敗した場合は次のフォールバックを試す。
  }

  try {
    const config = await rpcRequest<{ config?: { model?: string } }>('config/read', { includeLayers: false });
    const model = typeof config?.config?.model === 'string' ? config.config.model : '';
    if (model) return model;
  } catch {
    // 設定読取に失敗した場合は固定モデルにフォールバックする。
  }

  return DEFAULT_MODEL_FALLBACK;
}

function isThreadMissingError(error: unknown): boolean {
  const message = getErrorMessage(error, '');
  return message.includes('thread not found') || message.includes('thread_not_found') || message.includes('no rollout found for thread id');
}

function isThreadWarmupError(error: unknown): boolean {
  const message = getErrorMessage(error, '');
  return message.includes('no rollout found for thread id') || message.includes('thread_not_found') || message.includes('thread not found');
}

async function startTurnWithRetry(
  threadId: string,
  input: TurnInputItem[],
  maxAttempts = 20,
  onRetry: ((payload: StartTurnRetryPayload) => void) | null = null,
  overrides: TurnStartOverrides | null = null
): Promise<string> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const turnStartParams: JsonRecord = {
        threadId,
        input,
        ...(overrides && typeof overrides === 'object' ? overrides : {})
      };
      const turnStart = await rpcRequest<{ turn?: { id?: string } }>('turn/start', turnStartParams);
      const turnId = turnStart?.turn?.id;
      if (!turnId) throw new Error('turn_id_missing');
      if (attempt > 1) {
        pushRuntimeLog({
          level: 'info',
          event: 'turn_start_recovered',
          threadId,
          attempt
        });
      }
      return turnId;
    } catch (error) {
      lastError = error;
      if (!isThreadWarmupError(error) || attempt === maxAttempts) throw error;
      if (typeof onRetry === 'function') {
        onRetry({
          attempt,
          message: getErrorMessage(error)
        });
      }
      pushRuntimeLog({
        level: 'info',
        event: 'turn_start_retry',
        threadId,
        attempt,
        message: getErrorMessage(error)
      });
      await sleep(Math.min(700, 100 + attempt * 60));
    }
  }
  throw lastError || new Error('turn_start_failed');
}

function looksLikeDiff(text: string): boolean {
  return /^diff --git/m.test(text) || /^@@/m.test(text) || /^\+\+\+/m.test(text);
}

function asObject(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asRequestId(value: unknown): RequestId | null {
  if (typeof value === 'string' && value) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

function parseUserInputQuestions(rawQuestions: unknown): UserInputQuestion[] {
  const list = Array.isArray(rawQuestions) ? rawQuestions : [];
  const out: UserInputQuestion[] = [];
  for (const question of list) {
    const id = asString(question?.id);
    if (!id) continue;
    const header = asString(question?.header) || '';
    const text = asString(question?.question) || '';
    const optionsRaw = Array.isArray(question?.options) ? question.options : [];
    const options = [];
    for (const opt of optionsRaw) {
      const label = asString(opt?.label);
      if (!label) continue;
      options.push({
        label,
        description: asString(opt?.description) || ''
      });
    }
    out.push({
      id,
      header,
      question: text,
      isOther: Boolean(question?.isOther),
      isSecret: Boolean(question?.isSecret),
      options
    });
  }
  return out;
}

function parseToolRequestUserInput(msg: unknown): PendingUserInputRequest | null {
  const record = asObject(msg);
  if (!record) return null;
  const method = asString(record.method);
  if (method !== 'item/tool/requestUserInput') return null;
  const requestId = asRequestId(record.id);
  const params = asObject(record.params);
  if (!requestId || !params) return null;
  const threadId = asString(params.threadId);
  const turnId = asString(params.turnId);
  const itemId = asString(params.itemId);
  if (!threadId || !turnId || !itemId) return null;
  const questions = parseUserInputQuestions(params.questions);
  if (questions.length === 0) return null;
  return {
    requestId,
    threadId,
    turnId,
    itemId,
    questions
  };
}

function rememberPendingUserInputRequest(request: PendingUserInputRequest): void {
  if (!request?.requestId) return;
  pendingUserInputRequestById.set(String(request.requestId), {
    ...request,
    createdAt: new Date().toISOString()
  });
  pushRuntimeLog({
    level: 'info',
    event: 'request_user_input_received',
    threadId: request.threadId,
    turnId: request.turnId,
    itemId: request.itemId,
    requestId: request.requestId,
    questionsCount: request.questions.length
  });
}

function clearPendingUserInputForThread(threadId: string | null | undefined): void {
  if (!threadId) return;
  for (const [key, request] of pendingUserInputRequestById.entries()) {
    if (request?.threadId === threadId) pendingUserInputRequestById.delete(key);
  }
}

function sendJsonRpcResponse(id: RequestId, result: JsonRecord): void {
  if (!appServerWs || appServerWs.readyState !== WebSocket.OPEN) {
    throw new Error('app_server_not_connected');
  }
  const payload: JsonRecord = { jsonrpc: '2.0', id, result };
  appServerWs.send(JSON.stringify(payload));
}

function buildToolUserInputResponsePayload(answersMap: unknown): { answers: UserInputAnswerMap } {
  const src = answersMap && typeof answersMap === 'object' ? (answersMap as Record<string, unknown>) : {};
  const answers: UserInputAnswerMap = {};
  for (const [questionId, answerValue] of Object.entries(src)) {
    if (!questionId) continue;
    if (Array.isArray(answerValue)) {
      const list = answerValue.map((v) => String(v || '').trim()).filter(Boolean);
      if (list.length > 0) answers[questionId] = { answers: list };
      continue;
    }
    const answerRecord = asObject(answerValue);
    if (answerRecord && Array.isArray(answerRecord.answers)) {
      const list = answerRecord.answers.map((v: unknown) => String(v || '').trim()).filter(Boolean);
      if (list.length > 0) answers[questionId] = { answers: list };
      continue;
    }
    const single = String(answerValue || '').trim();
    if (single) answers[questionId] = { answers: [single] };
  }
  return { answers };
}

function parseV2TurnNotification(msg: unknown): ParsedV2TurnNotification | null {
  const record = asObject(msg);
  if (!record) return null;
  const method = asString(record.method);
  if (!method || method.startsWith('codex/event/')) return null;
  const params = asObject(record.params);
  if (!params) return null;
  const turnObj = asObject(params.turn);
  const errorObj = asObject(params.error);
  const turnErrorObj = asObject(turnObj?.error);
  return {
    protocol: 'v2',
    method,
    threadId: asString(params.threadId),
    turnId: asString(params.turnId) || asString(turnObj?.id),
    itemId: asString(params.itemId) || asString(asObject(params.item)?.id),
    delta: asString(params.delta),
    status: asString(turnObj?.status),
    errorMessage: asString(turnErrorObj?.message) || asString(errorObj?.message),
    willRetry: Boolean(params.willRetry)
  };
}

function parseLegacyTurnNotification(msg: unknown): ParsedLegacyTurnNotification | null {
  const record = asObject(msg);
  if (!record) return null;
  const method = asString(record.method);
  if (!method || !method.startsWith('codex/event/')) return null;
  const params = asObject(record.params);
  if (!params) return null;
  const event = asObject(params.msg) || {};
  const type =
    asString(event.type) ||
    method
      .slice('codex/event/'.length)
      .replace(/\//g, '_')
      .trim();
  return {
    protocol: 'legacy',
    method,
    type,
    threadId: asString(params.conversationId) || asString(params.threadId),
    turnId: asString(event.turn_id) || asString(event.turnId) || asString(params.turnId),
    delta: asString(event.delta),
    message: asString(event.message),
    reason: asString(event.reason)
  };
}

function isCompletedStatus(status: unknown): boolean {
  return String(status || '').toLowerCase() === 'completed';
}

function isErrorStatus(status: unknown): boolean {
  const normalized = String(status || '').toLowerCase();
  return normalized === 'failed' || normalized === 'interrupted' || normalized === 'cancelled';
}

function buildTurnPlanText(rawExplanation: unknown, rawPlan: unknown): string {
  const explanation = asString(rawExplanation) || '';
  const plan = Array.isArray(rawPlan) ? rawPlan : [];
  const lines = [];
  if (explanation.trim()) lines.push(explanation.trim());
  for (const step of plan) {
    const text = asString(step?.step);
    if (!text) continue;
    const status = String(step?.status || '').toLowerCase();
    let marker = '[ ]';
    if (status === 'completed') marker = '[x]';
    else if (status === 'inprogress') marker = '[-]';
    lines.push(`${marker} ${text}`);
  }
  return lines.join('\n').trim();
}

function parseTurnTerminalNotification(msg: unknown): TurnTerminalNotification | null {
  const v2 = parseV2TurnNotification(msg);
  if (v2?.threadId) {
    if (v2.method === 'turn/completed') {
      const normalized = String(v2.status || '').toLowerCase();
      if (normalized === 'completed' || (!normalized && !v2.errorMessage)) {
        return { threadId: v2.threadId, turnId: v2.turnId || null, kind: 'done', message: null };
      }
      return {
        threadId: v2.threadId,
        turnId: v2.turnId || null,
        kind: 'error',
        message: v2.errorMessage || `turn_${normalized || 'failed'}`
      };
    }
    if (v2.method === 'error' && !v2.willRetry) {
      return {
        threadId: v2.threadId,
        turnId: v2.turnId || null,
        kind: 'error',
        message: v2.errorMessage || 'turn_failed'
      };
    }
  }

  const legacy = parseLegacyTurnNotification(msg);
  if (!legacy?.threadId) return null;
  const legacyType = String(legacy.type || '').toLowerCase();
  if (legacyType === 'task_complete' || legacyType === 'turn_complete') {
    return { threadId: legacy.threadId, turnId: legacy.turnId || null, kind: 'done', message: null };
  }
  if (legacyType === 'turn_aborted' || legacyType === 'error') {
    return {
      threadId: legacy.threadId,
      turnId: legacy.turnId || null,
      kind: 'error',
      message: legacy.message || `turn_${legacy.reason || 'aborted'}`
    };
  }

  return null;
}

function handleTurnTerminalNotification(terminal: TurnTerminalNotification | null): void {
  if (!terminal || !terminal.threadId) return;

  const runningTurnId = runningTurnByThreadId.get(terminal.threadId);
  if (terminal.turnId && runningTurnId && terminal.turnId !== runningTurnId) return;

  const effectiveTurnId = terminal.turnId || runningTurnId || null;
  const turnKey = `${terminal.threadId}:${effectiveTurnId || 'unknown'}`;
  const liveState =
    effectiveTurnId && liveTurnStateByThreadId.get(terminal.threadId)?.turnId === effectiveTurnId
      ? (liveTurnStateByThreadId.get(terminal.threadId) as LiveTurnState)
      : null;

  runningTurnByThreadId.delete(terminal.threadId);
  clearPendingUserInputForThread(terminal.threadId);

  if (liveState) {
    emitLiveTurnEvent(
      liveState,
      terminal.kind === 'done'
        ? { type: 'done' }
        : { type: 'error', message: terminal.message || 'turn_failed' }
    );
  }

  if (!handledTerminalTurnKeys.has(turnKey)) {
    rememberBounded(handledTerminalTurnKeys, turnKey);
    pushRuntimeLog({
      level: terminal.kind === 'error' ? 'error' : 'info',
      event: 'turn_stream_terminal',
      threadId: terminal.threadId,
      turnId: effectiveTurnId,
      kind: terminal.kind,
      message: terminal.message || null
    });
  }

  if (terminal.kind !== 'done') return;
  if (handledPushTurnKeys.has(turnKey)) return;
  rememberBounded(handledPushTurnKeys, turnKey);

  notifyPushSubscribersForThread(terminal.threadId)
    .then((result) => {
      pushRuntimeLog({
        level: 'info',
        event: 'push_notified',
        threadId: terminal.threadId,
        sent: result.sent,
        staleRemoved: result.staleRemoved,
        skipped: result.skipped || null
      });
    })
    .catch((error) => {
      pushRuntimeLog({
        level: 'error',
        event: 'push_notify_failed',
        threadId: terminal.threadId,
        message: String(error?.message || 'unknown_error')
      });
    });
}

function selectTurnStreamUpdate(msg: unknown, state: SelectTurnStreamState): SelectTurnStreamUpdateResult {
  const threadId = state?.threadId || null;
  const turnId = state?.turnId || null;
  const preferV2 = Boolean(state?.preferV2);
  let nextPreferV2 = preferV2;

  const request = parseToolRequestUserInput(msg);
  if (request && request.threadId === threadId && request.turnId === turnId) {
    nextPreferV2 = true;
    return {
      matched: true,
      nextPreferV2,
      streamEvent: {
        type: 'request_user_input',
        requestId: request.requestId,
        turnId: request.turnId,
        itemId: request.itemId,
        questions: request.questions
      }
    };
  }

  const v2 = parseV2TurnNotification(msg);
  if (v2 && v2.threadId === threadId && (!v2.turnId || v2.turnId === turnId)) {
    nextPreferV2 = true;
    if (v2.method === 'item/agentMessage/delta' && v2.delta) {
      return {
        matched: true,
        nextPreferV2,
        streamEvent: v2.itemId
          ? { type: 'answer_delta', delta: v2.delta, itemId: v2.itemId }
          : { type: 'answer_delta', delta: v2.delta }
      };
    }
    if (v2.method === 'item/plan/delta' && v2.delta) {
      return {
        matched: true,
        nextPreferV2,
        streamEvent: v2.itemId
          ? { type: 'plan_delta', delta: v2.delta, itemId: v2.itemId }
          : { type: 'plan_delta', delta: v2.delta }
      };
    }
    if ((v2.method === 'item/reasoning/summaryTextDelta' || v2.method === 'item/reasoning/textDelta') && v2.delta) {
      return { matched: true, nextPreferV2, streamEvent: { type: 'reasoning_delta', delta: v2.delta } };
    }
    if (v2.method === 'turn/plan/updated') {
      const params = asObject(asObject(msg)?.params);
      const planText = buildTurnPlanText(params?.explanation, params?.plan);
      return {
        matched: true,
        nextPreferV2,
        streamEvent: asString(params?.itemId)
          ? { type: 'plan_snapshot', text: planText, itemId: asString(params?.itemId) as string }
          : { type: 'plan_snapshot', text: planText }
      };
    }
    if (v2.method === 'turn/completed') {
      if (isCompletedStatus(v2.status)) return { matched: true, nextPreferV2, terminal: { kind: 'done' } };
      if (isErrorStatus(v2.status)) {
        return {
          matched: true,
          nextPreferV2,
          terminal: { kind: 'error', message: `turn_${String(v2.status || '').toLowerCase()}` }
        };
      }
      return { matched: true, nextPreferV2, terminal: { kind: 'done' } };
    }
    if (v2.method === 'error') {
      if (v2.willRetry) {
        return {
          matched: true,
          nextPreferV2,
          streamEvent: {
            type: 'status',
            phase: 'reconnecting',
            message: v2.errorMessage || 'reconnecting'
          }
        };
      }
      return {
        matched: true,
        nextPreferV2,
        terminal: { kind: 'error', message: v2.errorMessage || 'turn_failed' }
      };
    }
    return { matched: true, nextPreferV2 };
  }

  if (nextPreferV2) return { matched: false, nextPreferV2 };

  const legacy = parseLegacyTurnNotification(msg);
  if (!legacy) return { matched: false, nextPreferV2 };
  if (legacy.threadId !== threadId) return { matched: false, nextPreferV2 };
  if (legacy.turnId && legacy.turnId !== turnId) return { matched: false, nextPreferV2 };

  const legacyType = String(legacy.type || '').toLowerCase();
  if (legacy.delta) {
    if (legacyType.includes('reasoning')) {
      return { matched: true, nextPreferV2, streamEvent: { type: 'reasoning_delta', delta: legacy.delta } };
    }
    if (legacyType.includes('agent_message')) {
      return { matched: true, nextPreferV2, streamEvent: { type: 'answer_delta', delta: legacy.delta } };
    }
    return { matched: true, nextPreferV2 };
  }
  if (legacyType === 'task_complete' || legacyType === 'turn_complete') {
    return { matched: true, nextPreferV2, terminal: { kind: 'done' } };
  }
  if (legacyType === 'turn_aborted') {
    return {
      matched: true,
      nextPreferV2,
      terminal: { kind: 'error', message: `turn_${legacy.reason || 'aborted'}` }
    };
  }
  if (legacyType === 'error') {
    return { matched: true, nextPreferV2, terminal: { kind: 'error', message: legacy.message || 'turn_failed' } };
  }
  return { matched: true, nextPreferV2 };
}

function normalizeThreadMessages(readResult: ThreadMessageReadResult): OutputItem[] {
  const turns = Array.isArray(readResult?.thread?.turns) ? readResult.thread.turns : [];
  return turns.flatMap((turn) => normalizeTurnMessages(turn));
}

function isUserInputBoundaryItem(item: unknown): boolean {
  const record = asObject(item);
  if (!record) return false;
  const type = (asString(record.type) || '').toLowerCase();
  const method = (asString(record.method) || '').toLowerCase();
  const name = (asString(record.name) || '').toLowerCase();
  const toolName = (asString(record.toolName) || '').toLowerCase();
  return (
    type.includes('requestuserinput') ||
    type.includes('request_user_input') ||
    type.includes('userinputrequest') ||
    method === 'item/tool/requestuserinput' ||
    name.includes('requestuserinput') ||
    name.includes('request_user_input') ||
    toolName.includes('requestuserinput') ||
    toolName.includes('request_user_input')
  );
}

function extractUserMessageText(item: unknown): string {
  const record = asObject(item);
  if (!record || record.type !== 'userMessage') return '';
  const content = Array.isArray(record.content) ? record.content : [];
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

function normalizeTurnMessages(turn: ThreadMessageTurn | null | undefined): OutputItem[] {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  const input = Array.isArray(turn?.input) ? turn.input : [];
  const messages: OutputItem[] = [];
  let userIndex = 0;
  let assistantIndex = 0;
  let currentAnswerParts: string[] = [];
  let currentPlanParts: string[] = [];

  function pushUserMessage(text: string): void {
    const normalized = String(text || '').trim();
    if (!normalized) return;
    messages.push({
      id: `${turn?.id}:user:${userIndex}`,
      role: 'user',
      type: 'plain',
      text: normalized
    });
    userIndex += 1;
  }

  function flushAssistantSegment(): void {
    const answerText = currentAnswerParts.join('\n');
    const planText = currentPlanParts.join('\n');
    if (!answerText && !planText) return;
    messages.push({
      id: `${turn?.id}:assistant:${assistantIndex}`,
      role: 'assistant',
      type: looksLikeDiff(answerText) ? 'diff' : 'markdown',
      text: answerText,
      answer: answerText,
      plan: planText
    });
    assistantIndex += 1;
    currentAnswerParts = [];
    currentPlanParts = [];
  }

  const hasUserMessageItems = items.some((item) => item?.type === 'userMessage');
  if (!hasUserMessageItems) {
    const userTextFromInput = input
      .filter((item) => item?.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('\n')
      .trim();
    pushUserMessage(userTextFromInput);
  }

  for (const item of items) {
    if (item?.type === 'userMessage') {
      flushAssistantSegment();
      pushUserMessage(extractUserMessageText(item));
      continue;
    }
    if (item?.type === 'agentMessage' && typeof item.text === 'string') {
      currentAnswerParts.push(item.text);
      continue;
    }
    if (item?.type === 'plan' && typeof item.text === 'string') {
      currentPlanParts.push(item.text);
      continue;
    }
    if (isUserInputBoundaryItem(item)) {
      flushAssistantSegment();
    }
  }
  flushAssistantSegment();

  return messages;
}

async function isAppServerReady(): Promise<boolean> {
  try {
    await connectWs();
    return true;
  } catch {
    return false;
  }
}

async function waitUntilAppServerReady(timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isAppServerReady()) return true;
    await sleep(300);
  }
  return false;
}

async function ensureCodexServerRunning(): Promise<void> {
  if (await isAppServerReady()) return;

  if (codexStartPromise) {
    await codexStartPromise;
    return;
  }

  codexStartPromise = (async () => {
    pushRuntimeLog({
      level: 'info',
      event: 'codex_server_autostart_begin',
      command: CODEX_APP_SERVER_START_CMD
    });

    const child = spawn('bash', ['-lc', CODEX_APP_SERVER_START_CMD], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    });
    codexServerProcess = child;
    child.unref();

    child.stdout?.on('data', (chunk: Buffer) => {
      pushRuntimeLog({
        level: 'info',
        event: 'codex_server_stdout',
        message: chunk.toString('utf8').slice(0, 500)
      });
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      pushRuntimeLog({
        level: 'error',
        event: 'codex_server_stderr',
        message: chunk.toString('utf8').slice(0, 500)
      });
    });
    child.on('exit', (code, signal) => {
      pushRuntimeLog({
        level: code === 0 ? 'info' : 'error',
        event: 'codex_server_exit',
        code,
        signal
      });
    });

    const ready = await waitUntilAppServerReady(CODEX_APP_SERVER_STARTUP_TIMEOUT_MS);
    if (!ready) throw new Error(`codex_server_start_timeout_${CODEX_APP_SERVER_STARTUP_TIMEOUT_MS}ms`);

    pushRuntimeLog({
      level: 'info',
      event: 'codex_server_autostart_ready',
      wsUrl: CODEX_APP_SERVER_WS_URL
    });
  })();

  try {
    await codexStartPromise;
  } finally {
    codexStartPromise = null;
  }
}

function repoFolderFromFullName(fullName: string): string {
  return fullName.replace(/[\\/]/g, '__');
}

function repoPathFromFullName(fullName: string): string {
  return path.join(WORKSPACE_ROOT, repoFolderFromFullName(fullName));
}

function getCloneState(fullName: string): CloneState {
  const repoPath = repoPathFromFullName(fullName);
  const job = cloneJobs.get(fullName);

  if (job?.status === 'cloning') return { status: 'cloning', repoPath };
  if (job?.status === 'failed') return job.error ? { status: 'failed', repoPath, error: job.error } : { status: 'failed', repoPath };
  if (fs.existsSync(path.join(repoPath, '.git'))) return { status: 'cloned', repoPath };
  return { status: 'not_cloned', repoPath };
}

function parseGitStatusOutput(repoFullName: string, repoPath: string, raw: string): GitRepoStatus {
  let branch = '';
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let stagedCount = 0;
  let unstagedCount = 0;
  let untrackedCount = 0;
  let conflictedCount = 0;

  const lines = String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);

  for (const line of lines) {
    if (line.startsWith('# branch.head ')) {
      branch = line.slice('# branch.head '.length).trim();
      continue;
    }
    if (line.startsWith('# branch.upstream ')) {
      upstream = line.slice('# branch.upstream '.length).trim() || null;
      continue;
    }
    if (line.startsWith('# branch.ab ')) {
      const match = line.match(/\+(\d+)\s+\-(\d+)/);
      ahead = Number(match?.[1] || 0);
      behind = Number(match?.[2] || 0);
      continue;
    }
    if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const xy = line.split(/\s+/, 3)[1] || '..';
      const x = xy[0] || '.';
      const y = xy[1] || '.';
      if (x !== '.' && x !== '?') stagedCount += 1;
      if (y !== '.' && y !== '?') unstagedCount += 1;
      continue;
    }
    if (line.startsWith('u ')) {
      conflictedCount += 1;
      continue;
    }
    if (line.startsWith('? ')) {
      untrackedCount += 1;
    }
  }

  const hasChanges = stagedCount + unstagedCount + untrackedCount + conflictedCount > 0;
  const branchLabel = !branch || branch === '(detached)' ? 'detached' : branch;
  const actionRecommended = hasChanges || ahead > 0 || behind > 0;
  let tone: GitRepoStatus['tone'] = 'neutral';
  let summary = 'Git は同期済みです';

  if (conflictedCount > 0) {
    tone = 'danger';
    summary = `Git 競合 ${conflictedCount} 件`;
  } else if (hasChanges) {
    tone = 'warning';
    const parts: string[] = [];
    if (stagedCount > 0) parts.push(`ステージ ${stagedCount}`);
    if (unstagedCount > 0) parts.push(`未反映 ${unstagedCount}`);
    if (untrackedCount > 0) parts.push(`未追跡 ${untrackedCount}`);
    summary = `変更あり: ${parts.join(' / ')}`;
    if (!upstream) summary += ' / upstream 未設定';
    else if (ahead > 0 || behind > 0) summary += ` / +${ahead} -${behind}`;
  } else if (ahead > 0 && behind > 0) {
    tone = 'danger';
    summary = `push 前に同期が必要: +${ahead} -${behind}`;
  } else if (ahead > 0) {
    tone = 'success';
    summary = `未 push のコミット ${ahead} 件`;
  } else if (behind > 0) {
    tone = 'warning';
    summary = `リモート更新 ${behind} 件`;
  }

  return {
    repoFullName,
    repoPath,
    branch: branchLabel,
    upstream,
    ahead,
    behind,
    stagedCount,
    unstagedCount,
    untrackedCount,
    conflictedCount,
    hasChanges,
    actionRecommended,
    tone,
    summary
  };
}

function readGitRepoStatus(repoFullName: string): GitRepoStatus {
  const repoPath = repoPathFromFullName(repoFullName);
  if (!fs.existsSync(path.join(repoPath, '.git'))) throw new Error('repo_not_cloned');
  const result = spawnSync('git', ['status', '--porcelain=2', '--branch'], {
    cwd: repoPath,
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || '').trim() || 'git_status_failed';
    throw new Error(message);
  }
  return parseGitStatusOutput(repoFullName, repoPath, result.stdout || '');
}

function runGitForRepo(
  repoPath: string,
  args: string[],
  options: { allowExitCodes?: number[] } = {}
): SpawnSyncReturns<string> {
  const result = spawnSync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 8 * 1024 * 1024
  });
  if (result.error) throw result.error;
  const allow = new Set([0, ...(options.allowExitCodes || [])]);
  if (!allow.has(Number(result.status ?? 1))) {
    const message = (result.stderr || result.stdout || '').trim() || `git_${args[0]}_failed`;
    throw new Error(message);
  }
  return result;
}

function resolveRepoTrackedPath(repoPath: string, rawPath: string): { fullPath: string; relativePath: string } {
  const trimmed = String(rawPath || '').trim();
  if (!trimmed) throw new Error('path_required');
  const decoded = decodeURIComponent(trimmed);
  const candidate = path.isAbsolute(decoded) ? path.resolve(decoded) : path.resolve(repoPath, decoded);
  const relative = path.relative(repoPath, candidate);
  if (
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    relative === '' ||
    candidate === repoPath
  ) {
    throw new Error('path_outside_repo');
  }
  return {
    fullPath: candidate,
    relativePath: relative.split(path.sep).join('/')
  };
}

function detectBinaryBuffer(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  for (const byte of sample) {
    if (byte === 0) return true;
  }
  return false;
}

function diffKindFromStatusCode(code: string): RepoFileChangeKind {
  const normalized = String(code || '').trim();
  if (normalized === '??') return 'untracked';
  if (/[UD]{2}|AA|DD|AU|UA|DU|UD|UU/.test(normalized) || normalized.includes('U')) return 'conflicted';
  if (normalized.includes('R')) return 'renamed';
  if (normalized.includes('D')) return 'deleted';
  if (normalized.includes('A')) return 'added';
  if (normalized.includes('M') || normalized.includes('T') || normalized.includes('C')) return 'modified';
  return 'unchanged';
}

function parseStatusPath(line: string): { code: string; path: string } | null {
  const text = String(line || '');
  if (!text) return null;
  if (text.startsWith('?? ')) return { code: '??', path: text.slice(3).trim() };
  if (text.length < 4) return null;
  const code = text.slice(0, 2);
  let filePath = text.slice(3).trim();
  const renameArrow = filePath.lastIndexOf(' -> ');
  if (renameArrow >= 0) filePath = filePath.slice(renameArrow + 4).trim();
  if (!filePath) return null;
  return { code, path: filePath };
}

function collectRepoFileStatus(repoPath: string): Map<string, RepoFileChangeKind> {
  const result = runGitForRepo(repoPath, ['status', '--porcelain']);
  const map = new Map<string, RepoFileChangeKind>();
  for (const line of String(result.stdout || '').split(/\r?\n/)) {
    const parsed = parseStatusPath(line);
    if (!parsed) continue;
    map.set(parsed.path, diffKindFromStatusCode(parsed.code));
  }
  return map;
}

function collectTrackedFiles(repoPath: string): string[] {
  const result = runGitForRepo(repoPath, ['ls-files']);
  return String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function collectIgnoredPaths(repoPath: string, parentPath: string | null = null): string[] {
  const args = ['ls-files', '--others', '-i', '--exclude-standard'];
  if (!parentPath) {
    args.push('--directory');
  } else {
    args.push('--', parentPath);
  }
  const result = runGitForRepo(repoPath, args);
  return String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function isIgnoredRepoPath(repoPath: string, relativePath: string): boolean {
  const target = String(relativePath || '').trim();
  if (!target) return false;
  const result = runGitForRepo(repoPath, ['check-ignore', '-q', '--', target], { allowExitCodes: [1] });
  return Number(result.status ?? 1) === 0;
}

function normalizeRepoTreeParentPath(repoPath: string, rawPath: string | null | undefined): string | null {
  const trimmed = String(rawPath || '').trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!normalized) return null;
  const resolved = path.resolve(repoPath, normalized);
  const repoRoot = path.resolve(repoPath);
  if (resolved !== repoRoot && !resolved.startsWith(repoRoot + path.sep)) throw new Error('path_outside_repo');
  return normalized;
}

function parseNumStatOutput(output: string, targetPath = ''): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of String(output || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('\t');
    if (parts.length < 3) continue;
    const filePath = parts[2].trim();
    if (targetPath && filePath !== targetPath) continue;
    const added = parts[0] === '-' ? 0 : Number(parts[0] || 0);
    const removed = parts[1] === '-' ? 0 : Number(parts[1] || 0);
    additions += Number.isFinite(added) ? added : 0;
    deletions += Number.isFinite(removed) ? removed : 0;
  }
  return { additions, deletions };
}

function collectDiffStats(repoPath: string, relativePath: string, trackedFiles: Set<string>): { additions: number; deletions: number } {
  const unstaged = String(runGitForRepo(repoPath, ['diff', '--numstat', '--', relativePath]).stdout || '');
  const staged = String(runGitForRepo(repoPath, ['diff', '--cached', '--numstat', '--', relativePath]).stdout || '');
  const unstagedStats = parseNumStatOutput(unstaged, relativePath);
  const stagedStats = parseNumStatOutput(staged, relativePath);
  let additions = unstagedStats.additions + stagedStats.additions;
  let deletions = unstagedStats.deletions + stagedStats.deletions;

  const absolutePath = path.join(repoPath, relativePath);
  if (!trackedFiles.has(relativePath) && fs.existsSync(absolutePath)) {
    const content = fs.readFileSync(absolutePath, 'utf8');
    additions += content.split(/\r?\n/).length;
  }

  return { additions, deletions };
}

function getChangePriority(kind: RepoFileChangeKind): number {
  switch (kind) {
    case 'deleted':
    case 'conflicted':
      return 5;
    case 'added':
    case 'untracked':
      return 4;
    case 'modified':
    case 'renamed':
      return 3;
    case 'ignored':
      return 2;
    default:
      return 1;
  }
}

function collectDiffOutput(
  repoPath: string,
  relativePath: string,
  trackedFiles: Set<string>,
  changeKind: RepoFileChangeKind = 'unchanged'
): { diff: string; isDeleted: boolean; additions: number; deletions: number } {
  const sections: string[] = [];
  if (changeKind === 'ignored') {
    return { diff: '', isDeleted: false, additions: 0, deletions: 0 };
  }
  const unstaged = String(runGitForRepo(repoPath, ['diff', '--', relativePath]).stdout || '').trim();
  if (unstaged) sections.push(unstaged);
  const staged = String(runGitForRepo(repoPath, ['diff', '--cached', '--', relativePath]).stdout || '').trim();
  if (staged) sections.push(staged);

  const absolutePath = path.join(repoPath, relativePath);
  const exists = fs.existsSync(absolutePath);
  const tracked = trackedFiles.has(relativePath);
  if (!exists && sections.length === 0) {
    return { diff: '', isDeleted: true, additions: 0, deletions: 0 };
  }

  if (!tracked && exists) {
    const untracked = runGitForRepo(repoPath, ['diff', '--no-index', '--', '/dev/null', absolutePath], { allowExitCodes: [1] });
    const output = String(untracked.stdout || '').trim();
    if (output) sections.push(output.replaceAll(absolutePath, relativePath));
  }

  const stats = collectDiffStats(repoPath, relativePath, trackedFiles);

  return {
    diff: sections.filter(Boolean).join('\n\n').trim(),
    isDeleted: !exists,
    additions: stats.additions,
    deletions: stats.deletions
  };
}

function readRepoFileContent(repoPath: string, relativePath: string): { content: string; isBinary: boolean } {
  const absolutePath = path.join(repoPath, relativePath);
  if (!fs.existsSync(absolutePath)) return { content: '', isBinary: false };
  const buffer = fs.readFileSync(absolutePath);
  if (detectBinaryBuffer(buffer)) return { content: '', isBinary: true };
  return { content: buffer.toString('utf8'), isBinary: false };
}

function listRepoFiles(repoFullName: string, includeUnchanged: boolean): RepoFileListResponse {
  const repoPath = repoPathFromFullName(repoFullName);
  if (!fs.existsSync(path.join(repoPath, '.git'))) throw new Error('repo_not_cloned');
  const statusMap = collectRepoFileStatus(repoPath);
  const trackedFiles = collectTrackedFiles(repoPath);
  const trackedFileSet = new Set(trackedFiles);
  const ignoredPaths = collectIgnoredPaths(repoPath);
  const itemsMap = new Map<string, RepoFileListItem>();

  for (const trackedPath of trackedFiles) {
    const changeKind = statusMap.get(trackedPath) || 'unchanged';
    const hasDiff = changeKind !== 'unchanged';
    if (!hasDiff && !includeUnchanged) continue;
    const stats = hasDiff ? collectDiffStats(repoPath, trackedPath, trackedFileSet) : { additions: 0, deletions: 0 };
    itemsMap.set(trackedPath, {
      path: trackedPath,
      hasDiff,
      changeKind,
      isBinary: false,
      additions: stats.additions,
      deletions: stats.deletions
    });
  }

  for (const [changedPath, changeKind] of statusMap.entries()) {
    const stats = collectDiffStats(repoPath, changedPath, trackedFileSet);
    itemsMap.set(changedPath, {
      path: changedPath,
      hasDiff: true,
      changeKind,
      isBinary: false,
      additions: stats.additions,
      deletions: stats.deletions
    });
  }

  if (includeUnchanged) {
    for (const ignoredPath of ignoredPaths) {
      if (itemsMap.has(ignoredPath)) continue;
      itemsMap.set(ignoredPath, {
        path: ignoredPath,
        hasDiff: false,
        changeKind: 'ignored',
        isBinary: false,
        additions: 0,
        deletions: 0
      });
    }
  }

  const items = Array.from(itemsMap.values()).sort((a, b) => {
    if (a.hasDiff !== b.hasDiff) return a.hasDiff ? -1 : 1;
    const priorityDiff = getChangePriority(b.changeKind) - getChangePriority(a.changeKind);
    if (priorityDiff !== 0) return priorityDiff;
    return a.path.localeCompare(b.path);
  });

  return {
    repoFullName,
    repoPath,
    items
  };
}

function listRepoTree(repoFullName: string, includeUnchanged: boolean, rawParentPath: string | null | undefined): RepoFileTreeResponse {
  const repoPath = repoPathFromFullName(repoFullName);
  if (!fs.existsSync(path.join(repoPath, '.git'))) throw new Error('repo_not_cloned');
  const parentPath = normalizeRepoTreeParentPath(repoPath, rawParentPath);
  const statusMap = collectRepoFileStatus(repoPath);
  const trackedFiles = collectTrackedFiles(repoPath);
  const trackedFileSet = new Set(trackedFiles);
  const ignoredPaths = includeUnchanged ? collectIgnoredPaths(repoPath, parentPath) : [];
  const baseItems: RepoFileListItem[] = [];

  for (const trackedPath of trackedFiles) {
    const changeKind = statusMap.get(trackedPath) || 'unchanged';
    const hasDiff = changeKind !== 'unchanged';
    if (!hasDiff && !includeUnchanged) continue;
    const stats = hasDiff ? collectDiffStats(repoPath, trackedPath, trackedFileSet) : { additions: 0, deletions: 0 };
    baseItems.push({
      path: trackedPath,
      hasDiff,
      changeKind,
      isBinary: false,
      additions: stats.additions,
      deletions: stats.deletions
    });
  }

  for (const [changedPath, changeKind] of statusMap.entries()) {
    const stats = collectDiffStats(repoPath, changedPath, trackedFileSet);
    baseItems.push({
      path: changedPath,
      hasDiff: true,
      changeKind,
      isBinary: false,
      additions: stats.additions,
      deletions: stats.deletions
    });
  }

  if (includeUnchanged) {
    for (const ignoredPath of ignoredPaths) {
      baseItems.push({
        path: ignoredPath,
        hasDiff: false,
        changeKind: 'ignored',
        isBinary: false,
        additions: 0,
        deletions: 0
      });
    }
  }

  const itemsMap = new Map<string, RepoFileListItem>();
  for (const item of baseItems) {
    const existing = itemsMap.get(item.path);
    if (!existing) {
      itemsMap.set(item.path, item);
      continue;
    }
    if (item.hasDiff && !existing.hasDiff) {
      itemsMap.set(item.path, item);
      continue;
    }
    if (getChangePriority(item.changeKind) > getChangePriority(existing.changeKind)) {
      itemsMap.set(item.path, item);
    }
  }

  const childMap = new Map<string, RepoFileTreeItem>();
  const grandchildNameSetByChildPath = new Map<string, Set<string>>();
  const parentPrefix = parentPath ? `${parentPath}/` : '';

  for (const item of itemsMap.values()) {
    const normalizedPath = item.path.endsWith('/') ? item.path.replace(/\/+$/, '') : item.path;
    if (!normalizedPath) continue;
    let remainder = normalizedPath;
    if (parentPath) {
      if (normalizedPath === parentPath) continue;
      if (!normalizedPath.startsWith(parentPrefix)) continue;
      remainder = normalizedPath.slice(parentPrefix.length);
    }
    const parts = remainder.split('/').filter(Boolean);
    if (parts.length === 0) continue;
    const childName = parts[0];
    const childPath = parentPath ? `${parentPath}/${childName}` : childName;
    const isDirectFile = parts.length === 1 && !item.path.endsWith('/');
    const existing = childMap.get(childPath);

    if (parts.length > 1) {
      const nextChildName = parts[1];
      if (nextChildName) {
        const nameSet = grandchildNameSetByChildPath.get(childPath) || new Set<string>();
        nameSet.add(nextChildName);
        grandchildNameSetByChildPath.set(childPath, nameSet);
      }
    }

    if (isDirectFile) {
      if (!existing || existing.type === 'directory') {
        childMap.set(childPath, {
          name: childName,
          path: childPath,
          type: 'file',
          hasDiff: item.hasDiff,
          changeKind: item.changeKind,
          isBinary: item.isBinary,
          additions: item.additions,
          deletions: item.deletions,
          hasChildren: false
        });
      } else {
        existing.hasDiff = existing.hasDiff || item.hasDiff;
        if (getChangePriority(item.changeKind) > getChangePriority(existing.changeKind)) {
          existing.changeKind = item.changeKind;
        }
        existing.additions += item.additions;
        existing.deletions += item.deletions;
      }
      continue;
    }

    if (!existing) {
      childMap.set(childPath, {
        name: childName,
        path: childPath,
        type: 'directory',
        hasDiff: item.hasDiff,
        changeKind: item.changeKind,
        isBinary: false,
        additions: item.additions,
        deletions: item.deletions,
        hasChildren: true
      });
      continue;
    }
    existing.hasDiff = existing.hasDiff || item.hasDiff;
    if (getChangePriority(item.changeKind) > getChangePriority(existing.changeKind)) {
      existing.changeKind = item.changeKind;
    }
    existing.additions += item.additions;
    existing.deletions += item.deletions;
    existing.hasChildren = true;
  }

  for (const item of childMap.values()) {
    if (item.type !== 'directory') continue;
    const directChildCount = grandchildNameSetByChildPath.get(item.path)?.size || 0;
    item.eagerSafe = directChildCount <= 20;
  }

  const items = Array.from(childMap.values()).sort((a, b) => {
    if (a.hasDiff !== b.hasDiff) return a.hasDiff ? -1 : 1;
    const priorityDiff = getChangePriority(b.changeKind) - getChangePriority(a.changeKind);
    if (priorityDiff !== 0) return priorityDiff;
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return {
    repoFullName,
    repoPath,
    parentPath,
    items
  };
}

function buildRepoFileView(repoFullName: string, rawPath: string): RepoFileViewResponse {
  const repoPath = repoPathFromFullName(repoFullName);
  if (!fs.existsSync(path.join(repoPath, '.git'))) throw new Error('repo_not_cloned');
  const resolved = resolveRepoTrackedPath(repoPath, rawPath);
  const statusMap = collectRepoFileStatus(repoPath);
  const trackedFiles = new Set(collectTrackedFiles(repoPath));
  const ignored = isIgnoredRepoPath(repoPath, resolved.relativePath);
  const changeKind = statusMap.get(resolved.relativePath) || (ignored ? 'ignored' : 'unchanged');
  const { diff, isDeleted, additions, deletions } = collectDiffOutput(repoPath, resolved.relativePath, trackedFiles, changeKind);
  const contentState = readRepoFileContent(repoPath, resolved.relativePath);
  return {
    repoFullName,
    repoPath,
    path: resolved.relativePath,
    hasDiff: Boolean(diff),
    changeKind,
    isBinary: contentState.isBinary,
    isDeleted,
    additions,
    deletions,
    content: contentState.content,
    diff
  };
}

function runClone(fullName: string, cloneUrl: string): void {
  const repoPath = repoPathFromFullName(fullName);
  if (fs.existsSync(path.join(repoPath, '.git'))) {
    cloneJobs.set(fullName, { status: 'cloned' });
    pushRuntimeLog({ level: 'info', event: 'clone_skipped_already_cloned', fullName, repoPath });
    return;
  }

  cloneJobs.set(fullName, { status: 'cloning' });
  pushRuntimeLog({ level: 'info', event: 'clone_started', fullName, repoPath, cloneUrl });
  const child = spawn('git', ['clone', '--depth', '1', cloneUrl, repoPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  child.on('close', (code) => {
    if (code === 0) {
      cloneJobs.set(fullName, { status: 'cloned' });
      pushRuntimeLog({ level: 'info', event: 'clone_succeeded', fullName, repoPath });
      return;
    }
    const error = stderr.trim() || `git clone exited with code ${code}`;
    cloneJobs.set(fullName, { status: 'failed', error });
    pushRuntimeLog({ level: 'error', event: 'clone_failed', fullName, repoPath, error });
  });
}

function runGh(args: string[]): SpawnSyncReturns<string> {
  return spawnSync('gh', args, { encoding: 'utf8' });
}

function getGithubTokenFromGh(): string {
  const tokenResult = runGh(['auth', 'token']);
  if (tokenResult.error) {
    if (getErrorCode(tokenResult.error) === 'ENOENT') throw new Error('gh_not_installed');
    throw new Error(`gh_auth_token_error:${tokenResult.error.message}`);
  }

  if (tokenResult.status !== 0) {
    const msg = (tokenResult.stderr || tokenResult.stdout || '').trim();
    throw new Error(`gh_not_logged_in:${msg}`);
  }

  const token = (tokenResult.stdout || '').trim();
  if (!token) throw new Error('gh_token_empty');
  return token;
}

function getGhStatus():
  | { available: false; connected: false; hint: string }
  | { available: true; connected: false; hint: string }
  | { available: true; connected: true; token: string } {
  const versionResult = runGh(['--version']);
  if (versionResult.error && getErrorCode(versionResult.error) === 'ENOENT') {
    return { available: false, connected: false, hint: 'gh がインストールされていません。' };
  }
  if (versionResult.status !== 0) {
    return { available: false, connected: false, hint: 'gh コマンドを実行できません。' };
  }

  try {
    const token = getGithubTokenFromGh();
    return { available: true, connected: true, token };
  } catch (error) {
    const message = getErrorMessage(error);
    if (message.startsWith('gh_not_logged_in')) {
      return { available: true, connected: false, hint: '先に `gh auth login` を実行してください。' };
    }
    return { available: true, connected: false, hint: message };
  }
}

async function githubUser(token: string): Promise<GithubUserResponse> {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      'User-Agent': 'codex-mobile-ui',
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`github_user_error:${response.status}:${text.slice(0, 200)}`);
  }
  return (await response.json()) as GithubUserResponse;
}

async function githubRepos(token: string, query: string): Promise<RepoSummary[]> {
  const endpoint = query
    ? `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}+user:@me`
    : 'https://api.github.com/user/repos?per_page=100&sort=updated';

  const response = await fetch(endpoint, {
    headers: {
      'User-Agent': 'codex-mobile-ui',
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`github_error:${response.status}:${text.slice(0, 200)}`);
  }

  const data = (await response.json()) as GithubRepoApiItem[] | { items?: GithubRepoApiItem[] };
  const repos = Array.isArray(data) ? data : data.items || [];
  return repos.map((repo) => ({
    id: repo.id,
    name: repo.name,
    fullName: repo.full_name,
    private: repo.private,
    cloneUrl: repo.clone_url,
    defaultBranch: repo.default_branch,
    updatedAt: repo.updated_at,
    cloneState: getCloneState(repo.full_name)
  }));
}

function buildServer(): FastifyInstance {
  pushSubscriptions = loadPushSubscriptions();
  try {
    const keys = loadOrCreateVapidKeys();
    pushPublicKey = keys.publicKey;
    pushPrivateKey = keys.privateKey;
    webPush.setVapidDetails(DEFAULT_PUSH_SUBJECT, pushPublicKey, pushPrivateKey);
    pushEnabled = true;
  } catch (error) {
    pushEnabled = false;
    pushRuntimeLog({
      level: 'error',
      event: 'push_vapid_init_failed',
      message: getErrorMessage(error)
    });
  }

  const app = Fastify({ logger: { level: 'info' } }) as FastifyInstance;

  app.register(fastifyStatic, {
    root: path.join(process.cwd(), 'public'),
    prefix: '/'
  });

  app.addHook('onRequest', async (request) => {
    request.startTime = process.hrtime.bigint();
  });

  app.addHook('onResponse', async (request, reply) => {
    const end = process.hrtime.bigint();
    const start = request.startTime ?? end;
    const durationMs = Number(end - start) / 1e6;
    const log = {
      requestId: request.id,
      method: request.method,
      path: request.url,
      statusCode: reply.statusCode,
      durationMs: Number(durationMs.toFixed(2))
    };
    pushRuntimeLog({ level: 'info', event: 'request_completed', ...log });
    request.log.info(log, 'request_completed');
  });

  app.setErrorHandler((error: Error, request, reply) => {
    const log = {
      requestId: request.id,
      path: request.url,
      method: request.method,
      message: getErrorMessage(error),
      stack: error.stack
    };
    pushRuntimeLog({ level: 'error', event: 'request_failed', ...log });
    request.log.error(log, 'request_failed');
    reply.code(500).send({ error: getErrorMessage(error, 'internal_error'), requestId: request.id });
  });

  app.get('/', async (_request, reply) => reply.sendFile('index.html'));
  app.get('/repos', async (_request, reply) => reply.sendFile('index.html'));
  app.get('/repos/', async (_request, reply) => reply.sendFile('index.html'));
  app.get('/chat', async (_request, reply) => reply.sendFile('index.html'));
  app.get('/chat/', async (_request, reply) => reply.sendFile('index.html'));
  app.get('/files', async (_request, reply) => reply.sendFile('index.html'));
  app.get('/files/', async (_request, reply) => reply.sendFile('index.html'));
  app.get('/files/view', async (_request, reply) => reply.sendFile('index.html'));
  app.get('/files/view/', async (_request, reply) => reply.sendFile('index.html'));
  app.get('/api/health', async () => ({
    ok: true,
    workspaceRoot: WORKSPACE_ROOT,
    codexMode: 'app-server',
    codexAppServerWsUrl: CODEX_APP_SERVER_WS_URL,
    codexAutostartEnabled: true
  }));

  app.get('/api/logs', async (request) => {
    const query = asObject(request.query) ?? {};
    const level = asString(query.level);
    const limitRaw = Number(query.limit || 200);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(1000, limitRaw)) : 200;
    let logs = runtimeLogs;
    if (level) logs = logs.filter((entry) => entry.level === level);
    const items = logs.slice(-limit);
    return { total: logs.length, count: items.length, items };
  });

  app.get('/api/push/config', async () => {
    return {
      enabled: pushEnabled,
      publicKey: pushEnabled ? pushPublicKey : '',
      hasVapidConfig: pushEnabled,
      subscriptionCount: pushSubscriptions.length
    };
  });

  app.post('/api/push/subscribe', async (request, reply) => {
    const body = asObject(request.body) ?? {};
    const sub = asObject(body.subscription) ?? {};
    const keys = asObject(sub.keys) ?? {};
    const endpoint = typeof sub.endpoint === 'string' ? sub.endpoint.trim() : '';
    const p256dh = typeof keys.p256dh === 'string' ? keys.p256dh.trim() : '';
    const auth = typeof keys.auth === 'string' ? keys.auth.trim() : '';
    if (!endpoint || !p256dh || !auth) {
      reply.code(400);
      return { error: 'invalid_subscription' };
    }
    const record = upsertPushSubscription({
      endpoint,
      keys: { p256dh, auth },
      currentThreadId: body.threadId ? String(body.threadId) : null,
      userAgent: body.userAgent ? String(body.userAgent) : ''
    });
    pushRuntimeLog({
      level: 'info',
      event: 'push_subscribed',
      endpoint,
      threadId: record.currentThreadId
    });
    return { ok: true, endpoint, threadId: record.currentThreadId };
  });

  app.post('/api/push/context', async (request, reply) => {
    const body = asObject(request.body) ?? {};
    const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
    if (!endpoint) {
      reply.code(400);
      return { error: 'endpoint_required' };
    }
    const record = setPushContext(endpoint, body.threadId ? String(body.threadId) : null);
    if (!record) {
      reply.code(404);
      return { error: 'subscription_not_found' };
    }
    return { ok: true, endpoint, threadId: record.currentThreadId };
  });

  app.post('/api/push/unsubscribe', async (request, reply) => {
    const body = asObject(request.body) ?? {};
    const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
    if (!endpoint) {
      reply.code(400);
      return { error: 'endpoint_required' };
    }
    const removed = removePushSubscription(endpoint);
    if (!removed) {
      reply.code(404);
      return { error: 'subscription_not_found' };
    }
    pushRuntimeLog({
      level: 'info',
      event: 'push_unsubscribed',
      endpoint
    });
    return { ok: true };
  });

  app.get('/api/github/auth/status', async () => {
    const status = getGhStatus();
    if (!status.available) return { available: false, connected: false, hint: status.hint };
    if (!status.connected) return { available: true, connected: false, hint: status.hint };
    const user = await githubUser(status.token);
    return { available: true, connected: true, login: user.login || '' };
  });

  app.post('/api/github/auth/logout', async (_request, reply) => {
    reply.code(400);
    return { error: 'gh_logout_required', hint: '`gh auth logout` をターミナルで実行してください。' };
  });

  app.get('/api/github/repos', async (request, reply) => {
    const queryRecord = asObject(request.query) ?? {};
    const status = getGhStatus();
    if (!status.available) {
      reply.code(503);
      return { error: 'gh_not_available', hint: status.hint };
    }
    if (!status.connected) {
      reply.code(401);
      return { error: 'gh_not_logged_in', hint: status.hint };
    }
    const query = asString(queryRecord.query) || '';
    const repos = await githubRepos(status.token, query);
    return { repos };
  });

  app.post('/api/repos/clone', async (request, reply) => {
    const body = asObject(request.body) ?? {};
    const fullName = asString(body.fullName);
    const cloneUrl = asString(body.cloneUrl);
    if (!fullName || !cloneUrl) {
      reply.code(400);
      return { error: 'fullName and cloneUrl are required' };
    }
    runClone(fullName, cloneUrl);
    reply.code(202);
    return getCloneState(fullName);
  });

  app.get('/api/repos/clone-status', async (request, reply) => {
    const query = asObject(request.query) ?? {};
    const fullName = asString(query.fullName);
    if (!fullName) {
      reply.code(400);
      return { error: 'fullName is required' };
    }
    return getCloneState(fullName);
  });

  app.get('/api/repos/git-status', async (request, reply) => {
    const query = asObject(request.query) ?? {};
    const repoFullName = asString(query.repoFullName);
    if (!repoFullName) {
      reply.code(400);
      return { error: 'repoFullName is required' };
    }
    try {
      return readGitRepoStatus(repoFullName);
    } catch (error) {
      const message = getErrorMessage(error);
      if (message === 'repo_not_cloned') {
        reply.code(404);
        return { error: message };
      }
      pushRuntimeLog({ level: 'error', event: 'git_status_failed', repoFullName, message });
      reply.code(500);
      return { error: 'git_status_failed', detail: message };
    }
  });

  app.get('/api/repos/files', async (request, reply) => {
    const query = asObject(request.query) ?? {};
    const repoFullName = asString(query.repoFullName);
    if (!repoFullName) {
      reply.code(400);
      return { error: 'repoFullName is required' };
    }
    const includeUnchangedRaw = String(query.includeUnchanged || '').trim().toLowerCase();
    const includeUnchanged =
      includeUnchangedRaw === '1' || includeUnchangedRaw === 'true' || includeUnchangedRaw === 'yes';
    try {
      return listRepoFiles(repoFullName, includeUnchanged);
    } catch (error) {
      const message = getErrorMessage(error);
      if (message === 'repo_not_cloned') {
        reply.code(404);
        return { error: message };
      }
      pushRuntimeLog({ level: 'error', event: 'repo_files_failed', repoFullName, message });
      reply.code(500);
      return { error: 'repo_files_failed', detail: message };
    }
  });

  app.get('/api/repos/file-tree', async (request, reply) => {
    const query = asObject(request.query) ?? {};
    const repoFullName = asString(query.repoFullName);
    if (!repoFullName) {
      reply.code(400);
      return { error: 'repoFullName is required' };
    }
    const includeUnchangedRaw = String(query.includeUnchanged || '').trim().toLowerCase();
    const includeUnchanged =
      includeUnchangedRaw === '1' || includeUnchangedRaw === 'true' || includeUnchangedRaw === 'yes';
    const rawPath = asString(query.path);
    try {
      return listRepoTree(repoFullName, includeUnchanged, rawPath);
    } catch (error) {
      const message = getErrorMessage(error);
      if (message === 'repo_not_cloned') {
        reply.code(404);
        return { error: message };
      }
      if (message === 'path_outside_repo') {
        reply.code(400);
        return { error: message };
      }
      pushRuntimeLog({ level: 'error', event: 'repo_file_tree_failed', repoFullName, path: rawPath, message });
      reply.code(500);
      return { error: 'repo_file_tree_failed', detail: message };
    }
  });

  app.get('/api/repos/file-view', async (request, reply) => {
    const query = asObject(request.query) ?? {};
    const repoFullName = asString(query.repoFullName);
    const rawPath = asString(query.path);
    if (!repoFullName || !rawPath) {
      reply.code(400);
      return { error: 'repoFullName and path are required' };
    }
    try {
      return buildRepoFileView(repoFullName, rawPath);
    } catch (error) {
      const message = getErrorMessage(error);
      if (message === 'repo_not_cloned') {
        reply.code(404);
        return { error: message };
      }
      if (message === 'path_required' || message === 'path_outside_repo') {
        reply.code(400);
        return { error: message };
      }
      pushRuntimeLog({ level: 'error', event: 'repo_file_view_failed', repoFullName, path: rawPath, message });
      reply.code(500);
      return { error: 'repo_file_view_failed', detail: message };
    }
  });

  app.get('/api/threads', async (request, reply) => {
    const query = asObject(request.query) ?? {};
    const repoFullName = asString(query.repoFullName);
    if (!repoFullName) {
      reply.code(400);
      return { error: 'repoFullName is required' };
    }
    const repoPath = repoPathFromFullName(repoFullName);
    const result = await rpcRequest<{ data?: Array<{ id?: string; name?: string; updatedAt?: number; preview?: string; source?: string | null; status?: { type?: string | null } }> }>('thread/list', {
      cwd: repoPath,
      archived: false,
      limit: 50
    });
    // Codex app-server v2 returns `data` (not `threads`) for list responses.
    const threads = Array.isArray(result?.data) ? result.data : [];
    const items = threads.map((t) => ({
      id: t.id,
      name: t.name || '',
      updatedAt: typeof t.updatedAt === 'number' ? new Date(t.updatedAt * 1000).toISOString() : null,
      preview: t.preview || '',
      source: t.source || null,
      status: t.status?.type || null
    }));
    pushRuntimeLog({
      level: 'info',
      event: 'threads_list_loaded',
      repoFullName,
      count: items.length,
      latestThreadId: items[0]?.id || null,
      latestUpdatedAt: items[0]?.updatedAt || null
    });
    return {
      items
    };
  });

  app.get('/api/models', async (_request, _reply) => {
    const result = await rpcRequest<JsonRecord>('model/list', {});
    const models = normalizeModelListResponse(result);
    pushRuntimeLog({
      level: 'info',
      event: 'models_loaded',
      count: models.length
    });
    return { models };
  });

  app.get('/api/threads/messages', async (request, reply) => {
    const query = asObject(request.query) ?? {};
    const threadId = asString(query.threadId);
    if (!threadId) {
      reply.code(400);
      return { error: 'threadId is required' };
    }
    try {
      await rpcRequest('thread/resume', { threadId });
      const read = await rpcRequest<ThreadMessageReadResult>('thread/read', { threadId, includeTurns: true });
      const model = typeof read?.thread?.model === 'string' ? read.thread.model : '';
      if (model) threadModelByThreadId.set(threadId, model);
      const items = normalizeThreadMessages(read);
      pushRuntimeLog({
        level: 'info',
        event: 'thread_messages_loaded',
        threadId,
        count: items.length
      });
      return { items, model: model || null };
    } catch (error) {
      if (isThreadMissingError(error)) {
        pushRuntimeLog({
          level: 'info',
          event: 'thread_messages_not_ready',
          threadId
        });
        return { items: [], model: null };
      }
      throw error;
    }
  });

  app.post('/api/threads/resume', async (request, reply) => {
    const body = asObject(request.body) ?? {};
    const threadId = asString(body.thread_id);
    if (!threadId) {
      reply.code(400);
      return { error: 'thread_id is required' };
    }
    try {
      const result = await rpcRequest<{ thread?: { model?: string } }>('thread/resume', { threadId });
      const model = typeof result?.thread?.model === 'string' ? result.thread.model : '';
      if (model) threadModelByThreadId.set(threadId, model);
      pushRuntimeLog({ level: 'info', event: 'thread_resumed', threadId });
      return { ok: true };
    } catch (error) {
      if (isThreadMissingError(error)) {
        pushRuntimeLog({ level: 'info', event: 'thread_resume_missing', threadId });
        reply.code(404);
        return { error: 'thread_not_found' };
      }
      throw error;
    }
  });

  app.post('/api/threads', async (request, reply) => {
    const body = asObject(request.body) ?? {};
    const model = normalizeModelId(body.model);
    const repoFullName = asString(body.repoFullName);
    if (!repoFullName) {
      reply.code(400);
      return { error: 'repoFullName is required' };
    }

    const repoPath = repoPathFromFullName(repoFullName);
    const params: JsonRecord = {
      cwd: repoPath,
      approvalPolicy: 'never',
      sandbox: 'workspace-write'
    };
    if (model) params.model = model;
    const result = await rpcRequest<{ thread?: { id?: string; model?: string } }>('thread/start', params);
    const id = result?.thread?.id;
    const resolvedModel = typeof result?.thread?.model === 'string' ? result.thread.model : model;
    if (!id) throw new Error('thread_id_missing');
    if (resolvedModel) threadModelByThreadId.set(id, resolvedModel);
    return { id };
  });

  app.post('/api/threads/ensure', async (request, reply) => {
    const body = asObject(request.body) ?? {};
    const repoFullName = asString(body.repoFullName);
    const preferredThreadId = asString(body.preferred_thread_id);
    const model = normalizeModelId(body.model);
    if (!repoFullName) {
      reply.code(400);
      return { error: 'repoFullName is required' };
    }

    if (preferredThreadId) {
      if (model) threadModelByThreadId.set(preferredThreadId, model);
      pushRuntimeLog({
        level: 'info',
        event: 'thread_ensured_preferred',
        repoFullName,
        threadId: preferredThreadId
      });
      return { id: preferredThreadId, reused: true };
    }

    const repoPath = repoPathFromFullName(repoFullName);
    const params: JsonRecord = {
      cwd: repoPath,
      approvalPolicy: 'never',
      sandbox: 'workspace-write'
    };
    if (model) params.model = model;
    const result = await rpcRequest<{ thread?: { id?: string; model?: string } }>('thread/start', params);
    const id = result?.thread?.id;
    const resolvedModel = typeof result?.thread?.model === 'string' ? result.thread.model : model;
    if (!id) throw new Error('thread_id_missing');
    if (resolvedModel) threadModelByThreadId.set(id, resolvedModel);
    pushRuntimeLog({
      level: 'info',
      event: 'thread_ensured_new',
      repoFullName,
      threadId: id
    });
    return { id, reused: false };
  });

  function attachLiveTurnStream({
    reply,
    threadId,
    turnId,
    afterSeq = 0,
    timeoutEvent,
    includeStarted = true,
    alreadyHijacked = false
  }: {
    reply: FastifyReply;
    threadId: string;
    turnId: string;
    afterSeq?: number;
    timeoutEvent: string;
    includeStarted?: boolean;
    alreadyHijacked?: boolean;
  }): void {
    if (!alreadyHijacked) {
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
    }

    let aborted = false;
    let closed = false;
    let lastSentSeq = Math.max(0, Number(afterSeq || 0));
    let timeoutHandle: NodeJS.Timeout | null = null;
    let unsubLive: (() => boolean) | null = null;

    function writeEvent(event: TurnStreamEvent): void {
      if (aborted) return;
      reply.raw.write(`${JSON.stringify(event)}\n`);
    }

    function closeStream(kind: 'done' | 'error', message: string | null = null): void {
      if (closed) return;
      closed = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      if (typeof unsubLive === 'function') {
        unsubLive();
        unsubLive = null;
      }
      if (kind === 'done') writeEvent({ type: 'done' });
      if (kind === 'error') writeEvent({ type: 'error', message: message || 'unknown_error' });
      if (!aborted) reply.raw.end();
    }

    if (includeStarted) writeEvent({ type: 'started', turnId });

    reply.raw.on('close', () => {
      aborted = true;
      closeStream('error', 'client_disconnected');
    });

    timeoutHandle = setTimeout(() => {
      pushRuntimeLog({
        level: 'error',
        event: timeoutEvent,
        threadId,
        turnId
      });
      closeStream('error', 'turn_timeout');
    }, 180000);

    unsubLive = addLiveTurnSubscriber((payload) => {
      if (aborted || closed) return;
      if (payload.threadId !== threadId || payload.turnId !== turnId) return;
      if (payload.seq <= lastSentSeq) return;
      lastSentSeq = payload.seq;
      if (payload.event.type === 'status' && payload.event.phase === 'reconnecting') {
        pushRuntimeLog({
          level: 'info',
          event: `${timeoutEvent}_reconnecting`,
          threadId,
          turnId,
          message: String(payload.event.message || 'reconnecting')
        });
      }
      if (payload.event.type === 'done') {
        closeStream('done');
        return;
      }
      if (payload.event.type === 'error') {
        closeStream('error', payload.event.message);
        return;
      }
      writeEvent(payload.event);
    });

    const existingState = liveTurnStateByThreadId.get(threadId);
    if (existingState && existingState.turnId === turnId) {
      lastSentSeq = replayLiveTurnEvents(existingState, lastSentSeq, writeEvent);
    }
  }

  app.get('/api/turns/running', async (request, reply) => {
    const query = asObject(request.query) ?? {};
    const threadId = asString(query.threadId);
    if (!threadId) {
      reply.code(400);
      return { error: 'threadId is required' };
    }
    const turnId = runningTurnByThreadId.get(threadId);
    if (!turnId) return { running: false, threadId };
    return { running: true, threadId, turnId };
  });

  app.get('/api/turns/live-state', async (request, reply) => {
    const query = asObject(request.query) ?? {};
    const threadId = asString(query.threadId);
    if (!threadId) {
      reply.code(400);
      return { error: 'threadId is required' };
    }

    const turnId = runningTurnByThreadId.get(threadId);
    if (!turnId) {
      return {
        running: false,
        threadId,
        seq: 0,
        items: [],
        liveReasoningText: ''
      };
    }

    const state = (await ensureLiveTurnStateSnapshot(threadId, turnId)) || ensureLiveTurnState(threadId, turnId);
    return {
      running: true,
      threadId,
      turnId,
      seq: state.latestSeq,
      items: state.renderItems,
      liveReasoningText: ''
    };
  });

  app.get('/api/turns/stream/resume', async (request, reply) => {
    const query = asObject(request.query) ?? {};
    const threadId = asString(query.threadId);
    const turnId = asString(query.turnId);
    const afterSeq = Number(query.afterSeq || 0);
    if (!threadId || !turnId) {
      reply.code(400);
      return { error: 'threadId and turnId are required' };
    }

    const currentTurnId = runningTurnByThreadId.get(threadId);
    if (!currentTurnId || currentTurnId !== turnId) {
      pushRuntimeLog({
        level: 'info',
        event: 'turn_stream_resume_mismatch',
        threadId,
        requestedTurnId: turnId,
        runningTurnId: currentTurnId || null
      });
      reply.code(404);
      return { error: 'running_turn_not_found' };
    }

    pushRuntimeLog({
      level: 'info',
      event: 'turn_stream_resume_start',
      threadId,
      turnId
    });

    await ensureLiveTurnStateSnapshot(threadId, turnId);
    attachLiveTurnStream({
      reply,
      threadId,
      turnId,
      afterSeq: Number.isFinite(afterSeq) ? afterSeq : 0,
      timeoutEvent: 'turn_stream_resume_timeout'
    });
  });

  app.post('/api/turns/stream', async (request, reply) => {
    const body = asObject(request.body) ?? {};
    const threadId = asString(body.thread_id);
    const prompt = String(body.input || '').trim();
    const attachments = Array.isArray(body.attachments) ? body.attachments : [];
    const selectedModel = normalizeModelId(body.model);
    const collaborationMode = normalizeCollaborationMode(body.collaboration_mode || body.mode);
    if (!threadId || !prompt) {
      reply.code(400);
      return { error: 'thread_id and input are required' };
    }
    const activeThreadId = threadId;
    pushRuntimeLog({
      level: 'info',
      event: 'turn_stream_start',
      threadId: activeThreadId,
      inputLength: prompt.length,
      collaborationMode: collaborationMode || null
    });
    const turnStartOverrides = await buildTurnStartOverrides(activeThreadId, {
      selectedModel,
      collaborationMode
    });

    if (selectedModel) threadModelByThreadId.set(activeThreadId, selectedModel);

    const pendingStreamEvents: TurnStreamEvent[] = [];
    let responseReady = false;

    function writeEvent(event: TurnStreamEvent): void {
      if (!responseReady) {
        pendingStreamEvents.push(event);
        return;
      }
      reply.raw.write(`${JSON.stringify(event)}\n`);
    }

    let turnId: string | null = null;
    try {
      turnId = await startTurnWithRetry(
        activeThreadId,
        buildTurnInput(prompt, attachments),
        20,
        ({ attempt, message }) => {
          writeEvent({ type: 'status', phase: 'starting', attempt, message });
        },
        turnStartOverrides
      );
      runningTurnByThreadId.set(activeThreadId, turnId);
      ensureLiveTurnState(activeThreadId, turnId);
    } catch (error) {
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      for (const event of pendingStreamEvents) reply.raw.write(`${JSON.stringify(event)}\n`);
      reply.raw.write(
        `${JSON.stringify({ type: 'error', message: getErrorMessage(error, 'turn_start_failed') } satisfies TurnStreamEvent)}\n`
      );
      reply.raw.end();
      return;
    }

    await ensureLiveTurnStateSnapshot(activeThreadId, turnId);
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    responseReady = true;
    for (const event of pendingStreamEvents) reply.raw.write(`${JSON.stringify(event)}\n`);
    attachLiveTurnStream({
      reply,
      threadId: activeThreadId,
      turnId,
      afterSeq: 0,
      timeoutEvent: 'turn_stream_timeout',
      alreadyHijacked: true
    });
  });

  app.post('/api/turns/cancel', async (request, reply) => {
    const body = asObject(request.body) ?? {};
    const threadId = asString(body.thread_id);
    if (!threadId) {
      reply.code(400);
      return { error: 'thread_id is required' };
    }

    const turnId = runningTurnByThreadId.get(threadId);
    if (!turnId) {
      reply.code(404);
      return { error: 'running_turn_not_found' };
    }

    await rpcRequest('turn/interrupt', { threadId, turnId });
    runningTurnByThreadId.delete(threadId);
    clearPendingUserInputForThread(threadId);
    return { cancelled: true };
  });

  app.post('/api/turns/steer', async (request, reply) => {
    const body = asObject(request.body) ?? {};
    const threadId = asString(body.thread_id);
    const turnId = asString(body.turn_id);
    const prompt = String(body.input || '').trim();
    const attachments = Array.isArray(body.attachments) ? body.attachments : [];
    if (!threadId || !turnId || !prompt) {
      reply.code(400);
      return { error: 'thread_id, turn_id and input are required' };
    }

    const runningTurnId = runningTurnByThreadId.get(threadId);
    if (!runningTurnId) {
      reply.code(409);
      return { error: 'no_active_turn' };
    }
    if (runningTurnId !== turnId) {
      reply.code(409);
      return { error: 'turn_mismatch', runningTurnId };
    }

    try {
      await rpcRequest('turn/steer', {
        threadId,
        expectedTurnId: turnId,
        input: buildTurnInput(prompt, attachments)
      });
      return { steered: true, threadId, turnId };
    } catch (error) {
      reply.code(500);
      return { error: getErrorMessage(error, 'steer_failed') };
    }
  });

  app.get('/api/approvals/pending', async (request, reply) => {
    const query = asObject(request.query) ?? {};
    const threadId = asString(query.threadId);
    if (!threadId) {
      reply.code(400);
      return { error: 'threadId is required' };
    }
    const requests: Array<PendingUserInputRequest & { createdAt: string }> = [];
    for (const pending of pendingUserInputRequestById.values()) {
      if (pending?.threadId !== threadId) continue;
      requests.push({
        requestId: pending.requestId,
        threadId: pending.threadId,
        turnId: pending.turnId,
        itemId: pending.itemId,
        questions: pending.questions,
        createdAt: pending.createdAt
      });
    }
    requests.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    return { requests };
  });

  app.post('/api/approvals/respond', async (request, reply) => {
    const body = asObject(request.body) ?? {};
    const requestIdRaw = asRequestId(body.request_id);
    if (!requestIdRaw) {
      reply.code(400);
      return { error: 'request_id is required' };
    }

    const key = String(requestIdRaw);
    const pending = pendingUserInputRequestById.get(key);
    if (!pending) {
      reply.code(404);
      return { error: 'pending_request_not_found' };
    }

    let payload = buildToolUserInputResponsePayload(body.answers);
    if (!payload.answers || Object.keys(payload.answers).length === 0) {
      const questionId = asString(body.question_id);
      const answer = asString(body.answer);
      if (questionId && answer) {
        payload = { answers: { [questionId]: { answers: [answer] } } };
      }
    }
    if (!payload.answers || Object.keys(payload.answers).length === 0) {
      reply.code(400);
      return { error: 'answers is required' };
    }

    await ensureCodexServerRunning();
    await connectWs();
    sendJsonRpcResponse(pending.requestId, payload);
    pendingUserInputRequestById.delete(key);
    pushRuntimeLog({
      level: 'info',
      event: 'request_user_input_responded',
      threadId: pending.threadId,
      turnId: pending.turnId,
      itemId: pending.itemId,
      requestId: pending.requestId
    });
    return { ok: true };
  });

  return app;
}

if (require.main === module) {
  const app = buildServer();
  app.listen({ port: PORT, host: '0.0.0.0' }).catch((error) => {
    app.log.error({ message: error.message, stack: error.stack }, 'server_start_failed');
    process.exit(1);
  });
}

export {
  buildServer,
  buildToolUserInputResponsePayload,
  buildTurnStartOverrides,
  buildCollaborationMode,
  repoFolderFromFullName,
  repoPathFromFullName,
  resolveRepoTrackedPath,
  parseStatusPath,
  diffKindFromStatusCode,
  getCloneState,
  parseGitStatusOutput,
  readGitRepoStatus,
  listRepoFiles,
  listRepoTree,
  buildRepoFileView,
  isIgnoredRepoPath,
  normalizeCollaborationMode,
  parseV2TurnNotification,
  parseLegacyTurnNotification,
  parseTurnTerminalNotification,
  selectTurnStreamUpdate,
  normalizeThreadMessages
};
