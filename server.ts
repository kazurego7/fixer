import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyRequest
} from 'fastify';
import fastifyStatic from '@fastify/static';
import { createAppServerClient, type AppServerClient } from './server/services/appServerClient';
import {
  createLiveTurnManager,
  type LiveTurnState,
  type ThreadMessageReadResult
} from './server/services/liveTurn';
import { createIssueSummaryService, parseIssueSummaryOutput } from './server/services/issueSummary';
import { normalizeThreadMessages, normalizeTurnMessages } from './server/services/messageNormalization';
import { createThreadRuntimeService } from './server/services/threadRuntime';
import { createTurnLifecycleService } from './server/services/turnLifecycle';
import {
  parseLegacyTurnNotification,
  parseThreadTokenUsageUpdatedNotification,
  parseTurnTerminalNotification,
  parseV2TurnNotification,
  selectTurnStreamUpdate
} from './server/services/turnNotifications';
import {
  DEFAULT_MODEL_FALLBACK,
  DEFAULT_THREAD_SANDBOX,
  buildCollaborationMode,
  buildTurnStartOverridesWithModelResolver,
  normalizeCollaborationMode,
  normalizeModelId,
  normalizeModelListResponse
} from './server/collaboration';
import { getErrorMessage } from './server/errors';
import { diffKindFromStatusCode, parseGitStatusOutput, parseStatusPath } from './server/gitParsing';
import { asObject, asString, type JsonRecord } from './server/json';
import { registerGithubRoutes } from './server/routes/github';
import { registerIssueRoutes } from './server/routes/issues';
import { registerPushRoutes } from './server/routes/push';
import { registerRepoRoutes } from './server/routes/repos';
import { registerThreadRoutes } from './server/routes/threads';
import { registerTurnRoutes } from './server/routes/turns';
import { registerApprovalRoutes } from './server/routes/approvals';
import { pushRuntimeLog } from './server/runtimeLogs';
import { registerHealthRoutes } from './server/routes/health';
import { registerSpaRoutes } from './server/routes/spa';
import { createIssueService, type IssueService } from './server/services/issues';
import { createPushService, type PushService } from './server/services/push';
import { WORKSPACE_ROOT, repoFolderFromFullName, repoPathFromFullName } from './server/workspace';
import {
  buildRepoFileView,
  isIgnoredRepoPath,
  listRepoFiles,
  listRepoTreeAll,
  listRepoTreeDiff,
  readGitRepoStatus,
  resolveRepoTrackedPath
} from './server/services/repos';
import { extractDisplayReasoningText } from './shared/reasoning';
import type {
  CloneState,
  CollaborationMode,
  RepoSummary,
  TurnStartOverrides,
  TurnStreamEvent,
  UserInputAnswerMap
} from './shared/types';

declare module 'fastify' {
  interface FastifyRequest {
    startTime?: bigint;
  }
}

interface CloneJobState {
  status: CloneState['status'];
  error?: string;
}

interface StartTurnRetryPayload {
  attempt: number;
  message: string;
}

interface TurnInputTextItem {
  type: 'text';
  text: string;
}

interface TurnInputImageItem {
  type: 'image';
  url: string;
}

type TurnInputItem = TurnInputTextItem | TurnInputImageItem;

const PORT = Number(process.env.PORT || 3000);
const CODEX_APP_SERVER_WS_URL = 'ws://127.0.0.1:39080';
const CODEX_APP_SERVER_START_CMD = `codex app-server --listen ${CODEX_APP_SERVER_WS_URL}`;
const CODEX_APP_SERVER_STARTUP_TIMEOUT_MS = 15000;

const PUSH_SUBSCRIPTIONS_PATH = path.join(WORKSPACE_ROOT, 'push-subscriptions.json');
const PUSH_VAPID_PATH = path.join(WORKSPACE_ROOT, 'push-vapid.json');
const ISSUE_STORE_PATH = path.join(WORKSPACE_ROOT, 'issues.json');
const cloneJobs = new Map<string, CloneJobState>();
const runningTurnByThreadId = new Map<string, string>();
let issueService: IssueService | null = null;
let liveTurnSeq = 1;

let appServerClient: AppServerClient | null = null;
const liveTurnManager = createLiveTurnManager({
  normalizeTurnMessages,
  extractDisplayReasoningText,
  nextSeq: () => {
    const seq = liveTurnSeq;
    liveTurnSeq += 1;
    return seq;
  }
});
let pushService: PushService | null = null;
let turnLifecycleService: ReturnType<typeof createTurnLifecycleService> | null = null;
let threadRuntimeService: ReturnType<typeof createThreadRuntimeService> | null = null;
let issueSummaryService: ReturnType<typeof createIssueSummaryService> | null = null;

function addLiveTurnSubscriber(
  handler: (payload: { threadId: string; turnId: string; seq: number; event: TurnStreamEvent }) => void
): () => boolean {
  return liveTurnManager.subscribe(handler);
}

async function ensureLiveTurnStateSnapshot(threadId: string, turnId: string): Promise<LiveTurnState | null> {
  const existing = liveTurnManager.getState(threadId);
  if (existing && existing.turnId === turnId) return existing;
  try {
    await rpcRequest('thread/resume', { threadId });
    const read = await rpcRequest<ThreadMessageReadResult>('thread/read', { threadId, includeTurns: true });
    const turns = Array.isArray(read?.thread?.turns) ? read.thread.turns : [];
    const turn = turns.find((entry) => entry?.id === turnId) || null;
    if (!turn) return null;
    return liveTurnManager.hydrateFromTurn(turnId, threadId, turn);
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rpcRequest<T = unknown>(method: string, params?: JsonRecord): Promise<T> {
  if (!appServerClient) throw new Error('app_server_client_uninitialized');
  return appServerClient.rpcRequest<T>(method, params);
}

function buildTurnInput(prompt: string, attachments: Array<{ type?: string; dataUrl?: string }> | null | undefined): TurnInputItem[] {
  const input: TurnInputItem[] = [{ type: 'text', text: String(prompt || '') }];
  const list = Array.isArray(attachments) ? attachments : [];
  for (const att of list) {
    if (!att || att.type !== 'image' || !att.dataUrl) continue;
    input.push({ type: 'image', url: String(att.dataUrl) });
  }
  return input;
}

async function buildTurnStartOverrides(
  threadId: string,
  options: { selectedModel?: string; collaborationMode?: CollaborationMode | null } = {}
) {
  if (!threadRuntimeService) {
    return buildTurnStartOverridesWithModelResolver(threadId, options, async () => DEFAULT_MODEL_FALLBACK);
  }
  return threadRuntimeService.buildTurnStartOverrides(threadId, options);
}

function isThreadMissingError(error: unknown): boolean {
  return threadRuntimeService?.isThreadMissingError(error) || false;
}

async function startTurnWithRetry(
  threadId: string,
  input: TurnInputItem[],
  maxAttempts = 20,
  onRetry: ((payload: StartTurnRetryPayload) => void) | null = null,
  overrides: TurnStartOverrides | null = null
): Promise<string> {
  if (!threadRuntimeService) throw new Error('thread_runtime_uninitialized');
  return threadRuntimeService.startTurnWithRetry(threadId, input, maxAttempts, onRetry, overrides);
}

function buildToolUserInputResponsePayload(answersMap: unknown): { answers: UserInputAnswerMap } {
  const src = answersMap && typeof answersMap === 'object' ? (answersMap as Record<string, unknown>) : {};
  const answers: UserInputAnswerMap = {};
  for (const [questionId, answerValue] of Object.entries(src)) {
    if (!questionId) continue;
    if (Array.isArray(answerValue)) {
      const list = answerValue.map((v) => String(v || '').trim()).filter(Boolean);
      if (list.length > 0) answers[questionId] = { answers: list };
      continue;
    }
    const answerRecord = asObject(answerValue);
    if (answerRecord && Array.isArray(answerRecord.answers)) {
      const list = answerRecord.answers.map((v: unknown) => String(v || '').trim()).filter(Boolean);
      if (list.length > 0) answers[questionId] = { answers: list };
      continue;
    }
    const single = String(answerValue || '').trim();
    if (single) answers[questionId] = { answers: [single] };
  }
  return { answers };
}

async function summarizeIssueMarkersForTurn(sourceThreadId: string, sourceTurnId: string | null): Promise<void> {
  await issueSummaryService?.summarizeIssueMarkersForTurn(sourceThreadId, sourceTurnId);
}

async function ensureCodexServerRunning(): Promise<void> {
  if (!appServerClient) throw new Error('app_server_client_uninitialized');
  await appServerClient.ensureServerRunning();
}

function getCloneState(fullName: string): CloneState {
  const repoPath = repoPathFromFullName(fullName);
  const job = cloneJobs.get(fullName);

  if (job?.status === 'cloning') return { status: 'cloning', repoPath };
  if (job?.status === 'failed') return job.error ? { status: 'failed', repoPath, error: job.error } : { status: 'failed', repoPath };
  if (fs.existsSync(path.join(repoPath, '.git'))) return { status: 'cloned', repoPath };
  return { status: 'not_cloned', repoPath };
}

function runClone(fullName: string, cloneUrl: string): void {
  const repoPath = repoPathFromFullName(fullName);
  if (fs.existsSync(path.join(repoPath, '.git'))) {
    cloneJobs.set(fullName, { status: 'cloned' });
    pushRuntimeLog({ level: 'info', event: 'clone_skipped_already_cloned', fullName, repoPath });
    return;
  }

  cloneJobs.set(fullName, { status: 'cloning' });
  pushRuntimeLog({ level: 'info', event: 'clone_started', fullName, repoPath, cloneUrl });
  const child = spawn('git', ['clone', '--depth', '1', cloneUrl, repoPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';

  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  child.on('close', (code: number | null) => {
    if (code === 0) {
      cloneJobs.set(fullName, { status: 'cloned' });
      pushRuntimeLog({ level: 'info', event: 'clone_succeeded', fullName, repoPath });
      return;
    }
    const error = stderr.trim() || `git clone exited with code ${code}`;
    cloneJobs.set(fullName, { status: 'failed', error });
    pushRuntimeLog({ level: 'error', event: 'clone_failed', fullName, repoPath, error });
  });
}

function buildServer(): FastifyInstance {
  appServerClient = createAppServerClient({
    wsUrl: CODEX_APP_SERVER_WS_URL,
    startCommand: CODEX_APP_SERVER_START_CMD,
    startupTimeoutMs: CODEX_APP_SERVER_STARTUP_TIMEOUT_MS,
    onMessage(msg) {
      turnLifecycleService?.onMessage(msg);
    },
    onLog(entry) {
      pushRuntimeLog(entry);
    }
  });
  issueService = createIssueService({
    issueStorePath: ISSUE_STORE_PATH
  });
  pushService = createPushService({
    subscriptionsPath: PUSH_SUBSCRIPTIONS_PATH,
    vapidPath: PUSH_VAPID_PATH
  });
  threadRuntimeService = createThreadRuntimeService({
    rpcRequest,
    defaultModelFallback: DEFAULT_MODEL_FALLBACK
  });
  issueSummaryService = createIssueSummaryService({
    issueService,
    repoPathFromFullName,
    defaultThreadSandbox: DEFAULT_THREAD_SANDBOX,
    rpcRequest,
    startTurnWithRetry,
    buildTurnInput,
    normalizeTurnMessages,
    setThreadModel(threadId, model) {
      threadRuntimeService?.setThreadModel(threadId, model);
    }
  });
  turnLifecycleService = createTurnLifecycleService({
    liveTurnManager,
    getRunningTurnId(threadId) {
      return runningTurnByThreadId.get(threadId);
    },
    deleteRunningTurnId(threadId) {
      runningTurnByThreadId.delete(threadId);
    },
    pushService,
    rpcRequest,
    triggerIssueSummary(threadId, turnId) {
      void summarizeIssueMarkersForTurn(threadId, turnId);
    }
  });

  const app = Fastify({ logger: { level: 'info' } }) as FastifyInstance;

  app.register(fastifyStatic, {
    root: path.join(process.cwd(), 'public'),
    prefix: '/'
  });

  app.addHook('onRequest', async (request) => {
    request.startTime = process.hrtime.bigint();
  });

  app.addHook('onResponse', async (request, reply) => {
    const end = process.hrtime.bigint();
    const start = request.startTime ?? end;
    const durationMs = Number(end - start) / 1e6;
    const log = {
      requestId: request.id,
      method: request.method,
      path: request.url,
      statusCode: reply.statusCode,
      durationMs: Number(durationMs.toFixed(2))
    };
    pushRuntimeLog({ level: 'info', event: 'request_completed', ...log });
    request.log.info(log, 'request_completed');
  });

  app.setErrorHandler((error: Error, request, reply) => {
    const log = {
      requestId: request.id,
      path: request.url,
      method: request.method,
      message: getErrorMessage(error),
      stack: error.stack
    };
    pushRuntimeLog({ level: 'error', event: 'request_failed', ...log });
    request.log.error(log, 'request_failed');
    reply.code(500).send({ error: getErrorMessage(error, 'internal_error'), requestId: request.id });
  });

  registerSpaRoutes(app);
  registerHealthRoutes(app, {
    workspaceRoot: WORKSPACE_ROOT,
    codexAppServerWsUrl: CODEX_APP_SERVER_WS_URL
  });
  registerGithubRoutes(app, { getCloneState });
  registerIssueRoutes(app, {
    issueService,
    getRunningTurnId(threadId) {
      return runningTurnByThreadId.get(threadId);
    },
    triggerSummarize(threadId, turnId) {
      void summarizeIssueMarkersForTurn(threadId, turnId);
    }
  });
  registerPushRoutes(app, { pushService });
  registerRepoRoutes(app, { getCloneState, runClone });
  registerThreadRoutes(app, {
    rpcRequest,
    repoPathFromFullName,
    normalizeThreadMessages,
    isThreadMissingError,
    normalizeModelId,
    setThreadModel(threadId, model) {
      threadRuntimeService?.setThreadModel(threadId, model);
    },
    sandbox: DEFAULT_THREAD_SANDBOX
  });

  app.get('/api/models', async (_request, _reply) => {
    const result = await rpcRequest<JsonRecord>('model/list', {});
    const models = normalizeModelListResponse(result);
    pushRuntimeLog({
      level: 'info',
      event: 'models_loaded',
      count: models.length
    });
    return { models };
  });

  registerTurnRoutes(app, {
    getRunningTurnId(threadId) {
      return runningTurnByThreadId.get(threadId);
    },
    setRunningTurnId(threadId, turnId) {
      runningTurnByThreadId.set(threadId, turnId);
    },
    deleteRunningTurnId(threadId) {
      runningTurnByThreadId.delete(threadId);
    },
    clearPendingUserInputForThread(threadId) {
      turnLifecycleService?.clearPendingUserInputForThread(threadId);
    },
    ensureLiveTurnStateSnapshot,
    liveTurnManager,
    startTurnWithRetry,
    buildTurnInput,
    buildTurnStartOverrides,
    normalizeModelId,
    normalizeCollaborationMode,
    setThreadModel(threadId, model) {
      threadRuntimeService?.setThreadModel(threadId, model);
    },
    rpcRequest
  });
  registerApprovalRoutes(app, {
    listPendingRequests(threadId) {
      return turnLifecycleService?.listPendingRequests(threadId) || [];
    },
    getPendingRequest(requestId) {
      return turnLifecycleService?.getPendingRequest(requestId);
    },
    deletePendingRequest(requestId) {
      turnLifecycleService?.deletePendingRequest(requestId);
    },
    buildToolUserInputResponsePayload,
    ensureCodexServerRunning,
    sendJsonRpcResponse(id, result) {
      appServerClient?.sendJsonRpcResponse(id, result);
    }
  });

  return app;
}

if (require.main === module) {
  const app = buildServer();
  app.listen({ port: PORT, host: '0.0.0.0' }).catch((error) => {
    app.log.error({ message: error.message, stack: error.stack }, 'server_start_failed');
    process.exit(1);
  });
}

export {
  buildServer,
  buildToolUserInputResponsePayload,
  buildTurnStartOverrides,
  buildCollaborationMode,
  repoFolderFromFullName,
  repoPathFromFullName,
  resolveRepoTrackedPath,
  parseStatusPath,
  diffKindFromStatusCode,
  getCloneState,
  parseGitStatusOutput,
  readGitRepoStatus,
  listRepoFiles,
  listRepoTreeDiff,
  listRepoTreeAll,
  buildRepoFileView,
  isIgnoredRepoPath,
  normalizeCollaborationMode,
  parseV2TurnNotification,
  parseLegacyTurnNotification,
  parseThreadTokenUsageUpdatedNotification,
  parseTurnTerminalNotification,
  selectTurnStreamUpdate,
  normalizeThreadMessages,
  parseIssueSummaryOutput
};
