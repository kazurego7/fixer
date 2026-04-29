import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import { registerIssueRoutes } from '../server/routes/issues';
import { registerApprovalRoutes } from '../server/routes/approvals';
import { createIssueService } from '../server/services/issues';
import { createIssueSummaryService } from '../server/services/issueSummary';
import { createThreadRuntimeService } from '../server/services/threadRuntime';
import { createTurnLifecycleService } from '../server/services/turnLifecycle';
import type { OutputItem } from '../shared/types';
import { createPushService } from '../server/services/push';
import { registerPushRoutes } from '../server/routes/push';
import { registerThreadRoutes } from '../server/routes/threads';
import { registerTurnRoutes } from '../server/routes/turns';

const {
  buildTurnStartOverrides,
  buildToolUserInputResponsePayload,
  buildCollaborationMode,
  repoFolderFromFullName,
  repoPathFromFullName,
  parseGitStatusOutput,
  isIgnoredRepoPath,
  resolveRepoTrackedPath,
  listRepoTreeDiff,
  listRepoTreeAll,
  listRepoFiles,
  parseStatusPath,
  diffKindFromStatusCode,
  normalizeCollaborationMode,
  parseV2TurnNotification,
  parseLegacyTurnNotification,
  parseThreadTokenUsageUpdatedNotification,
  parseTurnTerminalNotification,
  selectTurnStreamUpdate,
  normalizeThreadMessages,
  parseIssueSummaryOutput
} = require('../server') as typeof import('../server');

test('normalizeCollaborationMode normalizes valid values', () => {
  assert.equal(normalizeCollaborationMode('plan'), 'plan');
  assert.equal(normalizeCollaborationMode('default'), 'default');
  assert.equal(normalizeCollaborationMode('normal'), 'default');
  assert.equal(normalizeCollaborationMode('  PLAN  '), 'plan');
});

test('normalizeCollaborationMode rejects unknown values', () => {
  assert.equal(normalizeCollaborationMode('foo'), null);
  assert.equal(normalizeCollaborationMode(''), null);
  assert.equal(normalizeCollaborationMode(null), null);
});

test('buildCollaborationMode returns turn/start payload shape', () => {
  const out = buildCollaborationMode('plan', 'gpt-5-codex');
  assert.deepEqual(out, {
    mode: 'plan',
    settings: {
      model: 'gpt-5-codex',
      reasoning_effort: null,
      developer_instructions: null
    }
  });
});

test('buildTurnStartOverrides always requests concise reasoning summary', async () => {
  const out = await buildTurnStartOverrides('thread-1', {});
  assert.deepEqual(out, {
    summary: 'concise'
  });
});

test('buildTurnStartOverrides includes selected model and collaboration mode', async () => {
  const out = await buildTurnStartOverrides('thread-1', {
    selectedModel: 'gpt-5-codex',
    collaborationMode: 'plan'
  });
  assert.deepEqual(out, {
    summary: 'concise',
    model: 'gpt-5-codex',
    collaborationMode: {
      mode: 'plan',
      settings: {
        model: 'gpt-5-codex',
        reasoning_effort: null,
        developer_instructions: null
      }
    }
  });
});

test('createThreadRuntimeService は warmup error を retry して turn を開始する', async () => {
  const calls: string[] = [];
  let attempts = 0;
  const service = createThreadRuntimeService({
    defaultModelFallback: 'gpt-5',
    async rpcRequest<T = unknown>(method: string) {
      calls.push(method);
      if (method === 'turn/start') {
        attempts += 1;
        if (attempts === 1) throw new Error('thread_not_found');
        return { turn: { id: 'turn-1' } } as T;
      }
      throw new Error(`unexpected:${method}`);
    }
  });

  const turnId = await service.startTurnWithRetry('thread-1', [{ type: 'text', text: 'hello' }], 2);
  assert.equal(turnId, 'turn-1');
  assert.deepEqual(calls, ['turn/start', 'turn/start']);
});

test('createIssueSummaryService は source turn が無ければ marker を failed にする', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-issue-summary-'));
  const issueStorePath = path.join(tempDir, 'issues.json');
  const issueService = createIssueService({ issueStorePath });
  issueService.createIssueMarker({
    repoFullName: 'owner/repo',
    sourceThreadId: 'thread-1',
    sourceTurnId: 'turn-1'
  });

  const service = createIssueSummaryService({
    issueService,
    repoPathFromFullName(fullName) {
      return `/tmp/${fullName.replace('/', '__')}`;
    },
    defaultThreadSandbox: 'workspace-write',
    async rpcRequest<T = unknown>(method: string) {
      if (method === 'thread/read') {
        return { thread: { turns: [] } } as T;
      }
      throw new Error(`unexpected:${method}`);
    },
    async startTurnWithRetry() {
      throw new Error('not_used');
    },
    buildTurnInput(prompt) {
      return [{ type: 'text', text: prompt }];
    },
    normalizeTurnMessages() {
      return [];
    },
    setThreadModel() {}
  });

  await service.summarizeIssueMarkersForTurn('thread-1', 'turn-1');

  const issues = issueService.listIssues('owner/repo');
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.status, 'failed');

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('repoFolderFromFullName replaces slash', () => {
  assert.equal(repoFolderFromFullName('org/repo'), 'org__repo');
});

test('repoPathFromFullName resolves under workspace root', () => {
  const repoPath = repoPathFromFullName('org/repo');
  assert.equal(path.basename(repoPath), 'org__repo');
  assert.match(repoPath, /workspace/);
});

test('repoPathFromFullName uses current repo path when remote matches', () => {
  const repoPath = repoPathFromFullName('kazurego7/fixer');
  assert.equal(repoPath, process.cwd());
});

test('parseGitStatusOutput collects変更件数と ahead/behind を判定する', () => {
  const out = parseGitStatusOutput(
    'org/repo',
    '/tmp/org__repo',
    [
      '# branch.oid abcdef',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      '1 M. N... 100644 100644 100644 abcdef abcdef src/app.ts',
      '1 .M N... 100644 100644 100644 abcdef abcdef src/ui.ts',
      '? README.local.md'
    ].join('\n')
  );

  assert.equal(out.branch, 'main');
  assert.equal(out.upstream, 'origin/main');
  assert.equal(out.ahead, 2);
  assert.equal(out.behind, 1);
  assert.equal(out.stagedCount, 1);
  assert.equal(out.unstagedCount, 1);
  assert.equal(out.untrackedCount, 1);
  assert.equal(out.conflictedCount, 0);
  assert.equal(out.hasChanges, true);
  assert.equal(out.actionRecommended, true);
  assert.equal(out.tone, 'warning');
  assert.match(out.summary, /変更あり/);
  assert.match(out.summary, /新規追加 1/);
});

test('parseGitStatusOutput marks conflict state as danger', () => {
  const out = parseGitStatusOutput(
    'org/repo',
    '/tmp/org__repo',
    [
      '# branch.oid abcdef',
      '# branch.head main',
      'u UU N... 100644 100644 100644 100644 abcdef abcdef abcdef conflicted.ts'
    ].join('\n')
  );

  assert.equal(out.conflictedCount, 1);
  assert.equal(out.tone, 'danger');
  assert.match(out.summary, /競合/);
});

test('resolveRepoTrackedPath は repo 配下の相対パスを解決する', () => {
  const resolved = resolveRepoTrackedPath('/tmp/example-repo', 'src/app.ts');
  assert.equal(resolved.fullPath, path.resolve('/tmp/example-repo/src/app.ts'));
  assert.equal(resolved.relativePath, 'src/app.ts');
});

test('resolveRepoTrackedPath は repo 外パスを拒否する', () => {
  assert.throws(() => resolveRepoTrackedPath('/tmp/example-repo', '../secret.txt'), /path_outside_repo/);
  assert.throws(() => resolveRepoTrackedPath('/tmp/example-repo', '/tmp/example-repo'), /path_outside_repo/);
});

test('isIgnoredRepoPath は ignore ディレクトリ配下のファイルも判定できる', () => {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-ignore-test-'));
  const init = spawnSync('git', ['init'], { cwd: repoPath, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr || init.stdout);
  fs.writeFileSync(path.join(repoPath, '.gitignore'), '/public/\n');
  fs.mkdirSync(path.join(repoPath, 'public'), { recursive: true });
  fs.writeFileSync(path.join(repoPath, 'public', 'index.html'), '<html></html>\n');

  assert.equal(isIgnoredRepoPath(repoPath, 'public/index.html'), true);
  assert.equal(isIgnoredRepoPath(repoPath, 'src/app.ts'), false);

  fs.rmSync(repoPath, { recursive: true, force: true });
});

test('createPushService は購読情報を保存し context と unsubscribe を反映する', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-push-service-'));
  const subscriptionsPath = path.join(tempDir, 'push-subscriptions.json');
  const vapidPath = path.join(tempDir, 'push-vapid.json');
  const fakeWebPush = {
    generateVAPIDKeys() {
      return { publicKey: 'public-key', privateKey: 'private-key' };
    },
    setVapidDetails() {},
    async sendNotification() {}
  };

  const service = createPushService({
    subscriptionsPath,
    vapidPath,
    webPushModule: fakeWebPush
  });

  const first = service.subscribe({
    endpoint: 'https://example.com/sub-1',
    keys: { p256dh: 'p256dh-1', auth: 'auth-1' },
    currentThreadId: 'thread-1',
    userAgent: 'ua-1'
  });
  assert.equal(first.currentThreadId, 'thread-1');
  assert.equal(service.getConfig().subscriptionCount, 1);

  const updated = service.setContext('https://example.com/sub-1', 'thread-2');
  assert.equal(updated?.currentThreadId, 'thread-2');

  const saved = JSON.parse(fs.readFileSync(subscriptionsPath, 'utf8'));
  assert.equal(saved[0].currentThreadId, 'thread-2');

  const removed = service.unsubscribe('https://example.com/sub-1');
  assert.equal(removed, true);
  assert.equal(service.getConfig().subscriptionCount, 0);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('createPushService は VAPID鍵を生成して再利用する', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-push-vapid-'));
  const subscriptionsPath = path.join(tempDir, 'push-subscriptions.json');
  const vapidPath = path.join(tempDir, 'push-vapid.json');
  let generatedCount = 0;
  const fakeWebPush = {
    generateVAPIDKeys() {
      generatedCount += 1;
      return { publicKey: 'public-key', privateKey: 'private-key' };
    },
    setVapidDetails() {},
    async sendNotification() {}
  };

  const first = createPushService({ subscriptionsPath, vapidPath, webPushModule: fakeWebPush });
  assert.equal(first.getConfig().enabled, true);
  assert.equal(generatedCount, 1);

  const second = createPushService({ subscriptionsPath, vapidPath, webPushModule: fakeWebPush });
  assert.equal(second.getConfig().publicKey, 'public-key');
  assert.equal(generatedCount, 1);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('createPushService は対象 thread の購読だけ通知し 410 を stale として削除する', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-push-notify-'));
  const subscriptionsPath = path.join(tempDir, 'push-subscriptions.json');
  const vapidPath = path.join(tempDir, 'push-vapid.json');
  const sentEndpoints: string[] = [];
  const fakeWebPush = {
    generateVAPIDKeys() {
      return { publicKey: 'public-key', privateKey: 'private-key' };
    },
    setVapidDetails() {},
    async sendNotification(subscription: { endpoint: string }) {
      sentEndpoints.push(subscription.endpoint);
      if (subscription.endpoint.includes('stale')) {
        const error = new Error('gone') as Error & { statusCode?: number };
        error.statusCode = 410;
        throw error;
      }
    }
  };

  const service = createPushService({
    subscriptionsPath,
    vapidPath,
    webPushModule: fakeWebPush
  });

  service.subscribe({
    endpoint: 'https://example.com/ok',
    keys: { p256dh: 'p1', auth: 'a1' },
    currentThreadId: 'thread-1'
  });
  service.subscribe({
    endpoint: 'https://example.com/stale',
    keys: { p256dh: 'p2', auth: 'a2' },
    currentThreadId: 'thread-1'
  });
  service.subscribe({
    endpoint: 'https://example.com/other',
    keys: { p256dh: 'p3', auth: 'a3' },
    currentThreadId: 'thread-2'
  });

  const result = await service.notifyThreadSubscribers('thread-1');
  assert.deepEqual(sentEndpoints.sort(), ['https://example.com/ok', 'https://example.com/stale']);
  assert.equal(result.sent, 1);
  assert.equal(result.staleRemoved, 1);
  assert.equal(service.getConfig().subscriptionCount, 2);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('createPushService は未設定時に skipped を返す', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-push-disabled-'));
  const subscriptionsPath = path.join(tempDir, 'push-subscriptions.json');
  const vapidPath = path.join(tempDir, 'push-vapid.json');
  const fakeWebPush = {
    generateVAPIDKeys() {
      throw new Error('generate_failed');
    },
    setVapidDetails() {},
    async sendNotification() {}
  };

  const service = createPushService({
    subscriptionsPath,
    vapidPath,
    webPushModule: fakeWebPush
  });

  const result = await service.notifyThreadSubscribers('thread-1');
  assert.deepEqual(result, { sent: 0, staleRemoved: 0, skipped: 'push_not_configured' });

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('createIssueService は未解決 marker を重複作成せず、一覧に仮想 issue と open issue を返す', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-issue-service-'));
  const issueStorePath = path.join(tempDir, 'issues.json');
  const service = createIssueService({ issueStorePath });

  const marker = service.createIssueMarker({
    repoFullName: 'owner/repo',
    sourceThreadId: 'thread-1',
    sourceTurnId: 'turn-1'
  });
  const duplicate = service.createIssueMarker({
    repoFullName: 'owner/repo',
    sourceThreadId: 'thread-1',
    sourceTurnId: 'turn-1'
  });
  assert.equal(duplicate.id, marker.id);

  const createdAt = new Date('2026-04-30T00:00:00.000Z').toISOString();
  service.createIssueFromDraft({
    repoFullName: 'owner/repo',
    sourceThreadId: 'thread-2',
    sourceTurnId: 'turn-2',
    markerIds: ['marker-linked'],
    draft: {
      title: '既存 issue',
      summary: 'summary',
      nextPrompt: 'next prompt'
    },
    createdAt
  });

  const issues = service.listIssues('owner/repo');
  assert.equal(issues.length, 2);
  assert.equal(issues[0]?.title, '既存 issue');
  assert.equal(issues[1]?.id, `marker:${marker.id}`);
  assert.equal(issues[1]?.status, 'pending');

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('createIssueService は issue 解決時に紐づく marker も更新する', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-issue-resolve-'));
  const issueStorePath = path.join(tempDir, 'issues.json');
  const service = createIssueService({ issueStorePath });

  const marker = service.createIssueMarker({
    repoFullName: 'owner/repo',
    sourceThreadId: 'thread-1',
    sourceTurnId: 'turn-1'
  });
  const issue = service.createIssueFromDraft({
    repoFullName: 'owner/repo',
    sourceThreadId: 'thread-1',
    sourceTurnId: 'turn-1',
    markerIds: [marker.id],
    draft: {
      title: 'issue',
      summary: 'summary',
      nextPrompt: 'next prompt'
    }
  });

  const updated = service.updateIssueStatus(issue.id, 'resolved');
  assert.equal(updated?.status, 'resolved');

  const store = JSON.parse(fs.readFileSync(issueStorePath, 'utf8'));
  assert.equal(store.issues[0].status, 'resolved');
  assert.equal(store.markers[0].status, 'resolved');

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('registerIssueRoutes は marker 作成時に必要なら summarize を起動する', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-issue-routes-'));
  const issueStorePath = path.join(tempDir, 'issues.json');
  const service = createIssueService({ issueStorePath });
  const started: Array<{ threadId: string; turnId: string | null }> = [];
  const app = Fastify();

  registerIssueRoutes(app, {
    issueService: service,
    getRunningTurnId(threadId) {
      return threadId === 'thread-running' ? 'turn-running' : undefined;
    },
    triggerSummarize(threadId, turnId) {
      started.push({ threadId, turnId });
    }
  });

  const missingRepo = await app.inject({ method: 'GET', url: '/api/issues' });
  assert.equal(missingRepo.statusCode, 400);

  const created = await app.inject({
    method: 'POST',
    url: '/api/issues/markers',
    payload: {
      repoFullName: 'owner/repo',
      threadId: 'thread-1',
      turnId: 'turn-1'
    }
  });
  assert.equal(created.statusCode, 200);
  assert.equal(started.length, 1);
  assert.deepEqual(started[0], { threadId: 'thread-1', turnId: 'turn-1' });

  const running = await app.inject({
    method: 'POST',
    url: '/api/issues/markers',
    payload: {
      repoFullName: 'owner/repo',
      threadId: 'thread-running',
      turnId: 'turn-running'
    }
  });
  assert.equal(running.statusCode, 200);
  assert.equal(started.length, 1);

  await app.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('registerIssueRoutes は issue 一覧と status 更新の契約を返す', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-issue-route-update-'));
  const issueStorePath = path.join(tempDir, 'issues.json');
  const service = createIssueService({ issueStorePath });
  const marker = service.createIssueMarker({
    repoFullName: 'owner/repo',
    sourceThreadId: 'thread-1',
    sourceTurnId: 'turn-1'
  });
  const issue = service.createIssueFromDraft({
    repoFullName: 'owner/repo',
    sourceThreadId: 'thread-1',
    sourceTurnId: 'turn-1',
    markerIds: [marker.id],
    draft: {
      title: 'issue',
      summary: 'summary',
      nextPrompt: 'next prompt'
    }
  });

  const app = Fastify();
  registerIssueRoutes(app, {
    issueService: service,
    getRunningTurnId() {
      return undefined;
    },
    triggerSummarize() {}
  });

  const listRes = await app.inject({
    method: 'GET',
    url: '/api/issues?repoFullName=owner%2Frepo'
  });
  assert.equal(listRes.statusCode, 200);
  assert.equal(listRes.json().issues.length, 1);

  const invalidPatch = await app.inject({
    method: 'PATCH',
    url: `/api/issues/${encodeURIComponent(issue.id)}`,
    payload: { status: 'pending' }
  });
  assert.equal(invalidPatch.statusCode, 400);

  const missingPatch = await app.inject({
    method: 'PATCH',
    url: '/api/issues/missing',
    payload: { status: 'resolved' }
  });
  assert.equal(missingPatch.statusCode, 404);

  const updated = await app.inject({
    method: 'PATCH',
    url: `/api/issues/${encodeURIComponent(issue.id)}`,
    payload: { status: 'resolved' }
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().issue.status, 'resolved');

  await app.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('registerPushRoutes は config と subscribe の基本契約を返す', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-push-routes-'));
  const app = Fastify();
  registerPushRoutes(app, {
    pushService: createPushService({
      subscriptionsPath: path.join(tempDir, 'push-subscriptions.json'),
      vapidPath: path.join(tempDir, 'push-vapid.json'),
      webPushModule: {
        generateVAPIDKeys() {
          return { publicKey: 'public-key', privateKey: 'private-key' };
        },
        setVapidDetails() {},
        async sendNotification() {}
      }
    })
  });

  const configRes = await app.inject({ method: 'GET', url: '/api/push/config' });
  assert.equal(configRes.statusCode, 200);
  assert.deepEqual(configRes.json(), {
    enabled: true,
    publicKey: 'public-key',
    hasVapidConfig: true,
    subscriptionCount: 0
  });

  const subscribeRes = await app.inject({
    method: 'POST',
    url: '/api/push/subscribe',
    payload: {
      subscription: {
        endpoint: 'https://example.com/sub-1',
        keys: { p256dh: 'p1', auth: 'a1' }
      },
      threadId: 'thread-1',
      userAgent: 'ua-1'
    }
  });
  assert.equal(subscribeRes.statusCode, 200);
  assert.deepEqual(subscribeRes.json(), {
    ok: true,
    endpoint: 'https://example.com/sub-1',
    threadId: 'thread-1'
  });

  await app.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('registerPushRoutes は subscribe/context/unsubscribe のエラー契約を返す', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-push-routes-errors-'));
  const app = Fastify();
  registerPushRoutes(app, {
    pushService: createPushService({
      subscriptionsPath: path.join(tempDir, 'push-subscriptions.json'),
      vapidPath: path.join(tempDir, 'push-vapid.json'),
      webPushModule: {
        generateVAPIDKeys() {
          return { publicKey: 'public-key', privateKey: 'private-key' };
        },
        setVapidDetails() {},
        async sendNotification() {}
      }
    })
  });

  const invalidRes = await app.inject({
    method: 'POST',
    url: '/api/push/subscribe',
    payload: { subscription: { endpoint: '', keys: { p256dh: '', auth: '' } } }
  });
  assert.equal(invalidRes.statusCode, 400);
  assert.deepEqual(invalidRes.json(), { error: 'invalid_subscription' });

  const contextMissingRes = await app.inject({
    method: 'POST',
    url: '/api/push/context',
    payload: { endpoint: 'https://example.com/missing', threadId: 'thread-1' }
  });
  assert.equal(contextMissingRes.statusCode, 404);
  assert.deepEqual(contextMissingRes.json(), { error: 'subscription_not_found' });

  const unsubscribeMissingRes = await app.inject({
    method: 'POST',
    url: '/api/push/unsubscribe',
    payload: { endpoint: 'https://example.com/missing' }
  });
  assert.equal(unsubscribeMissingRes.statusCode, 404);
  assert.deepEqual(unsubscribeMissingRes.json(), { error: 'subscription_not_found' });

  await app.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('registerThreadRoutes は一覧、messages、resume、ensure の契約を返す', async () => {
  const app = Fastify();
  const savedModels = new Map<string, string>();
  const rpcCalls: Array<{ method: string; params: Record<string, unknown> | undefined }> = [];

  registerThreadRoutes(app, {
    async rpcRequest<T = unknown>(method: string, params?: Record<string, unknown>) {
      rpcCalls.push({ method, params });
      if (method === 'thread/list') {
        return {
          data: [
            {
              id: 'thread-1',
              name: 'thread 1',
              updatedAt: 1_714_428_800,
              preview: 'preview',
              source: 'chat',
              status: { type: 'idle' }
            }
          ]
        } as T;
      }
      if (method === 'thread/resume') {
        if (params?.threadId === 'missing-thread') throw new Error('thread missing');
        return { thread: { model: 'gpt-5' } } as T;
      }
      if (method === 'thread/read') {
        return {
          thread: {
            model: 'gpt-5',
            turns: []
          }
        } as T;
      }
      if (method === 'thread/start') {
        return { thread: { id: 'thread-new', model: 'gpt-5-codex' } } as T;
      }
      throw new Error(`unexpected_rpc:${method}`);
    },
    repoPathFromFullName(fullName) {
      return `/tmp/${fullName.replace('/', '__')}`;
    },
    normalizeThreadMessages() {
      return [{ id: 'msg-1', role: 'assistant', text: 'hello' } as OutputItem];
    },
    isThreadMissingError(error) {
      return error instanceof Error && error.message.includes('missing');
    },
    normalizeModelId(value) {
      return typeof value === 'string' && value ? value : null;
    },
    setThreadModel(threadId, model) {
      savedModels.set(threadId, model);
    },
    sandbox: 'workspace-write'
  });

  const missingRepo = await app.inject({ method: 'GET', url: '/api/threads' });
  assert.equal(missingRepo.statusCode, 400);

  const listRes = await app.inject({
    method: 'GET',
    url: '/api/threads?repoFullName=owner%2Frepo'
  });
  assert.equal(listRes.statusCode, 200);
  assert.equal(listRes.json().items[0].id, 'thread-1');

  const messagesRes = await app.inject({
    method: 'GET',
    url: '/api/threads/messages?threadId=thread-1'
  });
  assert.equal(messagesRes.statusCode, 200);
  assert.equal(messagesRes.json().model, 'gpt-5');
  assert.equal(savedModels.get('thread-1'), 'gpt-5');

  const missingMessagesRes = await app.inject({
    method: 'GET',
    url: '/api/threads/messages?threadId=missing-thread'
  });
  assert.equal(missingMessagesRes.statusCode, 200);
  assert.deepEqual(missingMessagesRes.json(), { items: [], model: null });

  const resumeMissingRes = await app.inject({
    method: 'POST',
    url: '/api/threads/resume',
    payload: { thread_id: 'missing-thread' }
  });
  assert.equal(resumeMissingRes.statusCode, 404);

  const ensurePreferredRes = await app.inject({
    method: 'POST',
    url: '/api/threads/ensure',
    payload: {
      repoFullName: 'owner/repo',
      preferred_thread_id: 'thread-preferred',
      model: 'gpt-5-mini'
    }
  });
  assert.equal(ensurePreferredRes.statusCode, 200);
  assert.deepEqual(ensurePreferredRes.json(), { id: 'thread-preferred', reused: true });
  assert.equal(savedModels.get('thread-preferred'), 'gpt-5-mini');

  const createdRes = await app.inject({
    method: 'POST',
    url: '/api/threads',
    payload: { repoFullName: 'owner/repo', model: 'gpt-5-codex' }
  });
  assert.equal(createdRes.statusCode, 200);
  assert.deepEqual(createdRes.json(), { id: 'thread-new' });
  assert.ok(rpcCalls.some((call) => call.method === 'thread/start'));

  await app.close();
});

test('registerTurnRoutes は running、live-state、cancel、steer の契約を返す', async () => {
  const app = Fastify();
  const runningTurnByThreadId = new Map<string, string>([['thread-running', 'turn-running']]);
  const rpcCalls: Array<{ method: string; params: Record<string, unknown> | undefined }> = [];
  const state = {
    threadId: 'thread-running',
    turnId: 'turn-running',
    latestSeq: 3,
    renderItems: [{ id: 'item-1', type: 'message' }],
    eventBuffer: []
  };

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
    clearPendingUserInputForThread() {},
    async ensureLiveTurnStateSnapshot(threadId, turnId) {
      if (threadId === 'thread-running' && turnId === 'turn-running') return state as any;
      return null;
    },
    liveTurnManager: {
      ensureState() {
        return state as any;
      },
      getState(threadId) {
        return threadId === 'thread-running' ? (state as any) : null;
      },
      replayEvents() {
        return 3;
      },
      subscribe() {
        return () => true;
      }
    },
    async startTurnWithRetry() {
      return 'turn-started';
    },
    buildTurnInput(prompt, attachments) {
      const items: Array<{ type: 'text'; text: string } | { type: 'image'; url: string }> = [
        { type: 'text', text: prompt }
      ];
      if (attachments?.length) items.push({ type: 'image', url: 'data:' });
      return items;
    },
    async buildTurnStartOverrides() {
      return { summary: 'concise' };
    },
    normalizeModelId(value) {
      return typeof value === 'string' && value ? value : null;
    },
    normalizeCollaborationMode() {
      return null;
    },
    setThreadModel() {},
    async rpcRequest<T = unknown>(method: string, params?: Record<string, unknown>) {
      rpcCalls.push({ method, params });
      return {} as T;
    }
  });

  const missingRunning = await app.inject({ method: 'GET', url: '/api/turns/running' });
  assert.equal(missingRunning.statusCode, 400);

  const runningFalse = await app.inject({
    method: 'GET',
    url: '/api/turns/running?threadId=thread-idle'
  });
  assert.deepEqual(runningFalse.json(), { running: false, threadId: 'thread-idle' });

  const runningTrue = await app.inject({
    method: 'GET',
    url: '/api/turns/running?threadId=thread-running'
  });
  assert.deepEqual(runningTrue.json(), {
    running: true,
    threadId: 'thread-running',
    turnId: 'turn-running'
  });

  const liveStateIdle = await app.inject({
    method: 'GET',
    url: '/api/turns/live-state?threadId=thread-idle'
  });
  assert.deepEqual(liveStateIdle.json(), {
    running: false,
    threadId: 'thread-idle',
    seq: 0,
    items: [],
    liveReasoningText: ''
  });

  const liveStateRunning = await app.inject({
    method: 'GET',
    url: '/api/turns/live-state?threadId=thread-running'
  });
  assert.equal(liveStateRunning.statusCode, 200);
  assert.equal(liveStateRunning.json().seq, 3);

  const cancelMissing = await app.inject({
    method: 'POST',
    url: '/api/turns/cancel',
    payload: { thread_id: 'thread-idle' }
  });
  assert.equal(cancelMissing.statusCode, 404);
  assert.deepEqual(cancelMissing.json(), { error: 'running_turn_not_found' });

  const steerNoActive = await app.inject({
    method: 'POST',
    url: '/api/turns/steer',
    payload: { thread_id: 'thread-idle', turn_id: 'turn-idle', input: 'next' }
  });
  assert.equal(steerNoActive.statusCode, 409);
  assert.deepEqual(steerNoActive.json(), { error: 'no_active_turn' });

  const steerMismatch = await app.inject({
    method: 'POST',
    url: '/api/turns/steer',
    payload: { thread_id: 'thread-running', turn_id: 'turn-other', input: 'next' }
  });
  assert.equal(steerMismatch.statusCode, 409);
  assert.deepEqual(steerMismatch.json(), {
    error: 'turn_mismatch',
    runningTurnId: 'turn-running'
  });

  const cancelRunning = await app.inject({
    method: 'POST',
    url: '/api/turns/cancel',
    payload: { thread_id: 'thread-running' }
  });
  assert.equal(cancelRunning.statusCode, 200);
  assert.deepEqual(cancelRunning.json(), { cancelled: true });
  assert.ok(rpcCalls.some((call) => call.method === 'turn/interrupt'));

  await app.close();
});

test('registerApprovalRoutes は pending と respond の契約を返す', async () => {
  const app = Fastify();
  const pendingById = new Map([
    [
      'req-2',
      {
        requestId: 'req-2',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-2',
        questions: [],
        createdAt: '2026-04-30T00:00:01.000Z'
      }
    ],
    [
      'req-1',
      {
        requestId: 'req-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        questions: [],
        createdAt: '2026-04-30T00:00:00.000Z'
      }
    ]
  ]);
  const sentResponses: Array<{ id: string | number; result: unknown }> = [];
  let ensured = 0;

  registerApprovalRoutes(app, {
    listPendingRequests(threadId) {
      return Array.from(pendingById.values()).filter((item) => item.threadId === threadId) as any;
    },
    getPendingRequest(requestId) {
      return pendingById.get(requestId) as any;
    },
    deletePendingRequest(requestId) {
      pendingById.delete(requestId);
    },
    buildToolUserInputResponsePayload(answersMap) {
      if (!answersMap || typeof answersMap !== 'object') return { answers: {} };
      return { answers: answersMap as any };
    },
    async ensureCodexServerRunning() {
      ensured += 1;
    },
    sendJsonRpcResponse(id, result) {
      sentResponses.push({ id, result });
    }
  });

  const missingThread = await app.inject({ method: 'GET', url: '/api/approvals/pending' });
  assert.equal(missingThread.statusCode, 400);

  const pendingRes = await app.inject({
    method: 'GET',
    url: '/api/approvals/pending?threadId=thread-1'
  });
  assert.equal(pendingRes.statusCode, 200);
  assert.deepEqual(
    pendingRes.json().requests.map((item: { requestId: string }) => item.requestId),
    ['req-1', 'req-2']
  );

  const missingRequestId = await app.inject({
    method: 'POST',
    url: '/api/approvals/respond',
    payload: {}
  });
  assert.equal(missingRequestId.statusCode, 400);

  const missingPending = await app.inject({
    method: 'POST',
    url: '/api/approvals/respond',
    payload: { request_id: 'missing', answers: { q1: { answers: ['a1'] } } }
  });
  assert.equal(missingPending.statusCode, 404);

  const missingAnswers = await app.inject({
    method: 'POST',
    url: '/api/approvals/respond',
    payload: { request_id: 'req-1' }
  });
  assert.equal(missingAnswers.statusCode, 400);

  const respondRes = await app.inject({
    method: 'POST',
    url: '/api/approvals/respond',
    payload: { request_id: 'req-1', answers: { q1: { answers: ['a1'] } } }
  });
  assert.equal(respondRes.statusCode, 200);
  assert.deepEqual(respondRes.json(), { ok: true });
  assert.equal(ensured, 1);
  assert.equal(sentResponses.length, 1);
  assert.equal(pendingById.has('req-1'), false);

  await app.close();
});

test('createTurnLifecycleService は request user input を保存して thread 単位で clear できる', () => {
  const runningTurnByThreadId = new Map<string, string>();
  const state = { threadId: 'thread-1', turnId: 'turn-1', liveReasoningRaw: '' };
  const service = createTurnLifecycleService({
    liveTurnManager: {
      getState() {
        return null;
      },
      ensureState() {
        return state as any;
      },
      subscribe() {
        return () => true;
      },
      toThreadMessageTurnItem() {
        return null;
      },
      ensureItemByType() {
        throw new Error('not_used');
      },
      upsertItem() {
        throw new Error('not_used');
      },
      appendBoundary() {},
      extractReasoningRawFromItem() {
        return '';
      },
      emitEvent() {
        return 0;
      },
      emitStateSnapshot() {},
      hydrateFromTurn() {
        throw new Error('not_used');
      },
      replayEvents() {
        return 0;
      }
    } as any,
    getRunningTurnId(threadId) {
      return runningTurnByThreadId.get(threadId);
    },
    deleteRunningTurnId(threadId) {
      runningTurnByThreadId.delete(threadId);
    },
    async rpcRequest<T = unknown>() {
      return {} as T;
    },
    triggerIssueSummary() {}
  });

  service.onMessage({
    method: 'item/tool/requestUserInput',
    id: 'req-1',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      questions: [{ id: 'q1', header: 'Q1', question: '質問', options: [{ label: 'A', description: 'a' }] }]
    }
  });

  assert.equal(service.listPendingRequests('thread-1').length, 1);
  assert.equal(service.getPendingRequest('req-1')?.threadId, 'thread-1');

  service.clearPendingUserInputForThread('thread-1');
  assert.equal(service.listPendingRequests('thread-1').length, 0);
  assert.equal(service.getPendingRequest('req-1'), undefined);
});

test('createTurnLifecycleService は turn 完了を一度だけ push 通知する', async () => {
  const runningTurnByThreadId = new Map<string, string>([['thread-1', 'turn-1']]);
  const emitted: Array<{ type: string; message: string | null }> = [];
  const triggerCalls: Array<{ threadId: string; turnId: string | null }> = [];
  let pushCalls = 0;
  const state = { threadId: 'thread-1', turnId: 'turn-1', liveReasoningRaw: '' };

  const service = createTurnLifecycleService({
    liveTurnManager: {
      getState(threadId: string) {
        return threadId === 'thread-1' ? (state as any) : null;
      },
      ensureState() {
        return state as any;
      },
      subscribe() {
        return () => true;
      },
      toThreadMessageTurnItem() {
        return null;
      },
      ensureItemByType() {
        throw new Error('not_used');
      },
      upsertItem() {
        throw new Error('not_used');
      },
      appendBoundary() {},
      extractReasoningRawFromItem() {
        return '';
      },
      emitEvent(_state: unknown, event: { type: string; message?: string }) {
        emitted.push({ type: event.type, message: event.message || null });
        return emitted.length;
      },
      emitStateSnapshot() {},
      hydrateFromTurn() {
        throw new Error('not_used');
      },
      replayEvents() {
        return 0;
      }
    } as any,
    getRunningTurnId(threadId) {
      return runningTurnByThreadId.get(threadId);
    },
    deleteRunningTurnId(threadId) {
      runningTurnByThreadId.delete(threadId);
    },
    pushService: {
      async notifyThreadSubscribers() {
        pushCalls += 1;
        return { sent: 1, staleRemoved: 0 };
      }
    },
    async rpcRequest<T = unknown>() {
      return {} as T;
    },
    triggerIssueSummary(threadId, turnId) {
      triggerCalls.push({ threadId, turnId });
    }
  });

  const doneMessage = {
    method: 'turn/completed',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      turn: { status: 'completed' }
    }
  };
  service.onMessage(doneMessage);
  service.onMessage(doneMessage);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(pushCalls, 1);
  assert.deepEqual(triggerCalls, [
    { threadId: 'thread-1', turnId: 'turn-1' },
    { threadId: 'thread-1', turnId: 'turn-1' }
  ]);
  assert.equal(emitted.filter((event) => event.type === 'done').length, 2);
  assert.equal(runningTurnByThreadId.has('thread-1'), false);
});

test('createTurnLifecycleService は token limit 超過時に auto compact を一度だけ起動する', async () => {
  const rpcCalls: Array<{ method: string; params: Record<string, unknown> | undefined }> = [];
  const service = createTurnLifecycleService({
    liveTurnManager: {
      getState() {
        return null;
      },
      ensureState() {
        throw new Error('not_used');
      },
      subscribe() {
        return () => true;
      },
      toThreadMessageTurnItem() {
        return null;
      },
      ensureItemByType() {
        throw new Error('not_used');
      },
      upsertItem() {
        throw new Error('not_used');
      },
      appendBoundary() {},
      extractReasoningRawFromItem() {
        return '';
      },
      emitEvent() {
        return 0;
      },
      emitStateSnapshot() {},
      hydrateFromTurn() {
        throw new Error('not_used');
      },
      replayEvents() {
        return 0;
      }
    } as any,
    getRunningTurnId() {
      return undefined;
    },
    deleteRunningTurnId() {},
    async rpcRequest<T = unknown>(method: string, params?: Record<string, unknown>) {
      rpcCalls.push({ method, params });
      if (method === 'config/read') {
        return { config: { model_auto_compact_token_limit: 100 } } as T;
      }
      return {} as T;
    },
    triggerIssueSummary() {}
  });

  const tokenMessage = {
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: 'thread-1',
      tokenUsage: { total: 120 }
    }
  };
  service.onMessage(tokenMessage);
  await new Promise((resolve) => setTimeout(resolve, 0));
  service.onMessage(tokenMessage);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(
    rpcCalls.filter((call) => call.method === 'thread/compact/start').length,
    1
  );
});

test('listRepoTreeAll はディレクトリ配下を nested tree で返す', () => {
  const fullName = 'test/eager-safe';
  const repoPath = repoPathFromFullName(fullName);
  fs.rmSync(repoPath, { recursive: true, force: true });
  fs.mkdirSync(repoPath, { recursive: true });

  const init = spawnSync('git', ['init'], { cwd: repoPath, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  fs.mkdirSync(path.join(repoPath, 'small'), { recursive: true });
  fs.mkdirSync(path.join(repoPath, 'large'), { recursive: true });
  for (let index = 1; index <= 20; index += 1) {
    fs.writeFileSync(path.join(repoPath, 'small', `file-${index}.txt`), `${index}\n`);
  }
  for (let index = 1; index <= 21; index += 1) {
    fs.writeFileSync(path.join(repoPath, 'large', `file-${index}.txt`), `${index}\n`);
  }
  fs.writeFileSync(path.join(repoPath, 'root.txt'), 'root\n');

  const add = spawnSync('git', ['add', '.'], { cwd: repoPath, encoding: 'utf8' });
  assert.equal(add.status, 0, add.stderr || add.stdout);
  const commit = spawnSync('git', ['commit', '-m', 'テスト初期化'], {
    cwd: repoPath,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test User',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test User',
      GIT_COMMITTER_EMAIL: 'test@example.com'
    }
  });
  assert.equal(commit.status, 0, commit.stderr || commit.stdout);

  const tree = listRepoTreeAll(fullName);
  const small = tree.items.find((item) => item.path === 'small');
  const large = tree.items.find((item) => item.path === 'large');

  assert.ok(small);
  assert.ok(large);
  assert.equal(small?.type, 'directory');
  assert.equal(large?.type, 'directory');
  assert.equal(small?.children?.length, 20);
  assert.equal(large?.children?.length, 21);

  fs.rmSync(repoPath, { recursive: true, force: true });
});

test('listRepoTreeAll は ignored ディレクトリ配下も nested tree で返す', () => {
  const fullName = 'test/ignored-nested-tree';
  const repoPath = repoPathFromFullName(fullName);
  fs.rmSync(repoPath, { recursive: true, force: true });
  fs.mkdirSync(repoPath, { recursive: true });

  const init = spawnSync('git', ['init'], { cwd: repoPath, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  fs.writeFileSync(path.join(repoPath, '.gitignore'), 'public/\n');
  fs.writeFileSync(path.join(repoPath, 'README.md'), '# test\n');
  const add = spawnSync('git', ['add', '.'], { cwd: repoPath, encoding: 'utf8' });
  assert.equal(add.status, 0, add.stderr || add.stdout);
  const commit = spawnSync('git', ['commit', '-m', 'テスト初期化'], {
    cwd: repoPath,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test User',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test User',
      GIT_COMMITTER_EMAIL: 'test@example.com'
    }
  });
  assert.equal(commit.status, 0, commit.stderr || commit.stdout);

  fs.mkdirSync(path.join(repoPath, 'public', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(repoPath, 'public', 'index.html'), '<html></html>\n');
  fs.writeFileSync(path.join(repoPath, 'public', 'assets', 'app.js'), 'console.log("ignored");\n');

  const tree = listRepoTreeAll(fullName);
  const publicDir = tree.items.find((item) => item.path === 'public');
  const assetsDir = publicDir?.children?.find((item) => item.path === 'public/assets');
  const quotedTopLevel = tree.items.filter((item) => item.path.startsWith('"'));

  assert.ok(publicDir);
  assert.equal(publicDir?.type, 'directory');
  assert.equal(publicDir?.changeKind, 'ignored');
  assert.ok(publicDir?.children?.some((item) => item.path === 'public/index.html'));
  assert.ok(assetsDir);
  assert.equal(assetsDir?.type, 'directory');
  assert.ok(assetsDir?.children?.some((item) => item.path === 'public/assets/app.js'));
  assert.deepEqual(quotedTopLevel, []);

  fs.rmSync(repoPath, { recursive: true, force: true });
});

test('listRepoFiles と listRepoTreeDiff は未追跡ディレクトリがあっても EISDIR で失敗しない', () => {
  const fullName = 'test/untracked-dir';
  const repoPath = repoPathFromFullName(fullName);
  fs.rmSync(repoPath, { recursive: true, force: true });
  fs.mkdirSync(repoPath, { recursive: true });

  const init = spawnSync('git', ['init'], { cwd: repoPath, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  fs.writeFileSync(path.join(repoPath, 'README.md'), '# test\n');
  const add = spawnSync('git', ['add', '.'], { cwd: repoPath, encoding: 'utf8' });
  assert.equal(add.status, 0, add.stderr || add.stdout);
  const commit = spawnSync('git', ['commit', '-m', 'テスト初期化'], {
    cwd: repoPath,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test User',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test User',
      GIT_COMMITTER_EMAIL: 'test@example.com'
    }
  });
  assert.equal(commit.status, 0, commit.stderr || commit.stdout);

  fs.mkdirSync(path.join(repoPath, 'docs', 'images'), { recursive: true });
  fs.writeFileSync(path.join(repoPath, 'docs', 'images', 'repos.png'), 'png\n');

  const files = listRepoFiles(fullName, false);
  assert.ok(files.items.some((item) => item.path === 'docs/images/repos.png'));

  const tree = listRepoTreeDiff(fullName);
  assert.ok(tree.items.some((item) => item.path === 'docs' && item.type === 'directory'));

  fs.rmSync(repoPath, { recursive: true, force: true });
});

test('listRepoTreeDiff と listRepoTreeAll は未追跡ディレクトリ内の新規追加ファイルまで辿れる', () => {
  const fullName = 'test/untracked-nested-files';
  const repoPath = repoPathFromFullName(fullName);
  fs.rmSync(repoPath, { recursive: true, force: true });
  fs.mkdirSync(repoPath, { recursive: true });

  const init = spawnSync('git', ['init'], { cwd: repoPath, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  fs.writeFileSync(path.join(repoPath, 'README.md'), '# test\n');
  const add = spawnSync('git', ['add', '.'], { cwd: repoPath, encoding: 'utf8' });
  assert.equal(add.status, 0, add.stderr || add.stdout);
  const commit = spawnSync('git', ['commit', '-m', 'テスト初期化'], {
    cwd: repoPath,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test User',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test User',
      GIT_COMMITTER_EMAIL: 'test@example.com'
    }
  });
  assert.equal(commit.status, 0, commit.stderr || commit.stdout);

  fs.mkdirSync(path.join(repoPath, 'docs', 'images'), { recursive: true });
  fs.writeFileSync(path.join(repoPath, 'docs', 'images', 'repos.png'), 'png\n');

  const root = listRepoTreeDiff(fullName);
  const docs = root.items.find((item) => item.path === 'docs' && item.type === 'directory');
  assert.ok(docs);
  const images = docs?.children?.find((item) => item.path === 'docs/images' && item.type === 'directory');
  assert.ok(images);
  assert.ok(images?.children?.some((item) => item.path === 'docs/images/repos.png' && item.type === 'file'));

  const rootAll = listRepoTreeAll(fullName);
  assert.ok(rootAll.items.some((item) => item.path === 'README.md' && item.type === 'file'));

  fs.rmSync(repoPath, { recursive: true, force: true });
});

test('parseStatusPath は rename 行を移動先パスで返す', () => {
  assert.deepEqual(parseStatusPath('R  old/name.ts -> new/name.ts'), {
    code: 'R ',
    path: 'new/name.ts'
  });
});

test('diffKindFromStatusCode は git status のコードを changeKind に変換する', () => {
  assert.equal(diffKindFromStatusCode('??'), 'untracked');
  assert.equal(diffKindFromStatusCode('UU'), 'conflicted');
  assert.equal(diffKindFromStatusCode('R '), 'renamed');
  assert.equal(diffKindFromStatusCode(' D'), 'deleted');
  assert.equal(diffKindFromStatusCode('A '), 'added');
  assert.equal(diffKindFromStatusCode(' M'), 'modified');
  assert.equal(diffKindFromStatusCode('  '), 'unchanged');
});

test('parseV2TurnNotification parses delta notification', () => {
  const parsed = parseV2TurnNotification({
    method: 'item/agentMessage/delta',
    params: { threadId: 't1', turnId: 'u1', itemId: 'm1', delta: 'abc' }
  });
  assert.ok(parsed);
  assert.equal(parsed.method, 'item/agentMessage/delta');
  assert.equal(parsed.threadId, 't1');
  assert.equal(parsed.turnId, 'u1');
  assert.equal(parsed.itemId, 'm1');
  assert.equal(parsed.delta, 'abc');
});

test('parseV2TurnNotification falls back to turn.id when turnId is absent', () => {
  const parsed = parseV2TurnNotification({
    method: 'turn/completed',
    params: { threadId: 't1', turn: { id: 'u-from-turn', status: 'Completed' } }
  });
  assert.ok(parsed);
  assert.equal(parsed.turnId, 'u-from-turn');
});

test('parseThreadTokenUsageUpdatedNotification parses total tokens', () => {
  const parsed = parseThreadTokenUsageUpdatedNotification({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: 't1',
      tokenUsage: {
        total: 12345
      }
    }
  });

  assert.deepEqual(parsed, {
    threadId: 't1',
    totalTokens: 12345
  });
});

test('parseLegacyTurnNotification parses codex event', () => {
  const parsed = parseLegacyTurnNotification({
    method: 'codex/event/agent_message_delta',
    params: {
      conversationId: 't1',
      msg: { type: 'agent_message_delta', turn_id: 'u1', delta: 'abc' }
    }
  });
  assert.ok(parsed);
  assert.equal(parsed.type, 'agent_message_delta');
  assert.equal(parsed.threadId, 't1');
  assert.equal(parsed.turnId, 'u1');
  assert.equal(parsed.delta, 'abc');
});

test('selectTurnStreamUpdate maps legacy reasoning delta', () => {
  const out = selectTurnStreamUpdate(
    {
      method: 'codex/event/reasoning_delta',
      params: {
        conversationId: 't1',
        msg: { type: 'reasoning_delta', turn_id: 'u1', delta: '**見出し** legacy' }
      }
    },
    { threadId: 't1', turnId: 'u1', preferV2: false }
  );
  assert.equal(out.matched, true);
  assert.deepEqual(out.streamEvent, { type: 'reasoning_delta', delta: '**見出し** legacy' });
});

test('parseTurnTerminalNotification maps v2 completed to done terminal', () => {
  const parsed = parseTurnTerminalNotification({
    method: 'turn/completed',
    params: { threadId: 't1', turn: { id: 'u1', status: 'Completed' } }
  });
  assert.deepEqual(parsed, {
    threadId: 't1',
    turnId: 'u1',
    kind: 'done',
    message: null
  });
});

test('parseTurnTerminalNotification maps v2 error without retry to error terminal', () => {
  const parsed = parseTurnTerminalNotification({
    method: 'error',
    params: { threadId: 't1', turnId: 'u1', willRetry: false, error: { message: 'boom' } }
  });
  assert.deepEqual(parsed, {
    threadId: 't1',
    turnId: 'u1',
    kind: 'error',
    message: 'boom'
  });
});

test('parseTurnTerminalNotification maps legacy turn_complete to done terminal', () => {
  const parsed = parseTurnTerminalNotification({
    method: 'codex/event/turn_complete',
    params: { conversationId: 't1', msg: { type: 'turn_complete', turn_id: 'u1' } }
  });
  assert.deepEqual(parsed, {
    threadId: 't1',
    turnId: 'u1',
    kind: 'done',
    message: null
  });
});

test('selectTurnStreamUpdate maps v2 answer delta', () => {
  const out = selectTurnStreamUpdate(
    {
      method: 'item/agentMessage/delta',
      params: { threadId: 't1', turnId: 'u1', itemId: 'm1', delta: 'A' }
    },
    { threadId: 't1', turnId: 'u1', preferV2: false }
  );
  assert.equal(out.matched, true);
  assert.equal(out.nextPreferV2, true);
  assert.deepEqual(out.streamEvent, { type: 'answer_delta', delta: 'A', itemId: 'm1' });
});

test('selectTurnStreamUpdate maps v2 reasoning summaryTextDelta', () => {
  const out = selectTurnStreamUpdate(
    {
      method: 'item/reasoning/summaryTextDelta',
      params: { threadId: 't1', turnId: 'u1', itemId: 'r1', delta: '**見出し** 検討中' }
    },
    { threadId: 't1', turnId: 'u1', preferV2: false }
  );
  assert.equal(out.matched, true);
  assert.equal(out.nextPreferV2, true);
  assert.deepEqual(out.streamEvent, { type: 'reasoning_delta', delta: '**見出し** 検討中' });
});

test('selectTurnStreamUpdate maps v2 reasoning textDelta', () => {
  const out = selectTurnStreamUpdate(
    {
      method: 'item/reasoning/textDelta',
      params: { threadId: 't1', turnId: 'u1', itemId: 'r1', delta: '補足本文' }
    },
    { threadId: 't1', turnId: 'u1', preferV2: false }
  );
  assert.equal(out.matched, true);
  assert.equal(out.nextPreferV2, true);
  assert.deepEqual(out.streamEvent, { type: 'reasoning_delta', delta: '補足本文' });
});

test('selectTurnStreamUpdate ignores v2 event for another thread', () => {
  const out = selectTurnStreamUpdate(
    {
      method: 'item/reasoning/summaryTextDelta',
      params: { threadId: 't-other', turnId: 'u1', itemId: 'r1', delta: '**見出し** 検討中' }
    },
    { threadId: 't1', turnId: 'u1', preferV2: false }
  );
  assert.equal(out.matched, false);
  assert.equal(out.nextPreferV2, false);
});

test('selectTurnStreamUpdate maps v2 plan delta', () => {
  const out = selectTurnStreamUpdate(
    {
      method: 'item/plan/delta',
      params: { threadId: 't1', turnId: 'u1', itemId: 'p1', delta: '計画の差分' }
    },
    { threadId: 't1', turnId: 'u1', preferV2: false }
  );
  assert.equal(out.matched, true);
  assert.equal(out.nextPreferV2, true);
  assert.deepEqual(out.streamEvent, { type: 'plan_delta', delta: '計画の差分', itemId: 'p1' });
});

test('selectTurnStreamUpdate maps v2 turn plan updated', () => {
  const out = selectTurnStreamUpdate(
    {
      method: 'turn/plan/updated',
      params: {
        threadId: 't1',
        turnId: 'u1',
        explanation: '方針',
        plan: [
          { step: '調査', status: 'completed' },
          { step: '実装', status: 'inProgress' }
        ]
      }
    },
    { threadId: 't1', turnId: 'u1', preferV2: true }
  );
  assert.equal(out.matched, true);
  assert.deepEqual(out.streamEvent, {
    type: 'plan_snapshot',
    text: '方針\n[x] 調査\n[-] 実装'
  });
});

test('selectTurnStreamUpdate maps request user input event', () => {
  const out = selectTurnStreamUpdate(
    {
      jsonrpc: '2.0',
      id: 77,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 't1',
        turnId: 'u1',
        itemId: 'i1',
        questions: [
          {
            id: 'q1',
            header: '確認',
            question: 'どちらにしますか？',
            isOther: false,
            isSecret: false,
            options: [{ label: 'はい', description: '進める' }, { label: 'いいえ', description: '止める' }]
          }
        ]
      }
    },
    { threadId: 't1', turnId: 'u1', preferV2: false }
  );
  assert.equal(out.matched, true);
  assert.equal(out.nextPreferV2, true);
  assert.deepEqual(out.streamEvent, {
    type: 'request_user_input',
    requestId: 77,
    turnId: 'u1',
    itemId: 'i1',
    questions: [
      {
        id: 'q1',
        header: '確認',
        question: 'どちらにしますか？',
        isOther: false,
        isSecret: false,
        options: [{ label: 'はい', description: '進める' }, { label: 'いいえ', description: '止める' }]
      }
    ]
  });
});

test('selectTurnStreamUpdate maps v2 completed as done', () => {
  const out = selectTurnStreamUpdate(
    {
      method: 'turn/completed',
      params: { threadId: 't1', turn: { id: 'u1', status: 'Completed' } }
    },
    { threadId: 't1', turnId: 'u1', preferV2: true }
  );
  assert.equal(out.matched, true);
  assert.deepEqual(out.terminal, { kind: 'done' });
});

test('selectTurnStreamUpdate maps v2 failed as error', () => {
  const out = selectTurnStreamUpdate(
    {
      method: 'turn/completed',
      params: { threadId: 't1', turn: { id: 'u1', status: 'Failed' } }
    },
    { threadId: 't1', turnId: 'u1', preferV2: true }
  );
  assert.equal(out.matched, true);
  assert.deepEqual(out.terminal, { kind: 'error', message: 'turn_failed' });
});

test('selectTurnStreamUpdate maps v2 interrupted as error', () => {
  const out = selectTurnStreamUpdate(
    {
      method: 'turn/completed',
      params: { threadId: 't1', turn: { id: 'u1', status: 'Interrupted' } }
    },
    { threadId: 't1', turnId: 'u1', preferV2: true }
  );
  assert.equal(out.matched, true);
  assert.deepEqual(out.terminal, { kind: 'error', message: 'turn_interrupted' });
});

test('selectTurnStreamUpdate maps v2 cancelled as error', () => {
  const out = selectTurnStreamUpdate(
    {
      method: 'turn/completed',
      params: { threadId: 't1', turn: { id: 'u1', status: 'Cancelled' } }
    },
    { threadId: 't1', turnId: 'u1', preferV2: true }
  );
  assert.equal(out.matched, true);
  assert.deepEqual(out.terminal, { kind: 'error', message: 'turn_cancelled' });
});

test('selectTurnStreamUpdate maps v2 retryable error to reconnect status', () => {
  const out = selectTurnStreamUpdate(
    {
      method: 'error',
      params: {
        threadId: 't1',
        turnId: 'u1',
        willRetry: true,
        error: { message: 'Reconnecting...2/5' }
      }
    },
    { threadId: 't1', turnId: 'u1', preferV2: true }
  );
  assert.equal(out.matched, true);
  assert.deepEqual(out.streamEvent, {
    type: 'status',
    phase: 'reconnecting',
    message: 'Reconnecting...2/5'
  });
});

test('selectTurnStreamUpdate ignores legacy when v2 preferred', () => {
  const out = selectTurnStreamUpdate(
    {
      method: 'codex/event/agent_message_delta',
      params: {
        conversationId: 't1',
        msg: { type: 'agent_message_delta', turn_id: 'u1', delta: 'legacy' }
      }
    },
    { threadId: 't1', turnId: 'u1', preferV2: true }
  );
  assert.equal(out.matched, false);
  assert.equal(out.nextPreferV2, true);
});

test('selectTurnStreamUpdate handles legacy completion', () => {
  const out = selectTurnStreamUpdate(
    {
      method: 'codex/event/task_complete',
      params: { conversationId: 't1', msg: { type: 'task_complete', turn_id: 'u1' } }
    },
    { threadId: 't1', turnId: 'u1', preferV2: false }
  );
  assert.equal(out.matched, true);
  assert.deepEqual(out.terminal, { kind: 'done' });
});

test('normalizeThreadMessages keeps assistant as single message unit even with reasoning items', () => {
  const readResult = {
    thread: {
      turns: [
        {
          id: 't1',
          input: [{ type: 'text', text: 'ユーザー質問' }],
          items: [
            { type: 'agentMessage', text: '本文1' },
            { type: 'reasoning', summary: ['thinking'] },
            { type: 'agentMessage', text: '本文2' },
            { type: 'reasoning', summary: ['thinking2'] },
            { type: 'agentMessage', text: '本文3' }
          ]
        }
      ]
    }
  };

  const out = normalizeThreadMessages(readResult);
  assert.deepEqual(
    out.map((item: OutputItem) => [item.id, item.role, item.type, item.text]),
    [
      ['t1:user:0', 'user', 'plain', 'ユーザー質問'],
      ['t1:assistant:0', 'assistant', 'markdown', '本文1\n本文2\n本文3']
    ]
  );
});

test('normalizeThreadMessages keeps single assistant segment when reasoning is absent', () => {
  const readResult = {
    thread: {
      turns: [
        {
          id: 't2',
          input: [{ type: 'text', text: 'q' }],
          items: [{ type: 'agentMessage', text: 'a1' }, { type: 'agentMessage', text: 'a2' }]
        }
      ]
    }
  };

  const out = normalizeThreadMessages(readResult);
  assert.deepEqual(
    out.map((item: OutputItem) => [item.id, item.role, item.type, item.text]),
    [
      ['t2:user:0', 'user', 'plain', 'q'],
      ['t2:assistant:0', 'assistant', 'markdown', 'a1\na2']
    ]
  );
});

test('normalizeThreadMessages keeps plan items in dedicated field', () => {
  const readResult = {
    thread: {
      turns: [
        {
          id: 't2p',
          input: [{ type: 'text', text: 'q' }],
          items: [{ type: 'plan', text: '手順1' }, { type: 'agentMessage', text: '最終回答' }]
        }
      ]
    }
  };

  const out = normalizeThreadMessages(readResult);
  assert.deepEqual(
    out.map((item: OutputItem) => [item.id, item.role, item.type, item.text]),
    [
      ['t2p:user:0', 'user', 'plain', 'q'],
      ['t2p:assistant:0', 'assistant', 'markdown', '最終回答']
    ]
  );
  const assistant = out.find((item: OutputItem) => item.id === 't2p:assistant:0');
  assert.ok(assistant && assistant.role === 'assistant');
  assert.equal(assistant.plan, '手順1');
});

test('normalizeThreadMessages marks diff segment as diff', () => {
  const readResult = {
    thread: {
      turns: [
        {
          id: 't3',
          input: [{ type: 'text', text: 'q' }],
          items: [{ type: 'agentMessage', text: 'diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b' }]
        }
      ]
    }
  };
  const out = normalizeThreadMessages(readResult);
  const assistant = out.find((item: OutputItem) => item.id === 't3:assistant:0');
  assert.ok(assistant);
  assert.equal(assistant.type, 'diff');
});

test('normalizeThreadMessages splits assistant segments around request user input item', () => {
  const readResult = {
    thread: {
      turns: [
        {
          id: 't4',
          input: [{ type: 'text', text: 'q' }],
          items: [
            { type: 'agentMessage', text: '確認前の回答' },
            { type: 'request_user_input', text: '' },
            { type: 'agentMessage', text: '確認後の回答' }
          ]
        }
      ]
    }
  };

  const out = normalizeThreadMessages(readResult);
  assert.deepEqual(
    out.map((item: OutputItem) => [item.id, item.role, item.type, item.text]),
    [
      ['t4:user:0', 'user', 'plain', 'q'],
      ['t4:assistant:0', 'assistant', 'markdown', '確認前の回答'],
      ['t4:assistant:1', 'assistant', 'markdown', '確認後の回答']
    ]
  );
});

test('normalizeThreadMessages splits same turn when app server history contains multiple userMessage items', () => {
  const readResult = {
    thread: {
      turns: [
        {
          id: 't5',
          input: [{ type: 'text', text: '最初の質問' }],
          items: [
            { type: 'userMessage', content: [{ type: 'text', text: '最初の質問' }] },
            { type: 'agentMessage', text: '最初の途中回答' },
            { type: 'userMessage', content: [{ type: 'text', text: '追加の入力' }] },
            { type: 'agentMessage', text: '追加入力を踏まえた最終回答' }
          ]
        }
      ]
    }
  };

  const out = normalizeThreadMessages(readResult);
  assert.deepEqual(
    out.map((item: OutputItem) => [item.id, item.role, item.type, item.text]),
    [
      ['t5:user:0', 'user', 'plain', '最初の質問'],
      ['t5:assistant:0', 'assistant', 'markdown', '最初の途中回答'],
      ['t5:user:1', 'user', 'plain', '追加の入力'],
      ['t5:assistant:1', 'assistant', 'markdown', '追加入力を踏まえた最終回答']
    ]
  );
});

test('buildToolUserInputResponsePayload normalizes single and array answers', () => {
  const out = buildToolUserInputResponsePayload({
    q1: '案A',
    q2: ['x', '', 'y'],
    q3: { answers: [' one ', ''] }
  });
  assert.deepEqual(out, {
    answers: {
      q1: { answers: ['案A'] },
      q2: { answers: ['x', 'y'] },
      q3: { answers: ['one'] }
    }
  });
});

test('buildToolUserInputResponsePayload drops empty answers', () => {
  const out = buildToolUserInputResponsePayload({
    q1: '',
    q2: [],
    q3: { answers: [''] }
  });
  assert.deepEqual(out, { answers: {} });
});

test('parseIssueSummaryOutput parses strict JSON summary', () => {
  const out = parseIssueSummaryOutput(
    JSON.stringify({
      title: '送信後に止まる',
      summary: 'Bad が押されたターンでは送信後に応答が進まなかった。',
      nextPrompt: '送信後に応答が進まない原因を調べて修正して'
    })
  );
  assert.equal(out.title, '送信後に止まる');
  assert.match(out.nextPrompt, /原因/);
});

test('parseIssueSummaryOutput rejects incomplete JSON without fallback', () => {
  assert.throws(() => parseIssueSummaryOutput('{"title":"x"}'), /issue_summary_json_invalid/);
});
