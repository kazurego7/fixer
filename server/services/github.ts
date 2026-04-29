import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import type { CloneState, RepoSummary } from '../../shared/types';
import { getErrorCode, getErrorMessage } from '../errors';

interface GithubUserResponse {
  login?: string;
}

interface GithubRepoApiItem {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  clone_url: string;
  default_branch: string;
  updated_at: string;
}

interface GithubRepoCreateResponse {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  clone_url: string;
  default_branch: string;
  updated_at: string;
  message?: string;
}

type CloneStateResolver = (fullName: string) => CloneState;

export type GhStatus =
  | { available: false; connected: false; hint: string }
  | { available: true; connected: false; hint: string }
  | { available: true; connected: true; token: string };

function runGh(args: string[]): SpawnSyncReturns<string> {
  return spawnSync('gh', args, { encoding: 'utf8' });
}

function getGithubTokenFromGh(): string {
  const tokenResult = runGh(['auth', 'token']);
  if (tokenResult.error) {
    if (getErrorCode(tokenResult.error) === 'ENOENT') throw new Error('gh_not_installed');
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

export function getGhStatus(): GhStatus {
  const versionResult = runGh(['--version']);
  if (versionResult.error && getErrorCode(versionResult.error) === 'ENOENT') {
    return { available: false, connected: false, hint: 'gh がインストールされていません。' };
  }
  if (versionResult.status !== 0) {
    return { available: false, connected: false, hint: 'gh コマンドを実行できません。' };
  }

  try {
    const token = getGithubTokenFromGh();
    return { available: true, connected: true, token };
  } catch (error) {
    const message = getErrorMessage(error);
    if (message.startsWith('gh_not_logged_in')) {
      return { available: true, connected: false, hint: '先に `gh auth login` を実行してください。' };
    }
    return { available: true, connected: false, hint: message };
  }
}

export async function githubUser(token: string): Promise<GithubUserResponse> {
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
  return (await response.json()) as GithubUserResponse;
}

export async function githubRepos(
  token: string,
  query: string,
  getCloneState: CloneStateResolver
): Promise<RepoSummary[]> {
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

  const data = (await response.json()) as GithubRepoApiItem[] | { items?: GithubRepoApiItem[] };
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

export async function githubCreateRepo(
  token: string,
  name: string,
  isPrivate: boolean,
  getCloneState: CloneStateResolver
): Promise<RepoSummary> {
  const response = await fetch('https://api.github.com/user/repos', {
    method: 'POST',
    headers: {
      'User-Agent': 'codex-mobile-ui',
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name,
      private: isPrivate,
      auto_init: false
    })
  });

  const data = (await response.json()) as GithubRepoCreateResponse;
  if (!response.ok) {
    throw new Error(String(data.message || `github_repo_create_error:${response.status}`));
  }

  return {
    id: data.id,
    name: data.name,
    fullName: data.full_name,
    private: data.private,
    cloneUrl: data.clone_url,
    defaultBranch: data.default_branch,
    updatedAt: data.updated_at,
    cloneState: getCloneState(data.full_name)
  };
}
