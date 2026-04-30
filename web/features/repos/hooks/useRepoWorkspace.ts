import { useEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import type {
  CollaborationMode,
  GitRepoStatus,
  IssueItem,
  ModelOption,
  RepoFileListItem,
  RepoFileListResponse,
  RepoFileViewResponse
} from '../../../../shared/types';
import { MODEL_BY_REPO_KEY, type ModelByRepoMap } from '../../../app/storage';
import { buildFileViewPath } from '../../../app/navigation';
import { getClientErrorMessage, loadJsonFromStorage, normalizeModelOptions } from '../../../lib/appUtils';

interface JsonErrorResponse {
  error?: string;
  hint?: string;
  [key: string]: unknown;
}

interface IssuesResponse extends JsonErrorResponse {
  issues?: IssueItem[];
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

interface UseRepoWorkspaceArgs {
  activeRepoFullName: string | null;
  activeThreadId: string | null;
  activeCollaborationMode: CollaborationMode;
  chatVisible: boolean;
  currentPath: string;
  currentSearch: string;
  streaming: boolean;
  activeRepoRef: MutableRefObject<string | null>;
  outputRef: RefObject<HTMLElement | null>;
  chatReturnScrollTopRef: MutableRefObject<number | null>;
  pendingChatScrollRestoreRef: MutableRefObject<number | null>;
  navigate: (path: string, replace?: boolean) => void;
  setMessage: (value: string) => void;
  toast: (text: string) => void;
}

export function useRepoWorkspace({
  activeRepoFullName,
  activeThreadId,
  activeCollaborationMode,
  chatVisible,
  currentPath,
  currentSearch,
  streaming,
  activeRepoRef,
  outputRef,
  chatReturnScrollTopRef,
  pendingChatScrollRestoreRef,
  navigate,
  setMessage,
  toast
}: UseRepoWorkspaceArgs) {
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
  const [issueItems, setIssueItems] = useState<IssueItem[]>([]);
  const [issueLoading, setIssueLoading] = useState(false);
  const [issueError, setIssueError] = useState('');
  const [badMarkerBusy, setBadMarkerBusy] = useState(false);
  const [markedBadTurnIds, setMarkedBadTurnIds] = useState<string[]>([]);
  const fileViewReturnPathRef = useRef<'/files/' | '/chat/'>('/files/');

  const activeRepoModel = activeRepoFullName ? String(modelByRepo[activeRepoFullName] || '').trim() : '';
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
      setAvailableModels(normalizeModelOptions(data.models));
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
      if (activeRepoRef.current === repoFullName) setGitStatusLoading(false);
    }
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
        chatReturnScrollTopRef.current = node instanceof HTMLElement ? node.scrollTop : 0;
        if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
      } else {
        fileViewReturnPathRef.current = '/files/';
      }
    }
    navigate(buildFileViewPath(filePath, line, jumpToFirstDiff), replace);
  }

  function returnFromFileView(): void {
    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    if (fileViewReturnPathRef.current === '/chat/') {
      pendingChatScrollRestoreRef.current = chatReturnScrollTopRef.current;
      navigate('/chat/');
      return;
    }
    navigate('/files/');
  }

  async function fetchIssues(repoFullName: string | null = activeRepoRef.current): Promise<void> {
    if (!repoFullName) {
      setIssueItems([]);
      setIssueError('');
      setIssueLoading(false);
      return;
    }
    setIssueLoading(true);
    setIssueError('');
    try {
      const res = await fetch(`/api/issues?repoFullName=${encodeURIComponent(repoFullName)}`);
      const data = (await res.json()) as IssuesResponse;
      if (!res.ok) throw new Error(data.error || 'issues_load_failed');
      if (activeRepoRef.current !== repoFullName) return;
      setIssueItems(Array.isArray(data.issues) ? data.issues : []);
    } catch (e: unknown) {
      if (activeRepoRef.current !== repoFullName) return;
      setIssueError(getClientErrorMessage(e, 'issues_load_failed'));
      setIssueItems([]);
    } finally {
      if (activeRepoRef.current === repoFullName) setIssueLoading(false);
    }
  }

  async function markTurnBad(turnId: string): Promise<void> {
    const repoFullName = activeRepoRef.current;
    const threadId = activeThreadId;
    const normalizedTurnId = String(turnId || '').trim();
    if (!repoFullName || !threadId || !normalizedTurnId || badMarkerBusy) return;
    if (markedBadTurnIds.includes(normalizedTurnId)) return;
    setBadMarkerBusy(true);
    try {
      const res = await fetch('/api/issues/markers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoFullName, threadId, turnId: normalizedTurnId })
      });
      const data = (await res.json()) as JsonErrorResponse;
      if (!res.ok) throw new Error(data.error || 'issue_marker_failed');
      setMarkedBadTurnIds((prev) => (prev.includes(normalizedTurnId) ? prev : [...prev, normalizedTurnId]));
      toast('Bad目印を保存しました');
      fetchIssues(repoFullName).catch(() => {});
    } catch (e: unknown) {
      toast(`Bad目印の保存失敗: ${getClientErrorMessage(e)}`);
    } finally {
      setBadMarkerBusy(false);
    }
  }

  function useIssuePrompt(issue: IssueItem): void {
    const prompt = String(issue?.nextPrompt || '').trim();
    if (!prompt) return;
    setMessage(prompt);
    navigate('/chat/');
    toast('課題を入力欄へ入れました');
  }

  async function resolveIssue(issue: IssueItem): Promise<void> {
    if (!issue?.id || issue.status !== 'open') return;
    try {
      const res = await fetch(`/api/issues/${encodeURIComponent(issue.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'resolved' })
      });
      const data = (await res.json()) as JsonErrorResponse;
      if (!res.ok) throw new Error(data.error || 'issue_resolve_failed');
      setIssueItems((prev) => prev.filter((item) => item.id !== issue.id));
      toast('課題を解決済みにしました');
    } catch (e: unknown) {
      toast(`課題更新失敗: ${getClientErrorMessage(e)}`);
    }
  }

  useEffect(() => {
    if (currentPath === '/chat/' && chatVisible) return;
    setChatSettingsOpen(false);
  }, [currentPath, chatVisible]);

  useEffect(() => {
    if (!chatVisible || !activeRepoFullName) {
      setIssueItems([]);
      setIssueError('');
      setIssueLoading(false);
      setMarkedBadTurnIds([]);
      return;
    }
    fetchIssues(activeRepoFullName).catch(() => {});
  }, [chatVisible, activeRepoFullName]);

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
  }, [chatVisible, activeRepoFullName, activeRepoRef]);

  useEffect(() => {
    if (!chatVisible || !activeRepoFullName) return;
    if (currentPath === '/issues/') {
      fetchIssues(activeRepoFullName).catch(() => {});
    }
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
    window.localStorage.setItem(MODEL_BY_REPO_KEY, JSON.stringify(modelByRepo));
  }, [modelByRepo]);

  useEffect(() => {
    if (!chatVisible || !activeRepoFullName || streaming) return;
    fetchGitStatus(activeRepoFullName, true).catch(() => {});
    if (currentPath === '/files/' || currentPath === '/files/view/') {
      fetchFileList(false, activeRepoFullName).catch(() => {});
    }
  }, [chatVisible, activeRepoFullName, streaming, currentPath]);

  const result = useMemo(
    () => ({
      activeCollaborationMode,
      activeRepoModel,
      availableModels,
      badMarkerBusy,
      chatSettingsOpen,
      closeChatSettings,
      fetchIssues,
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
      loadAvailableModels,
      markedBadTurnIds,
      markTurnBad,
      modelsError,
      modelsLoading,
      openChatSettings,
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
    }),
    [
      activeCollaborationMode,
      activeRepoModel,
      availableModels,
      badMarkerBusy,
      chatSettingsOpen,
      fileListError,
      fileListIncludeUnchanged,
      fileListItems,
      fileListLoading,
      gitStatus,
      gitStatusError,
      gitStatusLoading,
      issueError,
      issueItems,
      issueLoading,
      markedBadTurnIds,
      modelsError,
      modelsLoading,
      selectedFileView,
      selectedFileViewError,
      selectedFileViewLoading,
      activeCollaborationMode
    ]
  );

  return result;
}
