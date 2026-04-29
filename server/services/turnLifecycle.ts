import { getErrorMessage } from '../errors';
import { asObject, type JsonRecord } from '../json';
import { pushRuntimeLog } from '../runtimeLogs';
import type { LiveTurnManager, LiveTurnState, ThreadMessageTurnItem } from './liveTurn';
import {
  parseThreadTokenUsageUpdatedNotification,
  parseToolRequestUserInput,
  parseTurnPlanUpdateNotification,
  parseTurnTerminalNotification,
  parseV2RetryableErrorNotification
} from './turnNotifications';
import type {
  PendingUserInputRequest,
  TurnStreamEvent,
  TurnTerminalNotification
} from '../../shared/types';

interface PendingUserInputEntry extends PendingUserInputRequest {
  createdAt: string;
}

interface PushNotifier {
  notifyThreadSubscribers(threadId: string): Promise<{ sent: number; staleRemoved: number; skipped?: string }>;
}

interface TurnLifecycleOptions {
  liveTurnManager: LiveTurnManager;
  getRunningTurnId: (threadId: string) => string | undefined;
  deleteRunningTurnId: (threadId: string) => void;
  pushService?: PushNotifier | null;
  rpcRequest: <T = unknown>(method: string, params?: JsonRecord) => Promise<T>;
  triggerIssueSummary: (threadId: string, turnId: string | null) => void;
}

export interface TurnLifecycleService {
  onMessage(msg: unknown): void;
  clearPendingUserInputForThread(threadId: string | null | undefined): void;
  listPendingRequests(threadId: string): PendingUserInputEntry[];
  getPendingRequest(requestId: string): PendingUserInputEntry | undefined;
  deletePendingRequest(requestId: string): void;
}

function rememberBounded(set: Set<string>, key: string | null | undefined, max = 5000): void {
  if (!key) return;
  set.add(key);
  if (set.size <= max) return;
  const first = set.values().next().value;
  if (first !== undefined) set.delete(first);
}

export function createTurnLifecycleService(options: TurnLifecycleOptions): TurnLifecycleService {
  const pendingUserInputRequestById = new Map<string, PendingUserInputEntry>();
  const handledTerminalTurnKeys = new Set<string>();
  const handledPushTurnKeys = new Set<string>();
  const autoCompactInFlightThreadIds = new Set<string>();
  const lastAutoCompactTokenTotalByThreadId = new Map<string, number>();
  let cachedModelAutoCompactTokenLimit: number | null | undefined;

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

  function parseV2ItemLifecycleNotification(
    msg: unknown
  ): { method: 'item/started' | 'item/completed'; threadId: string; turnId: string; item: ThreadMessageTurnItem } | null {
    const record = asObject(msg);
    if (!record) return null;
    const method = typeof record.method === 'string' ? record.method : '';
    if (method !== 'item/started' && method !== 'item/completed') return null;
    const params = asObject(record.params);
    const threadId = typeof params?.threadId === 'string' ? params.threadId : '';
    const turnId = typeof params?.turnId === 'string' ? params.turnId : '';
    const item = options.liveTurnManager.toThreadMessageTurnItem(params?.item);
    if (!threadId || !turnId || !item) return null;
    return { method, threadId, turnId, item };
  }

  function applyLiveTurnNotification(msg: unknown): void {
    const lifecycle = parseV2ItemLifecycleNotification(msg);
    if (lifecycle) {
      const state = options.liveTurnManager.ensureState(lifecycle.threadId, lifecycle.turnId);
      if (lifecycle.item.type === 'contextCompaction') {
        options.liveTurnManager.emitEvent(state, {
          type: 'status',
          phase: lifecycle.method === 'item/started' ? 'compacting' : 'compacted',
          message:
            lifecycle.method === 'item/started' ? '会話履歴を圧縮しています...' : '会話履歴を圧縮しました'
        });
      }
      options.liveTurnManager.upsertItem(state, lifecycle.item);
      const reasoningRaw = options.liveTurnManager.extractReasoningRawFromItem(lifecycle.item);
      if (reasoningRaw) state.liveReasoningRaw = reasoningRaw;
      options.liveTurnManager.emitStateSnapshot(state);
      return;
    }

    const planUpdate = parseTurnPlanUpdateNotification(msg);
    if (planUpdate) {
      const state = options.liveTurnManager.ensureState(planUpdate.threadId, planUpdate.turnId);
      const planItem = options.liveTurnManager.ensureItemByType(state, planUpdate.itemId, 'plan');
      planItem.text = planUpdate.text;
      options.liveTurnManager.emitStateSnapshot(state);
      return;
    }

    const request = parseToolRequestUserInput(msg);
    if (request) {
      const state = options.liveTurnManager.ensureState(request.threadId, request.turnId);
      options.liveTurnManager.appendBoundary(state, `request_user_input:${String(request.requestId)}`);
      options.liveTurnManager.emitStateSnapshot(state);
      options.liveTurnManager.emitEvent(state, {
        type: 'request_user_input',
        requestId: request.requestId,
        turnId: request.turnId,
        itemId: request.itemId,
        questions: request.questions
      });
      return;
    }

    const v2 = parseV2RetryableErrorNotification(msg);
    if (v2) {
      const state = options.liveTurnManager.ensureState(v2.threadId, v2.turnId);
      options.liveTurnManager.emitEvent(state, {
        type: 'status',
        phase: 'reconnecting',
        message: v2.message
      });
      return;
    }

    const record = asObject(msg);
    const method = typeof record?.method === 'string' ? record.method : '';
    const params = asObject(record?.params);
    const threadId = typeof params?.threadId === 'string' ? params.threadId : '';
    const turnId = typeof params?.turnId === 'string' ? params.turnId : typeof asObject(params?.turn)?.id === 'string' ? String(asObject(params?.turn)?.id) : '';
    const itemId =
      typeof params?.itemId === 'string'
        ? params.itemId
        : typeof asObject(params?.item)?.id === 'string'
          ? String(asObject(params?.item)?.id)
          : '';
    const delta = typeof params?.delta === 'string' ? params.delta : '';
    if (!threadId || !turnId) return;

    const state = options.liveTurnManager.ensureState(threadId, turnId);
    if (method === 'item/agentMessage/delta' && itemId && delta) {
      const item = options.liveTurnManager.ensureItemByType(state, itemId, 'agentMessage');
      item.text = `${String(item.text || '')}${delta}`;
      options.liveTurnManager.emitStateSnapshot(state);
      return;
    }
    if (method === 'item/plan/delta' && itemId && delta) {
      const item = options.liveTurnManager.ensureItemByType(state, itemId, 'plan');
      item.text = `${String(item.text || '')}${delta}`;
      options.liveTurnManager.emitStateSnapshot(state);
      return;
    }
    if ((method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') && itemId && delta) {
      const item = options.liveTurnManager.ensureItemByType(state, itemId, 'reasoning');
      if (method === 'item/reasoning/summaryTextDelta') {
        const summary = Array.isArray(item.summary) ? item.summary : [];
        if (summary.length === 0) summary.push('');
        summary[summary.length - 1] = `${String(summary[summary.length - 1] || '')}${delta}`;
        item.summary = summary;
      } else {
        const content = Array.isArray(item.content) ? item.content : [];
        if (content.length === 0) content.push({ type: 'text', text: '' });
        const last = content[content.length - 1] || { type: 'text', text: '' };
        last.text = `${String(last.text || '')}${delta}`;
        content[content.length - 1] = last;
        item.content = content;
      }
      state.liveReasoningRaw = `${state.liveReasoningRaw}${delta}`;
      options.liveTurnManager.emitStateSnapshot(state);
    }
  }

  function handleTurnTerminalNotification(terminal: TurnTerminalNotification | null): void {
    if (!terminal || !terminal.threadId) return;

    const runningTurnId = options.getRunningTurnId(terminal.threadId);
    if (terminal.turnId && runningTurnId && terminal.turnId !== runningTurnId) return;

    const effectiveTurnId = terminal.turnId || runningTurnId || null;
    const turnKey = `${terminal.threadId}:${effectiveTurnId || 'unknown'}`;
    const existingState = options.liveTurnManager.getState(terminal.threadId);
    const liveState = effectiveTurnId && existingState?.turnId === effectiveTurnId ? existingState : null;

    options.deleteRunningTurnId(terminal.threadId);
    autoCompactInFlightThreadIds.delete(terminal.threadId);
    clearPendingUserInputForThread(terminal.threadId);

    if (liveState) {
      options.liveTurnManager.emitEvent(
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
    options.triggerIssueSummary(terminal.threadId, effectiveTurnId);
    if (handledPushTurnKeys.has(turnKey) || !options.pushService) return;
    rememberBounded(handledPushTurnKeys, turnKey);

    options.pushService
      .notifyThreadSubscribers(terminal.threadId)
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

  async function resolveModelAutoCompactTokenLimit(): Promise<number | null> {
    if (typeof cachedModelAutoCompactTokenLimit !== 'undefined') return cachedModelAutoCompactTokenLimit;
    try {
      const config = await options.rpcRequest<{ config?: { model_auto_compact_token_limit?: unknown } }>('config/read', {
        includeLayers: false
      });
      const rawLimit = config?.config?.model_auto_compact_token_limit;
      const limit = typeof rawLimit === 'number' ? rawLimit : Number(rawLimit);
      cachedModelAutoCompactTokenLimit = Number.isFinite(limit) && limit > 0 ? limit : null;
    } catch {
      cachedModelAutoCompactTokenLimit = null;
    }
    return cachedModelAutoCompactTokenLimit;
  }

  function syncAutoCompactLifecycle(msg: unknown): void {
    const lifecycle = parseV2ItemLifecycleNotification(msg);
    if (!lifecycle || lifecycle.item.type !== 'contextCompaction') return;
    if (lifecycle.method === 'item/started') {
      autoCompactInFlightThreadIds.add(lifecycle.threadId);
      return;
    }
    autoCompactInFlightThreadIds.delete(lifecycle.threadId);
  }

  async function maybeTriggerAutoCompaction(msg: unknown): Promise<void> {
    syncAutoCompactLifecycle(msg);

    const tokenUsage = parseThreadTokenUsageUpdatedNotification(msg);
    if (!tokenUsage) return;

    const limit = await resolveModelAutoCompactTokenLimit();
    if (!limit || tokenUsage.totalTokens < limit) {
      lastAutoCompactTokenTotalByThreadId.delete(tokenUsage.threadId);
      return;
    }
    if (autoCompactInFlightThreadIds.has(tokenUsage.threadId)) return;

    const lastTriggeredTotal = lastAutoCompactTokenTotalByThreadId.get(tokenUsage.threadId) || 0;
    if (lastTriggeredTotal >= tokenUsage.totalTokens) return;

    lastAutoCompactTokenTotalByThreadId.set(tokenUsage.threadId, tokenUsage.totalTokens);
    autoCompactInFlightThreadIds.add(tokenUsage.threadId);
    pushRuntimeLog({
      level: 'info',
      event: 'thread_auto_compact_start',
      threadId: tokenUsage.threadId,
      totalTokens: tokenUsage.totalTokens,
      tokenLimit: limit
    });

    try {
      await options.rpcRequest('thread/compact/start', { threadId: tokenUsage.threadId });
    } catch (error) {
      autoCompactInFlightThreadIds.delete(tokenUsage.threadId);
      pushRuntimeLog({
        level: 'error',
        event: 'thread_auto_compact_failed',
        threadId: tokenUsage.threadId,
        totalTokens: tokenUsage.totalTokens,
        tokenLimit: limit,
        message: getErrorMessage(error)
      });
    }
  }

  return {
    onMessage(msg: unknown): void {
      const record = asObject(msg);
      if (!record) return;
      const terminal = parseTurnTerminalNotification(record);
      if (terminal) handleTurnTerminalNotification(terminal);
      const userInputRequest = parseToolRequestUserInput(record);
      if (userInputRequest) rememberPendingUserInputRequest(userInputRequest);
      applyLiveTurnNotification(record);
      void maybeTriggerAutoCompaction(record);
    },

    clearPendingUserInputForThread,

    listPendingRequests(threadId: string): PendingUserInputEntry[] {
      const requests: PendingUserInputEntry[] = [];
      for (const pending of pendingUserInputRequestById.values()) {
        if (pending?.threadId !== threadId) continue;
        requests.push({ ...pending });
      }
      return requests;
    },

    getPendingRequest(requestId: string): PendingUserInputEntry | undefined {
      return pendingUserInputRequestById.get(requestId);
    },

    deletePendingRequest(requestId: string): void {
      pendingUserInputRequestById.delete(requestId);
    }
  };
}

