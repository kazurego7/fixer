import {
  Fragment,
  createContext,
  useContext,
  useCallback,
  useEffect,
  useLayoutEffect,
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
import type {
  AppErrorState,
  AssistantOutputItem,
  CollaborationMode,
  GitRepoStatus,
  ImageAttachmentDraft,
  ImageAttachmentMeta,
  LiveTurnStateResponse,
  ModelOption,
  OutputItem,
  PendingBusyMap,
  PendingThreadReturn,
  PendingUserInputRequest,
  RepoFileListItem,
  RepoFileListResponse,
  RepoFileViewResponse,
  RepoSummary,
  RequestId,
  TurnStateStreamEvent,
  TurnStreamEvent,
  UserInputAnswerMap,
  UserInputDraft,
  UserInputDraftMap,
  UserInputQuestion,
  UserOutputItem
} from '../../shared/types';
import { FileTreeNode, useFileTreeState } from './fileTree';

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
  compactionStatusPhase: '' | 'compacting' | 'compacted';
  compactionStatusMessage: string;
  awaitingFirstStreamChunk: boolean;
  hasReasoningStarted: boolean;
  hasAnswerStarted: boolean;
  navigate: (path: string, replace?: boolean) => void;
  bootstrapConnection: () => Promise<void>;
  fetchRepos: (nextQuery?: string) => Promise<void>;
  createRepo: (name: string, visibility: 'public' | 'private') => Promise<RepoSummary>;
  startWithRepo: (repo: RepoSummary) => Promise<boolean>;
  sendTurn: () => Promise<void>;
  cancelTurn: () => Promise<void>;
  startNewThread: () => Promise<void>;
  canReturnToPreviousThread: boolean;
  returnToPreviousThread: () => void;
  goBackToRepoList: () => void;
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
  gitStatus: GitRepoStatus | null;
  gitStatusLoading: boolean;
  gitStatusError: string;
  refreshGitStatus: () => Promise<void>;
  requestGitCommitPush: () => Promise<void>;
  fileListItems: RepoFileListItem[];
  fileListLoading: boolean;
  fileListError: string;
  fileListIncludeUnchanged: boolean;
  setFileListIncludeUnchanged: (value: boolean) => void;
  refreshFileList: (includeUnchanged?: boolean) => Promise<void>;
  selectedFileView: RepoFileViewResponse | null;
  selectedFileViewLoading: boolean;
  selectedFileViewError: string;
  openRepoFile: (filePath: string, line?: number | null, replace?: boolean, jumpToFirstDiff?: boolean) => Promise<void>;
  returnFromFileView: () => void;
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

interface GitStatusResponse extends GitRepoStatus {
  error?: string;
  detail?: string;
}

interface FileListFetchResponse extends RepoFileListResponse {
  error?: string;
  detail?: string;
}

interface FileViewFetchResponse extends RepoFileViewResponse {
  error?: string;
  detail?: string;
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
  const pathname = String(rawPath || '').split('?')[0].split('#')[0];
  if (pathname === '/files' || pathname === '/files/') return '/files/';
  if (pathname === '/files/view' || pathname === '/files/view/') return '/files/view/';
  if (pathname === '/chat' || pathname === '/chat/') return '/chat/';
  if (pathname === '/repos/new' || pathname === '/repos/new/') return '/repos/new/';
  return '/repos/';
}

function getCurrentPath() {
  if (typeof window === 'undefined') return '/repos/';
  const hash = window.location.hash || '';
  if (hash.startsWith('#!/')) return normalizePath(hash.slice(2));
  return normalizePath(window.location.pathname || '/');
}

function pushPath(path: string, replace = false): string {
  const raw = String(path || '');
  const queryIndex = raw.indexOf('?');
  const search = queryIndex >= 0 ? raw.slice(queryIndex) : '';
  const target = `${normalizePath(raw)}${search}`;
  if (typeof window === 'undefined') return target;
  if (replace) window.history.replaceState({}, '', target);
  else window.history.pushState({}, '', target);
  return target;
}

function getCurrentSearch(): string {
  if (typeof window === 'undefined') return '';
  return String(window.location.search || '');
}

function extractSearch(rawPath: string): string {
  const queryIndex = String(rawPath || '').indexOf('?');
  return queryIndex >= 0 ? String(rawPath || '').slice(queryIndex) : '';
}

function getCurrentFileParams(): { path: string; line: number | null; jumpToFirstDiff: boolean } {
  if (typeof window === 'undefined') return { path: '', line: null, jumpToFirstDiff: false };
  const params = new URLSearchParams(window.location.search || '');
  const filePath = String(params.get('path') || '').trim();
  const lineRaw = Number(params.get('line') || '');
  return {
    path: filePath,
    line: Number.isInteger(lineRaw) && lineRaw > 0 ? lineRaw : null,
    jumpToFirstDiff: params.get('jump') === 'first-diff'
  };
}

function buildFileViewPath(filePath: string, line: number | null = null, jumpToFirstDiff = false): string {
  const params = new URLSearchParams();
  params.set('path', filePath);
  if (line && line > 0) params.set('line', String(line));
  if (jumpToFirstDiff && !(line && line > 0)) params.set('jump', 'first-diff');
  return `/files/view/?${params.toString()}`;
}

function parseLineAnchor(rawHref: string): { path: string; line: number | null } {
  const href = String(rawHref || '').trim();
  let pathPart = href;
  let line: number | null = null;

  const hashIndex = href.indexOf('#');
  if (hashIndex >= 0) {
    pathPart = href.slice(0, hashIndex);
    const hash = href.slice(hashIndex + 1);
    const lineMatch = hash.match(/^L(\d+)/i);
    if (lineMatch) line = Number(lineMatch[1]);
  }

  if (!line) {
    const colonMatch = pathPart.match(/:(\d+)(?::\d+)?$/);
    if (colonMatch) {
      line = Number(colonMatch[1]);
      pathPart = pathPart.slice(0, colonMatch.index);
    }
  }

  return { path: pathPart, line: Number.isInteger(line) && line > 0 ? line : null };
}

function resolveRepoRelativeFilePath(rawHref: string, repoPath: string): { path: string; line: number | null } | null {
  const parsed = parseLineAnchor(rawHref);
  const hrefPath = String(parsed.path || '').trim();
  if (!hrefPath) return null;
  if (/^(https?:|mailto:|tel:)/i.test(hrefPath)) return null;

  let absolutePath = '';
  if (hrefPath.startsWith('file://')) {
    try {
      absolutePath = decodeURIComponent(new URL(hrefPath).pathname || '');
    } catch {
      return null;
    }
  } else if (hrefPath.startsWith('/')) {
    absolutePath = hrefPath;
  } else {
    absolutePath = `${repoPath.replace(/[\\/]+$/, '')}/${hrefPath}`;
  }

  const normalizedRepo = repoPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedAbsolute = absolutePath.replace(/\\/g, '/');
  if (normalizedAbsolute === normalizedRepo || !normalizedAbsolute.startsWith(`${normalizedRepo}/`)) return null;

  return {
    path: normalizedAbsolute.slice(normalizedRepo.length + 1),
    line: parsed.line
  };
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
              <div className="fx-repos-search-row">
                <Button
                  className="fx-repo-create-nav-btn"
                  type="button"
                  onClick={() => navigate('/repos/new/')}
                  aria-label="新規リポジトリ作成"
                  title="新規リポジトリ作成"
                >
                  ＋
                </Button>
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
              </div>
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

function NewRepoPage() {
  const { connected, busy, navigate, createRepo, fetchRepos } = useAppCtx();
  const [repoName, setRepoName] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'private'>('private');
  const [errorText, setErrorText] = useState('');

  async function handleCreate(): Promise<void> {
    const normalizedName = repoName.trim();
    if (!normalizedName) {
      setErrorText('リポジトリ名を入力してください');
      return;
    }

    setErrorText('');
    try {
      const created = await createRepo(normalizedName, visibility);
      await fetchRepos('');
      f7.toast.create({ text: `作成しました: ${created.fullName}`, closeTimeout: 1600, position: 'center' }).open();
      navigate('/repos/');
    } catch (error: unknown) {
      setErrorText(getClientErrorMessage(error));
    }
  }

  return (
    <Page noNavbar>
      <PageContent className="fx-page fx-page-repos">
        <section className="fx-repo-create-shell">
          <div className="fx-repo-create-card">
            <div className="fx-repo-create-header">
              <Button tonal className="fx-repo-create-back" onClick={() => navigate('/repos/')}>
                ←
              </Button>
              <div>
                <div className="fx-repo-create-title">新規リポジトリ作成</div>
                <div className="fx-mini">リポジトリ名と公開設定を指定します</div>
              </div>
            </div>

            <label className="fx-repo-create-field">
              <span className="fx-repo-create-label">リポジトリ名</span>
              <input
                value={repoName}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setRepoName(e.currentTarget.value)}
                placeholder="example-repo"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                data-testid="repo-create-name-input"
              />
            </label>

            <div className="fx-repo-create-field">
              <span className="fx-repo-create-label">公開設定</span>
              <div className="fx-repo-create-visibility">
                <button
                  type="button"
                  className={`fx-visibility-option${visibility === 'private' ? ' is-selected' : ''}`}
                  onClick={() => setVisibility('private')}
                  data-testid="repo-create-private"
                >
                  Private
                </button>
                <button
                  type="button"
                  className={`fx-visibility-option${visibility === 'public' ? ' is-selected' : ''}`}
                  onClick={() => setVisibility('public')}
                  data-testid="repo-create-public"
                >
                  Public
                </button>
              </div>
            </div>

            {!connected ? <p className="fx-mini">GitHub接続を確認中です</p> : null}
            {errorText ? <div className="fx-repo-create-error">{errorText}</div> : null}

            <div className="fx-repo-create-actions">
              <Button tonal onClick={() => navigate('/repos/')} disabled={busy}>
                キャンセル
              </Button>
              <Button
                fill
                onClick={() => void handleCreate()}
                disabled={busy || !connected || repoName.trim().length === 0}
                data-testid="repo-create-submit"
              >
                作成
              </Button>
            </div>
          </div>
        </section>
      </PageContent>
    </Page>
  );
}

function formatChangeKindLabel(kind: RepoFileListItem['changeKind'] | RepoFileViewResponse['changeKind']): string {
  switch (kind) {
    case 'added':
    case 'untracked':
      return '追加';
    case 'deleted':
      return '削除';
    case 'renamed':
      return '移動';
    case 'conflicted':
      return '競合';
    case 'ignored':
      return '除外';
    case 'unchanged':
      return '差分なし';
    default:
      return '変更';
  }
}

interface RepoFileTreeNode {
  name: string;
  path: string;
  type: 'directory' | 'file';
  hasDiff: boolean;
  changeKind: RepoFileListItem['changeKind'];
  additions: number;
  deletions: number;
  children: RepoFileTreeNode[];
  item: RepoFileListItem | null;
}

function getTreeTone(kind: RepoFileListItem['changeKind']): 'deleted' | 'added' | 'modified' | 'ignored' | 'normal' {
  switch (kind) {
    case 'deleted':
    case 'conflicted':
      return 'deleted';
    case 'added':
    case 'untracked':
      return 'added';
    case 'modified':
    case 'renamed':
      return 'modified';
    case 'ignored':
      return 'ignored';
    default:
      return 'normal';
  }
}

function getTreePriority(kind: RepoFileListItem['changeKind']): number {
  switch (kind) {
    case 'deleted':
    case 'conflicted':
      return 5;
    case 'added':
    case 'untracked':
      return 4;
    case 'modified':
    case 'renamed':
      return 3;
    case 'ignored':
      return 2;
    default:
      return 1;
  }
}

function buildRepoFileTree(items: RepoFileListItem[]): RepoFileTreeNode[] {
  const roots = new Map<string, RepoFileTreeNode>();

  function ensureDirectory(
    container: Map<string, RepoFileTreeNode>,
    name: string,
    path: string
  ): RepoFileTreeNode {
    const existing = container.get(name);
    if (existing) return existing;
    const node: RepoFileTreeNode = {
      name,
      path,
      type: 'directory',
      hasDiff: false,
      changeKind: 'unchanged',
      additions: 0,
      deletions: 0,
      children: [],
      item: null
    };
    container.set(name, node);
    return node;
  }

  for (const item of items) {
    const isDirectoryItem = item.path.endsWith('/');
    const normalizedPath = isDirectoryItem ? item.path.replace(/\/+$/, '') : item.path;
    const parts = normalizedPath.split('/').filter(Boolean);
    if (parts.length === 0) continue;
    let currentMap = roots;
    let currentPath = '';
    let parent: RepoFileTreeNode | null = null;

    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index];
      currentPath = currentPath ? `${currentPath}/${name}` : name;
      const isTerminal = index === parts.length - 1;
      const isFile = isTerminal && !isDirectoryItem;
      if (isFile) {
        const fileNode: RepoFileTreeNode = {
          name,
          path: normalizedPath,
          type: 'file',
          hasDiff: item.hasDiff,
          changeKind: item.changeKind,
          additions: item.additions,
          deletions: item.deletions,
          children: [],
          item
        };
        if (parent) parent.children.push(fileNode);
        else roots.set(name, fileNode);
        continue;
      }
      const dirNode = ensureDirectory(currentMap, name, currentPath);
      if (isTerminal && isDirectoryItem) {
        dirNode.item = item;
        dirNode.changeKind = item.changeKind;
        dirNode.additions = item.additions;
        dirNode.deletions = item.deletions;
      }
      if (parent && !parent.children.includes(dirNode)) parent.children.push(dirNode);
      parent = dirNode;
      const nextMap = new Map<string, RepoFileTreeNode>();
      for (const child of dirNode.children.filter((child) => child.type === 'directory')) {
        nextMap.set(child.name, child);
      }
      currentMap = nextMap;
    }
  }

  function finalize(nodes: RepoFileTreeNode[]): RepoFileTreeNode[] {
    for (const node of nodes) {
      if (node.type === 'directory') {
        node.children = finalize(node.children);
        node.hasDiff = Boolean(node.item?.hasDiff) || node.children.some((child) => child.hasDiff);
        node.additions = (node.item?.additions || 0) + node.children.reduce((sum, child) => sum + child.additions, 0);
        node.deletions = (node.item?.deletions || 0) + node.children.reduce((sum, child) => sum + child.deletions, 0);
        const strongestNode = [
          ...(node.item ? [{ changeKind: node.item.changeKind }] : []),
          ...node.children
        ].sort((a, b) => getTreePriority(b.changeKind) - getTreePriority(a.changeKind))[0];
        node.changeKind = strongestNode?.changeKind || 'unchanged';
      }
    }
    return [...nodes].sort((a, b) => {
      if (a.hasDiff !== b.hasDiff) return a.hasDiff ? -1 : 1;
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  return finalize(Array.from(roots.values()));
}

function formatNumstatParts(additions: number, deletions: number): Array<{ label: string; tone: 'plus' | 'minus' }> {
  const parts: Array<{ label: string; tone: 'plus' | 'minus' }> = [];
  if (additions > 0) parts.push({ label: `+${additions}`, tone: 'plus' });
  if (deletions > 0) parts.push({ label: `-${deletions}`, tone: 'minus' });
  return parts;
}

function renderRepoFileTree(
  nodes: RepoFileTreeNode[],
  openRepoFile: (filePath: string, line?: number | null, replace?: boolean, jumpToFirstDiff?: boolean) => Promise<void>,
  depth = 0
): JSX.Element[] {
  return nodes.map((node) => {
    if (node.type === 'directory') {
      return (
        <details
          key={node.path}
          className={`fx-file-tree-group is-${getTreeTone(node.changeKind)}`}
          open={node.hasDiff}
          data-testid={`file-tree-${node.path.replace(/[^a-zA-Z0-9_-]/g, '_')}`}
        >
          <summary className="fx-file-tree-summary" data-testid={`file-tree-label-${node.path.replace(/[^a-zA-Z0-9_-]/g, '_')}`}>
            <span className="fx-file-tree-caret" aria-hidden="true">
              ▾
            </span>
            <span className={`fx-file-tree-label is-${getTreeTone(node.changeKind)}`} style={{ paddingLeft: `${depth * 0.9}rem` }}>
              {node.name}
            </span>
          </summary>
          <div className="fx-file-tree-children">{renderRepoFileTree(node.children, openRepoFile, depth + 1)}</div>
        </details>
      );
    }

    const numstatParts = formatNumstatParts(node.additions, node.deletions);

    return (
      <button
        key={node.path}
        type="button"
        className={`fx-file-row is-${getTreeTone(node.changeKind)}`}
        onClick={() => openRepoFile(node.path)}
        data-testid={`file-row-${node.path.replace(/[^a-zA-Z0-9_-]/g, '_')}`}
      >
        <div className="fx-file-row-main">
          <span
            className={`fx-file-row-path is-${getTreeTone(node.changeKind)}`}
            style={{ paddingLeft: `${depth * 0.9}rem` }}
            data-testid={`file-row-label-${node.path.replace(/[^a-zA-Z0-9_-]/g, '_')}`}
          >
            {node.name}
          </span>
          {numstatParts.length > 0 ? (
            <span className="fx-file-row-stats" data-testid={`file-row-stats-${node.path.replace(/[^a-zA-Z0-9_-]/g, '_')}`}>
              {numstatParts.map((part) => (
                <span key={`${node.path}:${part.label}`} className={`fx-file-row-stat is-${part.tone}`}>
                  {part.label}
                </span>
              ))}
            </span>
          ) : null}
        </div>
      </button>
    );
  });
}

type FileRenderLineKind = 'context' | 'added' | 'removed';

const FILE_VIEW_VIRTUAL_LINE_HEIGHT_PX = 26;
const FILE_VIEW_VIRTUAL_OVERSCAN = 24;
const FILE_VIEW_VIRTUALIZE_THRESHOLD = 300;
const FILE_VIEW_DIFF_JUMP_TOP_OFFSET_PX = 8;

interface FileRenderLine {
  key: string;
  kind: FileRenderLineKind;
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

function splitFileContentLines(content: string): string[] {
  const lines = String(content || '').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function parseUnifiedHunks(diffText: string): Array<{ oldStart: number; newStart: number; lines: string[] }> {
  const rawLines = String(diffText || '').split('\n');
  const hunks: Array<{ oldStart: number; newStart: number; lines: string[] }> = [];
  let current: { oldStart: number; newStart: number; lines: string[] } | null = null;

  for (const rawLine of rawLines) {
    const line = String(rawLine || '');
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      if (current) hunks.push(current);
      current = {
        oldStart: Number(hunkMatch[1]),
        newStart: Number(hunkMatch[2]),
        lines: []
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('\\ No newline at end of file')) continue;
    current.lines.push(line);
  }

  if (current) hunks.push(current);
  return hunks;
}

function buildFileRenderLines(content: string, diffText: string): FileRenderLine[] {
  const contentLines = splitFileContentLines(content);
  if (!diffText.trim()) {
    return contentLines.map((line, index) => ({
      key: `ctx:${index + 1}`,
      kind: 'context',
      oldLine: index + 1,
      newLine: index + 1,
      text: line
    }));
  }

  const hunks = parseUnifiedHunks(diffText);
  if (hunks.length === 0) {
    return contentLines.map((line, index) => ({
      key: `ctx:${index + 1}`,
      kind: 'context',
      oldLine: index + 1,
      newLine: index + 1,
      text: line
    }));
  }

  const out: FileRenderLine[] = [];
  let contentIndex = 1;

  for (const hunk of hunks) {
    while (contentIndex < hunk.newStart && contentIndex <= contentLines.length) {
      const text = contentLines[contentIndex - 1] ?? '';
      out.push({
        key: `ctx:${contentIndex}`,
        kind: 'context',
        oldLine: contentIndex,
        newLine: contentIndex,
        text
      });
      contentIndex += 1;
    }

    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const line of hunk.lines) {
      const prefix = line[0] || ' ';
      const text = line.slice(1);
      if (prefix === '+') {
        out.push({
          key: `add:${newLine}:${text}`,
          kind: 'added',
          oldLine: null,
          newLine,
          text
        });
        newLine += 1;
        contentIndex += 1;
        continue;
      }
      if (prefix === '-') {
        out.push({
          key: `del:${oldLine}:${text}`,
          kind: 'removed',
          oldLine,
          newLine: null,
          text
        });
        oldLine += 1;
        continue;
      }
      out.push({
        key: `ctx:${newLine}:${text}`,
        kind: 'context',
        oldLine,
        newLine,
        text
      });
      oldLine += 1;
      newLine += 1;
      contentIndex += 1;
    }
  }

  while (contentIndex <= contentLines.length) {
    const text = contentLines[contentIndex - 1] ?? '';
    out.push({
      key: `ctx:${contentIndex}`,
      kind: 'context',
      oldLine: contentIndex,
      newLine: contentIndex,
      text
    });
    contentIndex += 1;
  }

  return out;
}

function findVirtualLineIndex(offsets: number[], targetOffset: number): number {
  if (offsets.length <= 1) return 0;
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (offsets[mid] <= targetOffset) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return Math.max(0, Math.min(offsets.length - 2, low - 1));
}

function FilesPage() {
  const { activeRepoFullName, fileListIncludeUnchanged, setFileListIncludeUnchanged, openRepoFile, navigate } = useAppCtx();
  const treeState = useFileTreeState({
    repoFullName: activeRepoFullName,
    includeUnchanged: fileListIncludeUnchanged
  });
  const { rootItems, rootLoading, rootError } = treeState;

  return (
    <Page noNavbar>
      <PageContent className="fx-page fx-page-files">
        <div className="fx-chat-head">
          <button
            className="fx-back-icon"
            type="button"
            onClick={() => navigate('/chat/')}
            data-testid="files-back-button"
          >
            ←
          </button>
          <div className="fx-files-title">ファイル一覧</div>
        </div>
        <div className="fx-files-toolbar">
          <label className="fx-files-toggle" htmlFor="files-include-unchanged" data-testid="files-include-unchanged-toggle">
            <input
              id="files-include-unchanged"
              type="checkbox"
              checked={fileListIncludeUnchanged}
              onChange={(e) => setFileListIncludeUnchanged(e.currentTarget.checked)}
            />
            <span>変更差分なしも表示</span>
          </label>
          <div className="fx-files-toolbar-repo">{activeRepoFullName || 'リポジトリ未選択'}</div>
        </div>
        <div className="fx-files-list" data-testid="files-list">
          {rootLoading ? <p className="fx-mini">ファイル一覧を読み込み中...</p> : null}
          {rootError ? <p className="fx-mini">読み込み失敗: {rootError}</p> : null}
          {!rootLoading && !rootError && rootItems.length === 0 ? <p className="fx-mini">表示できるファイルがありません。</p> : null}
          {!rootLoading && !rootError
            ? rootItems.map((node) => (
                <FileTreeNode key={node.path} node={node} depth={0} treeState={treeState} openRepoFile={openRepoFile} />
              ))
            : null}
        </div>
      </PageContent>
    </Page>
  );
}

function FileViewPage() {
  const { selectedFileView, selectedFileViewLoading, selectedFileViewError, fileListItems, openRepoFile, returnFromFileView } = useAppCtx();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const lastJumpKeyRef = useRef('');
  const pendingVirtualJumpIndexRef = useRef<number | null>(null);
  const pendingVirtualJumpKeyRef = useRef('');
  const pendingVirtualJumpAlignRef = useRef<'top' | 'center' | null>(null);
  const virtualLineHeightsRef = useRef<Record<number, number>>({});
  const virtualLineObserverCleanupRef = useRef<Map<number, () => void>>(new Map());
  const params = getCurrentFileParams();
  const diffItems = fileListItems.filter((item) => item.hasDiff);
  const currentPath = selectedFileView?.path || params.path;
  const currentDiffIndex = diffItems.findIndex((item) => item.path === currentPath);
  const previousDiffPath =
    currentDiffIndex >= 0
      ? diffItems[(currentDiffIndex - 1 + diffItems.length) % diffItems.length]?.path || null
      : diffItems[diffItems.length - 1]?.path || null;
  const nextDiffPath =
    currentDiffIndex >= 0 ? diffItems[(currentDiffIndex + 1) % diffItems.length]?.path || null : diffItems[0]?.path || null;
  const renderLines = useMemo(
    () => buildFileRenderLines(selectedFileView?.content || '', selectedFileView?.diff || ''),
    [selectedFileView?.content, selectedFileView?.diff]
  );
  const [contentScrollTop, setContentScrollTop] = useState(0);
  const [contentViewportHeight, setContentViewportHeight] = useState(0);
  const [virtualMetricsVersion, setVirtualMetricsVersion] = useState(0);
  const fileTitle = currentPath ? currentPath.split('/').filter(Boolean).pop() || currentPath : 'ファイル未選択';
  const canPreviewImage = Boolean(selectedFileView?.imageDataUrl && selectedFileView?.mimeType?.startsWith('image/'));
  const canVirtualizeLines = Boolean(
    selectedFileView &&
      !selectedFileView.isDeleted &&
      !canPreviewImage &&
      !selectedFileView.isBinary &&
      renderLines.length > FILE_VIEW_VIRTUALIZE_THRESHOLD
  );
  const setVirtualLineHeight = useCallback((index: number, nextHeight: number) => {
    if (!Number.isFinite(nextHeight) || nextHeight <= 0) return;
    const normalizedHeight = Math.max(FILE_VIEW_VIRTUAL_LINE_HEIGHT_PX, Math.ceil(nextHeight));
    const currentHeight = virtualLineHeightsRef.current[index];
    if (currentHeight && Math.abs(currentHeight - normalizedHeight) < 1) return;
    virtualLineHeightsRef.current[index] = normalizedHeight;
    setVirtualMetricsVersion((value) => value + 1);
  }, []);
  const bindVirtualLineNode = useCallback(
    (index: number, node: HTMLDivElement | null) => {
      const cleanupMap = virtualLineObserverCleanupRef.current;
      cleanupMap.get(index)?.();
      cleanupMap.delete(index);
      if (!canVirtualizeLines || !node) return;
      const measure = () => setVirtualLineHeight(index, node.getBoundingClientRect().height);
      measure();
      if (typeof ResizeObserver !== 'function') return;
      const observer = new ResizeObserver(() => measure());
      observer.observe(node);
      cleanupMap.set(index, () => observer.disconnect());
    },
    [canVirtualizeLines, setVirtualLineHeight]
  );
  const virtualLineHeights = useMemo(() => {
    if (!canVirtualizeLines) return [] as number[];
    return renderLines.map((_, index) => virtualLineHeightsRef.current[index] || FILE_VIEW_VIRTUAL_LINE_HEIGHT_PX);
  }, [canVirtualizeLines, renderLines, virtualMetricsVersion]);
  const virtualLineOffsets = useMemo(() => {
    if (!canVirtualizeLines) return [0];
    const offsets = [0];
    for (const height of virtualLineHeights) {
      offsets.push(offsets[offsets.length - 1] + height);
    }
    return offsets;
  }, [canVirtualizeLines, virtualLineHeights]);
  const virtualRange = useMemo(() => {
    if (!canVirtualizeLines) {
      return { start: 0, end: renderLines.length };
    }
    const pendingJumpIndex = pendingVirtualJumpIndexRef.current;
    if (pendingJumpIndex != null) {
      return {
        start: Math.max(0, pendingJumpIndex - FILE_VIEW_VIRTUAL_OVERSCAN),
        end: Math.min(renderLines.length, pendingJumpIndex + FILE_VIEW_VIRTUAL_OVERSCAN + 1)
      };
    }
    const viewportHeight = Math.max(contentViewportHeight, FILE_VIEW_VIRTUAL_LINE_HEIGHT_PX);
    const overscanHeight = FILE_VIEW_VIRTUAL_OVERSCAN * FILE_VIEW_VIRTUAL_LINE_HEIGHT_PX;
    const start = findVirtualLineIndex(virtualLineOffsets, Math.max(0, contentScrollTop - overscanHeight));
    const end = Math.min(
      renderLines.length,
      findVirtualLineIndex(virtualLineOffsets, contentScrollTop + viewportHeight + overscanHeight) + 1
    );
    return { start, end };
  }, [canVirtualizeLines, contentScrollTop, contentViewportHeight, renderLines.length, virtualLineOffsets]);
  const visibleRenderLines = useMemo(() => renderLines.slice(virtualRange.start, virtualRange.end), [renderLines, virtualRange.end, virtualRange.start]);
  const topSpacerHeight = canVirtualizeLines ? virtualLineOffsets[virtualRange.start] || 0 : 0;
  const bottomSpacerHeight = canVirtualizeLines
    ? Math.max(0, (virtualLineOffsets[renderLines.length] || 0) - (virtualLineOffsets[virtualRange.end] || 0))
    : 0;
  const diffJumpBottomSpacerHeight =
    params.jumpToFirstDiff || pendingVirtualJumpAlignRef.current === 'top'
      ? Math.max(0, contentViewportHeight - FILE_VIEW_VIRTUAL_LINE_HEIGHT_PX)
      : 0;

  useLayoutEffect(() => {
    if (!contentRef.current) return;
    const measure = () => {
      if (!contentRef.current) return;
      setContentViewportHeight(contentRef.current.clientHeight);
      setContentScrollTop(contentRef.current.scrollTop);
    };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(contentRef.current);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [selectedFileView?.path]);

  useEffect(() => {
    virtualLineObserverCleanupRef.current.forEach((cleanup) => cleanup());
    virtualLineObserverCleanupRef.current.clear();
    virtualLineHeightsRef.current = {};
    pendingVirtualJumpIndexRef.current = null;
    pendingVirtualJumpKeyRef.current = '';
    pendingVirtualJumpAlignRef.current = null;
    setVirtualMetricsVersion((value) => value + 1);
  }, [selectedFileView?.path]);

  useEffect(() => {
    if (!contentRef.current || !selectedFileView?.path) return;
    const shouldJumpToFirstDiff = !params.line && params.jumpToFirstDiff;
    const firstDiffIndex = shouldJumpToFirstDiff ? renderLines.findIndex((line) => line.kind !== 'context') : -1;
    const targetLineNumber = shouldJumpToFirstDiff
      ? firstDiffIndex >= 0
        ? renderLines[firstDiffIndex]?.newLine ?? renderLines[firstDiffIndex]?.oldLine ?? null
        : null
      : params.line;
    if (!targetLineNumber) return;
    const jumpKey = `${selectedFileView.path}:${shouldJumpToFirstDiff ? `first-diff:${firstDiffIndex}` : `line:${targetLineNumber}`}`;
    if (lastJumpKeyRef.current === jumpKey) return;
    const targetIndex = shouldJumpToFirstDiff
      ? firstDiffIndex
      : renderLines.findIndex((line) => line.newLine === targetLineNumber || line.oldLine === targetLineNumber);
    if (targetIndex < 0) return;
    const container = contentRef.current;
    if (!canVirtualizeLines) {
      pendingVirtualJumpIndexRef.current = null;
      pendingVirtualJumpKeyRef.current = '';
      pendingVirtualJumpAlignRef.current = null;
      let rafId = 0;
      const applyNonVirtualJump = () => {
        const targetNode = shouldJumpToFirstDiff
          ? container.querySelector('.fx-file-line.is-removed, .fx-file-line.is-added')
          : container.querySelector(`[data-file-render-index="${targetIndex}"]`);
        if (!(targetNode instanceof HTMLElement)) return false;
        const containerRect = container.getBoundingClientRect();
        const targetRect = targetNode.getBoundingClientRect();
        const targetAbsoluteTop = container.scrollTop + (targetRect.top - containerRect.top);
        const targetTop = shouldJumpToFirstDiff
          ? Math.max(0, targetAbsoluteTop - FILE_VIEW_DIFF_JUMP_TOP_OFFSET_PX)
          : Math.max(0, targetAbsoluteTop - Math.max(0, Math.floor((container.clientHeight - targetNode.offsetHeight) / 2)));
        container.scrollTop = targetTop;
        setContentScrollTop(targetTop);
        return true;
      };
      if (applyNonVirtualJump()) {
        lastJumpKeyRef.current = jumpKey;
        rafId = window.requestAnimationFrame(() => {
          applyNonVirtualJump();
        });
      }
      return () => {
        if (rafId) window.cancelAnimationFrame(rafId);
      };
    }
    if (canVirtualizeLines) {
      const targetHeight = virtualLineHeights[targetIndex] || FILE_VIEW_VIRTUAL_LINE_HEIGHT_PX;
      const targetOffset = virtualLineOffsets[targetIndex] || 0;
      const targetTop = shouldJumpToFirstDiff
        ? Math.max(0, targetOffset - FILE_VIEW_DIFF_JUMP_TOP_OFFSET_PX)
        : Math.max(0, targetOffset - Math.max(0, Math.floor((container.clientHeight - targetHeight) / 2)));
      container.scrollTop = targetTop;
      setContentScrollTop(targetTop);
      pendingVirtualJumpIndexRef.current = targetIndex;
      pendingVirtualJumpKeyRef.current = jumpKey;
      pendingVirtualJumpAlignRef.current = shouldJumpToFirstDiff ? 'top' : 'center';
      lastJumpKeyRef.current = jumpKey;
      return;
    }
  }, [canVirtualizeLines, params.jumpToFirstDiff, params.line, renderLines, selectedFileView?.path, virtualLineHeights, virtualLineOffsets]);

  useLayoutEffect(() => {
    if (!canVirtualizeLines || !contentRef.current) return;
    const targetIndex = pendingVirtualJumpIndexRef.current;
    const targetKey = pendingVirtualJumpKeyRef.current;
    const jumpAlign = pendingVirtualJumpAlignRef.current;
    if (targetIndex == null || !targetKey || targetKey !== lastJumpKeyRef.current) return;
    if (targetIndex < virtualRange.start || targetIndex >= virtualRange.end) return;
    const targetNode = contentRef.current.querySelector(`[data-file-render-index="${targetIndex}"]`);
    if (!(targetNode instanceof HTMLElement)) return;
    const container = contentRef.current;
    const containerRect = container.getBoundingClientRect();
    const targetRect = targetNode.getBoundingClientRect();
    const targetAbsoluteTop = container.scrollTop + (targetRect.top - containerRect.top);
    const correctedTop =
      jumpAlign === 'top'
        ? Math.max(0, targetAbsoluteTop - FILE_VIEW_DIFF_JUMP_TOP_OFFSET_PX)
        : Math.max(0, targetAbsoluteTop - Math.max(0, Math.floor((container.clientHeight - targetNode.offsetHeight) / 2)));
    if (Math.abs(container.scrollTop - correctedTop) > 1) {
      container.scrollTop = correctedTop;
      setContentScrollTop(correctedTop);
    }
    pendingVirtualJumpIndexRef.current = null;
    pendingVirtualJumpKeyRef.current = '';
    pendingVirtualJumpAlignRef.current = null;
  }, [canVirtualizeLines, virtualRange.end, virtualRange.start, virtualMetricsVersion]);

  useEffect(() => {
    if (params.line || params.jumpToFirstDiff) return;
    lastJumpKeyRef.current = '';
    pendingVirtualJumpIndexRef.current = null;
    pendingVirtualJumpKeyRef.current = '';
    pendingVirtualJumpAlignRef.current = null;
  }, [params.jumpToFirstDiff, params.line, selectedFileView?.path]);

  return (
    <Page noNavbar>
      <PageContent className="fx-page fx-page-file-view">
        <div className="fx-chat-head">
          <button
            className="fx-back-icon"
            type="button"
            onClick={returnFromFileView}
            data-testid="file-view-back-button"
          >
            ←
          </button>
          <div className="fx-files-title" data-testid="file-view-path">{fileTitle}</div>
        </div>
        <div className="fx-file-view-toolbar">
          <div className="fx-file-view-actions">
            <button
              type="button"
              className="fx-file-nav-btn"
              onClick={() => previousDiffPath && openRepoFile(previousDiffPath, null, false, true)}
              disabled={!previousDiffPath}
              data-testid="file-prev-diff-button"
            >
              前の diff
            </button>
            <button
              type="button"
              className="fx-file-nav-btn"
              onClick={() => nextDiffPath && openRepoFile(nextDiffPath, null, false, true)}
              disabled={!nextDiffPath}
              data-testid="file-next-diff-button"
            >
              次の diff
            </button>
          </div>
        </div>
        <div className="fx-file-view-body">
          {selectedFileViewLoading ? <p className="fx-mini">ファイルを読み込み中...</p> : null}
          {selectedFileViewError ? <p className="fx-mini">読み込み失敗: {selectedFileViewError}</p> : null}
          {!selectedFileViewLoading && !selectedFileViewError && selectedFileView ? (
            <section className={`fx-file-panel${canPreviewImage ? ' is-image-preview' : ''}`} data-testid="file-content-panel">
              <div className="fx-file-panel-head">
                {canPreviewImage ? (
                  <>
                    <span>画像</span>
                    <span className={`fx-file-row-chip is-${selectedFileView.changeKind}`}>
                      {formatChangeKindLabel(selectedFileView.changeKind)}
                    </span>
                  </>
                ) : (
                  <>
                    <span>テキスト</span>
                    <span className={`fx-file-row-chip is-${selectedFileView.changeKind}`}>
                      {formatChangeKindLabel(selectedFileView.changeKind)}
                    </span>
                  </>
                )}
              </div>
              {selectedFileView.isDeleted ? (
                <div className="fx-file-empty">このファイルは削除されています。</div>
              ) : canPreviewImage ? (
                <div className="fx-file-image-wrap" data-testid="file-image-panel">
                  <img
                    src={selectedFileView.imageDataUrl}
                    alt={selectedFileView.path}
                    className="fx-file-image"
                    data-testid="file-image-preview"
                  />
                </div>
              ) : selectedFileView.isBinary ? (
                <div className="fx-file-empty">バイナリファイルの本文表示には未対応です。</div>
              ) : (
                <div
                  className={`fx-file-content is-diff-inline${selectedFileView.hasDiff ? '' : ' is-plain'}`}
                  ref={contentRef}
                  data-testid="file-content"
                  onScroll={(event) => setContentScrollTop(event.currentTarget.scrollTop)}
                >
                  {renderLines.length === 0 ? (
                    <div className="fx-file-empty">内容は空です。</div>
                  ) : (
                    <>
                      {topSpacerHeight > 0 ? <div style={{ height: `${topSpacerHeight}px` }} aria-hidden="true" /> : null}
                      {visibleRenderLines.map((line, visibleIndex) => {
                        const actualIndex = virtualRange.start + visibleIndex;
                        const itemKey = `${selectedFileView.path}:${line.key}:${actualIndex}`;
                        const targetLine = params.line ? line.newLine === params.line || line.oldLine === params.line : false;
                        const displayLine = line.newLine || line.oldLine || undefined;
                        if (!selectedFileView.hasDiff) {
                          return (
                            <div
                              key={itemKey}
                              ref={(node) => bindVirtualLineNode(actualIndex, node)}
                              className={`fx-file-line is-${line.kind}${targetLine ? ' is-target' : ''}`}
                              data-file-line={displayLine}
                              data-file-render-index={actualIndex}
                            >
                              <span className="fx-file-line-no">{displayLine ?? ''}</span>
                              <span className="fx-file-line-text">{line.text || ' '}</span>
                            </div>
                          );
                        }
                        return (
                          <div
                            key={itemKey}
                            ref={(node) => bindVirtualLineNode(actualIndex, node)}
                            className={`fx-file-line is-${line.kind}${targetLine ? ' is-target' : ''}`}
                            data-file-line={displayLine}
                            data-file-render-index={actualIndex}
                          >
                            <span className="fx-file-line-no">{line.oldLine ?? ''}</span>
                            <span className="fx-file-line-no">{line.newLine ?? ''}</span>
                            <span className="fx-file-line-text">{line.text || ' '}</span>
                          </div>
                        );
                      })}
                      {bottomSpacerHeight + diffJumpBottomSpacerHeight > 0 ? (
                        <div style={{ height: `${bottomSpacerHeight + diffJumpBottomSpacerHeight}px` }} aria-hidden="true" />
                      ) : null}
                    </>
                  )}
                </div>
              )}
            </section>
          ) : null}
        </div>
      </PageContent>
    </Page>
  );
}

function renderAssistant(item: AssistantOutputItem, pending = false) {
  const answer = typeof item.answer === 'string' ? item.answer : String(item.text || '');
  const statusText = !answer ? String(item.status || item.text || '').trim() : '';
  const assistantHtml = String(marked.parse(answer));

  if (item.type === 'diff') {
    return <pre className="fx-diff">{answer}</pre>;
  }
  if (pending && !answer && !statusText) return null;
  if (statusText === '・・・') return null;
  if (!answer && statusText) return <div className="fx-stream-status">{statusText}</div>;
  if (pending && answer) {
    return (
      <div
        className="fx-assistant-rich fx-message-body-copy fx-stream-live"
        dangerouslySetInnerHTML={{ __html: assistantHtml }}
      />
    );
  }
  return (
    <div
      className="fx-assistant-rich fx-message-body-copy"
      dangerouslySetInnerHTML={{ __html: assistantHtml }}
    />
  );
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
  const EXPANDED_COMPOSER_MAX_HEIGHT = 140;
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
    compactionStatusPhase,
    compactionStatusMessage,
    awaitingFirstStreamChunk,
    hasReasoningStarted,
    hasAnswerStarted,
    sendTurn,
    cancelTurn,
    startNewThread,
    canReturnToPreviousThread,
    returnToPreviousThread,
    goBackToRepoList,
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
    gitStatus,
    gitStatusLoading,
    gitStatusError,
    requestGitCommitPush,
    openRepoFile,
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
  const [composerHeight, setComposerHeight] = useState(0);
  const [keyboardInset, setKeyboardInset] = useState(0);
  const composerRef = useRef<HTMLDivElement | null>(null);
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
  const showCompactionStatus = streaming && Boolean(compactionStatusMessage) && !hideThinkingWhileUserInput;
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
  const gitStatusSummary = gitStatusLoading
    ? 'Git 状態を確認中...'
    : gitStatusError
      ? `Git 状態取得失敗: ${gitStatusError}`
      : gitStatus?.summary || 'Git 状態を確認できません';
  const gitStatusTone = gitStatusError ? 'danger' : gitStatus?.tone || 'neutral';
  const canRequestGitCommitPush = Boolean(
    !busy &&
      !streaming &&
      !gitStatusLoading &&
      !gitStatusError &&
      gitStatus?.actionRecommended
  );
  const canOpenFiles = Boolean(activeRepoFullName);
  const isComposerExpanded = isInputFocused;
  const chatScrollPaddingBottom = Math.max(78, composerHeight + keyboardInset + 12);
  const composerInlineStyle = keyboardInset > 0 ? { bottom: `${keyboardInset}px` } : undefined;

  function handleChatContentClick(event: React.MouseEvent<HTMLElement>): void {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const anchor = target.closest('a');
    if (!(anchor instanceof HTMLAnchorElement)) return;
    const rawHref = String(anchor.getAttribute('href') || '').trim();
    if (!rawHref) return;

    const repoPath = String(gitStatus?.repoPath || '').trim();
    if (repoPath) {
      const localFile = resolveRepoRelativeFilePath(rawHref, repoPath);
      if (localFile?.path) {
        event.preventDefault();
        void openRepoFile(localFile.path, localFile.line);
        return;
      }
    }

    if (/^(https?:|mailto:|tel:)/i.test(rawHref)) {
      event.preventDefault();
      window.open(anchor.href, '_blank', 'noopener,noreferrer');
    }
  }

  function syncComposerLayout(
    target: HTMLTextAreaElement | null = composerInputRef.current,
    options: { expanded?: boolean } = {}
  ): void {
    if (typeof window === 'undefined') return;
    if (!(target instanceof HTMLTextAreaElement)) return;
    const expanded = typeof options.expanded === 'boolean' ? options.expanded : isComposerExpanded;
    const viewportHeight = window.visualViewport?.height || window.innerHeight || 0;
    const minHeight = expanded ? 104 : 36;
    const composerStyles = window.getComputedStyle(target);
    const borderTop = Number.parseFloat(composerStyles.borderTopWidth || '0') || 0;
    const borderBottom = Number.parseFloat(composerStyles.borderBottomWidth || '0') || 0;
    const borderHeight = borderTop + borderBottom;
    const maxHeight = expanded ? EXPANDED_COMPOSER_MAX_HEIGHT : Math.max(120, Math.floor(viewportHeight * 0.18));
    target.style.height = 'auto';
    const nextHeight = Math.max(target.scrollHeight + borderHeight, minHeight);
    const appliedHeight = Math.min(nextHeight, maxHeight);
    target.style.height = `${appliedHeight}px`;
    target.style.overflowY = target.scrollHeight + borderHeight > appliedHeight ? 'auto' : 'hidden';
  }

  function syncComposerMetrics(): void {
    syncComposerLayout(undefined, { expanded: isComposerExpanded });
    const node = composerRef.current;
    if (!(node instanceof HTMLElement)) return;
    const nextHeight = Math.ceil(node.getBoundingClientRect().height);
    setComposerHeight((prev) => (Math.abs(prev - nextHeight) < 1 ? prev : nextHeight));
  }

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
    if (typeof window === 'undefined') return;
    const rafId = window.requestAnimationFrame(syncComposerMetrics);
    return () => window.cancelAnimationFrame(rafId);
  }, [
    message,
    pendingAttachments.length,
    isInputFocused,
    streaming,
    activeUserInputRequest?.requestId,
    activeUserInputQuestion?.id
  ]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const node = composerRef.current;
    if (!(node instanceof HTMLElement) || typeof ResizeObserver === 'undefined') {
      syncComposerMetrics();
      return;
    }
    const observer = new ResizeObserver(() => syncComposerMetrics());
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const viewport = window.visualViewport;
    if (!viewport) return;
    const syncViewportInset = () => {
      // offsetTop は表示領域のパン量であり、キーボード高ではない。
      const nextInset = Math.max(0, Math.round(window.innerHeight - viewport.height));
      setKeyboardInset((prev) => (Math.abs(prev - nextInset) < 1 ? prev : nextInset));
    };
    syncViewportInset();
    viewport.addEventListener('resize', syncViewportInset);
    viewport.addEventListener('scroll', syncViewportInset);
    window.addEventListener('resize', syncViewportInset);
    return () => {
      viewport.removeEventListener('resize', syncViewportInset);
      viewport.removeEventListener('scroll', syncViewportInset);
      window.removeEventListener('resize', syncViewportInset);
    };
  }, []);

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
            onClick={goBackToRepoList}
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
          <button
            className="fx-git-action-icon"
            type="button"
            onClick={requestGitCommitPush}
            disabled={!canRequestGitCommitPush}
            aria-label="Codex にコミットと push を依頼"
            title="Codex にコミットと push を依頼"
            data-testid="git-commit-push-button"
          >
            <svg
              className="fx-git-action-icon-svg"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <path
                d="M6 4.5H16.5L19.5 7.5V19.5H4.5V6A1.5 1.5 0 0 1 6 4.5Z"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M8 4.5V10H15V4.5"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M8 19.5V14.5A1 1 0 0 1 9 13.5H15A1 1 0 0 1 16 14.5V19.5"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M10 16.5H14"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
        <button
          type="button"
          className={`fx-git-status-line is-${gitStatusTone}`}
          data-testid="git-status-line"
          title={gitStatusSummary}
          onClick={() => navigate('/files/')}
          disabled={!canOpenFiles}
        >
          <span className="fx-git-status-dot" aria-hidden="true" />
          <span className="fx-git-status-text">{gitStatusSummary}</span>
          {gitStatus?.branch ? <span className="fx-git-status-branch">{gitStatus.branch}</span> : null}
          <span className="fx-git-status-chevron" aria-hidden="true">
            <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path
                d="M7.5 4.5L12.5 10L7.5 15.5"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        </button>

        <article
          className="fx-chat-scroll"
          ref={outputRef}
          style={{ paddingBottom: `${chatScrollPaddingBottom}px` }}
          onClick={handleChatContentClick}
        >
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
              const showPlanApply = Boolean(planText && canApplyLatestPlan && String(item.id || '') === latestPlanItemId);
              const showAssistantCard = Boolean(assistantMain || planText || showPlanApply);
              return (
                <Fragment key={item.id}>
                  {showAssistantCard ? (
                    <div className="fx-msg fx-msg-assistant">
                      <div className="fx-msg-bubble">
                        {assistantMain}
                        {planText ? (
                          <div className="fx-plan-inline-block" data-testid="plan-inline-block">
                            <div className="fx-plan-bubble-title">プラン</div>
                            <pre className="fx-plan-bubble-content">{planText}</pre>
                          </div>
                        ) : null}
                        {showPlanApply ? (
                          <>
                            <div className="fx-plan-apply-row">
                              <button
                                className="fx-plan-apply-inline-btn"
                                type="button"
                                onClick={applyLatestPlanShortcut}
                                disabled={busy}
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
                      </div>
                    </div>
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
          {showCompactionStatus ? (
            <div
              className={`fx-thinking-live-panel fx-compaction-panel${compactionStatusPhase === 'compacted' ? ' is-completed' : ''}`}
              data-testid="compaction-status-panel"
              aria-live="polite"
            >
              {compactionStatusPhase === 'compacting' ? (
                <div className="fx-working-dots" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
              ) : null}
              <div className="fx-compaction-status-text" data-testid="compaction-status-text">
                {compactionStatusMessage}
              </div>
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
                <div className="fx-chat-settings-label">スレッド</div>
                <div className="fx-chat-settings-current">
                  {canReturnToPreviousThread ? '新規スレッドから前の会話へ戻せます' : 'ここから新規スレッドを開始できます'}
                </div>
                {canReturnToPreviousThread ? (
                  <button
                    className="fx-thread-action-button"
                    type="button"
                    onClick={returnToPreviousThread}
                    disabled={busy}
                    data-testid="return-thread-button"
                  >
                    <svg
                      className="fx-thread-action-icon"
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
                    <span>前のスレッドに戻る</span>
                  </button>
                ) : (
                  <button
                    className="fx-thread-action-button"
                    type="button"
                    onClick={startNewThread}
                    disabled={busy}
                    data-testid="new-thread-button"
                  >
                    <svg
                      className="fx-thread-action-icon"
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
                    <span>新規スレッドを開始</span>
                  </button>
                )}
              </div>
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
                          disabled={busy}
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

        <div
          className="fx-composer"
          ref={composerRef}
          style={composerInlineStyle}
          onPointerDownCapture={keepComposerFocus}
          data-testid="composer"
        >
          {isInputFocused ? (
            <div className="fx-mode-toggle" data-testid="mode-toggle">
              <button
                type="button"
                className={`fx-mode-btn is-default${activeCollaborationMode === 'default' ? ' is-active' : ''}`}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => setActiveCollaborationMode('default')}
                disabled={busy}
                data-testid="mode-default-button"
              >
                通常
              </button>
              <button
                type="button"
                className={`fx-mode-btn is-plan${activeCollaborationMode === 'plan' ? ' is-active' : ''}`}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => setActiveCollaborationMode('plan')}
                disabled={busy}
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
              className={isComposerExpanded ? 'is-expanded' : ''}
              ref={composerInputRef}
              value={message}
              onChange={(e) => {
                setMessage(e.target.value);
                syncComposerLayout(e.target, { expanded: true });
              }}
              rows={1}
              placeholder="指示を入力"
              onFocus={(e) => {
                setIsInputFocused(true);
                syncComposerLayout(e.currentTarget, { expanded: true });
              }}
              onBlur={(e) => {
                handleComposerInputBlur(e);
                const next = e.relatedTarget;
                const shouldStayExpanded = next instanceof HTMLElement && Boolean(next.closest('.fx-mode-toggle'));
                if (typeof window !== 'undefined') {
                  window.requestAnimationFrame(() =>
                    syncComposerLayout(e.currentTarget, { expanded: shouldStayExpanded })
                  );
                }
              }}
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
  const [compactionStatusPhase, setCompactionStatusPhase] = useState<'' | 'compacting' | 'compacted'>('');
  const [compactionStatusMessage, setCompactionStatusMessage] = useState('');
  const [awaitingFirstStreamChunk, setAwaitingFirstStreamChunk] = useState(false);
  const [hasReasoningStarted, setHasReasoningStarted] = useState(false);
  const [hasAnswerStarted, setHasAnswerStarted] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [currentPath, setCurrentPath] = useState(getCurrentPath());
  const [currentSearch, setCurrentSearch] = useState(getCurrentSearch());
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
  const [gitStatus, setGitStatus] = useState<GitRepoStatus | null>(null);
  const [gitStatusLoading, setGitStatusLoading] = useState(false);
  const [gitStatusError, setGitStatusError] = useState('');
  const [fileListItems, setFileListItems] = useState<RepoFileListItem[]>([]);
  const [fileListLoading, setFileListLoading] = useState(false);
  const [fileListError, setFileListError] = useState('');
  const [fileListIncludeUnchanged, setFileListIncludeUnchanged] = useState(false);
  const [selectedFileView, setSelectedFileView] = useState<RepoFileViewResponse | null>(null);
  const [selectedFileViewLoading, setSelectedFileViewLoading] = useState(false);
  const [selectedFileViewError, setSelectedFileViewError] = useState('');
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
  const compactionStatusTimerRef = useRef<number | null>(null);
  const activeRepoRef = useRef<string | null>(activeRepoFullName);
  const fileViewReturnPathRef = useRef<'/files/' | '/chat/'>('/files/');
  const fileViewReturnChatScrollTopRef = useRef<number | null>(null);
  const pendingChatScrollRestoreRef = useRef<number | null>(null);
  const streamingAssistantIdRef = useRef<string | null>(null);
  const activeLiveTurnSeqRef = useRef(0);
  const unboundPendingUserIdsRef = useRef<string[]>([]);
  const pendingUserIdsByTurnRef = useRef<Record<string, string[]>>({});
  const backgroundInterruptedTurnRef = useRef(false);
  const silentStreamAbortRef = useRef(false);
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

  function bindPendingUserIdsToTurn(turnId: string): void {
    const pendingIds = unboundPendingUserIdsRef.current;
    if (!turnId || pendingIds.length === 0) return;
    pendingUserIdsByTurnRef.current[turnId] = [
      ...(pendingUserIdsByTurnRef.current[turnId] || []),
      ...pendingIds
    ];
    unboundPendingUserIdsRef.current = [];
  }

  function trackPendingUserId(userId: string, turnId: string | null = null): void {
    if (!userId) return;
    if (!turnId) {
      unboundPendingUserIdsRef.current = [...unboundPendingUserIdsRef.current, userId];
      return;
    }
    pendingUserIdsByTurnRef.current[turnId] = [
      ...(pendingUserIdsByTurnRef.current[turnId] || []),
      userId
    ];
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
      if (isAssistantItem(item)) return String(item.id || '') || null;
    }
    return null;
  }

  function applyLiveTurnState(
    threadId: string,
    turnId: string,
    items: OutputItem[],
    {
      seq,
      liveReasoningText: nextLiveReasoningText,
      markStreaming
    }: { seq: number; liveReasoningText: string; markStreaming: boolean }
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
      if (includesOtherTurnItems) {
        return normalizedItems;
      }
      const nextBase = prev.filter((item) => {
        const itemId = String(item.id || '');
        if (itemId.startsWith(turnPrefix)) return false;
        if (hasCanonicalUser && pendingIds.includes(itemId)) return false;
        return true;
      });
      return [...nextBase, ...normalizedItems];
    });
    activeLiveTurnSeqRef.current = Math.max(0, Number(seq || 0));
    const nextAssistantId = markStreaming ? getLastAssistantId(normalizedItems) : null;
    setStreamingAssistantTarget(nextAssistantId);
    const hasOutput = hasAssistantContent(normalizedItems);
    setAwaitingFirstStreamChunk(!hasOutput && !String(nextLiveReasoningText || '').trim());
    setHasAnswerStarted(markStreaming && hasOutput);
    setHasReasoningStarted(markStreaming && Boolean(String(nextLiveReasoningText || '').trim()));
    setLiveReasoningText(markStreaming ? String(nextLiveReasoningText || '') : '');
  }

  function handleTurnStateEvent(
    threadId: string,
    evt: TurnStateStreamEvent,
    options: { markStreaming: boolean }
  ): void {
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
    if (resumeStreamAbortRef.current) {
      silentStreamAbortRef.current = true;
      resumeStreamAbortRef.current.abort();
    }
    if (streamAbortRef.current) streamAbortRef.current.abort();

    const threadId = activeThreadRef.current;
    if (threadId) {
      try {
        await fetch('/api/turns/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ thread_id: threadId })
        });
      } catch {
        // 画面遷移を優先する。
      }
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
    setOutputItems((prev) => [
      ...prev,
      {
        id: `system:${Date.now()}`,
        role: 'system',
        type: 'plain',
        text
      }
    ]);
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

  async function fetchGitStatus(repoFullName: string | null = activeRepoRef.current, background = false): Promise<void> {
    if (!repoFullName) {
      setGitStatus(null);
      setGitStatusError('');
      setGitStatusLoading(false);
      return;
    }
    if (!background) setGitStatusLoading(true);
    setGitStatusError('');
    try {
      const res = await fetch(`/api/repos/git-status?repoFullName=${encodeURIComponent(repoFullName)}`);
      const data = (await res.json()) as GitStatusResponse;
      if (!res.ok) throw new Error(data.detail || data.error || 'git_status_failed');
      if (activeRepoRef.current !== repoFullName) return;
      setGitStatus(data);
    } catch (e: unknown) {
      if (activeRepoRef.current !== repoFullName) return;
      setGitStatus(null);
      setGitStatusError(getClientErrorMessage(e, 'git_status_failed'));
    } finally {
      if (activeRepoRef.current === repoFullName) {
        setGitStatusLoading(false);
      }
    }
  }

  async function requestGitCommitPush(): Promise<void> {
    if (!activeRepoFullName) {
      toast('リポジトリが未選択です');
      return;
    }
    if (!gitStatus?.actionRecommended || gitStatusLoading || gitStatusError) return;
    await sendTurnWithOverrides({
      forcedPrompt: 'commit & push',
      forcedCollaborationMode: 'default'
    });
  }

  async function fetchFileList(
    includeUnchanged = fileListIncludeUnchanged,
    repoFullName: string | null = activeRepoRef.current
  ): Promise<void> {
    if (!repoFullName) {
      setFileListItems([]);
      setFileListError('');
      setFileListLoading(false);
      return;
    }
    setFileListLoading(true);
    setFileListError('');
    try {
      const res = await fetch(
        `/api/repos/files?repoFullName=${encodeURIComponent(repoFullName)}&includeUnchanged=${includeUnchanged ? '1' : '0'}`
      );
      const data = (await res.json()) as FileListFetchResponse;
      if (!res.ok) throw new Error(data.detail || data.error || 'repo_files_failed');
      if (activeRepoRef.current !== repoFullName) return;
      setFileListItems(Array.isArray(data.items) ? data.items : []);
    } catch (e: unknown) {
      if (activeRepoRef.current !== repoFullName) return;
      setFileListItems([]);
      setFileListError(getClientErrorMessage(e, 'repo_files_failed'));
    } finally {
      if (activeRepoRef.current === repoFullName) setFileListLoading(false);
    }
  }

  async function fetchFileView(repoFullName: string, filePath: string): Promise<void> {
    if (!repoFullName || !filePath) {
      setSelectedFileView(null);
      setSelectedFileViewError('');
      setSelectedFileViewLoading(false);
      return;
    }
    setSelectedFileViewLoading(true);
    setSelectedFileViewError('');
    try {
      const res = await fetch(
        `/api/repos/file-view?repoFullName=${encodeURIComponent(repoFullName)}&path=${encodeURIComponent(filePath)}`
      );
      const data = (await res.json()) as FileViewFetchResponse;
      if (!res.ok) throw new Error(data.detail || data.error || 'repo_file_view_failed');
      if (activeRepoRef.current !== repoFullName) return;
      setSelectedFileView(data);
    } catch (e: unknown) {
      if (activeRepoRef.current !== repoFullName) return;
      setSelectedFileView(null);
      setSelectedFileViewError(getClientErrorMessage(e, 'repo_file_view_failed'));
    } finally {
      if (activeRepoRef.current === repoFullName) setSelectedFileViewLoading(false);
    }
  }

  async function openRepoFile(filePath: string, line: number | null = null, replace = false, jumpToFirstDiff = false): Promise<void> {
    if (!activeRepoRef.current || !filePath) return;
    if (currentPath !== '/files/view/') {
      if (currentPath === '/chat/') {
        const node = outputRef.current;
        fileViewReturnPathRef.current = '/chat/';
        fileViewReturnChatScrollTopRef.current = node instanceof HTMLElement ? node.scrollTop : 0;
      } else {
        fileViewReturnPathRef.current = '/files/';
        fileViewReturnChatScrollTopRef.current = null;
      }
    }
    navigate(buildFileViewPath(filePath, line, jumpToFirstDiff), replace);
  }

  function returnFromFileView(): void {
    if (fileViewReturnPathRef.current === '/chat/') {
      pendingChatScrollRestoreRef.current = fileViewReturnChatScrollTopRef.current;
      navigate('/chat/');
      return;
    }
    navigate('/files/');
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

  async function fetchLiveTurnState(threadId: string): Promise<LiveTurnStateResponse> {
    const res = await fetch(`/api/turns/live-state?threadId=${encodeURIComponent(threadId)}`);
    const data = (await res.json()) as LiveTurnStateResponse;
    if (!res.ok) throw new Error(data.error || 'live_turn_state_fetch_failed');
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
    if (evt.type === 'status') {
      if (evt.phase === 'compacting' || evt.phase === 'compacted') {
        setCompactionStatus(
          evt.phase,
          String(
            evt.message || (evt.phase === 'compacting' ? '会話履歴を圧縮しています...' : '会話履歴を圧縮しました')
          )
        );
      }
      return;
    }
    if (evt.type === 'reasoning_delta' || evt.type === 'answer_delta' || evt.type === 'plan_delta' || evt.type === 'plan_snapshot') {
      return;
    }
  }

  async function consumeTurnStreamResponse(
    response: Response,
    threadId: string,
    signal: AbortSignal,
    options: { markStreaming: boolean }
  ): Promise<void> {
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
    if (evt.type === 'done') return;
    applyTurnStreamEvent(threadId, evt, options);
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
      const res = await fetch(
        `/api/turns/stream/resume?threadId=${encodeURIComponent(threadId)}&turnId=${encodeURIComponent(turnId)}&afterSeq=${encodeURIComponent(String(afterSeq || 0))}`,
        { signal: controller.signal }
      );
      if (!res.ok) {
        const err = await res.text();
        throw new Error(err || 'resume_stream_failed');
      }

      await consumeTurnStreamResponse(res, threadId, controller.signal, { markStreaming: true });
      restoreOutputForThread(threadId, activeRepoRef.current, { useCache: false }).catch(() => {});
    } catch (e: unknown) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        restoreOutputForThread(threadId, activeRepoRef.current, { useCache: false }).catch(() => {});
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
        silentStreamAbortRef.current = false;
        resetStreamingUiState();
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

  async function createRepo(name: string, visibility: 'public' | 'private'): Promise<RepoSummary> {
    const res = await fetch('/api/github/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, visibility })
    });
    const data = (await res.json()) as JsonErrorResponse & { repo?: RepoSummary; detail?: string };
    if (!res.ok || !data.repo) throw new Error(String(data.detail || data.hint || data.error || 'repo_create_failed'));
    return data.repo;
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

  async function restoreOutputForThread(
    threadId: string,
    repoFullName: string | null = activeRepoRef.current,
    options: { resumeLive?: boolean; useCache?: boolean } = {}
  ): Promise<void> {
    if (!threadId) return;
    activeThreadRef.current = threadId;
    if (options.useCache !== false) {
      const cached = loadThreadMessages(threadId);
      setOutputItems(cached);
    }
    fetchPendingUserInputRequests(threadId).catch(() => {
      // 取得失敗時は既存表示を維持する。
    });

    try {
      const payload = await fetchThreadMessages(threadId);
      if (activeThreadRef.current !== threadId) return;
      setOutputItems(payload.items);
      if (payload.model && repoFullName) setRepoModel(repoFullName, payload.model);
    } catch {
      // API取得に失敗した場合はキャッシュ表示を維持する。
    }

    if (!options.resumeLive) return;
    try {
      await resumeRunningTurn(threadId);
    } catch {
      // live-state 復元に失敗した場合は履歴表示のみ維持する。
    }
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
      restoreOutputForThread(threadId, repo.fullName, { resumeLive: true }).catch(() => {});
      toast('接続しました');
      return true;
    } catch (e: unknown) {
      toast(`接続失敗: ${getClientErrorMessage(e)}`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  function appendUserMessage(
    prompt: string,
    attachments: ImageAttachmentDraft[],
    options: { turnId?: string | null } = {}
  ): string {
    const userId = `u-${Date.now()}`;
    const attachmentMeta: ImageAttachmentMeta[] = attachments.map((att) => ({
      type: 'image',
      name: att.name,
      size: att.size,
      mime: att.mime
    }));
    trackPendingUserId(userId, options.turnId || null);
    setOutputItems((prev) => [...prev, { id: userId, role: 'user', type: 'plain', text: prompt, attachments: attachmentMeta }]);
    return userId;
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

      if (!res.ok) {
        const err = await res.text();
        throw new Error(err || 'send_failed');
      }

      await consumeTurnStreamResponse(res, threadIdToUse, controller.signal, { markStreaming: true });
      restoreOutputForThread(threadIdToUse, repoFullName, { useCache: false }).catch(() => {});
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        if (!backgroundInterruptedTurnRef.current && !silentStreamAbortRef.current) {
          appendStreamErrorMessage('停止', '停止しました');
        }
      } else if (backgroundInterruptedTurnRef.current) {
        // 背景化に伴う中断は再開処理へ委譲する。
      } else {
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
    setBusy(true);
    try {
      if (streaming) await interruptStreamingSilently();
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
    setCurrentPath(normalizePath(next));
    setCurrentSearch(extractSearch(next));
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
      const fallbackTop = Math.max(0, target.offsetTop - container.offsetTop);
      container.scrollTop = fallbackTop;
      diff = Math.abs(target.getBoundingClientRect().top - container.getBoundingClientRect().top);
    }
    return diff < 4;
  }

  useEffect(() => {
    if (didBootstrapRef.current) return;
    didBootstrapRef.current = true;
    f7ready(() => {
      if (window.location.pathname === '/') navigate(chatVisible ? '/chat/' : '/repos/', true);
      else {
        setCurrentPath(getCurrentPath());
        setCurrentSearch(getCurrentSearch());
      }
      bootstrapConnection();
    });
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    ensurePushNotificationsEnabled(activeThreadRef.current).catch(() => {});
  }, []);

  useEffect(() => {
    const onPopState = () => {
      setCurrentPath(getCurrentPath());
      setCurrentSearch(getCurrentSearch());
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if ((currentPath === '/chat/' || currentPath === '/files/' || currentPath === '/files/view/') && !chatVisible && connected) {
      navigate('/repos/', true);
    }
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
    if (!chatVisible || !activeRepoFullName) {
      setGitStatus(null);
      setGitStatusError('');
      setGitStatusLoading(false);
      setFileListItems([]);
      setFileListError('');
      setFileListLoading(false);
      setSelectedFileView(null);
      setSelectedFileViewError('');
      setSelectedFileViewLoading(false);
      return;
    }
    fetchGitStatus(activeRepoFullName).catch(() => {});
    const timer = window.setInterval(() => {
      fetchGitStatus(activeRepoRef.current, true).catch(() => {});
    }, 15000);
    return () => window.clearInterval(timer);
  }, [chatVisible, activeRepoFullName]);

  useEffect(() => {
    if (!chatVisible || !activeRepoFullName) return;
    if (currentPath === '/files/' || currentPath === '/files/view/') {
      fetchFileList(false, activeRepoFullName).catch(() => {});
    }
  }, [chatVisible, activeRepoFullName, currentPath]);

  useEffect(() => {
    if (!chatVisible || !activeRepoFullName || currentPath !== '/files/view/') {
      setSelectedFileView(null);
      setSelectedFileViewError('');
      setSelectedFileViewLoading(false);
      return;
    }
    const params = new URLSearchParams(currentSearch || '');
    const filePath = String(params.get('path') || '').trim();
    if (!filePath) {
      setSelectedFileView(null);
      setSelectedFileViewError('path_missing');
      setSelectedFileViewLoading(false);
      return;
    }
    fetchFileView(activeRepoFullName, filePath).catch(() => {});
  }, [chatVisible, activeRepoFullName, currentPath, currentSearch]);

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

      restoreOutputForThread(threadId, activeRepoRef.current, {
        resumeLive: shouldResumeOnVisibleRef.current
      }).catch(() => {});

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
    if (!streaming || !autoScrollRef.current || !outputRef.current) return;
    outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [outputItems, streaming]);

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
      const done = scrollLastUserMessageToTopOrKeepPosition();
      if (done) {
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
    if (!chatVisible || !activeRepoFullName || streaming) return;
    fetchGitStatus(activeRepoFullName, true).catch(() => {});
    if (currentPath === '/files/' || currentPath === '/files/view/') {
      fetchFileList(false, activeRepoFullName).catch(() => {});
    }
  }, [chatVisible, activeRepoFullName, streaming, currentPath]);

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
    latestPlanText && activeThreadId && activeRepoFullName && activeCollaborationMode === 'plan'
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
    void (async () => {
      if (streaming) await interruptStreamingSilently();
      setActiveThreadId(fallbackThreadId);
      setThreadByRepo((prev) => ({ ...prev, [repoFullName]: fallbackThreadId }));
      restoreOutputForThread(fallbackThreadId, repoFullName, { resumeLive: true }).catch(() => {});
      setPendingThreadReturn(null);
    })();
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
      compactionStatusPhase,
      compactionStatusMessage,
      awaitingFirstStreamChunk,
      hasReasoningStarted,
      hasAnswerStarted,
      navigate,
      bootstrapConnection,
      fetchRepos,
      createRepo,
      startWithRepo,
      sendTurn,
      cancelTurn,
      startNewThread,
      canReturnToPreviousThread,
      returnToPreviousThread,
      goBackToRepoList,
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
      gitStatus,
      gitStatusLoading,
      gitStatusError,
      refreshGitStatus: fetchGitStatus,
      requestGitCommitPush,
      fileListItems,
      fileListLoading,
      fileListError,
      fileListIncludeUnchanged,
      setFileListIncludeUnchanged,
      refreshFileList: fetchFileList,
      selectedFileView,
      selectedFileViewLoading,
      selectedFileViewError,
      openRepoFile,
      returnFromFileView,
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
      compactionStatusPhase,
      compactionStatusMessage,
      awaitingFirstStreamChunk,
      hasReasoningStarted,
      hasAnswerStarted,
      navigate,
      createRepo,
      activeCollaborationMode,
      activeRepoModel,
      canReturnToPreviousThread,
      goBackToRepoList,
      canApplyLatestPlan,
      chatSettingsOpen,
      availableModels,
      modelsLoading,
      modelsError,
      gitStatus,
      gitStatusLoading,
      gitStatusError,
      fileListItems,
      fileListLoading,
      fileListError,
      fileListIncludeUnchanged,
      selectedFileView,
      selectedFileViewLoading,
      selectedFileViewError,
      returnFromFileView,
      pendingUserInputRequests,
      pendingUserInputBusy,
      pendingUserInputDrafts
    ]
  );

  return (
    <App theme="auto">
      <AppCtx.Provider value={ctx}>
        {currentPath === '/chat/' ? (
          <ChatPage />
        ) : currentPath === '/repos/new/' ? (
          <NewRepoPage />
        ) : currentPath === '/files/' ? (
          <FilesPage />
        ) : currentPath === '/files/view/' ? (
          <FileViewPage />
        ) : (
          <ReposPage />
        )}
      </AppCtx.Provider>
    </App>
  );
}
