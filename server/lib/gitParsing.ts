import type { GitRepoStatus, RepoFileChangeKind } from '../../shared/types';

export function parseGitStatusOutput(repoFullName: string, repoPath: string, raw: string): GitRepoStatus {
  let branch = '';
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let stagedCount = 0;
  let unstagedCount = 0;
  let untrackedCount = 0;
  let conflictedCount = 0;

  const lines = String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);

  for (const line of lines) {
    if (line.startsWith('# branch.head ')) {
      branch = line.slice('# branch.head '.length).trim();
      continue;
    }
    if (line.startsWith('# branch.upstream ')) {
      upstream = line.slice('# branch.upstream '.length).trim() || null;
      continue;
    }
    if (line.startsWith('# branch.ab ')) {
      const match = line.match(/\+(\d+)\s+\-(\d+)/);
      ahead = Number(match?.[1] || 0);
      behind = Number(match?.[2] || 0);
      continue;
    }
    if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const xy = line.split(/\s+/, 3)[1] || '..';
      const x = xy[0] || '.';
      const y = xy[1] || '.';
      if (x !== '.' && x !== '?') stagedCount += 1;
      if (y !== '.' && y !== '?') unstagedCount += 1;
      continue;
    }
    if (line.startsWith('u ')) {
      conflictedCount += 1;
      continue;
    }
    if (line.startsWith('? ')) {
      untrackedCount += 1;
    }
  }

  const hasChanges = stagedCount + unstagedCount + untrackedCount + conflictedCount > 0;
  const branchLabel = !branch || branch === '(detached)' ? 'detached' : branch;
  const actionRecommended = hasChanges || ahead > 0 || behind > 0;
  let tone: GitRepoStatus['tone'] = 'neutral';
  let summary = 'Git は同期済みです';

  if (conflictedCount > 0) {
    tone = 'danger';
    summary = `Git 競合 ${conflictedCount} 件`;
  } else if (hasChanges) {
    tone = 'warning';
    const parts: string[] = [];
    if (stagedCount > 0) parts.push(`ステージ ${stagedCount}`);
    if (unstagedCount > 0) parts.push(`未反映 ${unstagedCount}`);
    if (untrackedCount > 0) parts.push(`新規追加 ${untrackedCount}`);
    summary = `変更あり: ${parts.join(' / ')}`;
    if (!upstream) summary += ' / upstream 未設定';
    else if (ahead > 0 || behind > 0) summary += ` / +${ahead} -${behind}`;
  } else if (ahead > 0 && behind > 0) {
    tone = 'danger';
    summary = `push 前に同期が必要: +${ahead} -${behind}`;
  } else if (ahead > 0) {
    tone = 'success';
    summary = `未 push のコミット ${ahead} 件`;
  } else if (behind > 0) {
    tone = 'warning';
    summary = `リモート更新 ${behind} 件`;
  }

  return {
    repoFullName,
    repoPath,
    branch: branchLabel,
    upstream,
    ahead,
    behind,
    stagedCount,
    unstagedCount,
    untrackedCount,
    conflictedCount,
    hasChanges,
    actionRecommended,
    tone,
    summary
  };
}

export function diffKindFromStatusCode(code: string): RepoFileChangeKind {
  const normalized = String(code || '').trim();
  if (normalized === '??') return 'untracked';
  if (/[UD]{2}|AA|DD|AU|UA|DU|UD|UU/.test(normalized) || normalized.includes('U')) return 'conflicted';
  if (normalized.includes('R')) return 'renamed';
  if (normalized.includes('D')) return 'deleted';
  if (normalized.includes('A')) return 'added';
  if (normalized.includes('M') || normalized.includes('T') || normalized.includes('C')) return 'modified';
  return 'unchanged';
}

export function parseStatusPath(line: string): { code: string; path: string } | null {
  const text = String(line || '');
  if (!text) return null;
  if (text.startsWith('?? ')) return { code: '??', path: text.slice(3).trim() };
  if (text.length < 4) return null;
  const code = text.slice(0, 2);
  let filePath = text.slice(3).trim();
  const renameArrow = filePath.lastIndexOf(' -> ');
  if (renameArrow >= 0) filePath = filePath.slice(renameArrow + 4).trim();
  if (!filePath) return null;
  return { code, path: filePath };
}
