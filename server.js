const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');
const webPush = require('web-push');
const Fastify = require('fastify');
const fastifyStatic = require('@fastify/static');

const PORT = Number(process.env.PORT || 3000);
const CODEX_APP_SERVER_WS_URL = 'ws://127.0.0.1:39080';
const CODEX_APP_SERVER_START_CMD = `codex app-server --listen ${CODEX_APP_SERVER_WS_URL}`;
const CODEX_APP_SERVER_STARTUP_TIMEOUT_MS = 15000;

function resolveWorkspaceRoot() {
  const preferred = path.join(os.homedir(), '.fixer', 'workspace');
  if (!fs.existsSync(preferred)) {
    try {
      fs.mkdirSync(preferred, { recursive: true });
      return preferred;
    } catch {
      const fallback = path.join(process.cwd(), 'workspace');
      fs.mkdirSync(fallback, { recursive: true });
      return fallback;
    }
  }
  return preferred;
}

const WORKSPACE_ROOT = resolveWorkspaceRoot();
const PUSH_SUBSCRIPTIONS_PATH = path.join(WORKSPACE_ROOT, 'push-subscriptions.json');
const PUSH_VAPID_PATH = path.join(WORKSPACE_ROOT, 'push-vapid.json');
const DEFAULT_PUSH_SUBJECT = 'mailto:fixer@local.invalid';
const cloneJobs = new Map();
const runtimeLogs = [];
const MAX_RUNTIME_LOGS = 2000;
const runningTurnByThreadId = new Map();

let codexServerProcess = null;
let codexStartPromise = null;
let appServerWs = null;
let wsConnectPromise = null;
let rpcSeq = 1;
const rpcPending = new Map();
const wsSubscribers = new Set();
let pushSubscriptions = [];
let pushPublicKey = '';
let pushPrivateKey = '';
let pushEnabled = false;

function pushRuntimeLog(entry) {
  runtimeLogs.push({ timestamp: new Date().toISOString(), ...entry });
  if (runtimeLogs.length > MAX_RUNTIME_LOGS) runtimeLogs.shift();
}

function loadPushSubscriptions() {
  try {
    if (!fs.existsSync(PUSH_SUBSCRIPTIONS_PATH)) return [];
    const raw = fs.readFileSync(PUSH_SUBSCRIPTIONS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item) =>
        item &&
        typeof item === 'object' &&
        typeof item.endpoint === 'string' &&
        item.endpoint &&
        item.keys &&
        typeof item.keys.p256dh === 'string' &&
        typeof item.keys.auth === 'string'
    );
  } catch {
    return [];
  }
}

function savePushSubscriptions() {
  const tmp = `${PUSH_SUBSCRIPTIONS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(pushSubscriptions, null, 2));
  fs.renameSync(tmp, PUSH_SUBSCRIPTIONS_PATH);
}

function loadOrCreateVapidKeys() {
  try {
    if (fs.existsSync(PUSH_VAPID_PATH)) {
      const raw = fs.readFileSync(PUSH_VAPID_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof parsed.publicKey === 'string' &&
        typeof parsed.privateKey === 'string' &&
        parsed.publicKey &&
        parsed.privateKey
      ) {
        return {
          publicKey: parsed.publicKey,
          privateKey: parsed.privateKey
        };
      }
    }
  } catch {
    // 読み込み失敗時は再生成する。
  }

  const generated = webPush.generateVAPIDKeys();
  const payload = {
    publicKey: String(generated.publicKey),
    privateKey: String(generated.privateKey),
    createdAt: new Date().toISOString()
  };
  const tmp = `${PUSH_VAPID_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, PUSH_VAPID_PATH);
  return {
    publicKey: payload.publicKey,
    privateKey: payload.privateKey
  };
}

function upsertPushSubscription({ endpoint, keys, currentThreadId = null, userAgent = '' }) {
  const now = new Date().toISOString();
  const record = {
    endpoint,
    keys: {
      p256dh: String(keys.p256dh),
      auth: String(keys.auth)
    },
    currentThreadId: currentThreadId ? String(currentThreadId) : null,
    userAgent: String(userAgent || ''),
    updatedAt: now
  };
  const idx = pushSubscriptions.findIndex((item) => item.endpoint === endpoint);
  if (idx >= 0) pushSubscriptions[idx] = { ...pushSubscriptions[idx], ...record };
  else pushSubscriptions.push(record);
  savePushSubscriptions();
  return record;
}

function removePushSubscription(endpoint) {
  const before = pushSubscriptions.length;
  pushSubscriptions = pushSubscriptions.filter((item) => item.endpoint !== endpoint);
  if (pushSubscriptions.length !== before) savePushSubscriptions();
  return before !== pushSubscriptions.length;
}

function setPushContext(endpoint, currentThreadId = null) {
  const idx = pushSubscriptions.findIndex((item) => item.endpoint === endpoint);
  if (idx < 0) return null;
  pushSubscriptions[idx] = {
    ...pushSubscriptions[idx],
    currentThreadId: currentThreadId ? String(currentThreadId) : null,
    updatedAt: new Date().toISOString()
  };
  savePushSubscriptions();
  return pushSubscriptions[idx];
}

async function notifyPushSubscribersForThread(threadId) {
  if (!pushEnabled) return { sent: 0, staleRemoved: 0, skipped: 'push_not_configured' };
  const targets = pushSubscriptions.filter((sub) => sub.currentThreadId === threadId);
  if (targets.length === 0) return { sent: 0, staleRemoved: 0 };

  const payload = JSON.stringify({
    title: 'Fixer',
    body: '返答が完了しました',
    threadId,
    url: '/chat/'
  });

  let sent = 0;
  let staleRemoved = 0;

  for (const sub of targets) {
    try {
      await webPush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.keys.p256dh,
            auth: sub.keys.auth
          }
        },
        payload,
        { TTL: 60 }
      );
      sent += 1;
    } catch (error) {
      const statusCode = Number(error?.statusCode || 0);
      if (statusCode === 404 || statusCode === 410) {
        if (removePushSubscription(sub.endpoint)) staleRemoved += 1;
      }
      pushRuntimeLog({
        level: 'error',
        event: 'push_send_failed',
        threadId,
        endpoint: sub.endpoint,
        statusCode: statusCode || null,
        message: String(error?.message || 'unknown_error')
      });
    }
  }

  return { sent, staleRemoved };
}

function addWsSubscriber(handler) {
  wsSubscribers.add(handler);
  return () => wsSubscribers.delete(handler);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForOpen(ws, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws_open_timeout')), timeoutMs);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function attachWsHandlers(ws) {
  ws.on('message', (buf) => {
    let msg = null;
    try {
      msg = JSON.parse(String(buf));
    } catch {
      return;
    }

    if (msg && Object.prototype.hasOwnProperty.call(msg, 'id') && rpcPending.has(msg.id)) {
      const pending = rpcPending.get(msg.id);
      rpcPending.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(`app_server_error:${msg.error.code || 'unknown'}:${msg.error.message || 'unknown'}`));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    for (const cb of wsSubscribers) cb(msg);
  });

  ws.on('close', () => {
    if (appServerWs === ws) appServerWs = null;
    for (const pending of rpcPending.values()) pending.reject(new Error('app_server_socket_closed'));
    rpcPending.clear();
  });

  ws.on('error', (error) => {
    pushRuntimeLog({ level: 'error', event: 'app_server_ws_error', message: error.message });
  });
}

async function connectWs() {
  if (appServerWs && appServerWs.readyState === WebSocket.OPEN) return;
  if (wsConnectPromise) {
    await wsConnectPromise;
    return;
  }

  wsConnectPromise = (async () => {
    const ws = new WebSocket(CODEX_APP_SERVER_WS_URL);
    await waitForOpen(ws, 2000);
    attachWsHandlers(ws);
    appServerWs = ws;
    await rpcRequestRaw('initialize', {
      clientInfo: { name: 'fixer-mobile-ui', version: '0.1.0' },
      capabilities: {
        experimentalApi: true
      }
    });
    sendClientNotification('initialized');
  })();

  try {
    await wsConnectPromise;
  } finally {
    wsConnectPromise = null;
  }
}

function rpcRequestRaw(method, params) {
  if (!appServerWs || appServerWs.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error('app_server_not_connected'));
  }

  const id = rpcSeq++;
  const payload = { jsonrpc: '2.0', id, method, params: params || {} };

  return new Promise((resolve, reject) => {
    rpcPending.set(id, { resolve, reject });
    appServerWs.send(JSON.stringify(payload), (err) => {
      if (err) {
        rpcPending.delete(id);
        reject(err);
      }
    });
  });
}

function sendClientNotification(method, params) {
  if (!appServerWs || appServerWs.readyState !== WebSocket.OPEN) {
    throw new Error('app_server_not_connected');
  }
  const payload = { jsonrpc: '2.0', method };
  if (params && typeof params === 'object') payload.params = params;
  appServerWs.send(JSON.stringify(payload));
}

async function rpcRequest(method, params) {
  await ensureCodexServerRunning();
  await connectWs();
  return rpcRequestRaw(method, params);
}

function buildTurnInput(prompt, attachments) {
  const input = [{ type: 'text', text: String(prompt || '') }];
  const list = Array.isArray(attachments) ? attachments : [];
  for (const att of list) {
    if (!att || att.type !== 'image' || !att.dataUrl) continue;
    input.push({ type: 'image', url: String(att.dataUrl) });
  }
  return input;
}

function isThreadMissingError(error) {
  const message = String(error?.message || '');
  return message.includes('thread not found') || message.includes('thread_not_found') || message.includes('no rollout found for thread id');
}

function isThreadWarmupError(error) {
  const message = String(error?.message || '');
  return message.includes('no rollout found for thread id') || message.includes('thread_not_found') || message.includes('thread not found');
}

async function startTurnWithRetry(threadId, input, maxAttempts = 20, onRetry = null) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const turnStart = await rpcRequest('turn/start', { threadId, input });
      const turnId = turnStart?.turn?.id;
      if (!turnId) throw new Error('turn_id_missing');
      if (attempt > 1) {
        pushRuntimeLog({
          level: 'info',
          event: 'turn_start_recovered',
          threadId,
          attempt
        });
      }
      return turnId;
    } catch (error) {
      lastError = error;
      if (!isThreadWarmupError(error) || attempt === maxAttempts) throw error;
      if (typeof onRetry === 'function') {
        onRetry({
          attempt,
          message: String(error?.message || 'unknown_error')
        });
      }
      pushRuntimeLog({
        level: 'info',
        event: 'turn_start_retry',
        threadId,
        attempt,
        message: String(error?.message || 'unknown_error')
      });
      await sleep(Math.min(700, 100 + attempt * 60));
    }
  }
  throw lastError || new Error('turn_start_failed');
}

function looksLikeDiff(text) {
  return /^diff --git/m.test(text) || /^@@/m.test(text) || /^\+\+\+/m.test(text);
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function asString(value) {
  return typeof value === 'string' ? value : null;
}

function parseV2TurnNotification(msg) {
  const method = asString(msg?.method);
  if (!method || method.startsWith('codex/event/')) return null;
  const params = asObject(msg?.params);
  if (!params) return null;
  const turnObj = asObject(params.turn);
  const errorObj = asObject(params.error);
  const turnErrorObj = asObject(turnObj?.error);
  return {
    protocol: 'v2',
    method,
    threadId: asString(params.threadId),
    turnId: asString(params.turnId) || asString(turnObj?.id),
    delta: asString(params.delta),
    status: asString(turnObj?.status),
    errorMessage: asString(turnErrorObj?.message) || asString(errorObj?.message),
    willRetry: Boolean(params.willRetry)
  };
}

function parseLegacyTurnNotification(msg) {
  const method = asString(msg?.method);
  if (!method || !method.startsWith('codex/event/')) return null;
  const params = asObject(msg?.params);
  if (!params) return null;
  const event = asObject(params.msg) || {};
  const type =
    asString(event.type) ||
    method
      .slice('codex/event/'.length)
      .replace(/\//g, '_')
      .trim();
  return {
    protocol: 'legacy',
    method,
    type,
    threadId: asString(params.conversationId) || asString(params.threadId),
    turnId: asString(event.turn_id) || asString(event.turnId) || asString(params.turnId),
    delta: asString(event.delta),
    message: asString(event.message),
    reason: asString(event.reason)
  };
}

function isCompletedStatus(status) {
  return String(status || '').toLowerCase() === 'completed';
}

function isErrorStatus(status) {
  const normalized = String(status || '').toLowerCase();
  return normalized === 'failed' || normalized === 'interrupted' || normalized === 'cancelled';
}

function selectTurnStreamUpdate(msg, state) {
  const threadId = state?.threadId || null;
  const turnId = state?.turnId || null;
  const preferV2 = Boolean(state?.preferV2);
  let nextPreferV2 = preferV2;

  const v2 = parseV2TurnNotification(msg);
  if (v2 && v2.threadId === threadId && (!v2.turnId || v2.turnId === turnId)) {
    nextPreferV2 = true;
    if (v2.method === 'item/agentMessage/delta' && v2.delta) {
      return { matched: true, nextPreferV2, streamEvent: { type: 'answer_delta', delta: v2.delta } };
    }
    if ((v2.method === 'item/reasoning/summaryTextDelta' || v2.method === 'item/reasoning/textDelta') && v2.delta) {
      return { matched: true, nextPreferV2, streamEvent: { type: 'reasoning_delta', delta: v2.delta } };
    }
    if (v2.method === 'turn/completed') {
      if (isCompletedStatus(v2.status)) return { matched: true, nextPreferV2, terminal: { kind: 'done' } };
      if (isErrorStatus(v2.status)) {
        return {
          matched: true,
          nextPreferV2,
          terminal: { kind: 'error', message: `turn_${String(v2.status || '').toLowerCase()}` }
        };
      }
      return { matched: true, nextPreferV2, terminal: { kind: 'done' } };
    }
    if (v2.method === 'error') {
      if (v2.willRetry) {
        return {
          matched: true,
          nextPreferV2,
          streamEvent: {
            type: 'status',
            phase: 'reconnecting',
            message: v2.errorMessage || 'reconnecting'
          }
        };
      }
      return {
        matched: true,
        nextPreferV2,
        terminal: { kind: 'error', message: v2.errorMessage || 'turn_failed' }
      };
    }
    return { matched: true, nextPreferV2 };
  }

  if (nextPreferV2) return { matched: false, nextPreferV2 };

  const legacy = parseLegacyTurnNotification(msg);
  if (!legacy) return { matched: false, nextPreferV2 };
  if (legacy.threadId !== threadId) return { matched: false, nextPreferV2 };
  if (legacy.turnId && legacy.turnId !== turnId) return { matched: false, nextPreferV2 };

  const legacyType = String(legacy.type || '').toLowerCase();
  if (legacy.delta) {
    if (legacyType.includes('reasoning')) {
      return { matched: true, nextPreferV2, streamEvent: { type: 'reasoning_delta', delta: legacy.delta } };
    }
    if (legacyType.includes('agent_message')) {
      return { matched: true, nextPreferV2, streamEvent: { type: 'answer_delta', delta: legacy.delta } };
    }
    return { matched: true, nextPreferV2 };
  }
  if (legacyType === 'task_complete' || legacyType === 'turn_complete') {
    return { matched: true, nextPreferV2, terminal: { kind: 'done' } };
  }
  if (legacyType === 'turn_aborted') {
    return {
      matched: true,
      nextPreferV2,
      terminal: { kind: 'error', message: `turn_${legacy.reason || 'aborted'}` }
    };
  }
  if (legacyType === 'error') {
    return { matched: true, nextPreferV2, terminal: { kind: 'error', message: legacy.message || 'turn_failed' } };
  }
  return { matched: true, nextPreferV2 };
}

function normalizeThreadMessages(readResult) {
  const turns = Array.isArray(readResult?.thread?.turns) ? readResult.thread.turns : [];
  const messages = [];

  for (const turn of turns) {
    const items = Array.isArray(turn?.items) ? turn.items : [];
    const input = Array.isArray(turn?.input) ? turn.input : [];
    const userTextFromInput = input
      .filter((item) => item?.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('\n')
      .trim();
    const userTextFromItems = items
      .filter((item) => item?.type === 'userMessage')
      .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
      .trim();
    const userText = userTextFromInput || userTextFromItems;
    if (userText) {
      messages.push({
        id: `${turn.id}:user`,
        role: 'user',
        type: 'plain',
        text: userText
      });
    }

    const answerText = items
      .filter((item) => item?.type === 'agentMessage' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('\n');

    if (answerText) {
      messages.push({
        id: `${turn.id}:assistant`,
        role: 'assistant',
        type: looksLikeDiff(answerText) ? 'diff' : 'markdown',
        text: answerText,
        answer: answerText
      });
      messages.push({
        id: `${turn.id}:sep`,
        role: 'system',
        type: 'separator',
        text: ''
      });
    }
  }

  return messages;
}

async function isAppServerReady() {
  try {
    await connectWs();
    return true;
  } catch {
    return false;
  }
}

async function waitUntilAppServerReady(timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isAppServerReady()) return true;
    await sleep(300);
  }
  return false;
}

async function ensureCodexServerRunning() {
  if (await isAppServerReady()) return;

  if (codexStartPromise) {
    await codexStartPromise;
    return;
  }

  codexStartPromise = (async () => {
    pushRuntimeLog({
      level: 'info',
      event: 'codex_server_autostart_begin',
      command: CODEX_APP_SERVER_START_CMD
    });

    codexServerProcess = spawn('bash', ['-lc', CODEX_APP_SERVER_START_CMD], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    });
    codexServerProcess.unref();

    codexServerProcess.stdout.on('data', (chunk) => {
      pushRuntimeLog({
        level: 'info',
        event: 'codex_server_stdout',
        message: chunk.toString('utf8').slice(0, 500)
      });
    });
    codexServerProcess.stderr.on('data', (chunk) => {
      pushRuntimeLog({
        level: 'error',
        event: 'codex_server_stderr',
        message: chunk.toString('utf8').slice(0, 500)
      });
    });
    codexServerProcess.on('exit', (code, signal) => {
      pushRuntimeLog({
        level: code === 0 ? 'info' : 'error',
        event: 'codex_server_exit',
        code,
        signal
      });
    });

    const ready = await waitUntilAppServerReady(CODEX_APP_SERVER_STARTUP_TIMEOUT_MS);
    if (!ready) throw new Error(`codex_server_start_timeout_${CODEX_APP_SERVER_STARTUP_TIMEOUT_MS}ms`);

    pushRuntimeLog({
      level: 'info',
      event: 'codex_server_autostart_ready',
      wsUrl: CODEX_APP_SERVER_WS_URL
    });
  })();

  try {
    await codexStartPromise;
  } finally {
    codexStartPromise = null;
  }
}

function repoFolderFromFullName(fullName) {
  return fullName.replace(/[\\/]/g, '__');
}

function repoPathFromFullName(fullName) {
  return path.join(WORKSPACE_ROOT, repoFolderFromFullName(fullName));
}

function getCloneState(fullName) {
  const repoPath = repoPathFromFullName(fullName);
  const job = cloneJobs.get(fullName);

  if (job?.status === 'cloning') return { status: 'cloning', repoPath };
  if (job?.status === 'failed') return { status: 'failed', repoPath, error: job.error };
  if (fs.existsSync(path.join(repoPath, '.git'))) return { status: 'cloned', repoPath };
  return { status: 'not_cloned', repoPath };
}

function runClone(fullName, cloneUrl) {
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

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  child.on('close', (code) => {
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

function runGh(args) {
  return spawnSync('gh', args, { encoding: 'utf8' });
}

function getGithubTokenFromGh() {
  const tokenResult = runGh(['auth', 'token']);
  if (tokenResult.error) {
    if (tokenResult.error.code === 'ENOENT') throw new Error('gh_not_installed');
    throw new Error(`gh_auth_token_error:${tokenResult.error.message}`);
  }

  if (tokenResult.status !== 0) {
    const msg = (tokenResult.stderr || tokenResult.stdout || '').trim();
    throw new Error(`gh_not_logged_in:${msg}`);
  }

  const token = (tokenResult.stdout || '').trim();
  if (!token) throw new Error('gh_token_empty');
  return token;
}

function getGhStatus() {
  const versionResult = runGh(['--version']);
  if (versionResult.error && versionResult.error.code === 'ENOENT') {
    return { available: false, connected: false, hint: 'gh がインストールされていません。' };
  }
  if (versionResult.status !== 0) {
    return { available: false, connected: false, hint: 'gh コマンドを実行できません。' };
  }

  try {
    const token = getGithubTokenFromGh();
    return { available: true, connected: true, token };
  } catch (error) {
    if (String(error.message).startsWith('gh_not_logged_in')) {
      return { available: true, connected: false, hint: '先に `gh auth login` を実行してください。' };
    }
    return { available: true, connected: false, hint: error.message };
  }
}

async function githubUser(token) {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      'User-Agent': 'codex-mobile-ui',
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`github_user_error:${response.status}:${text.slice(0, 200)}`);
  }
  return response.json();
}

async function githubRepos(token, query) {
  const endpoint = query
    ? `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}+user:@me`
    : 'https://api.github.com/user/repos?per_page=100&sort=updated';

  const response = await fetch(endpoint, {
    headers: {
      'User-Agent': 'codex-mobile-ui',
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`github_error:${response.status}:${text.slice(0, 200)}`);
  }

  const data = await response.json();
  const repos = Array.isArray(data) ? data : data.items || [];
  return repos.map((repo) => ({
    id: repo.id,
    name: repo.name,
    fullName: repo.full_name,
    private: repo.private,
    cloneUrl: repo.clone_url,
    defaultBranch: repo.default_branch,
    updatedAt: repo.updated_at,
    cloneState: getCloneState(repo.full_name)
  }));
}

function buildServer() {
  pushSubscriptions = loadPushSubscriptions();
  try {
    const keys = loadOrCreateVapidKeys();
    pushPublicKey = keys.publicKey;
    pushPrivateKey = keys.privateKey;
    webPush.setVapidDetails(DEFAULT_PUSH_SUBJECT, pushPublicKey, pushPrivateKey);
    pushEnabled = true;
  } catch (error) {
    pushEnabled = false;
    pushRuntimeLog({
      level: 'error',
      event: 'push_vapid_init_failed',
      message: String(error?.message || 'unknown_error')
    });
  }

  const app = Fastify({ logger: { level: 'info' } });

  app.register(fastifyStatic, {
    root: path.join(process.cwd(), 'public'),
    prefix: '/'
  });

  app.addHook('onRequest', async (request) => {
    request.startTime = process.hrtime.bigint();
  });

  app.addHook('onResponse', async (request, reply) => {
    const end = process.hrtime.bigint();
    const durationMs = Number(end - request.startTime) / 1e6;
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

  app.setErrorHandler((error, request, reply) => {
    const log = {
      requestId: request.id,
      path: request.url,
      method: request.method,
      message: error.message,
      stack: error.stack
    };
    pushRuntimeLog({ level: 'error', event: 'request_failed', ...log });
    request.log.error(log, 'request_failed');
    reply.code(500).send({ error: error.message || 'internal_error', requestId: request.id });
  });

  app.get('/', async (_request, reply) => reply.sendFile('index.html'));
  app.get('/repos', async (_request, reply) => reply.sendFile('index.html'));
  app.get('/repos/', async (_request, reply) => reply.sendFile('index.html'));
  app.get('/chat', async (_request, reply) => reply.sendFile('index.html'));
  app.get('/chat/', async (_request, reply) => reply.sendFile('index.html'));
  app.get('/api/health', async () => ({
    ok: true,
    workspaceRoot: WORKSPACE_ROOT,
    codexMode: 'app-server',
    codexAppServerWsUrl: CODEX_APP_SERVER_WS_URL,
    codexAutostartEnabled: true
  }));

  app.get('/api/logs', async (request) => {
    const level = request.query.level;
    const limitRaw = Number(request.query.limit || 200);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(1000, limitRaw)) : 200;
    let logs = runtimeLogs;
    if (level) logs = logs.filter((entry) => entry.level === level);
    const items = logs.slice(-limit);
    return { total: logs.length, count: items.length, items };
  });

  app.get('/api/push/config', async () => {
    return {
      enabled: pushEnabled,
      publicKey: pushEnabled ? pushPublicKey : '',
      hasVapidConfig: pushEnabled,
      subscriptionCount: pushSubscriptions.length
    };
  });

  app.post('/api/push/subscribe', async (request, reply) => {
    const body = request.body || {};
    const sub = body.subscription || {};
    const endpoint = typeof sub.endpoint === 'string' ? sub.endpoint.trim() : '';
    const p256dh = typeof sub?.keys?.p256dh === 'string' ? sub.keys.p256dh.trim() : '';
    const auth = typeof sub?.keys?.auth === 'string' ? sub.keys.auth.trim() : '';
    if (!endpoint || !p256dh || !auth) {
      reply.code(400);
      return { error: 'invalid_subscription' };
    }
    const record = upsertPushSubscription({
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
    const body = request.body || {};
    const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
    if (!endpoint) {
      reply.code(400);
      return { error: 'endpoint_required' };
    }
    const record = setPushContext(endpoint, body.threadId ? String(body.threadId) : null);
    if (!record) {
      reply.code(404);
      return { error: 'subscription_not_found' };
    }
    return { ok: true, endpoint, threadId: record.currentThreadId };
  });

  app.post('/api/push/unsubscribe', async (request, reply) => {
    const body = request.body || {};
    const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
    if (!endpoint) {
      reply.code(400);
      return { error: 'endpoint_required' };
    }
    const removed = removePushSubscription(endpoint);
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
    const status = getGhStatus();
    if (!status.available) {
      reply.code(503);
      return { error: 'gh_not_available', hint: status.hint };
    }
    if (!status.connected) {
      reply.code(401);
      return { error: 'gh_not_logged_in', hint: status.hint };
    }
    const query = request.query.query || '';
    const repos = await githubRepos(status.token, query);
    return { repos };
  });

  app.post('/api/repos/clone', async (request, reply) => {
    const body = request.body || {};
    if (!body.fullName || !body.cloneUrl) {
      reply.code(400);
      return { error: 'fullName and cloneUrl are required' };
    }
    runClone(body.fullName, body.cloneUrl);
    reply.code(202);
    return getCloneState(body.fullName);
  });

  app.get('/api/repos/clone-status', async (request, reply) => {
    const fullName = request.query.fullName;
    if (!fullName) {
      reply.code(400);
      return { error: 'fullName is required' };
    }
    return getCloneState(fullName);
  });

  app.get('/api/threads', async (request, reply) => {
    const repoFullName = request.query.repoFullName;
    if (!repoFullName) {
      reply.code(400);
      return { error: 'repoFullName is required' };
    }
    const repoPath = repoPathFromFullName(repoFullName);
    const result = await rpcRequest('thread/list', { cwd: repoPath, archived: false, limit: 50 });
    // Codex app-server v2 returns `data` (not `threads`) for list responses.
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
    return {
      items
    };
  });

  app.get('/api/threads/messages', async (request, reply) => {
    const threadId = request.query.threadId;
    if (!threadId) {
      reply.code(400);
      return { error: 'threadId is required' };
    }
    try {
      await rpcRequest('thread/resume', { threadId });
      const read = await rpcRequest('thread/read', { threadId, includeTurns: true });
      const items = normalizeThreadMessages(read);
      pushRuntimeLog({
        level: 'info',
        event: 'thread_messages_loaded',
        threadId,
        count: items.length
      });
      return { items };
    } catch (error) {
      if (isThreadMissingError(error)) {
        pushRuntimeLog({
          level: 'info',
          event: 'thread_messages_not_ready',
          threadId
        });
        return { items: [] };
      }
      throw error;
    }
  });

  app.post('/api/threads/resume', async (request, reply) => {
    const body = request.body || {};
    const threadId = body.thread_id;
    if (!threadId) {
      reply.code(400);
      return { error: 'thread_id is required' };
    }
    try {
      await rpcRequest('thread/resume', { threadId });
      pushRuntimeLog({ level: 'info', event: 'thread_resumed', threadId });
      return { ok: true };
    } catch (error) {
      if (isThreadMissingError(error)) {
        pushRuntimeLog({ level: 'info', event: 'thread_resume_missing', threadId });
        reply.code(404);
        return { error: 'thread_not_found' };
      }
      throw error;
    }
  });

  app.post('/api/threads', async (request, reply) => {
    const body = request.body || {};
    if (!body.repoFullName) {
      reply.code(400);
      return { error: 'repoFullName is required' };
    }

    const repoPath = repoPathFromFullName(body.repoFullName);
    const result = await rpcRequest('thread/start', {
      cwd: repoPath,
      approvalPolicy: 'never',
      sandbox: 'workspace-write'
    });
    const id = result?.thread?.id;
    if (!id) throw new Error('thread_id_missing');
    return { id };
  });

  app.post('/api/threads/ensure', async (request, reply) => {
    const body = request.body || {};
    const repoFullName = body.repoFullName;
    const preferredThreadId = body.preferred_thread_id;
    if (!repoFullName) {
      reply.code(400);
      return { error: 'repoFullName is required' };
    }

    if (preferredThreadId) {
      pushRuntimeLog({
        level: 'info',
        event: 'thread_ensured_preferred',
        repoFullName,
        threadId: preferredThreadId
      });
      return { id: preferredThreadId, reused: true };
    }

    const repoPath = repoPathFromFullName(repoFullName);
    const result = await rpcRequest('thread/start', {
      cwd: repoPath,
      approvalPolicy: 'never',
      sandbox: 'workspace-write'
    });
    const id = result?.thread?.id;
    if (!id) throw new Error('thread_id_missing');
    pushRuntimeLog({
      level: 'info',
      event: 'thread_ensured_new',
      repoFullName,
      threadId: id
    });
    return { id, reused: false };
  });

  app.post('/api/turns/stream', async (request, reply) => {
    const body = request.body || {};
    const threadId = body.thread_id;
    const prompt = String(body.input || '').trim();
    if (!threadId || !prompt) {
      reply.code(400);
      return { error: 'thread_id and input are required' };
    }
    pushRuntimeLog({
      level: 'info',
      event: 'turn_stream_start',
      threadId,
      inputLength: prompt.length
    });
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });

    let aborted = false;
    let closed = false;
    let unsubWs = null;
    let timeoutHandle = null;
    let preferV2 = false;

    function writeEvent(event) {
      if (aborted) return;
      reply.raw.write(`${JSON.stringify(event)}\n`);
    }

    function closeStream(kind, message = null) {
      if (closed) return;
      closed = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      if (typeof unsubWs === 'function') {
        unsubWs();
        unsubWs = null;
      }
      runningTurnByThreadId.delete(threadId);
      if (kind === 'done') writeEvent({ type: 'done' });
      if (kind === 'error') writeEvent({ type: 'error', message: message || 'unknown_error' });
      if (!aborted) reply.raw.end();
      if (kind === 'done') {
        notifyPushSubscribersForThread(threadId)
          .then((result) => {
            pushRuntimeLog({
              level: 'info',
              event: 'push_notified',
              threadId,
              sent: result.sent,
              staleRemoved: result.staleRemoved,
              skipped: result.skipped || null
            });
          })
          .catch((error) => {
            pushRuntimeLog({
              level: 'error',
              event: 'push_notify_failed',
              threadId,
              message: String(error?.message || 'unknown_error')
            });
          });
      }
    }

    writeEvent({ type: 'started' });

    let turnId = null;
    try {
      turnId = await startTurnWithRetry(
        threadId,
        buildTurnInput(prompt, body.attachments || []),
        20,
        ({ attempt, message }) => {
          writeEvent({ type: 'status', phase: 'starting', attempt, message });
        }
      );
      runningTurnByThreadId.set(threadId, turnId);
    } catch (error) {
      writeEvent({ type: 'error', message: String(error?.message || 'turn_start_failed') });
      if (!aborted) reply.raw.end();
      return;
    }

    reply.raw.on('close', () => {
      aborted = true;
      closeStream('error', 'client_disconnected');
    });

    timeoutHandle = setTimeout(() => {
      pushRuntimeLog({
        level: 'error',
        event: 'turn_stream_timeout',
        threadId,
        turnId
      });
      closeStream('error', 'turn_timeout');
    }, 180000);

    unsubWs = addWsSubscriber((msg) => {
      if (aborted || closed) return;
      const update = selectTurnStreamUpdate(msg, { threadId, turnId, preferV2 });
      preferV2 = update.nextPreferV2;
      if (!update.matched) return;
      if (update.streamEvent?.type === 'status' && update.streamEvent.phase === 'reconnecting') {
        pushRuntimeLog({
          level: 'info',
          event: 'turn_stream_reconnecting',
          threadId,
          turnId,
          message: String(update.streamEvent.message || 'reconnecting')
        });
      }
      if (update.streamEvent) {
        writeEvent(update.streamEvent);
        return;
      }
      if (update.terminal) {
        pushRuntimeLog({
          level: update.terminal.kind === 'error' ? 'error' : 'info',
          event: 'turn_stream_terminal',
          threadId,
          turnId,
          kind: update.terminal.kind,
          message: update.terminal.message || null
        });
        closeStream(update.terminal.kind, update.terminal.message);
      }
    });
  });

  app.post('/api/turns/cancel', async (request, reply) => {
    const body = request.body || {};
    const threadId = body.thread_id;
    if (!threadId) {
      reply.code(400);
      return { error: 'thread_id is required' };
    }

    const turnId = runningTurnByThreadId.get(threadId);
    if (!turnId) {
      reply.code(404);
      return { error: 'running_turn_not_found' };
    }

    await rpcRequest('turn/interrupt', { threadId, turnId });
    runningTurnByThreadId.delete(threadId);
    return { cancelled: true };
  });

  app.post('/api/approvals/respond', async (_request, reply) => {
    reply.code(501);
    return { error: 'not_implemented_yet' };
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

module.exports = {
  buildServer,
  repoFolderFromFullName,
  repoPathFromFullName,
  getCloneState,
  parseV2TurnNotification,
  parseLegacyTurnNotification,
  selectTurnStreamUpdate,
  normalizeThreadMessages
};
