import type { FastifyInstance } from 'fastify';
import type { PendingUserInputRequest, UserInputAnswerMap } from '../../shared/types';
import { pushRuntimeLog } from '../infra/runtimeLogs';
import { asObject, asRequestId, asString, type JsonRecord } from '../lib/json';

interface ApprovalsRouteOptions {
  listPendingRequests: (threadId: string) => Array<PendingUserInputRequest & { createdAt: string }>;
  getPendingRequest: (requestId: string) => (PendingUserInputRequest & { createdAt: string }) | undefined;
  deletePendingRequest: (requestId: string) => void;
  buildToolUserInputResponsePayload: (answersMap: unknown) => { answers: UserInputAnswerMap };
  ensureCodexServerRunning: () => Promise<void>;
  sendJsonRpcResponse: (id: string | number, result: JsonRecord) => void;
}

export function registerApprovalRoutes(app: FastifyInstance, options: ApprovalsRouteOptions): void {
  app.get('/api/approvals/pending', async (request, reply) => {
    const query = asObject(request.query) ?? {};
    const threadId = asString(query.threadId);
    if (!threadId) {
      reply.code(400);
      return { error: 'threadId is required' };
    }
    const requests = options.listPendingRequests(threadId).sort((a, b) =>
      String(a.createdAt).localeCompare(String(b.createdAt))
    );
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
    const pending = options.getPendingRequest(key);
    if (!pending) {
      reply.code(404);
      return { error: 'pending_request_not_found' };
    }

    let payload = options.buildToolUserInputResponsePayload(body.answers);
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

    await options.ensureCodexServerRunning();
    options.sendJsonRpcResponse(pending.requestId, payload);
    options.deletePendingRequest(key);
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
}
