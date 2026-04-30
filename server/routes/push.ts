import type { FastifyInstance } from 'fastify';
import { pushRuntimeLog } from '../infra/runtimeLogs';
import { asObject } from '../lib/json';
import type { PushService } from '../services/push';

interface PushRouteOptions {
  pushService: PushService;
}

export function registerPushRoutes(app: FastifyInstance, options: PushRouteOptions): void {
  app.get('/api/push/config', async () => options.pushService.getConfig());

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
    const record = options.pushService.subscribe({
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
    const record = options.pushService.setContext(endpoint, body.threadId ? String(body.threadId) : null);
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
    const removed = options.pushService.unsubscribe(endpoint);
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
}
