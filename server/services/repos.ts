import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { repoPathFromFullName } from '../infra/workspace';
import { diffKindFromStatusCode, parseGitStatusOutput, parseStatusPath } from '../lib/gitParsing';
import type {
  GitRepoStatus,
  RepoFileChangeKind,
  RepoFileListItem,
  RepoFileListResponse,
  RepoFileTreeItem,
  RepoFileTreeResponse,
  RepoFileViewResponse
} from '../../shared/types';

function runGitForRepo(
  repoPath: string,
  args: string[],
  options: { allowExitCodes?: number[] } = {}
): SpawnSyncReturns<string> {
  const result = spawnSync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 8 * 1024 * 1024
  });
  if (result.error) throw result.error;
  const allow = new Set([0, ...(options.allowExitCodes || [])]);
  if (!allow.has(Number(result.status ?? 1))) {
    const message = (result.stderr || result.stdout || '').trim() || `git_${args[0]}_failed`;
    throw new Error(message);
  }
  return result;
}

export function readGitRepoStatus(repoFullName: string): GitRepoStatus {
  const repoPath = repoPathFromFullName(repoFullName);
  if (!fs.existsSync(path.join(repoPath, '.git'))) throw new Error('repo_not_cloned');
  const result = spawnSync('git', ['status', '--porcelain=2', '--branch'], {
    cwd: repoPath,
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || '').trim() || 'git_status_failed';
    throw new Error(message);
  }
  return parseGitStatusOutput(repoFullName, repoPath, result.stdout || '');
}

export function resolveRepoTrackedPath(repoPath: string, rawPath: string): { fullPath: string; relativePath: string } {
  const trimmed = String(rawPath || '').trim();
  if (!trimmed) throw new Error('path_required');
  const decoded = decodeURIComponent(trimmed);
  const candidate = path.isAbsolute(decoded) ? path.resolve(decoded) : path.resolve(repoPath, decoded);
  const relative = path.relative(repoPath, candidate);
  if (
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    relative === '' ||
    candidate === repoPath
  ) {
    throw new Error('path_outside_repo');
  }
  return {
    fullPath: candidate,
    relativePath: relative.split(path.sep).join('/')
  };
}

function detectBinaryBuffer(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  for (const byte of sample) {
    if (byte === 0) return true;
  }
  return false;
}

function collectRepoFileStatus(repoPath: string): Map<string, RepoFileChangeKind> {
  const result = runGitForRepo(repoPath, ['status', '--porcelain', '--untracked-files=all']);
  const map = new Map<string, RepoFileChangeKind>();
  for (const line of String(result.stdout || '').split(/\r?\n/)) {
    const parsed = parseStatusPath(line);
    if (!parsed) continue;
    map.set(parsed.path, diffKindFromStatusCode(parsed.code));
  }
  return map;
}

function collectTrackedFiles(repoPath: string): string[] {
  const result = runGitForRepo(repoPath, ['ls-files', '-z']);
  return String(result.stdout || '')
    .split('\u0000')
    .map((line) => line.trim())
    .filter(Boolean);
}

function collectIgnoredPaths(repoPath: string, parentPath: string | null = null): string[] {
  const args = ['ls-files', '-z', '--others', '-i', '--exclude-standard'];
  if (parentPath) {
    args.push('--', parentPath);
  }
  const result = runGitForRepo(repoPath, args);
  return String(result.stdout || '')
    .split('\u0000')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function isIgnoredRepoPath(repoPath: string, relativePath: string): boolean {
  const target = String(relativePath || '').trim();
  if (!target) return false;
  const result = runGitForRepo(repoPath, ['check-ignore', '-q', '--', target], { allowExitCodes: [1] });
  return Number(result.status ?? 1) === 0;
}

function parseNumStatOutput(output: string, targetPath = ''): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of String(output || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('\t');
    if (parts.length < 3) continue;
    const filePath = String(parts[2] || '').trim();
    if (targetPath && filePath !== targetPath) continue;
    const added = parts[0] === '-' ? 0 : Number(parts[0] || 0);
    const removed = parts[1] === '-' ? 0 : Number(parts[1] || 0);
    additions += Number.isFinite(added) ? added : 0;
    deletions += Number.isFinite(removed) ? removed : 0;
  }
  return { additions, deletions };
}

function collectDiffStats(repoPath: string, relativePath: string, trackedFiles: Set<string>): { additions: number; deletions: number } {
  const unstaged = String(runGitForRepo(repoPath, ['diff', '--numstat', '--', relativePath]).stdout || '');
  const staged = String(runGitForRepo(repoPath, ['diff', '--cached', '--numstat', '--', relativePath]).stdout || '');
  const unstagedStats = parseNumStatOutput(unstaged, relativePath);
  const stagedStats = parseNumStatOutput(staged, relativePath);
  let additions = unstagedStats.additions + stagedStats.additions;
  let deletions = unstagedStats.deletions + stagedStats.deletions;

  const absolutePath = path.join(repoPath, relativePath);
  if (!trackedFiles.has(relativePath) && fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()) {
    const content = fs.readFileSync(absolutePath, 'utf8');
    additions += content.split(/\r?\n/).length;
  }

  return { additions, deletions };
}

function getChangePriority(kind: RepoFileChangeKind): number {
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

function collectDiffOutput(
  repoPath: string,
  relativePath: string,
  trackedFiles: Set<string>,
  changeKind: RepoFileChangeKind = 'unchanged'
): { diff: string; isDeleted: boolean; additions: number; deletions: number } {
  const sections: string[] = [];
  if (changeKind === 'ignored') {
    return { diff: '', isDeleted: false, additions: 0, deletions: 0 };
  }
  const unstaged = String(runGitForRepo(repoPath, ['diff', '--', relativePath]).stdout || '').trim();
  if (unstaged) sections.push(unstaged);
  const staged = String(runGitForRepo(repoPath, ['diff', '--cached', '--', relativePath]).stdout || '').trim();
  if (staged) sections.push(staged);

  const absolutePath = path.join(repoPath, relativePath);
  const exists = fs.existsSync(absolutePath);
  const tracked = trackedFiles.has(relativePath);
  if (!exists && sections.length === 0) {
    return { diff: '', isDeleted: true, additions: 0, deletions: 0 };
  }

  if (!tracked && exists) {
    const untracked = runGitForRepo(repoPath, ['diff', '--no-index', '--', '/dev/null', absolutePath], { allowExitCodes: [1] });
    const output = String(untracked.stdout || '').trim();
    if (output) sections.push(output.replaceAll(absolutePath, relativePath));
  }

  const stats = collectDiffStats(repoPath, relativePath, trackedFiles);

  return {
    diff: sections.filter(Boolean).join('\n\n').trim(),
    isDeleted: !exists,
    additions: stats.additions,
    deletions: stats.deletions
  };
}

function getMimeTypeFromPath(relativePath: string): string | null {
  const ext = path.extname(relativePath).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.svg':
      return 'image/svg+xml';
    case '.bmp':
      return 'image/bmp';
    case '.ico':
      return 'image/x-icon';
    case '.avif':
      return 'image/avif';
    default:
      return null;
  }
}

function readRepoFileContent(
  repoPath: string,
  relativePath: string
): { content: string; isBinary: boolean; mimeType?: string; imageDataUrl?: string } {
  const absolutePath = path.join(repoPath, relativePath);
  if (!fs.existsSync(absolutePath)) return { content: '', isBinary: false };
  const buffer = fs.readFileSync(absolutePath);
  if (detectBinaryBuffer(buffer)) {
    const mimeType = getMimeTypeFromPath(relativePath);
    if (mimeType?.startsWith('image/')) {
      return {
        content: '',
        isBinary: true,
        mimeType,
        imageDataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`
      };
    }
    return { content: '', isBinary: true };
  }
  return { content: buffer.toString('utf8'), isBinary: false };
}

export function listRepoFiles(repoFullName: string, includeUnchanged: boolean): RepoFileListResponse {
  const repoPath = repoPathFromFullName(repoFullName);
  if (!fs.existsSync(path.join(repoPath, '.git'))) throw new Error('repo_not_cloned');
  const statusMap = collectRepoFileStatus(repoPath);
  const trackedFiles = collectTrackedFiles(repoPath);
  const trackedFileSet = new Set(trackedFiles);
  const ignoredPaths = collectIgnoredPaths(repoPath);
  const itemsMap = new Map<string, RepoFileListItem>();

  for (const trackedPath of trackedFiles) {
    const changeKind = statusMap.get(trackedPath) || 'unchanged';
    const hasDiff = changeKind !== 'unchanged';
    if (!hasDiff && !includeUnchanged) continue;
    const stats = hasDiff ? collectDiffStats(repoPath, trackedPath, trackedFileSet) : { additions: 0, deletions: 0 };
    itemsMap.set(trackedPath, {
      path: trackedPath,
      hasDiff,
      changeKind,
      isBinary: false,
      additions: stats.additions,
      deletions: stats.deletions
    });
  }

  for (const [changedPath, changeKind] of statusMap.entries()) {
    const stats = collectDiffStats(repoPath, changedPath, trackedFileSet);
    itemsMap.set(changedPath, {
      path: changedPath,
      hasDiff: true,
      changeKind,
      isBinary: false,
      additions: stats.additions,
      deletions: stats.deletions
    });
  }

  if (includeUnchanged) {
    for (const ignoredPath of ignoredPaths) {
      if (itemsMap.has(ignoredPath)) continue;
      itemsMap.set(ignoredPath, {
        path: ignoredPath,
        hasDiff: false,
        changeKind: 'ignored',
        isBinary: false,
        additions: 0,
        deletions: 0
      });
    }
  }

  const items = Array.from(itemsMap.values()).sort((a, b) => {
    if (a.hasDiff !== b.hasDiff) return a.hasDiff ? -1 : 1;
    const priorityDiff = getChangePriority(b.changeKind) - getChangePriority(a.changeKind);
    if (priorityDiff !== 0) return priorityDiff;
    return a.path.localeCompare(b.path);
  });

  return {
    repoFullName,
    repoPath,
    items
  };
}

interface RepoTreeBuildNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  hasDiff: boolean;
  changeKind: RepoFileChangeKind;
  isBinary: boolean;
  additions: number;
  deletions: number;
  childMap: Map<string, RepoTreeBuildNode>;
}

function buildRepoTreeItemsMap(baseItems: RepoFileListItem[]): Map<string, RepoFileListItem> {
  const itemsMap = new Map<string, RepoFileListItem>();
  for (const item of baseItems) {
    const existing = itemsMap.get(item.path);
    if (!existing) {
      itemsMap.set(item.path, item);
      continue;
    }
    if (item.hasDiff && !existing.hasDiff) {
      itemsMap.set(item.path, item);
      continue;
    }
    if (getChangePriority(item.changeKind) > getChangePriority(existing.changeKind)) {
      itemsMap.set(item.path, item);
    }
  }
  return itemsMap;
}

function createRepoTreeBuildNode(name: string, path: string, type: 'file' | 'directory'): RepoTreeBuildNode {
  return {
    name,
    path,
    type,
    hasDiff: false,
    changeKind: 'unchanged',
    isBinary: false,
    additions: 0,
    deletions: 0,
    childMap: new Map<string, RepoTreeBuildNode>()
  };
}

function applyRepoTreeItemAggregate(target: RepoTreeBuildNode, item: RepoFileListItem, treatAsLeaf: boolean): void {
  target.hasDiff = target.hasDiff || item.hasDiff;
  if (getChangePriority(item.changeKind) > getChangePriority(target.changeKind)) {
    target.changeKind = item.changeKind;
  }
  target.additions += item.additions;
  target.deletions += item.deletions;
  if (treatAsLeaf) {
    target.isBinary = item.isBinary;
  }
}

function finalizeRepoTreeNodes(nodeMap: Map<string, RepoTreeBuildNode>): RepoFileTreeItem[] {
  const items = Array.from(nodeMap.values()).map((node) => {
    const children = node.type === 'directory' ? finalizeRepoTreeNodes(node.childMap) : undefined;
    const item: RepoFileTreeItem = {
      name: node.name,
      path: node.path,
      type: node.type,
      hasDiff: node.hasDiff,
      changeKind: node.changeKind,
      isBinary: node.isBinary,
      additions: node.additions,
      deletions: node.deletions,
      hasChildren: Boolean(children && children.length > 0)
    };
    if (children) item.children = children;
    return item;
  });

  return items.sort((a, b) => {
    if (a.hasDiff !== b.hasDiff) return a.hasDiff ? -1 : 1;
    const priorityDiff = getChangePriority(b.changeKind) - getChangePriority(a.changeKind);
    if (priorityDiff !== 0) return priorityDiff;
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function buildRepoTreeResponse(repoFullName: string, baseItems: RepoFileListItem[]): RepoFileTreeResponse {
  const repoPath = repoPathFromFullName(repoFullName);
  if (!fs.existsSync(path.join(repoPath, '.git'))) throw new Error('repo_not_cloned');
  const itemsMap = buildRepoTreeItemsMap(baseItems);
  const rootMap = new Map<string, RepoTreeBuildNode>();
  for (const item of itemsMap.values()) {
    const normalizedPath = item.path.endsWith('/') ? item.path.replace(/\/+$/, '') : item.path;
    if (!normalizedPath) continue;
    const parts = normalizedPath.split('/').filter(Boolean);
    if (parts.length === 0) continue;
    let currentMap = rootMap;
    let currentPath = '';
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index];
      if (!name) continue;
      currentPath = currentPath ? `${currentPath}/${name}` : name;
      const isLeaf = index === parts.length - 1;
      const nodeType: 'file' | 'directory' = isLeaf && !item.path.endsWith('/') ? 'file' : 'directory';
      let node = currentMap.get(name);
      if (!node) {
        node = createRepoTreeBuildNode(name, currentPath, nodeType);
        currentMap.set(name, node);
      } else if (isLeaf && nodeType === 'file') {
        node.type = 'file';
      }
      applyRepoTreeItemAggregate(node, item, isLeaf && nodeType === 'file');
      currentMap = node.childMap;
    }
  }

  const items = finalizeRepoTreeNodes(rootMap);

  return {
    repoFullName,
    repoPath,
    items
  };
}

function collectDiffTreeItems(repoPath: string): RepoFileListItem[] {
  const statusMap = collectRepoFileStatus(repoPath);
  const trackedFiles = collectTrackedFiles(repoPath);
  const trackedFileSet = new Set(trackedFiles);
  const items: RepoFileListItem[] = [];

  for (const [changedPath, changeKind] of statusMap.entries()) {
    const stats = collectDiffStats(repoPath, changedPath, trackedFileSet);
    items.push({
      path: changedPath,
      hasDiff: true,
      changeKind,
      isBinary: false,
      additions: stats.additions,
      deletions: stats.deletions
    });
  }

  return items;
}

function collectAllTreeItems(repoPath: string): RepoFileListItem[] {
  const statusMap = collectRepoFileStatus(repoPath);
  const trackedFiles = collectTrackedFiles(repoPath);
  const trackedFileSet = new Set(trackedFiles);
  const ignoredPaths = collectIgnoredPaths(repoPath, null);
  const items: RepoFileListItem[] = [];

  for (const trackedPath of trackedFiles) {
    const changeKind = statusMap.get(trackedPath) || 'unchanged';
    const hasDiff = changeKind !== 'unchanged';
    const stats = hasDiff ? collectDiffStats(repoPath, trackedPath, trackedFileSet) : { additions: 0, deletions: 0 };
    items.push({
      path: trackedPath,
      hasDiff,
      changeKind,
      isBinary: false,
      additions: stats.additions,
      deletions: stats.deletions
    });
  }

  for (const [changedPath, changeKind] of statusMap.entries()) {
    const stats = collectDiffStats(repoPath, changedPath, trackedFileSet);
    items.push({
      path: changedPath,
      hasDiff: true,
      changeKind,
      isBinary: false,
      additions: stats.additions,
      deletions: stats.deletions
    });
  }

  for (const ignoredPath of ignoredPaths) {
    items.push({
      path: ignoredPath,
      hasDiff: false,
      changeKind: 'ignored',
      isBinary: false,
      additions: 0,
      deletions: 0
    });
  }

  return items;
}

export function listRepoTreeDiff(repoFullName: string): RepoFileTreeResponse {
  const repoPath = repoPathFromFullName(repoFullName);
  if (!fs.existsSync(path.join(repoPath, '.git'))) throw new Error('repo_not_cloned');
  return buildRepoTreeResponse(repoFullName, collectDiffTreeItems(repoPath));
}

export function listRepoTreeAll(repoFullName: string): RepoFileTreeResponse {
  const repoPath = repoPathFromFullName(repoFullName);
  if (!fs.existsSync(path.join(repoPath, '.git'))) throw new Error('repo_not_cloned');
  return buildRepoTreeResponse(repoFullName, collectAllTreeItems(repoPath));
}

export function buildRepoFileView(repoFullName: string, rawPath: string): RepoFileViewResponse {
  const repoPath = repoPathFromFullName(repoFullName);
  if (!fs.existsSync(path.join(repoPath, '.git'))) throw new Error('repo_not_cloned');
  const resolved = resolveRepoTrackedPath(repoPath, rawPath);
  const statusMap = collectRepoFileStatus(repoPath);
  const trackedFiles = new Set(collectTrackedFiles(repoPath));
  const ignored = isIgnoredRepoPath(repoPath, resolved.relativePath);
  const changeKind = statusMap.get(resolved.relativePath) || (ignored ? 'ignored' : 'unchanged');
  const { diff, isDeleted, additions, deletions } = collectDiffOutput(repoPath, resolved.relativePath, trackedFiles, changeKind);
  const contentState = readRepoFileContent(repoPath, resolved.relativePath);
  const response: RepoFileViewResponse = {
    repoFullName,
    repoPath,
    path: resolved.relativePath,
    hasDiff: Boolean(diff),
    changeKind,
    isBinary: contentState.isBinary,
    isDeleted,
    additions,
    deletions,
    content: contentState.content,
    diff
  };
  if (contentState.mimeType) response.mimeType = contentState.mimeType;
  if (contentState.imageDataUrl) response.imageDataUrl = contentState.imageDataUrl;
  return response;
}
