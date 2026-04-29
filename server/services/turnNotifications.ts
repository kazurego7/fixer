import { getErrorMessage } from '../errors';
import { asObject, asRequestId, asString } from '../json';
import type {
  ParsedLegacyTurnNotification,
  ParsedV2TurnNotification,
  PendingUserInputRequest,
  SelectTurnStreamState,
  SelectTurnStreamUpdateResult,
  TurnTerminalNotification,
  UserInputQuestion
} from '../../shared/types';

export function buildTurnPlanText(rawExplanation: unknown, rawPlan: unknown): string {
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

export function parseUserInputQuestions(rawQuestions: unknown): UserInputQuestion[] {
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

export function parseToolRequestUserInput(msg: unknown): PendingUserInputRequest | null {
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

export function parseThreadTokenUsageUpdatedNotification(msg: unknown): { threadId: string; totalTokens: number } | null {
  const record = asObject(msg);
  if (!record || asString(record.method) !== 'thread/tokenUsage/updated') return null;
  const params = asObject(record.params);
  const threadId = asString(params?.threadId);
  const tokenUsage = asObject(params?.tokenUsage);
  const totalRaw = tokenUsage?.total;
  const totalTokens = typeof totalRaw === 'number' ? totalRaw : Number(totalRaw);
  if (!threadId || !Number.isFinite(totalTokens)) return null;
  return { threadId, totalTokens };
}

export function parseV2TurnNotification(msg: unknown): ParsedV2TurnNotification | null {
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

export function parseLegacyTurnNotification(msg: unknown): ParsedLegacyTurnNotification | null {
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

export function parseTurnTerminalNotification(msg: unknown): TurnTerminalNotification | null {
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

export function parseV2RetryableErrorNotification(
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

export function parseTurnPlanUpdateNotification(
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

export function selectTurnStreamUpdate(msg: unknown, state: SelectTurnStreamState): SelectTurnStreamUpdateResult {
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

export function isThreadWarmupError(error: unknown): boolean {
  const message = getErrorMessage(error, '');
  return message.includes('no rollout found for thread id') || message.includes('thread_not_found') || message.includes('thread not found');
}

