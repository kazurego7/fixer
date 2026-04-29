import type { RepoFileListItem, RepoFileViewResponse } from '../../shared/types';

export function formatChangeKindLabel(kind: RepoFileListItem['changeKind'] | RepoFileViewResponse['changeKind']): string {
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
