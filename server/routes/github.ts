import type { FastifyInstance } from 'fastify';
import type { CloneState } from '../../shared/types';
import { pushRuntimeLog } from '../infra/runtimeLogs';
import { getErrorMessage } from '../lib/errors';
import { asObject, asString } from '../lib/json';
import { getGhStatus, githubCreateRepo, githubRepos, githubUser } from '../services/github';

interface GithubRouteOptions {
  getCloneState: (fullName: string) => CloneState;
}

export function registerGithubRoutes(app: FastifyInstance, options: GithubRouteOptions): void {
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
    const repos = await githubRepos(status.token, query, options.getCloneState);
    return { repos };
  });

  app.post('/api/github/repos', async (request, reply) => {
    const body = asObject(request.body) ?? {};
    const status = getGhStatus();
    if (!status.available) {
      reply.code(503);
      return { error: 'gh_not_available', hint: status.hint };
    }
    if (!status.connected) {
      reply.code(401);
      return { error: 'gh_not_logged_in', hint: status.hint };
    }

    const name = asString(body.name).trim();
    const visibility = asString(body.visibility).trim();
    if (!name) {
      reply.code(400);
      return { error: 'repo_name_required' };
    }
    if (visibility !== 'public' && visibility !== 'private') {
      reply.code(400);
      return { error: 'visibility_invalid' };
    }

    try {
      const repo = await githubCreateRepo(status.token, name, visibility === 'private', options.getCloneState);
      pushRuntimeLog({
        level: 'info',
        event: 'github_repo_created',
        fullName: repo.fullName,
        visibility
      });
      return { repo };
    } catch (error) {
      const message = getErrorMessage(error);
      pushRuntimeLog({
        level: 'error',
        event: 'github_repo_create_failed',
        name,
        visibility,
        message
      });
      reply.code(400);
      return { error: 'github_repo_create_failed', detail: message };
    }
  });
}
