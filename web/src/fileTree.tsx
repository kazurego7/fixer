import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type { RepoFileListItem, RepoFileTreeItem, RepoFileTreeResponse } from '../../shared/types';

type TreeTone = 'deleted' | 'added' | 'modified' | 'ignored' | 'normal';

interface FileTreeFetchResponse extends RepoFileTreeResponse {
  error?: string;
  detail?: string;
}

interface UseFileTreeStateArgs {
  repoFullName: string | null;
  includeUnchanged: boolean;
}

interface UseFileTreeStateResult {
  rootItems: RepoFileTreeItem[];
  rootLoading: boolean;
  rootError: string;
  expandedByPath: Record<string, boolean>;
  setExpandedByPath: Dispatch<SetStateAction<Record<string, boolean>>>;
  invalidateTree: () => void;
}

interface FileTreeNodeProps {
  node: RepoFileTreeItem;
  depth: number;
  treeState: UseFileTreeStateResult;
  openRepoFile: (filePath: string, line?: number | null, replace?: boolean) => Promise<void>;
}

function getClientErrorMessage(error: unknown, fallback = 'unknown_error'): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return fallback;
}

export function getTreeTone(kind: RepoFileListItem['changeKind'] | RepoFileTreeItem['changeKind']): TreeTone {
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

export function formatNumstatParts(additions: number, deletions: number): Array<{ label: string; tone: 'plus' | 'minus' }> {
  const parts: Array<{ label: string; tone: 'plus' | 'minus' }> = [];
  if (additions > 0) parts.push({ label: `+${additions}`, tone: 'plus' });
  if (deletions > 0) parts.push({ label: `-${deletions}`, tone: 'minus' });
  return parts;
}

export function useFileTreeState({ repoFullName, includeUnchanged }: UseFileTreeStateArgs): UseFileTreeStateResult {
  const [rootItems, setRootItems] = useState<RepoFileTreeItem[]>([]);
  const [rootLoading, setRootLoading] = useState(false);
  const [rootError, setRootError] = useState('');
  const [expandedByPath, setExpandedByPath] = useState<Record<string, boolean>>({});

  const invalidateTree = useCallback(() => {
    setRootItems([]);
    setRootLoading(false);
    setRootError('');
    setExpandedByPath({});
  }, []);

  const loadTree = useCallback(async (): Promise<void> => {
    if (!repoFullName) return;
    setRootLoading(true);
    setRootError('');
    try {
      const qs = new URLSearchParams({ repoFullName });
      const endpoint = includeUnchanged ? '/api/repos/file-tree-all' : '/api/repos/file-tree-diff';
      const res = await fetch(`${endpoint}?${qs.toString()}`);
      const data = (await res.json()) as FileTreeFetchResponse;
      if (!res.ok) throw new Error(data.detail || data.error || 'repo_file_tree_failed');
      setRootItems(Array.isArray(data.items) ? data.items : []);
    } catch (e: unknown) {
      setRootError(getClientErrorMessage(e, 'repo_file_tree_failed'));
    } finally {
      setRootLoading(false);
    }
  }, [repoFullName, includeUnchanged]);

  useEffect(() => {
    invalidateTree();
    if (!repoFullName) return;
    loadTree().catch(() => {});
  }, [repoFullName, includeUnchanged, invalidateTree, loadTree]);

  return {
    rootItems,
    rootLoading,
    rootError,
    expandedByPath,
    setExpandedByPath,
    invalidateTree
  };
}

export function FileTreeNode({ node, depth, treeState, openRepoFile }: FileTreeNodeProps) {
  const { expandedByPath, setExpandedByPath } = treeState;
  const childItems = node.children || [];
  const isOpen = expandedByPath[node.path] ?? node.hasDiff;
  const numstatParts = formatNumstatParts(node.additions, node.deletions);

  if (node.type === 'directory') {
    return (
      <details
        className={`fx-file-tree-group is-${getTreeTone(node.changeKind)}`}
        open={isOpen}
        onToggle={(event) => {
          const nextOpen = (event.currentTarget as HTMLDetailsElement).open;
          setExpandedByPath((prev) => {
            if (prev[node.path] === nextOpen) return prev;
            return { ...prev, [node.path]: nextOpen };
          });
        }}
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
        {isOpen ? (
          <div className="fx-file-tree-children">
            {childItems.map((child) => (
              <FileTreeNode key={child.path} node={child} depth={depth + 1} treeState={treeState} openRepoFile={openRepoFile} />
            ))}
          </div>
        ) : null}
      </details>
    );
  }

  return (
    <button
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
}
