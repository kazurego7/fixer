import type { FastifyInstance } from 'fastify';
import type { CollaborationMode, OutputItem } from '../../shared/types';
import type { ThreadMessageReadResult } from '../services/liveTurn';
import { getErrorMessage } from '../errors';
import { asObject, asString, type JsonRecord } from '../json';
import { pushRuntimeLog } from '../runtimeLogs';

interface ThreadListResponse {
  data?: Array<{
    id?: string;
    name?: string;
    updatedAt?: number;
    preview?: string;
    source?: string | null;
    status?: { type?: string | null };
  }>;
}

interface ThreadStartResponse {
  thread?: { id?: string; model?: string };
}

interface ThreadResumeResponse {
  thread?: { model?: string };
}

interface ThreadRouteOptions {
  rpcRequest: <T = unknown>(method: string, params?: JsonRecord) => Promise<T>;
  repoPathFromFullName: (fullName: string) => string;
  normalizeThreadMessages: (readResult: ThreadMessageReadResult) => OutputItem[];
  isThreadMissingError: (error: unknown) => boolean;
  normalizeModelId: (value: unknown) => string | null;
  setThreadModel: (threadId: string, model: string) => void;
  sandbox: string;
}

export function registerThreadRoutes(app: FastifyInstance, options: ThreadRouteOptions): void {
  app.get('/api/threads', async (request, reply) => {
    const query = asObject(request.query) ?? {};
    const repoFullName = asString(query.repoFullName);
    if (!repoFullName) {
      reply.code(400);
      return { error: 'repoFullName is required' };
    }
    const repoPath = options.repoPathFromFullName(repoFullName);
    const result = await options.rpcRequest<ThreadListResponse>('thread/list', {
      cwd: repoPath,
      archived: false,
      limit: 50
    });
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
    return { items };
  });

  app.get('/api/threads/messages', async (request, reply) => {
    const query = asObject(request.query) ?? {};
    const threadId = asString(query.threadId);
    if (!threadId) {
      reply.code(400);
      return { error: 'threadId is required' };
    }
    try {
      await options.rpcRequest('thread/resume', { threadId });
      const read = await options.rpcRequest<ThreadMessageReadResult>('thread/read', { threadId, includeTurns: true });
      const model = typeof read?.thread?.model === 'string' ? read.thread.model : '';
      if (model) options.setThreadModel(threadId, model);
      const items = options.normalizeThreadMessages(read);
      pushRuntimeLog({
        level: 'info',
        event: 'thread_messages_loaded',
        threadId,
        count: items.length
      });
      return { items, model: model || null };
    } catch (error) {
      if (options.isThreadMissingError(error)) {
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
      const result = await options.rpcRequest<ThreadResumeResponse>('thread/resume', { threadId });
      const model = typeof result?.thread?.model === 'string' ? result.thread.model : '';
      if (model) options.setThreadModel(threadId, model);
      pushRuntimeLog({ level: 'info', event: 'thread_resumed', threadId });
      return { ok: true };
    } catch (error) {
      if (options.isThreadMissingError(error)) {
        pushRuntimeLog({ level: 'info', event: 'thread_resume_missing', threadId });
        reply.code(404);
        return { error: 'thread_not_found' };
      }
      throw error;
    }
  });

  app.post('/api/threads', async (request, reply) => {
    const body = asObject(request.body) ?? {};
    const model = options.normalizeModelId(body.model);
    const repoFullName = asString(body.repoFullName);
    if (!repoFullName) {
      reply.code(400);
      return { error: 'repoFullName is required' };
    }

    const repoPath = options.repoPathFromFullName(repoFullName);
    const params: JsonRecord = {
      cwd: repoPath,
      approvalPolicy: 'never',
      sandbox: options.sandbox
    };
    if (model) params.model = model;
    const result = await options.rpcRequest<ThreadStartResponse>('thread/start', params);
    const id = result?.thread?.id;
    const resolvedModel = typeof result?.thread?.model === 'string' ? result.thread.model : model;
    if (!id) throw new Error('thread_id_missing');
    if (resolvedModel) options.setThreadModel(id, resolvedModel);
    return { id };
  });

  app.post('/api/threads/ensure', async (request, reply) => {
    const body = asObject(request.body) ?? {};
    const repoFullName = asString(body.repoFullName);
    const preferredThreadId = asString(body.preferred_thread_id);
    const model = options.normalizeModelId(body.model);
    if (!repoFullName) {
      reply.code(400);
      return { error: 'repoFullName is required' };
    }

    if (preferredThreadId) {
      if (model) options.setThreadModel(preferredThreadId, model);
      pushRuntimeLog({
        level: 'info',
        event: 'thread_ensured_preferred',
        repoFullName,
        threadId: preferredThreadId
      });
      return { id: preferredThreadId, reused: true };
    }

    const repoPath = options.repoPathFromFullName(repoFullName);
    const params: JsonRecord = {
      cwd: repoPath,
      approvalPolicy: 'never',
      sandbox: options.sandbox
    };
    if (model) params.model = model;
    const result = await options.rpcRequest<ThreadStartResponse>('thread/start', params);
    const id = result?.thread?.id;
    const resolvedModel = typeof result?.thread?.model === 'string' ? result.thread.model : model;
    if (!id) throw new Error('thread_id_missing');
    if (resolvedModel) options.setThreadModel(id, resolvedModel);
    pushRuntimeLog({
      level: 'info',
      event: 'thread_ensured_new',
      repoFullName,
      threadId: id
    });
    return { id, reused: false };
  });
}
