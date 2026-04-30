import { useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react';
import type {
  CollaborationMode,
  ImageAttachmentDraft,
  ImageAttachmentMeta,
  LiveTurnStateResponse,
  OutputItem,
  PendingBusyMap,
  PendingThreadReturn,
  PendingUserInputRequest,
  RequestId,
  TurnStateStreamEvent,
  TurnStreamEvent,
  UserInputAnswerMap,
  UserInputDraftMap,
  UserInputQuestion
} from '../../../../shared/types';
import { LAST_REPO_FULLNAME_KEY, LAST_THREAD_ID_KEY, PUSH_ENDPOINT_KEY, type ThreadByRepoMap } from '../../../app/storage';
import {
  decodeBase64UrlToUint8Array,
  getClientErrorMessage,
  isAssistantItem,
  isUserItem,
  loadThreadMessages,
  parseTurnStreamEvent,
  readFileAsDataUrl,
  threadMessagesKey
} from '../../../lib/appUtils';
import { expandAssistantItems } from '../assistantRender';

interface JsonErrorResponse {
  error?: string;
  hint?: string;
  [key: string]: unknown;
}

interface PendingUserInputFetchResponse {
  requests?: PendingUserInputRequest[];
  error?: string;
}

interface RunningTurnResponse {
  running?: boolean;
  threadId?: string;
  turnId?: string;
  error?: string;
}

interface PushConfigResponse extends JsonErrorResponse {
  enabled?: boolean;
  publicKey?: string;
}

interface ThreadMessagesResponse {
  items?: OutputItem[];
  model?: string | null;
  error?: string;
}

interface EnsureThreadResponse {
  id?: string;
  thread_id?: string;
  error?: string;
}

interface UseChatRuntimeArgs {
  activeCollaborationMode: CollaborationMode;
  activeRepoFullName: string | null;
  activeThreadId: string | null;
  chatVisible: boolean;
  currentPath: string;
  navigate: (path: string, replace?: boolean) => void;
  outputRef: RefObject<HTMLElement | null>;
  pendingChatScrollRestoreRef: MutableRefObject<number | null>;
  setActiveThreadId: (value: string | null) => void;
  setPendingThreadReturn: (value: PendingThreadReturn | null) => void;
  setThreadByRepo: Dispatch<SetStateAction<ThreadByRepoMap>>;
  threadByRepo: ThreadByRepoMap;
  pendingThreadReturn: PendingThreadReturn | null;
  getRepoModel: (repoFullName?: string | null) => string;
  setRepoModel: (repoFullName: string | null, modelId: string) => void;
  fetchIssues: (repoFullName?: string | null) => Promise<void>;
  toast: (text: string) => void;
}

export function useChatRuntime({
  activeCollaborationMode,
  activeRepoFullName,
  activeThreadId,
  chatVisible,
  currentPath,
  navigate,
  outputRef,
  pendingChatScrollRestoreRef,
  setActiveThreadId,
  setPendingThreadReturn,
  setThreadByRepo,
  threadByRepo,
  pendingThreadReturn,
  getRepoModel,
  setRepoModel,
  fetchIssues,
  toast
}: UseChatRuntimeArgs) {
  const [message, setMessage] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState<ImageAttachmentDraft[]>([]);
  const [outputItems, setOutputItems] = useState<OutputItem[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamingAssistantId, setStreamingAssistantId] = useState<string | null>(null);
  const [, setActiveTurnId] = useState('');
  const [liveReasoningText, setLiveReasoningText] = useState('');
  const [compactionStatusPhase, setCompactionStatusPhase] = useState<'' | 'compacting' | 'compacted'>('');
  const [compactionStatusMessage, setCompactionStatusMessage] = useState('');
  const [awaitingFirstStreamChunk, setAwaitingFirstStreamChunk] = useState(false);
  const [hasReasoningStarted, setHasReasoningStarted] = useState(false);
  const [hasAnswerStarted, setHasAnswerStarted] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pendingUserInputRequests, setPendingUserInputRequests] = useState<PendingUserInputRequest[]>([]);
  const [pendingUserInputDrafts, setPendingUserInputDrafts] = useState<UserInputDraftMap>({});
  const [pendingUserInputBusy, setPendingUserInputBusy] = useState<PendingBusyMap>({});

  const autoScrollRef = useRef(true);
  const streamAbortRef = useRef<AbortController | null>(null);
  const resumeStreamAbortRef = useRef<AbortController | null>(null);
  const resumeStreamingThreadIdRef = useRef('');
  const resumeStreamingTurnIdRef = useRef('');
  const chatEntryPathRef = useRef(currentPath);
  const lastChatEntryAlignKeyRef = useRef('');
  const chatEntryScrollTopRef = useRef(0);
  const activeThreadRef = useRef<string | null>(activeThreadId);
  const activeTurnIdRef = useRef('');
  const compactionStatusTimerRef = useRef<number | null>(null);
  const activeRepoRef = useRef<string | null>(activeRepoFullName);
  const streamingAssistantIdRef = useRef<string | null>(null);
  const activeLiveTurnSeqRef = useRef(0);
  const unboundPendingUserIdsRef = useRef<string[]>([]);
  const pendingUserIdsByTurnRef = useRef<Record<string, string[]>>({});
  const backgroundInterruptedTurnRef = useRef(false);
  const silentStreamAbortRef = useRef(false);
  const shouldResumeOnVisibleRef = useRef(false);
  const pushEndpointRef = useRef(typeof window !== 'undefined' ? window.localStorage.getItem(PUSH_ENDPOINT_KEY) || '' : '');
  const pushPublicKeyRef = useRef('');
  const serviceWorkerRegRef = useRef<ServiceWorkerRegistration | null>(null);

  function setStreamingAssistantTarget(id: string | null): void {
    streamingAssistantIdRef.current = id;
    setStreamingAssistantId(id);
  }

  function bindPendingUserIdsToTurn(turnId: string): void {
    const pendingIds = unboundPendingUserIdsRef.current;
    if (!turnId || pendingIds.length === 0) return;
    pendingUserIdsByTurnRef.current[turnId] = [...(pendingUserIdsByTurnRef.current[turnId] || []), ...pendingIds];
    unboundPendingUserIdsRef.current = [];
  }

  function trackPendingUserId(userId: string, turnId: string | null = null): void {
    if (!userId) return;
    if (!turnId) {
      unboundPendingUserIdsRef.current = [...unboundPendingUserIdsRef.current, userId];
      return;
    }
    pendingUserIdsByTurnRef.current[turnId] = [...(pendingUserIdsByTurnRef.current[turnId] || []), userId];
  }

  function getTrackedPendingUserIds(turnId: string): string[] {
    return pendingUserIdsByTurnRef.current[turnId] || [];
  }

  function hasAssistantContent(items: OutputItem[]): boolean {
    return items.some((item) => {
      if (!isAssistantItem(item)) return false;
      const answer = typeof item.answer === 'string' ? item.answer.trim() : String(item.text || '').trim();
      const plan = typeof item.plan === 'string' ? item.plan.trim() : '';
      const status = typeof item.status === 'string' ? item.status.trim() : '';
      return Boolean(answer || plan || status);
    });
  }

  function getLastAssistantId(items: OutputItem[]): string | null {
    for (let idx = items.length - 1; idx >= 0; idx -= 1) {
      const item = items[idx];
      if (!item) continue;
      if (isAssistantItem(item)) return String(item.id || '') || null;
    }
    return null;
  }

  function applyLiveTurnState(
    threadId: string,
    turnId: string,
    items: OutputItem[],
    options: { seq: number; liveReasoningText: string; markStreaming: boolean }
  ): void {
    if (!threadId || !turnId) return;
    const normalizedItems = expandAssistantItems(Array.isArray(items) ? items : []);
    const pendingIds = getTrackedPendingUserIds(turnId);
    const hasCanonicalUser = normalizedItems.some((item) => isUserItem(item));
    if (hasCanonicalUser && pendingIds.length > 0) {
      delete pendingUserIdsByTurnRef.current[turnId];
    }
    const turnPrefix = `${turnId}:`;
    const includesOtherTurnItems = normalizedItems.some((item) => {
      const itemId = String(item.id || '');
      return Boolean(itemId) && !itemId.startsWith(turnPrefix) && !pendingIds.includes(itemId);
    });
    setOutputItems((prev) => {
      if (includesOtherTurnItems) return normalizedItems;
      const nextBase = prev.filter((item) => {
        const itemId = String(item.id || '');
        if (itemId.startsWith(turnPrefix)) return false;
        if (hasCanonicalUser && pendingIds.includes(itemId)) return false;
        return true;
      });
      return [...nextBase, ...normalizedItems];
    });
    activeLiveTurnSeqRef.current = Math.max(0, Number(options.seq || 0));
    const nextAssistantId = options.markStreaming ? getLastAssistantId(normalizedItems) : null;
    setStreamingAssistantTarget(nextAssistantId);
    const hasOutput = hasAssistantContent(normalizedItems);
    setAwaitingFirstStreamChunk(!hasOutput && !String(options.liveReasoningText || '').trim());
    setHasAnswerStarted(options.markStreaming && hasOutput);
    setHasReasoningStarted(options.markStreaming && Boolean(String(options.liveReasoningText || '').trim()));
    setLiveReasoningText(options.markStreaming ? String(options.liveReasoningText || '') : '');
  }

  function handleTurnStateEvent(threadId: string, evt: TurnStateStreamEvent, options: { markStreaming: boolean }): void {
    const turnId = String(evt.turnId || '');
    if (!turnId) return;
    setActiveTurnId(turnId);
    activeTurnIdRef.current = turnId;
    applyLiveTurnState(threadId, turnId, Array.isArray(evt.items) ? evt.items : [], {
      seq: Number(evt.seq || 0),
      liveReasoningText: String(evt.liveReasoningText || ''),
      markStreaming: options.markStreaming
    });
  }

  function clearCompactionStatusTimer(): void {
    if (compactionStatusTimerRef.current !== null && typeof window !== 'undefined') {
      window.clearTimeout(compactionStatusTimerRef.current);
      compactionStatusTimerRef.current = null;
    }
  }

  function setCompactionStatus(phase: '' | 'compacting' | 'compacted', message = ''): void {
    clearCompactionStatusTimer();
    setCompactionStatusPhase(phase);
    setCompactionStatusMessage(message);
    if (phase === 'compacted' && typeof window !== 'undefined') {
      compactionStatusTimerRef.current = window.setTimeout(() => {
        setCompactionStatusPhase('');
        setCompactionStatusMessage('');
        compactionStatusTimerRef.current = null;
      }, 1800);
    }
  }

  function resetStreamingUiState(): void {
    setStreaming(false);
    setStreamingAssistantTarget(null);
    setLiveReasoningText('');
    setCompactionStatus('', '');
    setAwaitingFirstStreamChunk(false);
    setHasReasoningStarted(false);
    setHasAnswerStarted(false);
    setActiveTurnId('');
    activeTurnIdRef.current = '';
    activeLiveTurnSeqRef.current = 0;
  }

  async function interruptStreamingSilently(): Promise<void> {
    if (!streaming && !streamAbortRef.current && !resumeStreamAbortRef.current) return;
    silentStreamAbortRef.current = true;
    shouldResumeOnVisibleRef.current = false;
    if (resumeStreamAbortRef.current) resumeStreamAbortRef.current.abort();
    if (streamAbortRef.current) streamAbortRef.current.abort();
    const threadId = activeThreadRef.current;
    if (threadId) {
      try {
        await fetch('/api/turns/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ thread_id: threadId })
        });
      } catch {}
    }
    setPendingUserInputRequests([]);
    setPendingUserInputDrafts({});
    setActiveTurnId('');
    activeTurnIdRef.current = '';
  }

  function detachStreamingSubscriptionSilently(): void {
    if (!streaming && !streamAbortRef.current && !resumeStreamAbortRef.current) return;
    silentStreamAbortRef.current = true;
    shouldResumeOnVisibleRef.current = false;
    backgroundInterruptedTurnRef.current = false;
    if (resumeStreamAbortRef.current) resumeStreamAbortRef.current.abort();
    if (streamAbortRef.current) streamAbortRef.current.abort();
  }

  function appendStreamErrorMessage(prefix: string, messageText: string): void {
    const text = `${prefix}: ${messageText}`;
    setOutputItems((prev) => [...prev, { id: `system:${Date.now()}`, role: 'system', type: 'plain', text }]);
  }

  async function addImageAttachments(fileList: FileList | null): Promise<void> {
    const files = Array.from(fileList || []) as File[];
    if (files.length === 0) return;
    const next: ImageAttachmentDraft[] = [];
    for (const file of files) {
      if (!file.type || !file.type.startsWith('image/')) {
        toast(`画像のみ添付できます: ${file.name}`);
        continue;
      }
      try {
        const dataUrl = await readFileAsDataUrl(file);
        if (!dataUrl) throw new Error('empty_data_url');
        next.push({
          type: 'image',
          name: String(file.name || 'image'),
          mime: String(file.type || 'image/*'),
          size: Number(file.size || 0),
          dataUrl
        });
      } catch {
        toast(`画像読み込み失敗: ${file.name}`);
      }
    }
    if (next.length > 0) setPendingAttachments((prev) => [...prev, ...next]);
  }

  function removePendingAttachment(index: number): void {
    setPendingAttachments((prev) => prev.filter((_, idx) => idx !== index));
  }

  async function fetchPushConfig(): Promise<PushConfigResponse> {
    const res = await fetch('/api/push/config');
    const data = (await res.json()) as PushConfigResponse;
    if (!res.ok) throw new Error(data.error || 'push_config_failed');
    return data;
  }

  async function ensureServiceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
    if (serviceWorkerRegRef.current) return serviceWorkerRegRef.current;
    const reg = await navigator.serviceWorker.register('/sw.js');
    serviceWorkerRegRef.current = reg;
    return reg;
  }

  async function syncPushSubscription(subscription: PushSubscription, threadId: string | null = activeThreadRef.current): Promise<JsonErrorResponse> {
    const json = subscription?.toJSON?.();
    if (!json?.endpoint || !json?.keys?.p256dh || !json?.keys?.auth) throw new Error('push_subscription_invalid');
    const res = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: json, threadId: threadId || null, userAgent: navigator.userAgent })
    });
    const data = (await res.json()) as JsonErrorResponse;
    if (!res.ok) throw new Error(data.error || 'push_subscribe_failed');
    pushEndpointRef.current = json.endpoint;
    window.localStorage.setItem(PUSH_ENDPOINT_KEY, json.endpoint);
    return data;
  }

  async function ensurePushNotificationsEnabled(threadId: string | null = activeThreadRef.current): Promise<boolean> {
    if (typeof window === 'undefined') return false;
    const supported = window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    if (!supported) {
      setPushEnabled(false);
      return false;
    }
    try {
      if (!pushPublicKeyRef.current) {
        const config = await fetchPushConfig();
        if (!config.enabled || !config.publicKey) {
          setPushEnabled(false);
          return false;
        }
        pushPublicKeyRef.current = String(config.publicKey);
      }
      if (Notification.permission === 'denied') {
        setPushEnabled(false);
        return false;
      }
      const reg = await ensureServiceWorkerRegistration();
      let subscription = await reg.pushManager.getSubscription();
      if (!subscription) {
        const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
        if (permission !== 'granted') {
          setPushEnabled(false);
          return false;
        }
        subscription = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: decodeBase64UrlToUint8Array(pushPublicKeyRef.current) as BufferSource
        });
      }
      await syncPushSubscription(subscription, threadId);
      setPushEnabled(true);
      return true;
    } catch {
      setPushEnabled(false);
      return false;
    }
  }

  async function fetchRunningTurn(threadId: string): Promise<RunningTurnResponse> {
    const res = await fetch(`/api/turns/running?threadId=${encodeURIComponent(threadId)}`);
    const data = (await res.json()) as RunningTurnResponse;
    if (!res.ok) throw new Error(data.error || 'running_turn_fetch_failed');
    return data;
  }

  async function fetchLiveTurnState(threadId: string): Promise<LiveTurnStateResponse> {
    const res = await fetch(`/api/turns/live-state?threadId=${encodeURIComponent(threadId)}`);
    const data = (await res.json()) as LiveTurnStateResponse;
    if (!res.ok) throw new Error(data.error || 'live_turn_state_fetch_failed');
    return data;
  }

  function sanitizePendingUserInputRequests(items: unknown, threadId: string | null = activeThreadRef.current): PendingUserInputRequest[] {
    const list = Array.isArray(items) ? items : [];
    const keyed = new Map<string, PendingUserInputRequest>();
    const normalized = list
      .map((item) => (item && typeof item === 'object' ? (item as Partial<PendingUserInputRequest>) : null))
      .filter((item): item is Partial<PendingUserInputRequest> => Boolean(item))
      .filter((item) => !threadId || String(item.threadId || '') === String(threadId))
      .map((item) => ({
        requestId: (item.requestId || '') as RequestId,
        threadId: String(item.threadId || ''),
        turnId: String(item.turnId || ''),
        itemId: String(item.itemId || ''),
        questions: Array.isArray(item.questions) ? (item.questions as UserInputQuestion[]) : [],
        createdAt: String(item.createdAt || '')
      }));
    for (const item of normalized) {
      const key = String(item.requestId || '');
      if (!key) continue;
      keyed.set(key, item);
    }
    return Array.from(keyed.values()).sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  }

  function mergePendingUserInputRequest(request: PendingUserInputRequest): void {
    if (!request || !request.requestId) return;
    setPendingUserInputRequests((prev) => {
      const next = [...prev.filter((item) => String(item.requestId) !== String(request.requestId)), request];
      next.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
      return next;
    });
  }

  async function fetchPendingUserInputRequests(threadId: string | null): Promise<PendingUserInputRequest[]> {
    if (!threadId) {
      setPendingUserInputRequests([]);
      return [];
    }
    const res = await fetch(`/api/approvals/pending?threadId=${encodeURIComponent(threadId)}`);
    const data = (await res.json()) as PendingUserInputFetchResponse;
    if (!res.ok) throw new Error(data.error || 'pending_user_input_fetch_failed');
    const requests = sanitizePendingUserInputRequests(data.requests, threadId);
    setPendingUserInputRequests(requests);
    return requests;
  }

  function applyTurnStreamEvent(threadId: string, evt: TurnStreamEvent, options: { markStreaming: boolean }): void {
    if (evt.type === 'started') {
      const turnId = String(evt.turnId || '');
      if (!turnId) return;
      setActiveTurnId(turnId);
      activeTurnIdRef.current = turnId;
      bindPendingUserIdsToTurn(turnId);
      return;
    }
    if (evt.type === 'turn_state') {
      handleTurnStateEvent(threadId, evt, options);
      return;
    }
    if (evt.type === 'request_user_input' && evt.requestId && Array.isArray(evt.questions)) {
      mergePendingUserInputRequest({
        requestId: evt.requestId,
        threadId,
        turnId: String(evt.turnId || activeTurnIdRef.current || ''),
        itemId: String(evt.itemId || ''),
        questions: evt.questions,
        createdAt: new Date().toISOString()
      });
      return;
    }
    if (evt.type === 'status' && (evt.phase === 'compacting' || evt.phase === 'compacted')) {
      setCompactionStatus(evt.phase, String(evt.message || (evt.phase === 'compacting' ? '会話履歴を圧縮しています...' : '会話履歴を圧縮しました')));
    }
  }

  async function consumeTurnStreamResponse(response: Response, threadId: string, signal: AbortSignal, options: { markStreaming: boolean }): Promise<void> {
    if (!response.body) throw new Error('turn_stream_body_missing');
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let lineBuf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      lineBuf += decoder.decode(value, { stream: true });
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const evt = parseTurnStreamEvent(trimmed);
        if (!evt) continue;
        if (evt.type === 'error') throw new Error(String(evt.message || 'unknown_error'));
        if (evt.type === 'done') return;
        applyTurnStreamEvent(threadId, evt, options);
      }
    }
    if (!lineBuf.trim()) return;
    const evt = parseTurnStreamEvent(lineBuf.trim());
    if (!evt) return;
    if (evt.type === 'error') throw new Error(String(evt.message || 'unknown_error'));
    if (evt.type !== 'done') applyTurnStreamEvent(threadId, evt, options);
  }

  async function fetchThreadMessages(threadId: string): Promise<{ items: OutputItem[]; model: string }> {
    const res = await fetch(`/api/threads/messages?threadId=${encodeURIComponent(threadId)}`);
    const data = (await res.json()) as ThreadMessagesResponse;
    if (!res.ok) throw new Error(data.error || 'thread_messages_failed');
    return { items: expandAssistantItems(Array.isArray(data.items) ? data.items : []), model: String(data.model || '').trim() };
  }

  async function resumeRunningTurn(threadId: string): Promise<boolean> {
    if (!threadId) return false;
    const running = await fetchRunningTurn(threadId);
    if (!running?.running || !running.turnId) {
      resetStreamingUiState();
      return false;
    }
    const liveState = await fetchLiveTurnState(threadId);
    if (activeThreadRef.current !== threadId) return false;
    const snapshotTurnId = String(liveState.turnId || running.turnId || '');
    if (snapshotTurnId && Array.isArray(liveState.items)) {
      setActiveTurnId(snapshotTurnId);
      activeTurnIdRef.current = snapshotTurnId;
      applyLiveTurnState(threadId, snapshotTurnId, liveState.items, {
        seq: Number(liveState.seq || 0),
        liveReasoningText: '',
        markStreaming: false
      });
    } else {
      setStreamingAssistantTarget(null);
      setLiveReasoningText('');
      setAwaitingFirstStreamChunk(true);
      setHasReasoningStarted(false);
      setHasAnswerStarted(false);
      activeLiveTurnSeqRef.current = Number(liveState.seq || 0);
      setActiveTurnId(String(running.turnId || ''));
      activeTurnIdRef.current = String(running.turnId || '');
    }
    await startResumeStream(threadId, String(running.turnId), Number(liveState.seq || 0));
    return true;
  }

  async function ensureThread(repoFullName: string, preferredThreadId: string | null = null, model = ''): Promise<string> {
    const normalizedModel = String(model || '').trim();
    const res = await fetch('/api/threads/ensure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoFullName, preferred_thread_id: preferredThreadId || undefined, model: normalizedModel || undefined })
    });
    const data = (await res.json()) as EnsureThreadResponse;
    if (!res.ok) throw new Error(data.error || 'thread_ensure_failed');
    const id = data.id || data.thread_id;
    if (!id) throw new Error('thread_id_missing');
    return id;
  }

  function isRecoverableThreadError(text: string): boolean {
    const raw = String(text || '');
    return raw.includes('thread not found') || raw.includes('thread_not_found') || raw.includes('no rollout found for thread id');
  }

  async function restoreOutputForThread(threadId: string, repoFullName: string | null = activeRepoRef.current, options: { resumeLive?: boolean; useCache?: boolean } = {}): Promise<void> {
    if (!threadId) return;
    activeThreadRef.current = threadId;
    if (options.useCache !== false) setOutputItems(loadThreadMessages(threadId));
    fetchPendingUserInputRequests(threadId).catch(() => {});
    try {
      const payload = await fetchThreadMessages(threadId);
      if (activeThreadRef.current !== threadId) return;
      setOutputItems(payload.items);
      if (payload.model && repoFullName) setRepoModel(repoFullName, payload.model);
    } catch {}
    if (!options.resumeLive) return;
    try {
      await resumeRunningTurn(threadId);
    } catch {}
  }

  function appendUserMessage(prompt: string, attachments: ImageAttachmentDraft[], options: { turnId?: string | null } = {}): string {
    const userId = `u-${Date.now()}`;
    const attachmentMeta: ImageAttachmentMeta[] = attachments.map((att) => ({ type: 'image', name: att.name, size: att.size, mime: att.mime }));
    trackPendingUserId(userId, options.turnId || null);
    setOutputItems((prev) => [...prev, { id: userId, role: 'user', type: 'plain', text: prompt, attachments: attachmentMeta }]);
    return userId;
  }

  async function postSteerTurn(threadId: string, turnId: string, prompt: string, attachments: ImageAttachmentDraft[]): Promise<{ ok: boolean; status: number; error: string }> {
    const res = await fetch('/api/turns/steer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thread_id: threadId, turn_id: turnId, input: prompt, attachments })
    });
    let data: JsonErrorResponse = {};
    try {
      data = (await res.json()) as JsonErrorResponse;
    } catch {}
    return { ok: res.ok, status: res.status, error: String(data.error || '') };
  }

  async function startResumeStream(threadId: string, turnId: string, afterSeq = 0): Promise<void> {
    if (!threadId || !turnId) return;
    if (resumeStreamingTurnIdRef.current === turnId && resumeStreamAbortRef.current) return;
    if (resumeStreamAbortRef.current) resumeStreamAbortRef.current.abort();
    const controller = new AbortController();
    resumeStreamAbortRef.current = controller;
    resumeStreamingThreadIdRef.current = threadId;
    resumeStreamingTurnIdRef.current = turnId;
    streamAbortRef.current = controller;
    setStreaming(true);
    setActiveTurnId(String(turnId || ''));
    activeTurnIdRef.current = String(turnId || '');
    try {
      const res = await fetch(`/api/turns/stream/resume?threadId=${encodeURIComponent(threadId)}&turnId=${encodeURIComponent(turnId)}&afterSeq=${encodeURIComponent(String(afterSeq || 0))}`, { signal: controller.signal });
      if (!res.ok) throw new Error((await res.text()) || 'resume_stream_failed');
      await consumeTurnStreamResponse(res, threadId, controller.signal, { markStreaming: true });
      restoreOutputForThread(threadId, activeRepoRef.current, { useCache: false }).catch(() => {});
    } catch (e: unknown) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) restoreOutputForThread(threadId, activeRepoRef.current, { useCache: false }).catch(() => {});
    } finally {
      if (resumeStreamAbortRef.current === controller) {
        resumeStreamAbortRef.current = null;
        resumeStreamingThreadIdRef.current = '';
        resumeStreamingTurnIdRef.current = '';
      }
      if (streamAbortRef.current === controller) streamAbortRef.current = null;
      if (streamAbortRef.current === null || streamAbortRef.current === controller) {
        silentStreamAbortRef.current = false;
        resetStreamingUiState();
      }
    }
  }

  async function respondToUserInput(requestId: RequestId, answers: UserInputAnswerMap, requestMeta: Pick<PendingUserInputRequest, 'threadId' | 'turnId'> | null = null): Promise<boolean> {
    const key = String(requestId || '');
    if (!key) return false;
    setPendingUserInputBusy((prev) => ({ ...prev, [key]: true }));
    try {
      const res = await fetch('/api/approvals/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_id: requestId, answers })
      });
      const data = (await res.json()) as JsonErrorResponse;
      if (!res.ok) throw new Error(data.error || 'approval_respond_failed');
      setPendingUserInputRequests((prev) => prev.filter((item) => String(item.requestId) !== key));
      toast('入力を送信しました');
      const metaThreadId = String(requestMeta?.threadId || '');
      if (metaThreadId) {
        if (streaming) return true;
        try {
          const resumed = await resumeRunningTurn(metaThreadId);
          if (!resumed) restoreOutputForThread(metaThreadId).catch(() => {});
        } catch {
          restoreOutputForThread(metaThreadId).catch(() => {});
        }
      }
      return true;
    } catch (e: unknown) {
      toast(`入力送信失敗: ${getClientErrorMessage(e)}`);
      return false;
    } finally {
      setPendingUserInputBusy((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  }

  async function selectUserInputOption(request: PendingUserInputRequest, questionIndex: number, questionId: string, optionLabel: string): Promise<void> {
    if (!request || !request.requestId || !questionId) return;
    const requestKey = String(request.requestId);
    const questions = Array.isArray(request.questions) ? request.questions : [];
    if (questions.length === 0 || pendingUserInputBusy[requestKey]) return;
    const snapshotState = pendingUserInputDrafts[requestKey] && typeof pendingUserInputDrafts[requestKey] === 'object' ? pendingUserInputDrafts[requestKey] : { index: 0, answers: {} };
    const snapshotAnswers = snapshotState.answers && typeof snapshotState.answers === 'object' ? snapshotState.answers : {};
    const nextAnswers = { ...snapshotAnswers, [questionId]: { answers: [String(optionLabel || '')] } };
    const rawIndex = Number.isInteger(questionIndex) ? questionIndex : Number(snapshotState.index || 0);
    const currentIndex = Math.min(Math.max(0, rawIndex), Math.max(0, questions.length - 1));
    const nextIndex = currentIndex + 1;
    const complete = nextIndex >= questions.length;
    setPendingUserInputDrafts((prev) => ({
      ...prev,
      [requestKey]: { index: complete ? Math.max(0, questions.length - 1) : nextIndex, answers: nextAnswers }
    }));
    if (!complete) return;
    const ok = await respondToUserInput(request.requestId, nextAnswers, { threadId: request.threadId, turnId: request.turnId });
    if (!ok) return;
    setPendingUserInputDrafts((prev) => {
      const next = { ...prev };
      delete next[requestKey];
      return next;
    });
  }

  async function startTurnStream(prompt: string, attachmentsToSend: ImageAttachmentDraft[], threadIdToUse: string, appendUser = true, forcedCollaborationMode = ''): Promise<void> {
    const repoFullName = activeRepoFullName;
    if (!repoFullName) throw new Error('repo_not_selected');
    setMessage('');
    setPendingAttachments([]);
    setLiveReasoningText('');
    setAwaitingFirstStreamChunk(true);
    setHasReasoningStarted(false);
    setHasAnswerStarted(false);
    setStreaming(true);
    setStreamingAssistantTarget(null);
    setActiveTurnId('');
    activeTurnIdRef.current = '';
    activeLiveTurnSeqRef.current = 0;
    if (appendUser) appendUserMessage(prompt, attachmentsToSend);
    const controller = new AbortController();
    streamAbortRef.current = controller;
    backgroundInterruptedTurnRef.current = false;
    try {
      async function postTurn(targetThreadId: string): Promise<Response> {
        const model = getRepoModel(activeRepoRef.current);
        return fetch('/api/turns/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            thread_id: targetThreadId,
            input: prompt,
            attachments: attachmentsToSend,
            collaboration_mode: forcedCollaborationMode || activeCollaborationMode,
            model: model || undefined
          }),
          signal: controller.signal
        });
      }
      let res = await postTurn(threadIdToUse);
      if (!res.ok) {
        const firstErr = await res.text();
        if (isRecoverableThreadError(firstErr)) {
          const recovered = await ensureThread(repoFullName, null, getRepoModel(repoFullName));
          threadIdToUse = recovered;
          setActiveThreadId(recovered);
          setThreadByRepo((prev) => ({ ...prev, [repoFullName]: recovered }));
          restoreOutputForThread(recovered, repoFullName, { resumeLive: true }).catch(() => {});
          res = await postTurn(threadIdToUse);
        } else {
          throw new Error(firstErr || 'send_failed');
        }
      }
      if (!res.ok) throw new Error((await res.text()) || 'send_failed');
      await consumeTurnStreamResponse(res, threadIdToUse, controller.signal, { markStreaming: true });
      restoreOutputForThread(threadIdToUse, repoFullName, { useCache: false }).catch(() => {});
      window.setTimeout(() => fetchIssues(repoFullName).catch(() => {}), 1800);
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        if (!backgroundInterruptedTurnRef.current && !silentStreamAbortRef.current) appendStreamErrorMessage('停止', '停止しました');
      } else if (!backgroundInterruptedTurnRef.current) {
        appendStreamErrorMessage('送信失敗', getClientErrorMessage(e));
        toast('送信に失敗しました');
      }
    } finally {
      if (streamAbortRef.current === controller) {
        streamAbortRef.current = null;
        backgroundInterruptedTurnRef.current = false;
        silentStreamAbortRef.current = false;
        resetStreamingUiState();
      }
    }
  }

  async function sendTurnWithOverrides({ forcedPrompt = '', forcedCollaborationMode = '' }: { forcedPrompt?: CollaborationMode | string; forcedCollaborationMode?: CollaborationMode | string } = {}): Promise<void> {
    const repoFullName = activeRepoFullName;
    if (!repoFullName) {
      toast('リポジトリが未選択です');
      return;
    }
    const overridePrompt = String(forcedPrompt || '').trim();
    const forcedMode = String(forcedCollaborationMode || '').trim();
    if (!activeThreadId) {
      try {
        const created = await ensureThread(repoFullName, null, getRepoModel(repoFullName));
        setActiveThreadId(created);
        setThreadByRepo((prev) => ({ ...prev, [repoFullName]: created }));
        restoreOutputForThread(created, repoFullName, { resumeLive: true }).catch(() => {});
      } catch (e: unknown) {
        toast(`Thread準備失敗: ${getClientErrorMessage(e)}`);
        return;
      }
    }
    const prompt = overridePrompt || message.trim();
    const attachmentsToSend = overridePrompt ? [] : pendingAttachments;
    if (!prompt && attachmentsToSend.length === 0) return;
    if (overridePrompt) {
      setMessage('');
      setPendingAttachments([]);
    }
    let threadIdToUse = activeThreadId || threadByRepo[repoFullName];
    if (!threadIdToUse) return;
    try {
      const ensured = await ensureThread(repoFullName, threadIdToUse, getRepoModel(repoFullName));
      threadIdToUse = ensured;
      if (ensured !== activeThreadId) {
        setActiveThreadId(ensured);
        setThreadByRepo((prev) => ({ ...prev, [repoFullName]: ensured }));
        restoreOutputForThread(ensured, repoFullName, { resumeLive: true }).catch(() => {});
      }
    } catch (e: unknown) {
      toast(`Thread再接続失敗: ${getClientErrorMessage(e)}`);
      return;
    }
    if (pendingThreadReturn && pendingThreadReturn.repoFullName === repoFullName && pendingThreadReturn.toThreadId === threadIdToUse) {
      setPendingThreadReturn(null);
    }
    if (!streaming) {
      await startTurnStream(prompt, attachmentsToSend, threadIdToUse, true, forcedMode);
      return;
    }
    setMessage('');
    setPendingAttachments([]);
    if (resumeStreamAbortRef.current) resumeStreamAbortRef.current.abort();
    const turnIdToUse = String(activeTurnIdRef.current || '');
    if (!turnIdToUse) {
      appendUserMessage(prompt, attachmentsToSend);
      const controller = streamAbortRef.current;
      if (controller) {
        silentStreamAbortRef.current = true;
        controller.abort();
      }
      await startTurnStream(prompt, attachmentsToSend, threadIdToUse, false, forcedMode);
      return;
    }
    appendUserMessage(prompt, attachmentsToSend, { turnId: turnIdToUse });
    const steerResult = await postSteerTurn(threadIdToUse, turnIdToUse, prompt, attachmentsToSend);
    if (steerResult.ok) return;
    const isRecoverableSteerError =
      steerResult.status === 409 ||
      steerResult.error.includes('no_active_turn') ||
      steerResult.error.includes('turn_mismatch') ||
      steerResult.error.includes('running_turn_not_found');
    if (isRecoverableSteerError) {
      const controller = streamAbortRef.current;
      if (controller) {
        silentStreamAbortRef.current = true;
        controller.abort();
      }
      await startTurnStream(prompt, attachmentsToSend, threadIdToUse, false, forcedMode);
      return;
    }
    toast(`追加入力送信失敗: ${steerResult.error || 'steer_failed'}`);
  }

  async function sendTurn(): Promise<void> {
    await sendTurnWithOverrides();
  }

  function goBackToRepoList(): void {
    detachStreamingSubscriptionSilently();
    navigate('/repos/');
  }

  async function startNewThread(): Promise<void> {
    const repoFullName = activeRepoFullName;
    if (!repoFullName) {
      toast('リポジトリが未選択です');
      return;
    }
    try {
      if (streaming) await interruptStreamingSilently();
      const previousThreadId = String(activeThreadRef.current || '');
      const id = await (async () => {
        const normalizedModel = String(getRepoModel(repoFullName) || '').trim();
        const res = await fetch('/api/threads', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoFullName, title: `thread-${Date.now()}`, model: normalizedModel || undefined })
        });
        const data = (await res.json()) as EnsureThreadResponse;
        if (!res.ok) throw new Error(data.error || 'thread_create_failed');
        const nextId = data.id || data.thread_id;
        if (!nextId) throw new Error('thread_id_missing');
        return nextId;
      })();
      setActiveThreadId(id);
      setThreadByRepo((prev) => ({ ...prev, [repoFullName]: id }));
      if (previousThreadId && previousThreadId !== id) {
        setPendingThreadReturn({ repoFullName, fromThreadId: previousThreadId, toThreadId: id });
      } else {
        setPendingThreadReturn(null);
      }
      setOutputItems([]);
      setMessage('');
      setPendingAttachments([]);
      toast('新規スレッドを開始しました');
    } catch (e: unknown) {
      toast(`新規スレッド開始失敗: ${getClientErrorMessage(e)}`);
    }
  }

  async function cancelTurn(): Promise<void> {
    const controller = streamAbortRef.current;
    if (controller) controller.abort();
    const threadId = activeThreadRef.current;
    if (threadId) {
      try {
        await fetch('/api/turns/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ thread_id: threadId })
        });
      } catch {}
    }
    setPendingUserInputRequests([]);
    setPendingUserInputDrafts({});
    setActiveTurnId('');
    activeTurnIdRef.current = '';
  }

  function scrollLastUserMessageToTopOrKeepPosition(): boolean {
    const container = outputRef.current;
    if (!(container instanceof HTMLElement)) return false;
    const lastUserItem = [...outputItems].reverse().find((item) => item?.role === 'user');
    if (!lastUserItem?.id) {
      if (outputItems.length === 0) return false;
      container.scrollTop = chatEntryScrollTopRef.current;
      return true;
    }
    const userNodes = container.querySelectorAll('[data-msg-role="user"]');
    let target = null;
    for (const node of userNodes) {
      if (node instanceof HTMLElement && node.dataset.msgId === String(lastUserItem.id)) {
        target = node;
        break;
      }
    }
    if (!(target instanceof HTMLElement)) return false;
    target.scrollIntoView({ behavior: 'auto', block: 'start' });
    const containerTop = container.getBoundingClientRect().top;
    const targetTop = target.getBoundingClientRect().top;
    container.scrollTop += targetTop - containerTop;
    let diff = Math.abs(target.getBoundingClientRect().top - container.getBoundingClientRect().top);
    if (diff >= 4) {
      container.scrollTop = Math.max(0, target.offsetTop - container.offsetTop);
      diff = Math.abs(target.getBoundingClientRect().top - container.getBoundingClientRect().top);
    }
    return diff < 4;
  }

  const latestPlanText = useMemo(() => {
    for (let idx = outputItems.length - 1; idx >= 0; idx -= 1) {
      const item = outputItems[idx];
      if (!item || !isAssistantItem(item)) continue;
      const planText = String(item.plan || '').trim();
      if (planText) return planText;
    }
    return '';
  }, [outputItems]);

  const canReturnToPreviousThread = Boolean(
    pendingThreadReturn &&
      pendingThreadReturn.repoFullName === activeRepoFullName &&
      pendingThreadReturn.toThreadId === activeThreadId &&
      pendingThreadReturn.fromThreadId
  );
  const canApplyLatestPlan = Boolean(latestPlanText && activeThreadId && activeRepoFullName && activeCollaborationMode === 'plan');

  async function applyLatestPlanShortcut(): Promise<void> {
    if (!canApplyLatestPlan) return;
    await sendTurnWithOverrides({ forcedPrompt: 'このプランを実現して', forcedCollaborationMode: 'default' });
  }

  function returnToPreviousThread() {
    if (!canReturnToPreviousThread || !pendingThreadReturn) return;
    const repoFullName = activeRepoFullName;
    if (!repoFullName) return;
    const fallbackThreadId = String(pendingThreadReturn.fromThreadId || '');
    if (!fallbackThreadId) {
      setPendingThreadReturn(null);
      toast('前のスレッドが見つかりません');
      return;
    }
    void (async () => {
      if (streaming) await interruptStreamingSilently();
      setActiveThreadId(fallbackThreadId);
      setThreadByRepo((prev) => ({ ...prev, [repoFullName]: fallbackThreadId }));
      restoreOutputForThread(fallbackThreadId, repoFullName, { resumeLive: true }).catch(() => {});
      setPendingThreadReturn(null);
    })();
  }

  useEffect(() => {
    activeRepoRef.current = activeRepoFullName;
  }, [activeRepoFullName]);

  useEffect(() => {
    activeThreadRef.current = activeThreadId;
    setActiveTurnId('');
    activeTurnIdRef.current = '';
    if (
      resumeStreamAbortRef.current &&
      resumeStreamingThreadIdRef.current &&
      (!activeThreadId || resumeStreamingThreadIdRef.current !== activeThreadId)
    ) {
      resumeStreamAbortRef.current.abort();
    }
  }, [activeThreadId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    ensurePushNotificationsEnabled(activeThreadRef.current).catch(() => {});
  }, []);

  useEffect(() => {
    return () => {
      clearCompactionStatusTimer();
      if (resumeStreamAbortRef.current) resumeStreamAbortRef.current.abort();
    };
  }, []);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        if (streaming) {
          backgroundInterruptedTurnRef.current = true;
          shouldResumeOnVisibleRef.current = true;
          if (resumeStreamAbortRef.current) resumeStreamAbortRef.current.abort();
          if (streamAbortRef.current) streamAbortRef.current.abort();
        }
        return;
      }
      if (document.visibilityState !== 'visible') return;
      const threadId = activeThreadRef.current;
      if (!threadId) return;
      restoreOutputForThread(threadId, activeRepoRef.current, { resumeLive: shouldResumeOnVisibleRef.current }).catch(() => {});
      shouldResumeOnVisibleRef.current = false;
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [streaming]);

  useEffect(() => {
    const endpoint = pushEndpointRef.current;
    if (!endpoint || !pushEnabled) return;
    fetch('/api/push/context', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint, threadId: activeThreadId || null })
    }).catch(() => {});
  }, [activeThreadId, pushEnabled]);

  useEffect(() => {
    if (!activeThreadId) return;
    ensurePushNotificationsEnabled(activeThreadId).catch(() => {});
  }, [activeThreadId]);

  useEffect(() => {
    if (activeThreadId && activeRepoFullName) {
      window.localStorage.setItem(LAST_THREAD_ID_KEY, activeThreadId);
      window.localStorage.setItem(LAST_REPO_FULLNAME_KEY, activeRepoFullName);
      return;
    }
    window.localStorage.removeItem(LAST_THREAD_ID_KEY);
    window.localStorage.removeItem(LAST_REPO_FULLNAME_KEY);
  }, [activeThreadId, activeRepoFullName]);

  useEffect(() => {
    if (!activeRepoFullName || !activeThreadId) return;
    setThreadByRepo((prev) => {
      if (prev[activeRepoFullName] === activeThreadId) return prev;
      return { ...prev, [activeRepoFullName]: activeThreadId };
    });
  }, [activeRepoFullName, activeThreadId, setThreadByRepo]);

  useEffect(() => {
    if (!activeThreadId) return;
    window.localStorage.setItem(threadMessagesKey(activeThreadId), JSON.stringify(outputItems.slice(-200)));
  }, [activeThreadId, outputItems]);

  useEffect(() => {
    if (!streaming || !autoScrollRef.current || !outputRef.current) return;
    outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [outputItems, streaming]);

  useEffect(() => {
    const prevPath = chatEntryPathRef.current;
    chatEntryPathRef.current = currentPath;
    if (currentPath !== '/chat/' || prevPath === '/chat/') return;
    lastChatEntryAlignKeyRef.current = '';
    const node = outputRef.current;
    chatEntryScrollTopRef.current = node instanceof HTMLElement ? node.scrollTop : 0;
  }, [currentPath]);

  useEffect(() => {
    if (currentPath !== '/chat/' || !chatVisible || !activeThreadId) return;
    const container = outputRef.current;
    if (!(container instanceof HTMLElement)) return;
    const onScroll = () => {
      chatEntryScrollTopRef.current = container.scrollTop;
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => container.removeEventListener('scroll', onScroll);
  }, [currentPath, chatVisible, activeThreadId, outputItems.length]);

  useEffect(() => {
    if (currentPath !== '/chat/' || !chatVisible) return;
    const preferredScrollTop = pendingChatScrollRestoreRef.current;
    if (preferredScrollTop === null) return;
    const container = outputRef.current;
    if (!(container instanceof HTMLElement)) return;
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const nextScrollTop = Math.min(Math.max(0, preferredScrollTop), maxScrollTop);
    if (preferredScrollTop > 0 && nextScrollTop === 0 && outputItems.length === 0) return;
    container.scrollTop = nextScrollTop;
    chatEntryScrollTopRef.current = nextScrollTop;
    pendingChatScrollRestoreRef.current = null;
    lastChatEntryAlignKeyRef.current = `${String(activeThreadId || '')}:${currentPath}`;
  }, [currentPath, chatVisible, outputItems, activeThreadId]);

  useEffect(() => {
    if (currentPath !== '/chat/' || !chatVisible) return;
    if (typeof window === 'undefined') return;
    if (outputItems.length === 0) return;
    const alignKey = `${String(activeThreadId || '')}:${currentPath}`;
    if (lastChatEntryAlignKeyRef.current === alignKey) return;
    let attempts = 0;
    let rafId = 0;
    const tick = () => {
      attempts += 1;
      if (scrollLastUserMessageToTopOrKeepPosition()) {
        lastChatEntryAlignKeyRef.current = alignKey;
        return;
      }
      if (attempts >= 60) return;
      rafId = window.requestAnimationFrame(tick);
    };
    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [currentPath, chatVisible, outputItems, activeThreadId]);

  useEffect(() => {
    if (currentPath === '/chat/') return;
    lastChatEntryAlignKeyRef.current = '';
  }, [currentPath]);

  useEffect(() => {
    if (!activeThreadId) return;
    restoreOutputForThread(activeThreadId, activeRepoFullName, { resumeLive: true }).catch(() => {});
  }, [activeThreadId, activeRepoFullName]);

  useEffect(() => {
    if (activeThreadId) return;
    setPendingUserInputRequests([]);
  }, [activeThreadId]);

  useEffect(() => {
    const alive = new Set(pendingUserInputRequests.map((item) => String(item.requestId || '')));
    setPendingUserInputDrafts((prev) => {
      let changed = false;
      const next: UserInputDraftMap = {};
      for (const [key, value] of Object.entries(prev)) {
        if (alive.has(key)) next[key] = value;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [pendingUserInputRequests]);

  return {
    activeRepoRef,
    activeThreadRef,
    addImageAttachments,
    applyLatestPlanShortcut,
    awaitingFirstStreamChunk,
    canApplyLatestPlan,
    canReturnToPreviousThread,
    cancelTurn,
    compactionStatusMessage,
    compactionStatusPhase,
    ensureThread,
    goBackToRepoList,
    hasAnswerStarted,
    hasReasoningStarted,
    interruptStreamingSilently,
    liveReasoningText,
    message,
    outputItems,
    outputRef,
    pendingAttachments,
    pendingChatScrollRestoreRef,
    pendingUserInputBusy,
    pendingUserInputDrafts,
    pendingUserInputRequests,
    removePendingAttachment,
    restoreOutputForThread,
    returnToPreviousThread,
    selectUserInputOption,
    sendTurn,
    sendTurnWithOverrides,
    setMessage,
    setOutputItems,
    setPendingAttachments,
    startNewThread,
    streaming,
    streamingAssistantId
  };
}
