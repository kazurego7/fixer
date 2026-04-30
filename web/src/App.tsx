import { useEffect, useMemo, useRef, useState } from 'react';
import { App, f7ready, f7 } from 'framework7-react';
import type { AppErrorState, CollaborationMode, PendingThreadReturn, RepoSummary } from '../../shared/types';
import { AppCtx, type RepoFilter } from './appContext';
import {
  COLLABORATION_MODE_BY_REPO_KEY,
  DEFAULT_COLLABORATION_MODE,
  LAST_REPO_FULLNAME_KEY,
  LAST_THREAD_ID_KEY,
  THREAD_BY_REPO_KEY,
  type CollaborationModeByRepoMap,
  type ThreadByRepoMap
} from './appStorage';
import { getClientErrorMessage, loadJsonFromStorage } from './appUtils';
import { extractSearch, getCurrentPath, getCurrentSearch, normalizePath, pushPath } from './navigation';
import { useChatRuntime } from './hooks/useChatRuntime';
import { useRepoBootstrap } from './hooks/useRepoBootstrap';
import { useRepoWorkspace } from './hooks/useRepoWorkspace';
import { ChatPage } from './pages/ChatPage';
import { FilesPage } from './pages/FilesPage';
import { FileViewPage } from './pages/FileViewPage';
import { NewRepoPage } from './pages/NewRepoPage';
import { ReposPage } from './pages/ReposPage';

interface JsonErrorResponse {
  error?: string;
  hint?: string;
  [key: string]: unknown;
}

export default function AppRoot() {
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<AppErrorState | null>(null);

  const [query, setQuery] = useState('');
  const [repos, setRepos] = useState<RepoSummary[]>([]);
  const [repoFilter, setRepoFilter] = useState<RepoFilter>('all');
  const [selectedRepo, setSelectedRepo] = useState<RepoSummary | null>(null);

  const initialThreadId = typeof window !== 'undefined' ? window.localStorage.getItem(LAST_THREAD_ID_KEY) : null;
  const initialRepoFullName = typeof window !== 'undefined' ? window.localStorage.getItem(LAST_REPO_FULLNAME_KEY) : null;
  const [activeThreadId, setActiveThreadId] = useState<string | null>(initialThreadId);
  const [activeRepoFullName, setActiveRepoFullName] = useState<string | null>(initialRepoFullName);
  const [chatVisible, setChatVisible] = useState(Boolean(initialThreadId && initialRepoFullName));

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
  const [pendingThreadReturn, setPendingThreadReturn] = useState<PendingThreadReturn | null>(null);
  const didBootstrapRef = useRef(false);
  const lastPathRef = useRef(getCurrentPath());
  const activeRepoRef = useRef<string | null>(activeRepoFullName);
  const outputRef = useRef<HTMLElement | null>(null);
  const pendingChatScrollRestoreRef = useRef<number | null>(null);
  const setMessageRef = useRef<(value: string) => void>(() => {});
  const getRepoModelRef = useRef<(repoFullName?: string | null) => string>(() => '');
  const setRepoModelRef = useRef<(repoFullName: string | null, modelId: string) => void>(() => {});
  const fetchIssuesRef = useRef<(repoFullName?: string | null) => Promise<void>>(() => Promise.resolve());
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

  useEffect(() => {
    window.localStorage.setItem(COLLABORATION_MODE_BY_REPO_KEY, JSON.stringify(collaborationModeByRepo));
  }, [collaborationModeByRepo]);

  const chatRuntime = useChatRuntime({
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
    getRepoModel: (repoFullName) => getRepoModelRef.current(repoFullName),
    setRepoModel: (repoFullName, modelId) => setRepoModelRef.current(repoFullName, modelId),
    fetchIssues: (repoFullName) => fetchIssuesRef.current(repoFullName),
    toast
  });
  const {
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
    pendingAttachments,
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
  } = chatRuntime;

  const workspace = useRepoWorkspace({
    activeRepoFullName,
    activeThreadId,
    chatVisible,
    currentPath,
    currentSearch,
    streaming,
    activeRepoRef,
    outputRef,
    pendingChatScrollRestoreRef,
    navigate,
    setMessage,
    toast
  });
  const {
    activeRepoModel,
    availableModels,
    badMarkerBusy,
    chatSettingsOpen,
    closeChatSettings,
    closeIssuePanel,
    fetchFileList,
    fetchGitStatus,
    fileListError,
    fileListIncludeUnchanged,
    fileListItems,
    fileListLoading,
    getRepoModel,
    gitStatus,
    gitStatusError,
    gitStatusLoading,
    issueError,
    issueItems,
    issueLoading,
    issuePanelOpen,
    loadAvailableModels,
    markedBadTurnIds,
    markTurnBad,
    modelsError,
    modelsLoading,
    openChatSettings,
    openIssuePanel,
    openRepoFile,
    resolveIssue,
    returnFromFileView,
    selectedFileView,
    selectedFileViewError,
    selectedFileViewLoading,
    setActiveRepoModel,
    setFileListIncludeUnchanged,
    setRepoModel,
    useIssuePrompt
  } = workspace;

  useEffect(() => {
    setMessageRef.current = setMessage;
  }, [setMessage]);
  useEffect(() => {
    getRepoModelRef.current = getRepoModel;
    setRepoModelRef.current = setRepoModel;
    fetchIssuesRef.current = workspace.fetchIssues;
  }, [getRepoModel, setRepoModel, workspace.fetchIssues]);

  const repoBootstrap = useRepoBootstrap({
    query,
    setConnected,
    setError,
    setRepos,
    setSelectedRepo,
    setActiveThreadId,
    setActiveRepoFullName,
    setChatVisible,
    setThreadByRepo,
    setPendingThreadReturn,
    setPendingAttachments,
    fetchReposState: async (nextQuery = query) => {
      const res = await fetch(`/api/github/repos?query=${encodeURIComponent(nextQuery.trim())}`);
      const data = (await res.json()) as JsonErrorResponse & { repos?: RepoSummary[] };
      if (!res.ok) throw new Error(data.hint || data.error || 'repo_load_failed');
      setRepos(Array.isArray(data.repos) ? data.repos : []);
    },
    getRepoModel,
    ensureThread,
    restoreOutputForThread,
    toast,
    getClientErrorMessage: (error) => getClientErrorMessage(error),
    threadByRepo
  });
  const { bootstrapConnection, busy, createRepo, fetchRepos, startWithRepo } = repoBootstrap;

  function toast(text: string): void {
    f7?.toast?.create({ text, closeTimeout: 1400, position: 'center' }).open();
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

  function navigate(path: string, replace = false): void {
    const next = pushPath(path, replace);
    setCurrentPath(normalizePath(next));
    setCurrentSearch(extractSearch(next));
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
    if (!connected) return;
    const prevPath = lastPathRef.current;
    lastPathRef.current = currentPath;
    if (currentPath !== '/repos/' || prevPath === '/repos/') return;
    setSelectedRepo(null);
    fetchRepos(query).catch(() => {});
  }, [currentPath, connected, query]);

  useEffect(() => {
    activeRepoRef.current = activeRepoFullName;
  }, [activeRepoFullName]);

  useEffect(() => {
    window.localStorage.setItem(THREAD_BY_REPO_KEY, JSON.stringify(threadByRepo));
  }, [threadByRepo]);

  const clonedRepos = repos.filter((repo) => repo.cloneState?.status === 'cloned');
  const notClonedRepos = repos.filter((repo) => repo.cloneState?.status !== 'cloned');
  const filteredRepos = repoFilter === 'cloned' ? clonedRepos : repoFilter === 'not_cloned' ? notClonedRepos : repos;

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
      pendingUserInputDrafts,
      issueItems,
      issuePanelOpen,
      issueLoading,
      issueError,
      openIssuePanel,
      closeIssuePanel,
      markTurnBad,
      badMarkerBusy,
      markedBadTurnIds,
      useIssuePrompt,
      resolveIssue
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
      pendingUserInputDrafts,
      issueItems,
      issuePanelOpen,
      issueLoading,
      issueError,
      badMarkerBusy,
      markedBadTurnIds
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
