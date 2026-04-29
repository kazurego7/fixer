import type { FastifyInstance } from 'fastify';
import type { CloneState } from '../../shared/types';
import { getErrorMessage } from '../errors';
import { asObject, asString } from '../json';
import { pushRuntimeLog } from '../runtimeLogs';
import {
  buildRepoFileView,
  listRepoFiles,
  listRepoTreeAll,
  listRepoTreeDiff,
  readGitRepoStatus
} from '../services/repos';

interface RepoRouteOptions {
  getCloneState: (fullName: string) => CloneState;
  runClone: (fullName: string, cloneUrl: string) => void;
}

export function registerRepoRoutes(app: FastifyInstance, options: RepoRouteOptions): void {
  app.post('/api/repos/clone', async (request, reply) => {
    const body = asObject(request.body) ?? {};
    const fullName = asString(body.fullName);
    const cloneUrl = asString(body.cloneUrl);
    if (!fullName || !cloneUrl) {
      reply.code(400);
      return { error: 'fullName and cloneUrl are required' };
    }
    options.runClone(fullName, cloneUrl);
    reply.code(202);
    return options.getCloneState(fullName);
  });

  app.get('/api/repos/clone-status', async (request, reply) => {
    const query = asObject(request.query) ?? {};
    const fullName = asString(query.fullName);
    if (!fullName) {
      reply.code(400);
      return { error: 'fullName is required' };
    }
    return options.getCloneState(fullName);
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

  app.get('/api/repos/file-tree-diff', async (request, reply) => {
    const query = asObject(request.query) ?? {};
    const repoFullName = asString(query.repoFullName);
    if (!repoFullName) {
      reply.code(400);
      return { error: 'repoFullName is required' };
    }
    try {
      return listRepoTreeDiff(repoFullName);
    } catch (error) {
      const message = getErrorMessage(error);
      if (message === 'repo_not_cloned') {
        reply.code(404);
        return { error: message };
      }
      pushRuntimeLog({ level: 'error', event: 'repo_file_tree_diff_failed', repoFullName, message });
      reply.code(500);
      return { error: 'repo_file_tree_diff_failed', detail: message };
    }
  });

  app.get('/api/repos/file-tree-all', async (request, reply) => {
    const query = asObject(request.query) ?? {};
    const repoFullName = asString(query.repoFullName);
    if (!repoFullName) {
      reply.code(400);
      return { error: 'repoFullName is required' };
    }
    try {
      return listRepoTreeAll(repoFullName);
    } catch (error) {
      const message = getErrorMessage(error);
      if (message === 'repo_not_cloned') {
        reply.code(404);
        return { error: message };
      }
      pushRuntimeLog({ level: 'error', event: 'repo_file_tree_all_failed', repoFullName, message });
      reply.code(500);
      return { error: 'repo_file_tree_all_failed', detail: message };
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
}
