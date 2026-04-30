import type { FastifyInstance, FastifyReply } from 'fastify';
import type { CollaborationMode, TurnStreamEvent, TurnStartOverrides } from '../../shared/types';
import type { LiveTurnState } from '../services/liveTurn';
import { pushRuntimeLog } from '../infra/runtimeLogs';
import { getErrorMessage } from '../lib/errors';
import { asObject, asString } from '../lib/json';

interface ThreadStartRetryPayload {
  attempt: number;
  message: string;
}

interface TurnRouteOptions {
  getRunningTurnId: (threadId: string) => string | undefined;
  setRunningTurnId: (threadId: string, turnId: string) => void;
  deleteRunningTurnId: (threadId: string) => void;
  clearPendingUserInputForThread: (threadId: string) => void;
  ensureLiveTurnStateSnapshot: (threadId: string, turnId: string) => Promise<LiveTurnState | null>;
  liveTurnManager: {
    ensureState(threadId: string, turnId: string): LiveTurnState;
    getState(threadId: string): LiveTurnState | null;
    replayEvents(state: LiveTurnState, afterSeq: number, writeEvent: (event: TurnStreamEvent) => void): number;
    subscribe(handler: (payload: { threadId: string; turnId: string; seq: number; event: TurnStreamEvent }) => void): () => boolean;
  };
  startTurnWithRetry: (
    threadId: string,
    input: Array<{ type: 'text'; text: string } | { type: 'image'; url: string }>,
    maxAttempts?: number,
    onRetry?: ((payload: ThreadStartRetryPayload) => void) | null,
    overrides?: TurnStartOverrides | null
  ) => Promise<string>;
  buildTurnInput: (
    prompt: string,
    attachments: Array<{ type?: string; dataUrl?: string }> | null | undefined
  ) => Array<{ type: 'text'; text: string } | { type: 'image'; url: string }>;
  buildTurnStartOverrides: (
    threadId: string,
    options: { selectedModel?: string; collaborationMode?: CollaborationMode | null }
  ) => Promise<TurnStartOverrides>;
  normalizeModelId: (value: unknown) => string | null;
  normalizeCollaborationMode: (value: unknown) => CollaborationMode | null;
  setThreadModel: (threadId: string, model: string) => void;
  rpcRequest: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
}

export function registerTurnRoutes(app: FastifyInstance, options: TurnRouteOptions): void {
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

    unsubLive = options.liveTurnManager.subscribe((payload) => {
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

    const existingState = options.liveTurnManager.getState(threadId);
    if (existingState && existingState.turnId === turnId) {
      lastSentSeq = options.liveTurnManager.replayEvents(existingState, lastSentSeq, writeEvent);
    }
  }

  app.get('/api/turns/running', async (request, reply) => {
    const query = asObject(request.query) ?? {};
    const threadId = asString(query.threadId);
    if (!threadId) {
      reply.code(400);
      return { error: 'threadId is required' };
    }
    const turnId = options.getRunningTurnId(threadId);
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

    const turnId = options.getRunningTurnId(threadId);
    if (!turnId) {
      return {
        running: false,
        threadId,
        seq: 0,
        items: [],
        liveReasoningText: ''
      };
    }

    const state =
      (await options.ensureLiveTurnStateSnapshot(threadId, turnId)) || options.liveTurnManager.ensureState(threadId, turnId);
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

    const currentTurnId = options.getRunningTurnId(threadId);
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

    await options.ensureLiveTurnStateSnapshot(threadId, turnId);
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
    const selectedModel = options.normalizeModelId(body.model);
    const collaborationMode = options.normalizeCollaborationMode(body.collaboration_mode || body.mode);
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
    const turnStartOverridesOptions: { selectedModel?: string; collaborationMode?: CollaborationMode | null } = {};
    if (selectedModel) turnStartOverridesOptions.selectedModel = selectedModel;
    if (collaborationMode !== undefined) turnStartOverridesOptions.collaborationMode = collaborationMode;
    const turnStartOverrides = await options.buildTurnStartOverrides(activeThreadId, turnStartOverridesOptions);

    if (selectedModel) options.setThreadModel(activeThreadId, selectedModel);

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
      turnId = await options.startTurnWithRetry(
        activeThreadId,
        options.buildTurnInput(prompt, attachments),
        20,
        ({ attempt, message }) => {
          writeEvent({ type: 'status', phase: 'starting', attempt, message });
        },
        turnStartOverrides
      );
      options.setRunningTurnId(activeThreadId, turnId);
      options.liveTurnManager.ensureState(activeThreadId, turnId);
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

    await options.ensureLiveTurnStateSnapshot(activeThreadId, turnId);
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

    const turnId = options.getRunningTurnId(threadId);
    if (!turnId) {
      reply.code(404);
      return { error: 'running_turn_not_found' };
    }

    await options.rpcRequest('turn/interrupt', { threadId, turnId });
    options.deleteRunningTurnId(threadId);
    options.clearPendingUserInputForThread(threadId);
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

    const runningTurnId = options.getRunningTurnId(threadId);
    if (!runningTurnId) {
      reply.code(409);
      return { error: 'no_active_turn' };
    }
    if (runningTurnId !== turnId) {
      reply.code(409);
      return { error: 'turn_mismatch', runningTurnId };
    }

    try {
      await options.rpcRequest('turn/steer', {
        threadId,
        expectedTurnId: turnId,
        input: options.buildTurnInput(prompt, attachments)
      });
      return { steered: true, threadId, turnId };
    } catch (error) {
      reply.code(500);
      return { error: getErrorMessage(error, 'steer_failed') };
    }
  });
}
