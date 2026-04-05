import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
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
  childrenByParent: Record<string, RepoFileTreeItem[]>;
  loadingByParent: Record<string, boolean>;
  errorByParent: Record<string, string>;
  expandedByPath: Record<string, boolean>;
  setExpandedByPath: Dispatch<SetStateAction<Record<string, boolean>>>;
  loadChildren: (parentPath: string | null, force?: boolean) => Promise<void>;
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

export function getTreeParentKey(path: string | null): string {
  return path || '__root__';
}

export function useFileTreeState({ repoFullName, includeUnchanged }: UseFileTreeStateArgs): UseFileTreeStateResult {
  const [childrenByParent, setChildrenByParent] = useState<Record<string, RepoFileTreeItem[]>>({});
  const [loadingByParent, setLoadingByParent] = useState<Record<string, boolean>>({});
  const [errorByParent, setErrorByParent] = useState<Record<string, string>>({});
  const [expandedByPath, setExpandedByPath] = useState<Record<string, boolean>>({});
  const childrenByParentRef = useRef(childrenByParent);
  const loadingByParentRef = useRef(loadingByParent);

  useEffect(() => {
    childrenByParentRef.current = childrenByParent;
  }, [childrenByParent]);

  useEffect(() => {
    loadingByParentRef.current = loadingByParent;
  }, [loadingByParent]);

  const invalidateTree = useCallback(() => {
    setChildrenByParent({});
    setLoadingByParent({});
    setErrorByParent({});
    setExpandedByPath({});
    childrenByParentRef.current = {};
    loadingByParentRef.current = {};
  }, []);

  const loadChildren = useCallback(
    async (parentPath: string | null, force = false): Promise<void> => {
      if (!repoFullName) return;
      const key = getTreeParentKey(parentPath);
      if (
        !force &&
        (loadingByParentRef.current[key] || Object.prototype.hasOwnProperty.call(childrenByParentRef.current, key))
      ) {
        return;
      }
      setLoadingByParent((prev) => ({ ...prev, [key]: true }));
      setErrorByParent((prev) => ({ ...prev, [key]: '' }));
      try {
        const qs = new URLSearchParams({
          repoFullName,
          includeUnchanged: includeUnchanged ? '1' : '0'
        });
        if (parentPath) qs.set('path', parentPath);
        const res = await fetch(`/api/repos/file-tree?${qs.toString()}`);
        const data = (await res.json()) as FileTreeFetchResponse;
        if (!res.ok) throw new Error(data.detail || data.error || 'repo_file_tree_failed');
        setChildrenByParent((prev) => ({ ...prev, [key]: Array.isArray(data.items) ? data.items : [] }));
      } catch (e: unknown) {
        setErrorByParent((prev) => ({ ...prev, [key]: getClientErrorMessage(e, 'repo_file_tree_failed') }));
      } finally {
        setLoadingByParent((prev) => ({ ...prev, [key]: false }));
      }
    },
    [repoFullName, includeUnchanged]
  );

  useEffect(() => {
    invalidateTree();
    if (!repoFullName) return;
    loadChildren(null, true).catch(() => {});
  }, [repoFullName, includeUnchanged, invalidateTree, loadChildren]);

  const rootKey = getTreeParentKey(null);

  return {
    rootItems: childrenByParent[rootKey] || [],
    rootLoading: Boolean(loadingByParent[rootKey]),
    rootError: errorByParent[rootKey] || '',
    childrenByParent,
    loadingByParent,
    errorByParent,
    expandedByPath,
    setExpandedByPath,
    loadChildren,
    invalidateTree
  };
}

export function FileTreeNode({ node, depth, treeState, openRepoFile }: FileTreeNodeProps) {
  const {
    childrenByParent,
    loadingByParent,
    errorByParent,
    expandedByPath,
    setExpandedByPath,
    loadChildren
  } = treeState;
  const pathKey = getTreeParentKey(node.path);
  const childItems = childrenByParent[pathKey] || [];
  const childrenLoaded = Object.prototype.hasOwnProperty.call(childrenByParent, pathKey);
  const childrenLoading = Boolean(loadingByParent[pathKey]);
  const childrenError = errorByParent[pathKey] || '';
  const isOpen = expandedByPath[node.path] ?? node.hasDiff;
  const numstatParts = formatNumstatParts(node.additions, node.deletions);

  useEffect(() => {
    if (node.type !== 'directory' || !isOpen || childrenLoaded || childrenLoading) return;
    loadChildren(node.path).catch(() => {});
  }, [node.type, node.path, isOpen, childrenLoaded, childrenLoading, loadChildren]);

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
        <div className="fx-file-tree-children">
          {childrenError ? <p className="fx-mini">読み込み失敗: {childrenError}</p> : null}
          {!childrenLoading && !childrenError
            ? childItems.map((child) => (
                <FileTreeNode key={child.path} node={child} depth={depth + 1} treeState={treeState} openRepoFile={openRepoFile} />
              ))
            : null}
        </div>
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
