import {
  Fragment,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject
} from 'react';
import { marked } from 'marked';
import { App, Page, PageContent, Button, f7ready, f7 } from 'framework7-react';
import { extractDisplayReasoningText } from './reasoning';
import type {
  AppErrorState,
  AssistantOutputItem,
  CollaborationMode,
  ImageAttachmentDraft,
  ImageAttachmentMeta,
  ModelOption,
  OutputItem,
  PendingBusyMap,
  PendingThreadReturn,
  PendingUserInputRequest,
  RepoSummary,
  RequestId,
  TurnStreamEvent,
  UserInputAnswerMap,
  UserInputDraft,
  UserInputDraftMap,
  UserInputQuestion,
  UserOutputItem
} from '../../shared/types';

marked.setOptions({ gfm: true, breaks: true });

const CLONE_TIMEOUT_MS = 180000;
const LAST_THREAD_ID_KEY = 'fx:lastThreadId';
const LAST_REPO_FULLNAME_KEY = 'fx:lastRepoFullName';
const THREAD_BY_REPO_KEY = 'fx:threadByRepo';
const COLLABORATION_MODE_BY_REPO_KEY = 'fx:collaborationModeByRepo';
const MODEL_BY_REPO_KEY = 'fx:modelByRepo';
const PUSH_ENDPOINT_KEY = 'fx:pushEndpoint';
const DEFAULT_COLLABORATION_MODE = 'default';

type RepoFilter = 'all' | 'cloned' | 'not_cloned';
type ThreadByRepoMap = Record<string, string>;
type CollaborationModeByRepoMap = Record<string, CollaborationMode>;
type ModelByRepoMap = Record<string, string>;
type AssistantPatch = Partial<AssistantOutputItem> | ((item: AssistantOutputItem) => AssistantOutputItem);

interface AppContextValue {
  connected: boolean;
  error: AppErrorState | null;
  busy: boolean;
  query: string;
  setQuery: (value: string) => void;
  repos: RepoSummary[];
  repoFilter: RepoFilter;
  setRepoFilter: (value: RepoFilter) => void;
  selectedRepo: RepoSummary | null;
  setSelectedRepo: (value: RepoSummary | null) => void;
  clonedRepos: RepoSummary[];
  notClonedRepos: RepoSummary[];
  filteredRepos: RepoSummary[];
  activeRepoFullName: string | null;
  activeThreadId: string | null;
  chatVisible: boolean;
  outputItems: OutputItem[];
  outputRef: RefObject<HTMLElement | null>;
  message: string;
  setMessage: (value: string) => void;
  pendingAttachments: ImageAttachmentDraft[];
  addImageAttachments: (fileList: FileList | null) => Promise<void>;
  removePendingAttachment: (index: number) => void;
  streaming: boolean;
  streamingAssistantId: string | null;
  liveReasoningText: string;
  awaitingFirstStreamChunk: boolean;
  hasReasoningStarted: boolean;
  hasAnswerStarted: boolean;
  navigate: (path: string, replace?: boolean) => void;
  bootstrapConnection: () => Promise<void>;
  fetchRepos: (nextQuery?: string) => Promise<void>;
  startWithRepo: (repo: RepoSummary) => Promise<boolean>;
  sendTurn: () => Promise<void>;
  cancelTurn: () => Promise<void>;
  startNewThread: () => Promise<void>;
  canReturnToPreviousThread: boolean;
  returnToPreviousThread: () => void;
  canApplyLatestPlan: boolean;
  applyLatestPlanShortcut: () => Promise<void>;
  chatSettingsOpen: boolean;
  openChatSettings: () => void;
  closeChatSettings: () => void;
  availableModels: ModelOption[];
  modelsLoading: boolean;
  modelsError: string;
  loadAvailableModels: (force?: boolean) => Promise<void>;
  activeRepoModel: string;
  setActiveRepoModel: (modelId: string) => void;
  activeCollaborationMode: CollaborationMode;
  setActiveCollaborationMode: (mode: CollaborationMode) => void;
  pendingUserInputRequests: PendingUserInputRequest[];
  selectUserInputOption: (
    request: PendingUserInputRequest,
    questionIndex: number,
    questionId: string,
    optionLabel: string
  ) => Promise<void>;
  pendingUserInputBusy: PendingBusyMap;
  pendingUserInputDrafts: UserInputDraftMap;
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

interface JsonErrorResponse {
  error?: string;
  hint?: string;
  [key: string]: unknown;
}

const AppCtx = createContext<AppContextValue | null>(null);

function useAppCtx(): AppContextValue {
  const ctx = useContext(AppCtx);
  if (!ctx) throw new Error('app_context_missing');
  return ctx;
}

function getClientErrorMessage(error: unknown, fallback = 'unknown_error'): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return fallback;
}

function isAssistantItem(item: OutputItem): item is AssistantOutputItem {
  return item.role === 'assistant';
}

function isUserItem(item: OutputItem): item is UserOutputItem {
  return item.role === 'user';
}

function parseTurnStreamEvent(rawLine: string): TurnStreamEvent | null {
  try {
    const parsed = JSON.parse(rawLine) as { type?: string } | null;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') return null;
    return parsed as TurnStreamEvent;
  } catch {
    return null;
  }
}

function createEmptyAssistantItem(id: string): AssistantOutputItem {
  return {
    id,
    role: 'assistant',
    type: 'markdown',
    text: '',
    status: '',
    answer: '',
    plan: ''
  };
}

function formatFileSize(size: number | string | null | undefined): string {
  const bytes = Number(size || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('file_read_failed'));
    reader.readAsDataURL(file);
  });
}

function decodeBase64UrlToUint8Array(base64Url: string): Uint8Array {
  const normalized = String(base64Url || '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const pad = '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
  const base64 = normalized + pad;
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function normalizePath(rawPath: string): string {
  if (rawPath === '/chat' || rawPath === '/chat/') return '/chat/';
  return '/repos/';
}

function getCurrentPath() {
  if (typeof window === 'undefined') return '/repos/';
  const hash = window.location.hash || '';
  if (hash.startsWith('#!/')) return normalizePath(hash.slice(2));
  return normalizePath(window.location.pathname || '/');
}

function pushPath(path: string, replace = false): string {
  const target = normalizePath(path);
  if (typeof window === 'undefined') return target;
  if (replace) window.history.replaceState({}, '', target);
  else window.history.pushState({}, '', target);
  return target;
}

function threadMessagesKey(threadId: string): string {
  return `fx:threadMessages:${threadId}`;
}

function loadJsonFromStorage<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function loadThreadMessages(threadId: string | null): OutputItem[] {
  if (!threadId || typeof window === 'undefined') return [];
  const items = loadJsonFromStorage(threadMessagesKey(threadId), []);
  return Array.isArray(items) ? items : [];
}

function normalizeModelOptions(models: unknown): ModelOption[] {
  const src = Array.isArray(models) ? models : [];
  const out: ModelOption[] = [];
  const seen = new Set();
  for (const item of src) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: String(item.name || id),
      description: String(item.description || '')
    });
  }
  return out;
}

function ReposPage() {
  const {
    connected,
    error,
    busy,
    query,
    setQuery,
    repos,
    repoFilter,
    setRepoFilter,
    selectedRepo,
    setSelectedRepo,
    clonedRepos,
    notClonedRepos,
    filteredRepos,
    activeRepoFullName,
    activeThreadId,
    chatVisible,
    navigate,
    bootstrapConnection,
    fetchRepos,
    startWithRepo
  } = useAppCtx();

  return (
    <Page noNavbar>
      <PageContent className="fx-page fx-page-repos">
        {!connected && error ? (
          <section className="fx-error-panel">
            <h2>GitHub接続エラー</h2>
            <p>{error.title}</p>
            <pre className="fx-code">{error.cause}</pre>
            <div className="fx-actions">
              <Button fill onClick={bootstrapConnection}>再試行</Button>
              <Button tonal onClick={() => f7.dialog.alert('gh auth login', 'ログイン手順')}>ログイン手順</Button>
            </div>
          </section>
        ) : null}

        {connected ? (
          <section className="fx-repos-shell">
            <div className="fx-repos-toolbar">
              <input
                value={query}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setQuery(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    fetchRepos(e.currentTarget.value).catch((err: unknown) => {
                      f7.toast.create({ text: `読み込み失敗: ${getClientErrorMessage(err)}`, closeTimeout: 1400, position: 'center' }).open();
                    });
                  }
                }}
                placeholder="リポジトリ名で検索"
              />
              <div className="fx-filter">
                <Button small fill={repoFilter === 'all'} tonal={repoFilter !== 'all'} onClick={() => setRepoFilter('all')}>
                  すべて {repos.length}
                </Button>
                <Button small fill={repoFilter === 'cloned'} tonal={repoFilter !== 'cloned'} onClick={() => setRepoFilter('cloned')}>
                  クローン済み {clonedRepos.length}
                </Button>
                <Button small fill={repoFilter === 'not_cloned'} tonal={repoFilter !== 'not_cloned'} onClick={() => setRepoFilter('not_cloned')}>
                  未クローン {notClonedRepos.length}
                </Button>
              </div>
            </div>

            <div className="fx-repo-scroll">
              {filteredRepos.map((repo) => {
                const isSelected = selectedRepo?.id === repo.id;
                const cloned = repo.cloneState?.status === 'cloned';
                const [owner = '', repoName = repo.fullName] = String(repo.fullName || '').split('/');
                return (
                  <button
                    key={repo.id}
                    className={`fx-repo-tile${isSelected ? ' is-selected' : ''}`}
                    type="button"
                    onClick={async () => {
                      if (busy) return;
                      setSelectedRepo(repo);
                      if (chatVisible && activeRepoFullName === repo.fullName && activeThreadId) {
                        navigate('/chat/');
                        return;
                      }
                      const ok = await startWithRepo(repo);
                      if (ok) navigate('/chat/');
                    }}
                  >
                    <div className="fx-repo-line">
                      <div className="fx-repo-text">
                        <div className="fx-repo-name">{repoName}</div>
                        <div className="fx-repo-owner">{owner}</div>
                      </div>
                      <span className={`fx-chip${cloned ? ' is-ok' : ''}`}>{cloned ? 'クローン済み' : '未クローン'}</span>
                    </div>
                    <div className="fx-mini">最終更新: {repo.updatedAt ? new Date(repo.updatedAt).toLocaleDateString('ja-JP') : '不明'}</div>
                  </button>
                );
              })}
              {filteredRepos.length === 0 ? <p className="fx-mini">一致するリポジトリはありません</p> : null}
            </div>
          </section>
        ) : null}
      </PageContent>
    </Page>
  );
}

function renderAssistant(item: AssistantOutputItem, pending = false) {
  const answer = typeof item.answer === 'string' ? item.answer : String(item.text || '');
  const statusText = !answer ? String(item.status || item.text || '').trim() : '';

  if (item.type === 'diff') {
    return <pre className="fx-diff">{answer}</pre>;
  }
  if (pending && !answer && !statusText) return null;
  if (statusText === '・・・') return null;
  if (!answer && statusText) return <div className="fx-stream-status">{statusText}</div>;
  if (pending && answer) {
    return <pre className="fx-stream-live">{answer}</pre>;
  }
  return <div dangerouslySetInnerHTML={{ __html: String(marked.parse(answer)) }} />;
}

function expandAssistantItems(items: OutputItem[]): OutputItem[] {
  const src = Array.isArray(items) ? items : [];
  const out: OutputItem[] = [];
  for (const item of src) {
    if (isAssistantItem(item)) {
      const answer =
        typeof item.answer === 'string' && item.answer.length > 0
          ? item.answer
          : String(item.text || '');
      out.push({
        ...item,
        answer,
        text: answer,
        reasoning: ''
      });
      continue;
    }
    out.push(item);
  }
  return out;
}

function ChatPage() {
  const {
    connected,
    busy,
    chatVisible,
    navigate,
    activeRepoFullName,
    message,
    setMessage,
    pendingAttachments,
    addImageAttachments,
    removePendingAttachment,
    outputItems,
    outputRef,
    streaming,
    streamingAssistantId,
    liveReasoningText,
    awaitingFirstStreamChunk,
    hasReasoningStarted,
    hasAnswerStarted,
    sendTurn,
    cancelTurn,
    startNewThread,
    canReturnToPreviousThread,
    returnToPreviousThread,
    canApplyLatestPlan,
    applyLatestPlanShortcut,
    chatSettingsOpen,
    openChatSettings,
    closeChatSettings,
    availableModels,
    modelsLoading,
    modelsError,
    loadAvailableModels,
    activeRepoModel,
    setActiveRepoModel,
    activeCollaborationMode,
    setActiveCollaborationMode,
    pendingUserInputRequests,
    selectUserInputOption,
    pendingUserInputBusy,
    pendingUserInputDrafts
  } = useAppCtx();
  const hasComposerInput = message.trim().length > 0 || pendingAttachments.length > 0;
  const canSend = hasComposerInput;
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const userInputCardRef = useRef<HTMLDivElement | null>(null);
  const swipeStartXRef = useRef<number | null>(null);
  const swipeStartYRef = useRef<number | null>(null);
  const displayItems = outputItems;
  const latestPlanItemId = useMemo(() => {
    for (let idx = displayItems.length - 1; idx >= 0; idx -= 1) {
      const item = displayItems[idx];
      if (!item || (item.role !== 'assistant' && item.role !== 'user')) continue;
      if (item.role !== 'assistant') return '';
      const planText = typeof item.plan === 'string' ? item.plan.trim() : '';
      return planText ? String(item.id || '') : '';
    }
    return '';
  }, [displayItems]);
  const thinkingText = typeof liveReasoningText === 'string' ? liveReasoningText : '';
  const activeUserInputRequest = pendingUserInputRequests.length > 0 ? pendingUserInputRequests[0] : null;
  const activeUserInputDraftState: UserInputDraft = activeUserInputRequest
    ? pendingUserInputDrafts[String(activeUserInputRequest.requestId)] || { index: 0, answers: {} }
    : { index: 0, answers: {} };
  const activeUserInputIndex = Number(activeUserInputDraftState.index || 0);
  const activeUserInputQuestion = activeUserInputRequest
    ? (activeUserInputRequest.questions || [])[activeUserInputIndex] || null
    : null;
  const answeredUserInputCount = activeUserInputRequest ? Math.min(activeUserInputIndex, (activeUserInputRequest.questions || []).length) : 0;
  const hideThinkingWhileUserInput = Boolean(activeUserInputRequest && activeUserInputQuestion);
  const showInitialLoading = streaming && awaitingFirstStreamChunk && !hideThinkingWhileUserInput;
  const showThinkingWorking = streaming && hasReasoningStarted && !hideThinkingWhileUserInput;
  const previewAttachment =
    previewIndex !== null && previewIndex >= 0 && previewIndex < pendingAttachments.length
      ? pendingAttachments[previewIndex]
      : null;
  const canGoPrev = previewIndex !== null && previewIndex > 0;
  const canGoNext = previewIndex !== null && previewIndex < pendingAttachments.length - 1;
  const activeModelLabel = useMemo(() => {
    if (!activeRepoModel) return '未設定';
    const hit = availableModels.find((item) => item.id === activeRepoModel);
    return hit?.name || activeRepoModel;
  }, [availableModels, activeRepoModel]);
  const keepComposerFocus = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.closest('.fx-attachments-bar')) return;
    if (target.closest('textarea,button,input,select,a,[role="button"]')) return;
    event.preventDefault();
    composerInputRef.current?.focus();
  };
  const handleComposerInputBlur = (event: FocusEvent<HTMLTextAreaElement>) => {
    const next = event.relatedTarget;
    if (next instanceof HTMLElement && next.closest('.fx-mode-toggle')) return;
    setIsInputFocused(false);
  };
  const closePreview = () => setPreviewIndex(null);
  const openPreviewAt = (idx: number) => {
    if (idx < 0 || idx >= pendingAttachments.length) return;
    setPreviewIndex(idx);
  };
  const showPrevPreview = () => {
    setPreviewIndex((prev) => {
      if (prev === null || prev <= 0) return prev;
      return prev - 1;
    });
  };
  const showNextPreview = () => {
    setPreviewIndex((prev) => {
      if (prev === null || prev >= pendingAttachments.length - 1) return prev;
      return prev + 1;
    });
  };
  const onPreviewPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    swipeStartXRef.current = event.clientX;
    swipeStartYRef.current = event.clientY;
  };
  const onPreviewPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (swipeStartXRef.current === null || swipeStartYRef.current === null) return;
    const dx = event.clientX - swipeStartXRef.current;
    const dy = event.clientY - swipeStartYRef.current;
    swipeStartXRef.current = null;
    swipeStartYRef.current = null;
    if (Math.abs(dx) < 40 || Math.abs(dx) <= Math.abs(dy)) return;
    if (dx < 0) showNextPreview();
    else showPrevPreview();
  };
  const onPreviewPointerCancel = () => {
    swipeStartXRef.current = null;
    swipeStartYRef.current = null;
  };

  useEffect(() => {
    if (connected && !chatVisible) navigate('/repos/', true);
  }, [connected, chatVisible, navigate]);

  useEffect(() => {
    if (previewIndex === null) return;
    if (pendingAttachments.length === 0) {
      setPreviewIndex(null);
      return;
    }
    if (previewIndex > pendingAttachments.length - 1) {
      setPreviewIndex(pendingAttachments.length - 1);
    }
  }, [previewIndex, pendingAttachments.length]);

  useEffect(() => {
    if (previewIndex === null) return undefined;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        closePreview();
        return;
      }
      if (event.key === 'ArrowLeft') {
        showPrevPreview();
        return;
      }
      if (event.key === 'ArrowRight') {
        showNextPreview();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [previewIndex, pendingAttachments.length]);

  useEffect(() => {
    if (!activeUserInputRequest || !activeUserInputQuestion) return;
    const node = userInputCardRef.current;
    if (!(node instanceof HTMLElement)) return;
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [activeUserInputRequest?.requestId, activeUserInputQuestion?.id]);

  if (!chatVisible) {
    return (
      <Page noNavbar>
        <PageContent className="fx-page">
          <p className="fx-mini">接続を準備しています...</p>
        </PageContent>
      </Page>
    );
  }

  return (
    <Page noNavbar>
      <PageContent className="fx-page fx-page-chat">
        <div className="fx-chat-head">
          <button
            className="fx-back-icon"
            type="button"
            onClick={() => navigate('/repos/')}
            data-testid="back-button"
          >
            ←
          </button>
          <button
            className="fx-repo-pill fx-repo-pill-btn"
            type="button"
            onClick={openChatSettings}
            data-testid="chat-settings-trigger"
            aria-label="チャット設定を開く"
            title="チャット設定"
          >
            <span className="fx-repo-pill-text">{activeRepoFullName}</span>
            <span className="fx-repo-pill-gear" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path stroke="none" d="M0 0h24v24H0z" fill="none" />
                <path
                  d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37c.996 -1.636 .04 -2.433 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1.636 .996 2.433 .04 2.572 -1.065z"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0" stroke="currentColor" strokeWidth="1.7" />
              </svg>
            </span>
          </button>
          {canReturnToPreviousThread ? (
            <button
              className="fx-new-thread-icon"
              type="button"
              onClick={returnToPreviousThread}
              disabled={busy || streaming}
              aria-label="前のスレッドに戻る"
              title="前のスレッドに戻る"
              data-testid="return-thread-button"
            >
              <svg
                className="fx-new-thread-icon-svg"
                viewBox="0 0 24 24"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
              >
                <path
                  d="M9 14L4 9L9 4"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M4 9H15C17.2091 9 19 10.7909 19 13V13C19 15.2091 17.2091 17 15 17H14"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          ) : (
            <button
              className="fx-new-thread-icon"
              type="button"
              onClick={startNewThread}
              disabled={busy || streaming}
              aria-label="新規スレッド"
              title="新規スレッド"
              data-testid="new-thread-button"
            >
              <svg
                className="fx-new-thread-icon-svg"
                viewBox="0 0 24 24"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
              >
                <path
                  d="M16.8617 4.48667L18.5492 2.79917C19.2814 2.06694 20.4686 2.06694 21.2008 2.79917C21.9331 3.53141 21.9331 4.71859 21.2008 5.45083L10.5822 16.0695C10.0535 16.5981 9.40144 16.9868 8.68489 17.2002L6 18L6.79978 15.3151C7.01323 14.5986 7.40185 13.9465 7.93052 13.4178L16.8617 4.48667ZM16.8617 4.48667L19.5 7.12499M18 14V18.75C18 19.9926 16.9926 21 15.75 21H5.25C4.00736 21 3 19.9926 3 18.75V8.24999C3 7.00735 4.00736 5.99999 5.25 5.99999H10"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
        </div>

        <article className="fx-chat-scroll" ref={outputRef}>
          {displayItems.map((item) => {
            if (item.role !== 'assistant' && item.role !== 'user') {
              return (
                <div key={item.id} className="fx-msg fx-msg-system">
                  <div className="fx-msg-bubble">
                    <pre className="fx-system-line">{String(item.text || '')}</pre>
                  </div>
                </div>
              );
            }
            if (item.role === 'assistant' && streaming && item.id === streamingAssistantId) {
              const currentAnswer = typeof item.answer === 'string' ? item.answer : String(item.text || '');
              const currentPlan = typeof item.plan === 'string' ? item.plan.trim() : '';
              const currentStatus = !currentAnswer ? String(item.status || item.text || '').trim() : '';
              if (!currentAnswer.trim() && !currentStatus.trim() && !currentPlan) return null;
            }
            if (item.role === 'assistant') {
              const planText = typeof item.plan === 'string' ? item.plan.trim() : '';
              const assistantMain = renderAssistant(item, streaming && item.id === streamingAssistantId);
              return (
                <Fragment key={item.id}>
                  {assistantMain ? (
                    <div className="fx-msg fx-msg-assistant">
                      <div className="fx-msg-bubble">{assistantMain}</div>
                    </div>
                  ) : null}
                  {planText ? (
                    <div className="fx-msg fx-msg-assistant fx-msg-plan">
                      <div className="fx-msg-bubble">
                        <div className="fx-plan-bubble-title">プラン</div>
                        <pre className="fx-plan-bubble-content">{planText}</pre>
                      </div>
                    </div>
                  ) : null}
                  {planText && canApplyLatestPlan && String(item.id || '') === latestPlanItemId ? (
                    <>
                      <div className="fx-plan-apply-row">
                        <button
                          className="fx-plan-apply-inline-btn"
                          type="button"
                          onClick={applyLatestPlanShortcut}
                          disabled={busy || streaming}
                          data-testid="plan-apply-button"
                          aria-label="プランを実現"
                          title="プランを実現"
                        >
                          プランを実現
                        </button>
                      </div>
                      <div className="fx-plan-apply-help-note" data-testid="plan-edit-help">
                        ※ プランを修正する場合は、下の入力欄に修正内容や質問を入力して送信してください。
                      </div>
                    </>
                  ) : null}
                </Fragment>
              );
            }
            return (
              <div
                key={item.id}
                className={`fx-msg fx-msg-${item.role}`}
                data-msg-id={String(item.id || '')}
                data-msg-role={item.role}
              >
                <div className="fx-msg-bubble">
                  {item.text ? <p className="fx-user-line">{item.text}</p> : null}
                  {Array.isArray(item.attachments) && item.attachments.length > 0 ? (
                    <div className="fx-user-attachments">
                      {item.attachments.map((att, idx) => (
                        <span key={`${item.id}:att:${idx}`} className="fx-user-attachment-chip">
                          画像: {String(att?.name || 'image')} ({formatFileSize(att?.size)})
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
          {showInitialLoading ? (
            <div className="fx-thinking-live-panel fx-working-panel" data-testid="stream-loading-indicator" aria-live="polite">
              <div className="fx-working-dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
            </div>
          ) : null}
          {showThinkingWorking ? (
            <div className="fx-thinking-live-panel fx-working-panel" data-testid="thinking-working-indicator" aria-live="polite">
              <div className="fx-working-dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
              {thinkingText ? <pre className="fx-thinking-live-text" data-testid="thinking-live-content">{thinkingText}</pre> : null}
            </div>
          ) : null}
          {activeUserInputRequest && activeUserInputQuestion ? (
            <div className="fx-user-input-requests fx-user-input-requests-inline" data-testid="user-input-requests">
              <div
                key={`uir:${activeUserInputRequest.requestId}`}
                className="fx-user-input-card"
                ref={userInputCardRef}
              >
                <div className="fx-user-input-progress">
                  {answeredUserInputCount + 1}/{(activeUserInputRequest.questions || []).length}
                </div>
                <div key={`q:${activeUserInputRequest.requestId}:${activeUserInputQuestion.id}`} className="fx-user-input-question">
                  {activeUserInputQuestion.header ? <div className="fx-user-input-header">{activeUserInputQuestion.header}</div> : null}
                  <div className="fx-user-input-text">{activeUserInputQuestion.question}</div>
                  <div className="fx-user-input-options">
                    {(activeUserInputQuestion.options || []).map((opt) => (
                      <button
                        key={`opt:${activeUserInputRequest.requestId}:${activeUserInputQuestion.id}:${opt.label}`}
                        type="button"
                        className="fx-user-input-option-btn"
                        onClick={() => selectUserInputOption(activeUserInputRequest, activeUserInputIndex, activeUserInputQuestion.id, opt.label)}
                        disabled={Boolean(pendingUserInputBusy[String(activeUserInputRequest.requestId)])}
                        data-testid={`user-input-option-${activeUserInputQuestion.id}`}
                      >
                        <span className="fx-user-input-option-label">{opt.label}</span>
                        {opt.description ? <span className="fx-user-input-option-desc">{opt.description}</span> : null}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </article>

        {chatSettingsOpen ? (
          <div className="fx-chat-settings-overlay" onClick={closeChatSettings} data-testid="chat-settings-modal">
            <section
              className="fx-chat-settings-panel"
              role="dialog"
              aria-modal="true"
              aria-label="チャット設定"
              onClick={(e) => e.stopPropagation()}
            >
              <header className="fx-chat-settings-head">
                <h3>チャット設定</h3>
                <button
                  type="button"
                  className="fx-chat-settings-close"
                  onClick={closeChatSettings}
                  data-testid="chat-settings-close"
                  aria-label="設定を閉じる"
                >
                  ×
                </button>
              </header>
              <div className="fx-chat-settings-section">
                <div className="fx-chat-settings-label">モデル</div>
                <div className="fx-chat-settings-current">現在: {activeModelLabel}</div>
                {modelsLoading ? <p className="fx-mini">モデル一覧を読み込み中...</p> : null}
                {modelsError ? (
                  <div className="fx-chat-settings-error">
                    <p className="fx-mini">読み込みに失敗しました</p>
                    <Button small tonal onClick={() => loadAvailableModels(true)} data-testid="model-reload-button">
                      再読み込み
                    </Button>
                  </div>
                ) : null}
                {!modelsLoading && availableModels.length > 0 ? (
                  <div className="fx-model-list" data-testid="model-list">
                    {availableModels.map((model) => {
                      const testIdModel = model.id.replace(/[^a-zA-Z0-9_-]/g, '_');
                      const selected = model.id === activeRepoModel;
                      return (
                        <button
                          key={model.id}
                          type="button"
                          className={`fx-model-option${selected ? ' is-selected' : ''}`}
                          onClick={() => setActiveRepoModel(model.id)}
                          disabled={streaming}
                          data-testid={`model-option-${testIdModel}`}
                        >
                          <div className="fx-model-option-title">{model.name}</div>
                          <div className="fx-model-option-id">{model.id}</div>
                          {model.description ? <div className="fx-model-option-desc">{model.description}</div> : null}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
                {!modelsLoading && !modelsError && availableModels.length === 0 ? (
                  <p className="fx-mini">利用可能なモデルが見つかりませんでした。</p>
                ) : null}
              </div>
            </section>
          </div>
        ) : null}

        <div className="fx-composer" onPointerDownCapture={keepComposerFocus} data-testid="composer">
          {isInputFocused ? (
            <div className="fx-mode-toggle" data-testid="mode-toggle">
              <button
                type="button"
                className={`fx-mode-btn is-default${activeCollaborationMode === 'default' ? ' is-active' : ''}`}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => setActiveCollaborationMode('default')}
                disabled={streaming}
                data-testid="mode-default-button"
              >
                通常
              </button>
              <button
                type="button"
                className={`fx-mode-btn is-plan${activeCollaborationMode === 'plan' ? ' is-active' : ''}`}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => setActiveCollaborationMode('plan')}
                disabled={streaming}
                data-testid="mode-plan-button"
              >
                プラン
              </button>
            </div>
          ) : null}
          {pendingAttachments.length > 0 ? (
            <div className="fx-attachments-bar" data-testid="attachments-bar">
              <div className="fx-attachments-list" data-testid="attachments-list">
                {pendingAttachments.map((att, idx) => (
                  <div
                    key={`${att.name}:${att.size}:${idx}`}
                    className="fx-attachment-item"
                    role="button"
                    tabIndex={0}
                    onClick={() => openPreviewAt(idx)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        openPreviewAt(idx);
                      }
                    }}
                    aria-label={`プレビュー: ${att.name}`}
                    title="プレビュー"
                    data-testid={`attachment-item-${idx}`}
                  >
                    <img
                      src={att.dataUrl}
                      alt={att.name}
                      className="fx-attachment-thumb"
                      data-testid={`attachment-thumb-${idx}`}
                    />
                    <div className="fx-attachment-meta">
                      <span className="fx-attachment-name">{att.name}</span>
                      <span className="fx-attachment-size">{formatFileSize(att.size)}</span>
                    </div>
                    <button
                      type="button"
                      className="fx-attachment-remove"
                      onClick={(e) => {
                        e.stopPropagation();
                        removePendingAttachment(idx);
                      }}
                      aria-label={`添付解除: ${att.name}`}
                      title="添付解除"
                      data-testid={`attachment-remove-${idx}`}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          <div className="fx-composer-inner">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="fx-file-input"
              data-testid="attachment-input"
              onChange={async (e) => {
                await addImageAttachments(e.target.files);
                e.target.value = '';
                composerInputRef.current?.focus();
              }}
            />
            <Button
              tonal
              className="fx-icon-btn fx-attach-btn"
              onClick={() => fileInputRef.current?.click()}
              aria-label="画像を添付"
              data-testid="attachment-add-button"
            >
              ＋
            </Button>
            <textarea
              ref={composerInputRef}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={1}
              placeholder="指示を入力"
              onFocus={() => setIsInputFocused(true)}
              onBlur={handleComposerInputBlur}
              data-testid="composer-textarea"
            />
            <div
              className={`fx-composer-actions${
                !isInputFocused && !streaming && message.trim().length === 0 && pendingAttachments.length === 0
                  ? ' is-hidden'
                  : ''
              }`}
            >
              {streaming ? (
                hasComposerInput ? (
                  <Button
                    tonal
                    className="fx-icon-btn fx-followup-btn"
                    onClick={sendTurn}
                    disabled={!canSend}
                    aria-label="追加指示"
                    data-testid="followup-button"
                  >
                  <svg
                    className="fx-followup-icon-svg"
                    viewBox="0 0 24 24"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                    aria-hidden="true"
                  >
                      <path d="M10 14l11 -11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      <path
                        d="M21 3l-6.5 18a.55 .55 0 0 1 -1 0l-3.5 -7l-7 -3.5a.55 .55 0 0 1 0 -1l18 -6.5"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                  </svg>
                </Button>
                ) : (
                  <Button
                    tonal
                    className="fx-icon-btn fx-stop-btn"
                    onClick={cancelTurn}
                    aria-label="停止"
                    data-testid="stop-button"
                  >
                    ■
                  </Button>
                )
              ) : (
                <Button
                  fill
                  className="fx-icon-btn"
                  onClick={sendTurn}
                  disabled={!canSend}
                  aria-label="送信"
                  data-testid="send-button"
                >
                <svg
                  className="fx-send-icon-svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                  aria-hidden="true"
                >
                  <path
                    d="M4.698 4.034l16.302 7.966l-16.302 7.966a.503 .503 0 0 1 -.546 -.124a.555 .555 0 0 1 -.12 -.568l2.468 -7.274l-2.468 -7.274a.555 .555 0 0 1 .12 -.568a.503 .503 0 0 1 .546 -.124"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M6.5 12h14.5"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </Button>
              )}
            </div>
          </div>
        </div>
        {previewAttachment ? (
          <div
            className="fx-image-preview-overlay"
            role="dialog"
            aria-modal="true"
            onClick={closePreview}
            data-testid="image-preview-overlay"
          >
            <div
              className="fx-image-preview-panel"
              onClick={(e) => e.stopPropagation()}
              onPointerDown={onPreviewPointerDown}
              onPointerUp={onPreviewPointerUp}
              onPointerCancel={onPreviewPointerCancel}
              data-testid="image-preview-panel"
            >
              <button
                type="button"
                className="fx-image-preview-close"
                onClick={closePreview}
                aria-label="プレビューを閉じる"
                title="閉じる"
                data-testid="image-preview-close"
              >
                ×
              </button>
              <button
                type="button"
                className="fx-image-preview-nav is-left"
                onClick={showPrevPreview}
                disabled={!canGoPrev}
                aria-label="前の画像"
                title="前の画像"
                data-testid="image-preview-prev"
              >
                ‹
              </button>
              <img
                src={previewAttachment.dataUrl}
                alt={previewAttachment.name}
                className="fx-image-preview-img"
                data-testid="image-preview-img"
              />
              <button
                type="button"
                className="fx-image-preview-nav is-right"
                onClick={showNextPreview}
                disabled={!canGoNext}
                aria-label="次の画像"
                title="次の画像"
                data-testid="image-preview-next"
              >
                ›
              </button>
              <div className="fx-image-preview-caption" data-testid="image-preview-caption">
                <span className="fx-image-preview-name">{previewAttachment.name}</span>
                <span className="fx-image-preview-index">
                  {(previewIndex ?? 0) + 1} / {pendingAttachments.length}
                </span>
              </div>
            </div>
          </div>
        ) : null}
      </PageContent>
    </Page>
  );
}

export default function AppRoot() {
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<AppErrorState | null>(null);
  const [busy, setBusy] = useState(false);

  const [query, setQuery] = useState('');
  const [repos, setRepos] = useState<RepoSummary[]>([]);
  const [repoFilter, setRepoFilter] = useState<RepoFilter>('all');
  const [selectedRepo, setSelectedRepo] = useState<RepoSummary | null>(null);

  const initialThreadId = typeof window !== 'undefined' ? window.localStorage.getItem(LAST_THREAD_ID_KEY) : null;
  const initialRepoFullName = typeof window !== 'undefined' ? window.localStorage.getItem(LAST_REPO_FULLNAME_KEY) : null;
  const [activeThreadId, setActiveThreadId] = useState<string | null>(initialThreadId);
  const [activeRepoFullName, setActiveRepoFullName] = useState<string | null>(initialRepoFullName);
  const [chatVisible, setChatVisible] = useState(Boolean(initialThreadId && initialRepoFullName));

  const [message, setMessage] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState<ImageAttachmentDraft[]>([]);
  const [outputItems, setOutputItems] = useState<OutputItem[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamingAssistantId, setStreamingAssistantId] = useState<string | null>(null);
  const [, setActiveTurnId] = useState('');
  const [liveReasoningText, setLiveReasoningText] = useState('');
  const [awaitingFirstStreamChunk, setAwaitingFirstStreamChunk] = useState(false);
  const [hasReasoningStarted, setHasReasoningStarted] = useState(false);
  const [hasAnswerStarted, setHasAnswerStarted] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [currentPath, setCurrentPath] = useState(getCurrentPath());
  const [threadByRepo, setThreadByRepo] = useState<ThreadByRepoMap>(() => {
    if (typeof window === 'undefined') return {};
    const map = loadJsonFromStorage<ThreadByRepoMap>(THREAD_BY_REPO_KEY, {});
    if (initialRepoFullName && initialThreadId && !map[initialRepoFullName]) {
      map[initialRepoFullName] = initialThreadId;
    }
    return map;
  });
  const [collaborationModeByRepo, setCollaborationModeByRepo] = useState<CollaborationModeByRepoMap>(() => {
    if (typeof window === 'undefined') return {};
    const map = loadJsonFromStorage<CollaborationModeByRepoMap>(COLLABORATION_MODE_BY_REPO_KEY, {});
    return map && typeof map === 'object' ? map : {};
  });
  const [modelByRepo, setModelByRepo] = useState<ModelByRepoMap>(() => {
    if (typeof window === 'undefined') return {};
    const map = loadJsonFromStorage<ModelByRepoMap>(MODEL_BY_REPO_KEY, {});
    return map && typeof map === 'object' ? map : {};
  });
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState('');
  const [chatSettingsOpen, setChatSettingsOpen] = useState(false);
  const [pendingUserInputRequests, setPendingUserInputRequests] = useState<PendingUserInputRequest[]>([]);
  const [pendingUserInputDrafts, setPendingUserInputDrafts] = useState<UserInputDraftMap>({});
  const [pendingUserInputBusy, setPendingUserInputBusy] = useState<PendingBusyMap>({});
  const [pendingThreadReturn, setPendingThreadReturn] = useState<PendingThreadReturn | null>(null);

  const outputRef = useRef<HTMLElement | null>(null);
  const autoScrollRef = useRef(true);
  const streamAbortRef = useRef<AbortController | null>(null);
  const resumeStreamAbortRef = useRef<AbortController | null>(null);
  const resumeStreamingThreadIdRef = useRef('');
  const resumeStreamingTurnIdRef = useRef('');
  const didBootstrapRef = useRef(false);
  const lastPathRef = useRef(getCurrentPath());
  const chatEntryPathRef = useRef(getCurrentPath());
  const lastChatEntryAlignKeyRef = useRef('');
  const chatEntryScrollTopRef = useRef(0);
  const activeThreadRef = useRef<string | null>(activeThreadId);
  const activeTurnIdRef = useRef('');
  const activeRepoRef = useRef<string | null>(activeRepoFullName);
  const streamingAssistantIdRef = useRef<string | null>(null);
  const streamingAssistantMessageItemIdRef = useRef('');
  const streamingAnswerBufferRef = useRef('');
  const streamingPlanBufferRef = useRef('');
  const pendingFollowupSplitRef = useRef(false);
  const awaitingPostUserInputAssistantRef = useRef(false);
  const backgroundInterruptedTurnRef = useRef(false);
  const shouldResumeOnVisibleRef = useRef(false);
  const pushEndpointRef = useRef(
    typeof window !== 'undefined' ? window.localStorage.getItem(PUSH_ENDPOINT_KEY) || '' : ''
  );
  const pushPublicKeyRef = useRef('');
  const serviceWorkerRegRef = useRef<ServiceWorkerRegistration | null>(null);

  function toast(text: string): void {
    f7?.toast?.create({ text, closeTimeout: 1400, position: 'center' }).open();
  }

  function setStreamingAssistantTarget(id: string | null): void {
    streamingAssistantIdRef.current = id;
    setStreamingAssistantId(id);
  }

  function appendStreamingAssistantCard(): string {
    const assistantId = `a-${Date.now() + 1}`;
    setStreamingAssistantTarget(assistantId);
    setOutputItems((prev) => [...prev, createEmptyAssistantItem(assistantId)]);
    return assistantId;
  }

  function finalizeStreamingAssistantCard(id: string, answer: string, plan: string): void {
    if (!id) return;
    const finalAnswer = answer.trim() ? answer : '(応答なし)';
    const finalType: AssistantOutputItem['type'] = looksLikeDiff(finalAnswer) ? 'diff' : 'markdown';
    setOutputItems((prev): OutputItem[] =>
      prev.map((item) =>
        item.id === id && isAssistantItem(item)
          ? { ...item, type: finalType, status: '', answer: finalAnswer, text: finalAnswer, plan }
          : item
      )
    );
  }

  function discardStreamingAssistantCard(id: string): void {
    if (!id) return;
    setOutputItems((prev) => prev.filter((item) => item.id !== id));
  }

  function splitStreamingAssistantCard(): void {
    const currentAssistantId = String(streamingAssistantIdRef.current || '');
    finalizeStreamingAssistantCard(currentAssistantId, streamingAnswerBufferRef.current, streamingPlanBufferRef.current);
    streamingAnswerBufferRef.current = '';
    streamingPlanBufferRef.current = '';
    streamingAssistantMessageItemIdRef.current = '';
    appendStreamingAssistantCard();
  }

  function ensureStreamingAssistantCardForItem(itemId: string): void {
    const nextItemId = String(itemId || '').trim();
    if (!nextItemId) return;
    const currentItemId = String(streamingAssistantMessageItemIdRef.current || '');
    if (!currentItemId) {
      streamingAssistantMessageItemIdRef.current = nextItemId;
      return;
    }
    if (currentItemId === nextItemId) return;
    if (pendingFollowupSplitRef.current) {
      splitStreamingAssistantCard();
      pendingFollowupSplitRef.current = false;
    }
    streamingAssistantMessageItemIdRef.current = nextItemId;
  }

  function getRepoModel(repoFullName: string | null = activeRepoRef.current): string {
    if (!repoFullName) return '';
    return String(modelByRepo[repoFullName] || '').trim();
  }

  function setRepoModel(repoFullName: string | null, modelId: string): void {
    if (!repoFullName) return;
    const normalized = String(modelId || '').trim();
    setModelByRepo((prev) => {
      const current = String(prev[repoFullName] || '').trim();
      if (current === normalized) return prev;
      if (!normalized) {
        const next = { ...prev };
        delete next[repoFullName];
        return next;
      }
      return { ...prev, [repoFullName]: normalized };
    });
  }

  function setActiveRepoModel(modelId: string): void {
    setRepoModel(activeRepoRef.current, modelId);
  }

  async function loadAvailableModels(force = false): Promise<void> {
    if (modelsLoading) return;
    if (!force && availableModels.length > 0) return;
    setModelsLoading(true);
    setModelsError('');
    try {
      const res = await fetch('/api/models');
      const data = (await res.json()) as JsonErrorResponse & { models?: unknown };
      if (!res.ok) throw new Error(data.error || 'models_load_failed');
      const list = normalizeModelOptions(data.models);
      setAvailableModels(list);
    } catch (e: unknown) {
      setModelsError(getClientErrorMessage(e, 'models_load_failed'));
      setAvailableModels([]);
    } finally {
      setModelsLoading(false);
    }
  }

  function openChatSettings() {
    setChatSettingsOpen(true);
    loadAvailableModels(false).catch(() => {});
  }

  function closeChatSettings() {
    setChatSettingsOpen(false);
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

  async function syncPushSubscription(
    subscription: PushSubscription,
    threadId: string | null = activeThreadRef.current
  ): Promise<JsonErrorResponse> {
    const json = subscription?.toJSON?.();
    if (!json?.endpoint || !json?.keys?.p256dh || !json?.keys?.auth) throw new Error('push_subscription_invalid');
    const res = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscription: json,
        threadId: threadId || null,
        userAgent: navigator.userAgent
      })
    });
    const data = (await res.json()) as JsonErrorResponse;
    if (!res.ok) throw new Error(data.error || 'push_subscribe_failed');
    pushEndpointRef.current = json.endpoint;
    window.localStorage.setItem(PUSH_ENDPOINT_KEY, json.endpoint);
    return data;
  }

  async function ensurePushNotificationsEnabled(threadId: string | null = activeThreadRef.current): Promise<boolean> {
    if (typeof window === 'undefined') return false;
    const supported =
      window.isSecureContext &&
      'serviceWorker' in navigator &&
      'PushManager' in window &&
      'Notification' in window;
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
        const permission =
          Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
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

  function sanitizePendingUserInputRequests(
    items: unknown,
    threadId: string | null = activeThreadRef.current
  ): PendingUserInputRequest[] {
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
      const next = [
        ...prev.filter((item) => String(item.requestId) !== String(request.requestId)),
        request
      ];
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

  async function respondToUserInput(
    requestId: RequestId,
    answers: UserInputAnswerMap,
    requestMeta: Pick<PendingUserInputRequest, 'threadId' | 'turnId'> | null = null
  ): Promise<boolean> {
    const key = String(requestId || '');
    if (!key) return false;
    setPendingUserInputBusy((prev) => ({ ...prev, [key]: true }));
    try {
      const res = await fetch('/api/approvals/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request_id: requestId,
          answers
        })
      });
      const data = (await res.json()) as JsonErrorResponse;
      if (!res.ok) throw new Error(data.error || 'approval_respond_failed');
      setPendingUserInputRequests((prev) => prev.filter((item) => String(item.requestId) !== key));
      toast('入力を送信しました');
      const metaThreadId = String(requestMeta?.threadId || '');
      if (metaThreadId) {
        if (streaming) return true;
        try {
          const running = await fetchRunningTurn(metaThreadId);
          if (running?.running && running.turnId) {
            await startResumeStream(metaThreadId, running.turnId);
          } else {
            restoreOutputForThread(metaThreadId);
          }
        } catch {
          restoreOutputForThread(metaThreadId);
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

  async function selectUserInputOption(
    request: PendingUserInputRequest,
    questionIndex: number,
    questionId: string,
    optionLabel: string
  ): Promise<void> {
    if (!request || !request.requestId || !questionId) return;
    const requestKey = String(request.requestId);
    const questions = Array.isArray(request.questions) ? request.questions : [];
    if (questions.length === 0) return;
    if (pendingUserInputBusy[requestKey]) return;

    const snapshotState =
      pendingUserInputDrafts[requestKey] && typeof pendingUserInputDrafts[requestKey] === 'object'
        ? pendingUserInputDrafts[requestKey]
        : { index: 0, answers: {} };
    const snapshotAnswers = snapshotState.answers && typeof snapshotState.answers === 'object' ? snapshotState.answers : {};
    const nextAnswers = {
      ...snapshotAnswers,
      [questionId]: { answers: [String(optionLabel || '')] }
    };
    const rawIndex = Number.isInteger(questionIndex) ? questionIndex : Number(snapshotState.index || 0);
    const currentIndex = Math.min(Math.max(0, rawIndex), Math.max(0, questions.length - 1));
    const nextIndex = currentIndex + 1;
    const complete = nextIndex >= questions.length;

    setPendingUserInputDrafts((prev) => ({
      ...prev,
      [requestKey]: {
        // 回答送信中/失敗時に問いが消えないよう、完了時は最終問い位置に留める。
        index: complete ? Math.max(0, questions.length - 1) : nextIndex,
        answers: nextAnswers
      }
    }));
    if (!complete) return;

    const ok = await respondToUserInput(request.requestId, nextAnswers, {
      threadId: request.threadId,
      turnId: request.turnId
    });
    if (!ok) return;
    setPendingUserInputDrafts((prev) => {
      const next = { ...prev };
      delete next[requestKey];
      return next;
    });
  }

  async function startResumeStream(threadId: string, turnId: string): Promise<void> {
    if (!threadId || !turnId) return;
    if (resumeStreamingTurnIdRef.current === turnId && resumeStreamAbortRef.current) return;
    if (resumeStreamAbortRef.current) resumeStreamAbortRef.current.abort();

    const controller = new AbortController();
    resumeStreamAbortRef.current = controller;
    resumeStreamingThreadIdRef.current = threadId;
    resumeStreamingTurnIdRef.current = turnId;
    streamAbortRef.current = controller;

    const assistantId = `resume:${turnId}:${Date.now()}`;
    setAwaitingFirstStreamChunk(true);
    setHasReasoningStarted(false);
    setHasAnswerStarted(false);
    setStreaming(true);
    setStreamingAssistantTarget(assistantId);
    streamingAssistantMessageItemIdRef.current = '';
    awaitingPostUserInputAssistantRef.current = false;
    setLiveReasoningText('');
    setActiveTurnId(String(turnId || ''));
    activeTurnIdRef.current = String(turnId || '');

    setOutputItems((prev) => [...prev, createEmptyAssistantItem(assistantId)]);

    let answerCommitted = '';
    let planCommitted = '';
    let reasoningRaw = '';
    let lineBuf = '';

    function updateAssistant(patch: AssistantPatch): void {
      setOutputItems((prev) =>
        prev.map((item) => {
          if (item.id !== assistantId || !isAssistantItem(item)) return item;
          const merged = typeof patch === 'function' ? patch(item) : { ...item, ...patch };
          return merged;
        })
      );
    }

    try {
      const res = await fetch(
        `/api/turns/stream/resume?threadId=${encodeURIComponent(threadId)}&turnId=${encodeURIComponent(turnId)}`,
        { signal: controller.signal }
      );
      if (!res.ok || !res.body) {
        const err = await res.text();
        throw new Error(err || 'resume_stream_failed');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        lineBuf += decoder.decode(value, { stream: true });
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const evt = parseTurnStreamEvent(trimmed);
          if (!evt) {
            setAwaitingFirstStreamChunk(false);
            setHasAnswerStarted(true);
            answerCommitted += `${line}\n`;
            const nextType = looksLikeDiff(answerCommitted) ? 'diff' : 'plain';
            updateAssistant({ type: nextType, answer: answerCommitted, text: answerCommitted, plan: planCommitted, status: '' });
            continue;
          }
          if (evt.type === 'reasoning_delta' && evt.delta) {
            setAwaitingFirstStreamChunk(false);
            setHasReasoningStarted(true);
            reasoningRaw += evt.delta;
            const displayReasoning = extractDisplayReasoningText(reasoningRaw);
            if (displayReasoning) setLiveReasoningText(displayReasoning);
            continue;
          }
          if (evt.type === 'answer_delta' && evt.delta) {
            setAwaitingFirstStreamChunk(false);
            setHasAnswerStarted(true);
            answerCommitted += evt.delta;
            const nextType = looksLikeDiff(answerCommitted) ? 'diff' : 'plain';
            updateAssistant({ type: nextType, answer: answerCommitted, text: answerCommitted, plan: planCommitted, status: '' });
            continue;
          }
          if (evt.type === 'plan_delta' && evt.delta) {
            planCommitted += evt.delta;
            updateAssistant({ plan: planCommitted, status: '' });
            continue;
          }
          if (evt.type === 'plan_snapshot' && typeof evt.text === 'string') {
            planCommitted = evt.text;
            updateAssistant({ plan: planCommitted, status: '' });
            continue;
          }
          if (evt.type === 'request_user_input' && evt.requestId && Array.isArray(evt.questions)) {
            mergePendingUserInputRequest({
              requestId: evt.requestId,
              threadId,
              turnId,
              itemId: String(evt.itemId || ''),
              questions: evt.questions,
              createdAt: new Date().toISOString()
            });
            continue;
          }
          if (evt.type === 'started') {
            const nextTurnId = String(evt.turnId || turnId || '');
            if (nextTurnId) {
              setActiveTurnId(nextTurnId);
              activeTurnIdRef.current = nextTurnId;
            }
            continue;
          }
          if (evt.type === 'status' && (evt.phase === 'starting' || evt.phase === 'reconnecting')) continue;
          if (evt.type === 'done') continue;
          if (evt.type === 'error') {
            throw new Error(String(evt.message || 'unknown_error'));
          }
        }
      }

      if (lineBuf.trim()) {
        const evt = parseTurnStreamEvent(lineBuf.trim());
        if (!evt) {
          setAwaitingFirstStreamChunk(false);
          setHasAnswerStarted(true);
          answerCommitted += lineBuf;
          const nextType = looksLikeDiff(answerCommitted) ? 'diff' : 'plain';
          updateAssistant({ type: nextType, answer: answerCommitted, text: answerCommitted, plan: planCommitted, status: '' });
        } else {
          if (evt.type === 'reasoning_delta' && evt.delta) {
            setAwaitingFirstStreamChunk(false);
            setHasReasoningStarted(true);
            reasoningRaw += evt.delta;
            const displayReasoning = extractDisplayReasoningText(reasoningRaw);
            if (displayReasoning) setLiveReasoningText(displayReasoning);
          }
          if (evt.type === 'answer_delta' && evt.delta) {
            setAwaitingFirstStreamChunk(false);
            setHasAnswerStarted(true);
            answerCommitted += evt.delta;
            const nextType = looksLikeDiff(answerCommitted) ? 'diff' : 'plain';
            updateAssistant({ type: nextType, answer: answerCommitted, text: answerCommitted, plan: planCommitted, status: '' });
          }
          if (evt.type === 'plan_delta' && evt.delta) {
            planCommitted += evt.delta;
            updateAssistant({ plan: planCommitted, status: '' });
          }
          if (evt.type === 'plan_snapshot' && typeof evt.text === 'string') {
            planCommitted = evt.text;
            updateAssistant({ plan: planCommitted, status: '' });
          }
          if (evt.type === 'request_user_input' && evt.requestId && Array.isArray(evt.questions)) {
            mergePendingUserInputRequest({
              requestId: evt.requestId,
              threadId,
              turnId,
              itemId: String(evt.itemId || ''),
              questions: evt.questions,
              createdAt: new Date().toISOString()
            });
          }
          if (evt.type === 'started') {
            const nextTurnId = String(evt.turnId || turnId || '');
            if (nextTurnId) {
              setActiveTurnId(nextTurnId);
              activeTurnIdRef.current = nextTurnId;
            }
          }
          if (evt.type === 'done') {
            // no-op: 最終確定はストリーム読了後に行う。
          }
          if (evt.type === 'error') {
            throw new Error(String(evt.message || 'unknown_error'));
          }
        }
      }

      const finalAnswer = answerCommitted.trim() ? answerCommitted : '(応答なし)';
      const finalType: AssistantOutputItem['type'] = looksLikeDiff(finalAnswer) ? 'diff' : 'markdown';
      setOutputItems((prev): OutputItem[] =>
        prev.map((item) =>
          item.id === assistantId && isAssistantItem(item)
            ? { ...item, type: finalType, status: '', answer: finalAnswer, text: finalAnswer, plan: planCommitted }
            : item
        )
      );
    } catch (e: unknown) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        // resume失敗時は履歴再取得で最新化し、失敗トーストは出さない。
        restoreOutputForThread(threadId);
      }
    } finally {
      if (resumeStreamAbortRef.current === controller) {
        resumeStreamAbortRef.current = null;
        resumeStreamingThreadIdRef.current = '';
        resumeStreamingTurnIdRef.current = '';
      }
      if (streamAbortRef.current === controller) {
        streamAbortRef.current = null;
      }
      if (streamAbortRef.current === null || streamAbortRef.current === controller) {
        setStreaming(false);
        setStreamingAssistantTarget(null);
        streamingAssistantMessageItemIdRef.current = '';
        setLiveReasoningText('');
        setAwaitingFirstStreamChunk(false);
        setHasReasoningStarted(false);
        setHasAnswerStarted(false);
        setActiveTurnId('');
        activeTurnIdRef.current = '';
      }
    }
  }

  async function checkAuthStatus(): Promise<JsonErrorResponse & { available?: boolean; connected?: boolean; login?: string }> {
    const res = await fetch('/api/github/auth/status');
    const data = (await res.json()) as JsonErrorResponse & { available?: boolean; connected?: boolean; login?: string };
    if (!res.ok) throw new Error(data.error || 'auth_status_failed');
    return data;
  }

  async function fetchRepos(nextQuery = query): Promise<void> {
    const res = await fetch(`/api/github/repos?query=${encodeURIComponent(nextQuery.trim())}`);
    const data = (await res.json()) as JsonErrorResponse & { repos?: RepoSummary[] };
    if (!res.ok) throw new Error(data.hint || data.error || 'repo_load_failed');
    setRepos(Array.isArray(data.repos) ? data.repos : []);
  }

  async function fetchThreadMessages(threadId: string): Promise<{ items: OutputItem[]; model: string }> {
    const res = await fetch(`/api/threads/messages?threadId=${encodeURIComponent(threadId)}`);
    const data = (await res.json()) as ThreadMessagesResponse;
    if (!res.ok) throw new Error(data.error || 'thread_messages_failed');
    return {
      items: expandAssistantItems(Array.isArray(data.items) ? data.items : []),
      model: String(data.model || '').trim()
    };
  }

  async function ensureThread(repoFullName: string, preferredThreadId: string | null = null, model = ''): Promise<string> {
    const normalizedModel = String(model || '').trim();
    const res = await fetch('/api/threads/ensure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoFullName,
        preferred_thread_id: preferredThreadId || undefined,
        model: normalizedModel || undefined
      })
    });
    const data = (await res.json()) as EnsureThreadResponse;
    if (!res.ok) throw new Error(data.error || 'thread_ensure_failed');
    const id = data.id || data.thread_id;
    if (!id) throw new Error('thread_id_missing');
    return id;
  }

  function isRecoverableThreadError(text: string): boolean {
    const raw = String(text || '');
    return (
      raw.includes('thread not found') ||
      raw.includes('thread_not_found') ||
      raw.includes('no rollout found for thread id')
    );
  }

  function looksLikeDiff(text: string): boolean {
    return /^diff --git/m.test(text) || /^@@/m.test(text) || /^\+\+\+/m.test(text);
  }

  async function bootstrapConnection(): Promise<void> {
    setConnected(false);
    setError(null);
    setRepos([]);
    setSelectedRepo(null);
    try {
      const auth = await checkAuthStatus();
      if (!auth.available) {
        setError({ title: 'gh CLIが利用できません', cause: auth.hint || 'gh のインストール状況を確認してください。' });
        return;
      }
      if (!auth.connected) {
        setError({ title: 'GitHubに未ログインです', cause: auth.hint || '`gh auth login` を実行してください。' });
        return;
      }
      setConnected(true);
      await fetchRepos('');
    } catch (e: unknown) {
      setError({ title: '接続確認に失敗しました', cause: getClientErrorMessage(e) });
    }
  }

  async function refreshCloneState(fullName: string): Promise<{ status?: string; error?: string }> {
    const res = await fetch(`/api/repos/clone-status?fullName=${encodeURIComponent(fullName)}`);
    const data = (await res.json()) as JsonErrorResponse & { status?: string; error?: string };
    if (!res.ok) throw new Error(data.error || 'clone_status_failed');
    return data;
  }

  async function cloneSelectedRepo(repo: RepoSummary): Promise<JsonErrorResponse> {
    const res = await fetch('/api/repos/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullName: repo.fullName, cloneUrl: repo.cloneUrl })
    });
    const data = (await res.json()) as JsonErrorResponse;
    if (!res.ok) throw new Error(data.error || 'clone_failed');
    return data;
  }

  async function waitForClone(fullName: string, timeoutMs = CLONE_TIMEOUT_MS): Promise<{ status?: string; error?: string }> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const data = await refreshCloneState(fullName);
      if (data.status === 'cloned') return data;
      if (data.status === 'failed') throw new Error(data.error || 'clone_failed');
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`clone_timeout_${Math.floor(timeoutMs / 1000)}s`);
  }

  async function createThread(repoFullName: string, model = ''): Promise<string> {
    const normalizedModel = String(model || '').trim();
    const res = await fetch('/api/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoFullName, title: `thread-${Date.now()}`, model: normalizedModel || undefined })
    });
    const data = (await res.json()) as EnsureThreadResponse;
    if (!res.ok) throw new Error(data.error || 'thread_create_failed');
    const id = data.id || data.thread_id;
    if (!id) throw new Error('thread_id_missing');
    return id;
  }

  function restoreOutputForThread(threadId: string, repoFullName: string | null = activeRepoRef.current): void {
    if (!threadId) return;
    // スレッド切替直後でも、到着した履歴を破棄しないよう即時更新する。
    activeThreadRef.current = threadId;
    const cached = loadThreadMessages(threadId);
    setOutputItems(cached);
    fetchPendingUserInputRequests(threadId).catch(() => {
      // 取得失敗時は既存表示を維持する。
    });
    fetchThreadMessages(threadId)
      .then((payload) => {
        if (activeThreadRef.current !== threadId) return;
        setOutputItems(payload.items);
        if (payload.model && repoFullName) setRepoModel(repoFullName, payload.model);
      })
      .catch(() => {
        // API取得に失敗した場合はキャッシュ表示を維持する。
      });
  }

  async function startWithRepo(repo: RepoSummary): Promise<boolean> {
    setBusy(true);
    try {
      setPendingAttachments([]);
      setSelectedRepo(repo);
      if (repo.cloneState?.status !== 'cloned') {
        await cloneSelectedRepo(repo);
        await waitForClone(repo.fullName);
        setRepos((prev) =>
          prev.map((item) =>
            item.fullName === repo.fullName
              ? { ...item, cloneState: { ...(item.cloneState || {}), status: 'cloned' } }
              : item
          )
        );
      }
      let threadId = threadByRepo[repo.fullName] || null;
      threadId = await ensureThread(repo.fullName, threadId, getRepoModel(repo.fullName));

      if (!threadId) throw new Error('thread_not_found');
      setActiveThreadId(threadId);
      setActiveRepoFullName(repo.fullName);
      setChatVisible(true);
      setThreadByRepo((prev) => ({ ...prev, [repo.fullName]: threadId }));
      restoreOutputForThread(threadId, repo.fullName);
      toast('接続しました');
      return true;
    } catch (e: unknown) {
      toast(`接続失敗: ${getClientErrorMessage(e)}`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  function appendUserMessage(prompt: string, attachments: ImageAttachmentDraft[]): void {
    const userId = `u-${Date.now()}`;
    const attachmentMeta: ImageAttachmentMeta[] = attachments.map((att) => ({
      type: 'image',
      name: att.name,
      size: att.size,
      mime: att.mime
    }));
    setOutputItems((prev) => [...prev, { id: userId, role: 'user', type: 'plain', text: prompt, attachments: attachmentMeta }]);
  }

  async function postSteerTurn(
    threadId: string,
    turnId: string,
    prompt: string,
    attachments: ImageAttachmentDraft[]
  ): Promise<{ ok: boolean; status: number; error: string }> {
    const res = await fetch('/api/turns/steer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        thread_id: threadId,
        turn_id: turnId,
        input: prompt,
        attachments
      })
    });
    let data: JsonErrorResponse = {};
    try {
      data = (await res.json()) as JsonErrorResponse;
    } catch {
      data = {};
    }
    return {
      ok: res.ok,
      status: res.status,
      error: String(data.error || '')
    };
  }

  async function startTurnStream(
    prompt: string,
    attachmentsToSend: ImageAttachmentDraft[],
    threadIdToUse: string,
    appendUser = true,
    forcedCollaborationMode = ''
  ): Promise<void> {
    const repoFullName = activeRepoFullName;
    if (!repoFullName) throw new Error('repo_not_selected');
    setMessage('');
    setPendingAttachments([]);
    setLiveReasoningText('');
    setAwaitingFirstStreamChunk(true);
    setHasReasoningStarted(false);
    setHasAnswerStarted(false);
    setStreaming(true);
    setActiveTurnId('');
    activeTurnIdRef.current = '';

    if (appendUser) appendUserMessage(prompt, attachmentsToSend);

    const assistantId = appendStreamingAssistantCard();
    streamingAssistantMessageItemIdRef.current = '';
    streamingAnswerBufferRef.current = '';
    streamingPlanBufferRef.current = '';
    pendingFollowupSplitRef.current = false;
    awaitingPostUserInputAssistantRef.current = false;

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
          restoreOutputForThread(recovered, repoFullName);
          res = await postTurn(threadIdToUse);
        } else {
          throw new Error(firstErr || 'send_failed');
        }
      }

      if (!res.ok || !res.body) {
        const err = await res.text();
        throw new Error(err || 'send_failed');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let reasoningRaw = '';
      let lineBuf = '';

      function updateAssistant(patch: AssistantPatch): void {
        const targetId = String(streamingAssistantIdRef.current || assistantId || '');
        if (!targetId) return;
        setOutputItems((prev) =>
          prev.map((item) => {
            if (item.id !== targetId || !isAssistantItem(item)) return item;
            const merged = typeof patch === 'function' ? patch(item) : { ...item, ...patch };
            return merged;
          })
        );
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        lineBuf += decoder.decode(value, { stream: true });
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const evt = parseTurnStreamEvent(trimmed);
          if (!evt) {
            setAwaitingFirstStreamChunk(false);
            setHasAnswerStarted(true);
            streamingAnswerBufferRef.current += `${line}\n`;
            const nextType = looksLikeDiff(streamingAnswerBufferRef.current) ? 'diff' : 'plain';
            updateAssistant({
              type: nextType,
              answer: streamingAnswerBufferRef.current,
              text: streamingAnswerBufferRef.current,
              plan: streamingPlanBufferRef.current,
              status: ''
            });
            continue;
          }
          if (evt.type === 'reasoning_delta' && evt.delta) {
            setAwaitingFirstStreamChunk(false);
            setHasReasoningStarted(true);
            reasoningRaw += evt.delta;
            const displayReasoning = extractDisplayReasoningText(reasoningRaw);
            if (displayReasoning) setLiveReasoningText(displayReasoning);
            continue;
          }
          if (evt.type === 'answer_delta' && evt.delta) {
            setAwaitingFirstStreamChunk(false);
            setHasAnswerStarted(true);
            awaitingPostUserInputAssistantRef.current = false;
            ensureStreamingAssistantCardForItem(String(evt.itemId || ''));
            streamingAnswerBufferRef.current += evt.delta;
            const nextType = looksLikeDiff(streamingAnswerBufferRef.current) ? 'diff' : 'plain';
            updateAssistant({
              type: nextType,
              answer: streamingAnswerBufferRef.current,
              text: streamingAnswerBufferRef.current,
              plan: streamingPlanBufferRef.current,
              status: ''
            });
            continue;
          }
          if (evt.type === 'plan_delta' && evt.delta) {
            awaitingPostUserInputAssistantRef.current = false;
            ensureStreamingAssistantCardForItem(String(evt.itemId || ''));
            streamingPlanBufferRef.current += evt.delta;
            updateAssistant({ plan: streamingPlanBufferRef.current, status: '' });
            continue;
          }
          if (evt.type === 'plan_snapshot' && typeof evt.text === 'string') {
            awaitingPostUserInputAssistantRef.current = false;
            ensureStreamingAssistantCardForItem(String(evt.itemId || ''));
            streamingPlanBufferRef.current = evt.text;
            updateAssistant({ plan: streamingPlanBufferRef.current, status: '' });
            continue;
          }
          if (evt.type === 'request_user_input' && evt.requestId && Array.isArray(evt.questions)) {
            if (streamingAnswerBufferRef.current.trim() || streamingPlanBufferRef.current.trim()) {
              splitStreamingAssistantCard();
              awaitingPostUserInputAssistantRef.current = true;
            }
            mergePendingUserInputRequest({
              requestId: evt.requestId,
              threadId: threadIdToUse,
              turnId: String(evt.turnId || ''),
              itemId: String(evt.itemId || ''),
              questions: evt.questions,
              createdAt: new Date().toISOString()
            });
            continue;
          }
          if (evt.type === 'started') {
            const nextTurnId = String(evt.turnId || '');
            if (nextTurnId) {
              setActiveTurnId(nextTurnId);
              activeTurnIdRef.current = nextTurnId;
            }
            continue;
          }
          if (evt.type === 'status' && (evt.phase === 'starting' || evt.phase === 'reconnecting')) {
            continue;
          }
          if (evt.type === 'error') {
            throw new Error(String(evt.message || 'unknown_error'));
          }
        }
      }

      if (lineBuf.trim()) {
        const evt = parseTurnStreamEvent(lineBuf.trim());
        if (!evt) {
          setAwaitingFirstStreamChunk(false);
          setHasAnswerStarted(true);
          streamingAnswerBufferRef.current += lineBuf;
        } else {
          if (evt.type === 'reasoning_delta' && evt.delta) {
            setAwaitingFirstStreamChunk(false);
            setHasReasoningStarted(true);
            reasoningRaw += evt.delta;
            const displayReasoning = extractDisplayReasoningText(reasoningRaw);
            if (displayReasoning) setLiveReasoningText(displayReasoning);
          }
          if (evt.type === 'answer_delta' && evt.delta) {
            setAwaitingFirstStreamChunk(false);
            setHasAnswerStarted(true);
            awaitingPostUserInputAssistantRef.current = false;
            ensureStreamingAssistantCardForItem(String(evt.itemId || ''));
            streamingAnswerBufferRef.current += evt.delta;
            const nextType = looksLikeDiff(streamingAnswerBufferRef.current) ? 'diff' : 'plain';
            updateAssistant({
              type: nextType,
              answer: streamingAnswerBufferRef.current,
              text: streamingAnswerBufferRef.current,
              plan: streamingPlanBufferRef.current,
              status: ''
            });
          }
          if (evt.type === 'plan_delta' && evt.delta) {
            awaitingPostUserInputAssistantRef.current = false;
            ensureStreamingAssistantCardForItem(String(evt.itemId || ''));
            streamingPlanBufferRef.current += evt.delta;
            updateAssistant({ plan: streamingPlanBufferRef.current, status: '' });
          }
          if (evt.type === 'plan_snapshot' && typeof evt.text === 'string') {
            awaitingPostUserInputAssistantRef.current = false;
            ensureStreamingAssistantCardForItem(String(evt.itemId || ''));
            streamingPlanBufferRef.current = evt.text;
            updateAssistant({ plan: streamingPlanBufferRef.current, status: '' });
          }
          if (evt.type === 'request_user_input' && evt.requestId && Array.isArray(evt.questions)) {
            if (streamingAnswerBufferRef.current.trim() || streamingPlanBufferRef.current.trim()) {
              splitStreamingAssistantCard();
              awaitingPostUserInputAssistantRef.current = true;
            }
            mergePendingUserInputRequest({
              requestId: evt.requestId,
              threadId: threadIdToUse,
              turnId: String(evt.turnId || ''),
              itemId: String(evt.itemId || ''),
              questions: evt.questions,
              createdAt: new Date().toISOString()
            });
          }
          if (evt.type === 'started') {
            const nextTurnId = String(evt.turnId || '');
            if (nextTurnId) {
              setActiveTurnId(nextTurnId);
              activeTurnIdRef.current = nextTurnId;
            }
          }
          if (evt.type === 'error') {
            throw new Error(String(evt.message || 'unknown_error'));
          }
        }
      }

      const currentAssistantId = String(streamingAssistantIdRef.current || assistantId || '');
      if (
        awaitingPostUserInputAssistantRef.current &&
        !streamingAnswerBufferRef.current.trim() &&
        !streamingPlanBufferRef.current.trim()
      ) {
        discardStreamingAssistantCard(currentAssistantId);
      } else {
        finalizeStreamingAssistantCard(currentAssistantId, streamingAnswerBufferRef.current, streamingPlanBufferRef.current);
      }
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        const currentAssistantId = String(streamingAssistantIdRef.current || assistantId || '');
        setOutputItems((prev) =>
          prev.map((item) => (item.id === currentAssistantId && isAssistantItem(item) ? { ...item, text: '(停止しました)' } : item))
        );
      } else if (backgroundInterruptedTurnRef.current) {
        const currentAssistantId = String(streamingAssistantIdRef.current || assistantId || '');
        setOutputItems((prev) => prev.filter((item) => item.id !== currentAssistantId));
      } else {
        const currentAssistantId = String(streamingAssistantIdRef.current || assistantId || '');
        setOutputItems((prev) =>
          prev.map((item) =>
            item.id === currentAssistantId && isAssistantItem(item)
              ? { ...item, text: `送信失敗: ${getClientErrorMessage(e)}` }
              : item
          )
        );
        toast('送信に失敗しました');
      }
    } finally {
      if (streamAbortRef.current === controller) {
        setStreaming(false);
        setStreamingAssistantTarget(null);
        setLiveReasoningText('');
        setAwaitingFirstStreamChunk(false);
        setHasReasoningStarted(false);
        setHasAnswerStarted(false);
        setActiveTurnId('');
        activeTurnIdRef.current = '';
        streamingAssistantMessageItemIdRef.current = '';
        streamingAnswerBufferRef.current = '';
        streamingPlanBufferRef.current = '';
        pendingFollowupSplitRef.current = false;
        awaitingPostUserInputAssistantRef.current = false;
        streamAbortRef.current = null;
        backgroundInterruptedTurnRef.current = false;
      }
    }
  }

  async function sendTurnWithOverrides({
    forcedPrompt = '',
    forcedCollaborationMode = ''
  }: { forcedPrompt?: string; forcedCollaborationMode?: CollaborationMode | string } = {}): Promise<void> {
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
        restoreOutputForThread(created, repoFullName);
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
        restoreOutputForThread(ensured, repoFullName);
      }
    } catch (e: unknown) {
      toast(`Thread再接続失敗: ${getClientErrorMessage(e)}`);
      return;
    }
    if (
      pendingThreadReturn &&
      pendingThreadReturn.repoFullName === repoFullName &&
      pendingThreadReturn.toThreadId === threadIdToUse
    ) {
      setPendingThreadReturn(null);
    }

    if (!streaming) {
      await startTurnStream(prompt, attachmentsToSend, threadIdToUse, true, forcedMode);
      return;
    }

    setMessage('');
    setPendingAttachments([]);
    appendUserMessage(prompt, attachmentsToSend);

    if (resumeStreamAbortRef.current) resumeStreamAbortRef.current.abort();

    const turnIdToUse = String(activeTurnIdRef.current || '');
    if (!turnIdToUse) {
      const controller = streamAbortRef.current;
      if (controller) controller.abort();
      await startTurnStream(prompt, attachmentsToSend, threadIdToUse, false, forcedMode);
      return;
    }

    pendingFollowupSplitRef.current = true;
    const steerResult = await postSteerTurn(threadIdToUse, turnIdToUse, prompt, attachmentsToSend);
    if (steerResult.ok) return;

    const isRecoverableSteerError =
      steerResult.status === 409 ||
      steerResult.error.includes('no_active_turn') ||
      steerResult.error.includes('turn_mismatch') ||
      steerResult.error.includes('running_turn_not_found');
    if (isRecoverableSteerError) {
      pendingFollowupSplitRef.current = false;
      const controller = streamAbortRef.current;
      if (controller) controller.abort();
      await startTurnStream(prompt, attachmentsToSend, threadIdToUse, false, forcedMode);
      return;
    }

    pendingFollowupSplitRef.current = false;
    toast(`追加入力送信失敗: ${steerResult.error || 'steer_failed'}`);
  }

  async function sendTurn(): Promise<void> {
    await sendTurnWithOverrides();
  }

  async function startNewThread(): Promise<void> {
    if (streaming) return;
    const repoFullName = activeRepoFullName;
    if (!repoFullName) {
      toast('リポジトリが未選択です');
      return;
    }
    setBusy(true);
    try {
      const previousThreadId = String(activeThreadRef.current || '');
      const id = await createThread(repoFullName, getRepoModel(repoFullName));
      setActiveThreadId(id);
      setThreadByRepo((prev) => ({ ...prev, [repoFullName]: id }));
      if (previousThreadId && previousThreadId !== id) {
        setPendingThreadReturn({
          repoFullName,
          fromThreadId: previousThreadId,
          toThreadId: id
        });
      } else {
        setPendingThreadReturn(null);
      }
      setOutputItems([]);
      setMessage('');
      setPendingAttachments([]);
      toast('新規スレッドを開始しました');
    } catch (e: unknown) {
      toast(`新規スレッド開始失敗: ${getClientErrorMessage(e)}`);
    } finally {
      setBusy(false);
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
      } catch {
        // 切断時は中断API失敗を無視してUI側を先に整合させる。
      }
    }

    setPendingUserInputRequests([]);
    setPendingUserInputDrafts({});
    setActiveTurnId('');
    activeTurnIdRef.current = '';
  }

  function navigate(path: string, replace = false): void {
    const next = pushPath(path, replace);
    setCurrentPath(next);
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
    return true;
  }

  useEffect(() => {
    if (didBootstrapRef.current) return;
    didBootstrapRef.current = true;
    f7ready(() => {
      if (window.location.pathname === '/') navigate(chatVisible ? '/chat/' : '/repos/', true);
      else setCurrentPath(getCurrentPath());
      bootstrapConnection();
    });
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    ensurePushNotificationsEnabled(activeThreadRef.current).catch(() => {});
  }, []);

  useEffect(() => {
    const onPopState = () => setCurrentPath(getCurrentPath());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (currentPath === '/chat/' && !chatVisible && connected) navigate('/repos/', true);
  }, [currentPath, chatVisible, connected]);

  useEffect(() => {
    if (currentPath === '/chat/' && chatVisible) return;
    setChatSettingsOpen(false);
  }, [currentPath, chatVisible]);

  useEffect(() => {
    if (!connected) return;
    const prevPath = lastPathRef.current;
    lastPathRef.current = currentPath;
    if (currentPath !== '/repos/' || prevPath === '/repos/') return;
    setSelectedRepo(null);
    fetchRepos(query).catch(() => {});
  }, [currentPath, connected, query]);

  useEffect(() => {
    const prevPath = chatEntryPathRef.current;
    chatEntryPathRef.current = currentPath;
    if (currentPath !== '/chat/' || prevPath === '/chat/') return;
    lastChatEntryAlignKeyRef.current = '';
    const node = outputRef.current;
    chatEntryScrollTopRef.current = node instanceof HTMLElement ? node.scrollTop : 0;
  }, [currentPath]);

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
    return () => {
      if (resumeStreamAbortRef.current) resumeStreamAbortRef.current.abort();
    };
  }, []);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        if (streaming) {
          backgroundInterruptedTurnRef.current = true;
          shouldResumeOnVisibleRef.current = true;
        }
        return;
      }

      if (document.visibilityState !== 'visible') return;
      const threadId = activeThreadRef.current;
      if (!threadId) return;

      restoreOutputForThread(threadId);

      if (!shouldResumeOnVisibleRef.current) return;
      shouldResumeOnVisibleRef.current = false;

      (async () => {
        try {
          const running = await fetchRunningTurn(threadId);
          if (document.visibilityState !== 'visible') return;
          if (activeThreadRef.current !== threadId) return;
          if (running?.running && running.turnId) {
            await startResumeStream(threadId, running.turnId);
          }
        } catch {
          // running turnの取得に失敗した場合は履歴再取得のみ維持。
        }
      })();
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
      body: JSON.stringify({
        endpoint,
        threadId: activeThreadId || null
      })
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
  }, [activeRepoFullName, activeThreadId]);

  useEffect(() => {
    window.localStorage.setItem(THREAD_BY_REPO_KEY, JSON.stringify(threadByRepo));
  }, [threadByRepo]);

  useEffect(() => {
    window.localStorage.setItem(COLLABORATION_MODE_BY_REPO_KEY, JSON.stringify(collaborationModeByRepo));
  }, [collaborationModeByRepo]);

  useEffect(() => {
    window.localStorage.setItem(MODEL_BY_REPO_KEY, JSON.stringify(modelByRepo));
  }, [modelByRepo]);

  useEffect(() => {
    if (!activeThreadId) return;
    window.localStorage.setItem(threadMessagesKey(activeThreadId), JSON.stringify(outputItems.slice(-200)));
  }, [activeThreadId, outputItems]);

  useEffect(() => {
    if (!autoScrollRef.current || !outputRef.current) return;
    outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [outputItems]);

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
      const done = scrollLastUserMessageToTopOrKeepPosition();
      if (done) {
        lastChatEntryAlignKeyRef.current = alignKey;
        return;
      }
      if (attempts >= 12) return;
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
    restoreOutputForThread(activeThreadId, activeRepoFullName);
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

  const clonedRepos = repos.filter((repo) => repo.cloneState?.status === 'cloned');
  const notClonedRepos = repos.filter((repo) => repo.cloneState?.status !== 'cloned');
  const filteredRepos = repoFilter === 'cloned' ? clonedRepos : repoFilter === 'not_cloned' ? notClonedRepos : repos;
  const activeRepoModel = activeRepoFullName ? String(modelByRepo[activeRepoFullName] || '').trim() : '';
  const latestPlanText = useMemo(() => {
    for (let idx = outputItems.length - 1; idx >= 0; idx -= 1) {
      const item = outputItems[idx];
      if (!item || !isAssistantItem(item)) continue;
      const planText = String(item.plan || '').trim();
      if (planText) return planText;
    }
    return '';
  }, [outputItems]);
  const activeCollaborationMode =
    activeRepoFullName &&
    (collaborationModeByRepo[activeRepoFullName] === 'plan' ||
      collaborationModeByRepo[activeRepoFullName] === 'default')
      ? collaborationModeByRepo[activeRepoFullName]
      : DEFAULT_COLLABORATION_MODE;

  function setActiveCollaborationMode(mode: CollaborationMode): void {
    const repoFullName = activeRepoFullName;
    if (!repoFullName) return;
    const next = mode === 'default' ? 'default' : 'plan';
    setCollaborationModeByRepo((prev) => ({ ...prev, [repoFullName]: next }));
  }

  const canReturnToPreviousThread = Boolean(
    pendingThreadReturn &&
      pendingThreadReturn.repoFullName === activeRepoFullName &&
      pendingThreadReturn.toThreadId === activeThreadId &&
      pendingThreadReturn.fromThreadId
  );

  const canApplyLatestPlan = Boolean(
    latestPlanText && activeThreadId && activeRepoFullName && !streaming
  );

  async function applyLatestPlanShortcut(): Promise<void> {
    if (!canApplyLatestPlan) return;
    setActiveCollaborationMode('default');
    await sendTurnWithOverrides({
      forcedPrompt: 'このプランを実現して',
      forcedCollaborationMode: 'default'
    });
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
    setActiveThreadId(fallbackThreadId);
    setThreadByRepo((prev) => ({ ...prev, [repoFullName]: fallbackThreadId }));
    restoreOutputForThread(fallbackThreadId, repoFullName);
    setPendingThreadReturn(null);
  }

  const ctx = useMemo(
    () => ({
      connected,
      error,
      busy,
      query,
      setQuery,
      repos,
      repoFilter,
      setRepoFilter,
      selectedRepo,
      setSelectedRepo,
      clonedRepos,
      notClonedRepos,
      filteredRepos,
      activeRepoFullName,
      activeThreadId,
      chatVisible,
      outputItems,
      outputRef,
      message,
      setMessage,
      pendingAttachments,
      addImageAttachments,
      removePendingAttachment,
      streaming,
      streamingAssistantId,
      liveReasoningText,
      awaitingFirstStreamChunk,
      hasReasoningStarted,
      hasAnswerStarted,
      navigate,
      bootstrapConnection,
      fetchRepos,
      startWithRepo,
      sendTurn,
      cancelTurn,
      startNewThread,
      canReturnToPreviousThread,
      returnToPreviousThread,
      canApplyLatestPlan,
      applyLatestPlanShortcut,
      chatSettingsOpen,
      openChatSettings,
      closeChatSettings,
      availableModels,
      modelsLoading,
      modelsError,
      loadAvailableModels,
      activeRepoModel,
      setActiveRepoModel,
      activeCollaborationMode,
      setActiveCollaborationMode,
      pendingUserInputRequests,
      selectUserInputOption,
      pendingUserInputBusy,
      pendingUserInputDrafts
    }),
    [
      connected,
      error,
      busy,
      query,
      repos,
      repoFilter,
      selectedRepo,
      clonedRepos,
      notClonedRepos,
      filteredRepos,
      activeRepoFullName,
      activeThreadId,
      chatVisible,
      outputItems,
      message,
      pendingAttachments,
      streaming,
      liveReasoningText,
      awaitingFirstStreamChunk,
      hasReasoningStarted,
      hasAnswerStarted,
      navigate,
      activeCollaborationMode,
      activeRepoModel,
      canReturnToPreviousThread,
      canApplyLatestPlan,
      chatSettingsOpen,
      availableModels,
      modelsLoading,
      modelsError,
      pendingUserInputRequests,
      pendingUserInputBusy,
      pendingUserInputDrafts
    ]
  );

  return (
    <App theme="auto">
      <AppCtx.Provider value={ctx}>
        {currentPath === '/chat/' ? <ChatPage /> : <ReposPage />}
      </AppCtx.Provider>
    </App>
  );
}
