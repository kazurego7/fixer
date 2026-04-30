import { useState, type Dispatch, type SetStateAction } from 'react';
import type { AppErrorState, PendingThreadReturn, RepoSummary } from '../../../shared/types';
import type { ThreadByRepoMap } from '../appStorage';

const CLONE_TIMEOUT_MS = 180000;

interface JsonErrorResponse {
  error?: string;
  hint?: string;
  [key: string]: unknown;
}

interface EnsureThreadResponse {
  id?: string;
  thread_id?: string;
  error?: string;
}

interface UseRepoBootstrapArgs {
  query: string;
  setConnected: (value: boolean) => void;
  setError: (value: AppErrorState | null) => void;
  setRepos: Dispatch<SetStateAction<RepoSummary[]>>;
  setSelectedRepo: (value: RepoSummary | null) => void;
  setActiveThreadId: (value: string | null) => void;
  setActiveRepoFullName: (value: string | null) => void;
  setChatVisible: (value: boolean) => void;
  setThreadByRepo: Dispatch<SetStateAction<ThreadByRepoMap>>;
  setPendingThreadReturn: (value: PendingThreadReturn | null) => void;
  setPendingAttachments: Dispatch<SetStateAction<unknown[]>>;
  fetchReposState: (nextQuery?: string) => Promise<void>;
  getRepoModel: (repoFullName?: string | null) => string;
  ensureThread: (repoFullName: string, preferredThreadId?: string | null, model?: string) => Promise<string>;
  restoreOutputForThread: (threadId: string, repoFullName?: string | null, options?: { resumeLive?: boolean; useCache?: boolean }) => Promise<void>;
  toast: (text: string) => void;
  getClientErrorMessage: (error: unknown) => string;
  threadByRepo: ThreadByRepoMap;
}

export function useRepoBootstrap({
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
  fetchReposState,
  getRepoModel,
  ensureThread,
  restoreOutputForThread,
  toast,
  getClientErrorMessage,
  threadByRepo
}: UseRepoBootstrapArgs) {
  const [busy, setBusy] = useState(false);

  async function checkAuthStatus(): Promise<JsonErrorResponse & { available?: boolean; connected?: boolean; login?: string }> {
    const res = await fetch('/api/github/auth/status');
    const data = (await res.json()) as JsonErrorResponse & { available?: boolean; connected?: boolean; login?: string };
    if (!res.ok) throw new Error(data.error || 'auth_status_failed');
    return data;
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
      await fetchReposState('');
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

  async function startNewLocalThread(repoFullName: string): Promise<string> {
    return createThread(repoFullName, getRepoModel(repoFullName));
  }

  return {
    bootstrapConnection,
    busy,
    createRepo,
    fetchRepos: fetchReposState,
    query,
    setBusy,
    startNewLocalThread,
    startWithRepo
  };
}
