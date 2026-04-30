import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function resolveWorkspaceRoot(): string {
  const preferred = path.join(os.homedir(), '.fixer', 'workspace');
  try {
    if (!fs.existsSync(preferred)) {
      fs.mkdirSync(preferred, { recursive: true });
    }
    fs.accessSync(preferred, fs.constants.W_OK);
    return preferred;
  } catch {
    const fallback = path.join(process.cwd(), 'workspace');
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

export const WORKSPACE_ROOT = resolveWorkspaceRoot();

export function parseGithubRepoFullName(remoteUrl: string): string | null {
  const raw = String(remoteUrl || '').trim();
  if (!raw) return null;
  const normalized = raw.replace(/\.git$/i, '');
  const sshMatch = normalized.match(/github\.com[:/]([^/]+\/[^/]+)$/i);
  if (sshMatch?.[1]) return sshMatch[1];
  const urlMatch = normalized.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)$/i);
  if (urlMatch?.[1]) return urlMatch[1];
  return null;
}

let cachedCurrentRepoMatch: { fullName: string; repoPath: string } | null | undefined;

export function getCurrentRepoMatch(): { fullName: string; repoPath: string } | null {
  if (typeof cachedCurrentRepoMatch !== 'undefined') return cachedCurrentRepoMatch;
  try {
    const topLevel = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: process.cwd(),
      encoding: 'utf8'
    });
    if (topLevel.status !== 0) {
      cachedCurrentRepoMatch = null;
      return null;
    }
    const repoPath = String(topLevel.stdout || '').trim();
    if (!repoPath) {
      cachedCurrentRepoMatch = null;
      return null;
    }
    const remote = spawnSync('git', ['remote', 'get-url', 'origin'], {
      cwd: repoPath,
      encoding: 'utf8'
    });
    if (remote.status !== 0) {
      cachedCurrentRepoMatch = null;
      return null;
    }
    const fullName = parseGithubRepoFullName(String(remote.stdout || ''));
    cachedCurrentRepoMatch = fullName ? { fullName, repoPath } : null;
    return cachedCurrentRepoMatch;
  } catch {
    cachedCurrentRepoMatch = null;
    return null;
  }
}

export function repoFolderFromFullName(fullName: string): string {
  return fullName.replace(/[\\/]/g, '__');
}

export function repoPathFromFullName(fullName: string): string {
  const currentRepoMatch = getCurrentRepoMatch();
  if (currentRepoMatch?.fullName === fullName) return currentRepoMatch.repoPath;
  return path.join(WORKSPACE_ROOT, repoFolderFromFullName(fullName));
}
