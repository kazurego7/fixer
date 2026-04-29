import type { FastifyInstance } from 'fastify';
import { asObject, asString } from '../json';
import { pushRuntimeLog } from '../runtimeLogs';
import type { IssueService } from '../services/issues';

interface IssueRouteOptions {
  issueService: IssueService;
  getRunningTurnId: (threadId: string) => string | undefined;
  triggerSummarize: (threadId: string, turnId: string | null) => void;
}

export function registerIssueRoutes(app: FastifyInstance, options: IssueRouteOptions): void {
  app.get('/api/issues', async (request, reply) => {
    const query = asObject(request.query) ?? {};
    const repoFullName = asString(query.repoFullName);
    if (!repoFullName) {
      reply.code(400);
      return { error: 'repoFullName is required' };
    }
    return { issues: options.issueService.listIssues(repoFullName) };
  });

  app.post('/api/issues/markers', async (request, reply) => {
    const body = asObject(request.body) ?? {};
    const repoFullName = asString(body.repoFullName);
    const sourceThreadId = asString(body.threadId || body.sourceThreadId);
    const sourceTurnId = asString(body.turnId || body.sourceTurnId);
    if (!repoFullName || !sourceThreadId || !sourceTurnId) {
      reply.code(400);
      return { error: 'repoFullName, threadId and turnId are required' };
    }
    const marker = options.issueService.createIssueMarker({ repoFullName, sourceThreadId, sourceTurnId });
    pushRuntimeLog({
      level: 'info',
      event: 'issue_marker_created',
      repoFullName,
      sourceThreadId,
      sourceTurnId,
      markerId: marker.id
    });
    if (options.getRunningTurnId(sourceThreadId) !== sourceTurnId) {
      options.triggerSummarize(sourceThreadId, sourceTurnId);
    }
    return { marker };
  });

  app.patch('/api/issues/:id', async (request, reply) => {
    const params = asObject(request.params) ?? {};
    const body = asObject(request.body) ?? {};
    const id = asString(params.id);
    const status = asString(body.status);
    if (!id) {
      reply.code(400);
      return { error: 'id is required' };
    }
    if (status !== 'open' && status !== 'resolved') {
      reply.code(400);
      return { error: 'status must be open or resolved' };
    }
    const issue = options.issueService.updateIssueStatus(id, status);
    if (!issue) {
      reply.code(404);
      return { error: 'issue_not_found' };
    }
    return { issue };
  });
}
