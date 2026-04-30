import type { FastifyInstance } from 'fastify';
import { listRuntimeLogs } from '../infra/runtimeLogs';
import { asObject, asString } from '../lib/json';

interface HealthRouteOptions {
  workspaceRoot: string;
  codexAppServerWsUrl: string;
}

export function registerHealthRoutes(app: FastifyInstance, options: HealthRouteOptions): void {
  app.get('/api/health', async () => ({
    ok: true,
    workspaceRoot: options.workspaceRoot,
    codexMode: 'app-server',
    codexAppServerWsUrl: options.codexAppServerWsUrl,
    codexAutostartEnabled: true
  }));

  app.get('/api/logs', async (request) => {
    const query = asObject(request.query) ?? {};
    return listRuntimeLogs({ level: asString(query.level), limit: Number(query.limit || 200) });
  });
}
