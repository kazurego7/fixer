import { Page, PageContent } from 'framework7-react';
import { useAppCtx } from '../appContext';
import { FileTreeNode, useFileTreeState } from '../fileTree';

export function FilesPage() {
  const { activeRepoFullName, fileListIncludeUnchanged, setFileListIncludeUnchanged, openRepoFile, navigate } = useAppCtx();
  const treeState = useFileTreeState({
    repoFullName: activeRepoFullName,
    includeUnchanged: fileListIncludeUnchanged
  });
  const { rootItems, rootLoading, rootError } = treeState;

  return (
    <Page noNavbar>
      <PageContent className="fx-page fx-page-files">
        <div className="fx-chat-head">
          <button
            className="fx-back-icon"
            type="button"
            onClick={() => navigate('/chat/')}
            data-testid="files-back-button"
          >
            ←
          </button>
          <div className="fx-files-title">ファイル一覧</div>
        </div>
        <div className="fx-files-toolbar">
          <label className="fx-files-toggle" htmlFor="files-include-unchanged" data-testid="files-include-unchanged-toggle">
            <input
              id="files-include-unchanged"
              type="checkbox"
              checked={fileListIncludeUnchanged}
              onChange={(e) => setFileListIncludeUnchanged(e.currentTarget.checked)}
            />
            <span>変更差分なしも表示</span>
          </label>
          <div className="fx-files-toolbar-repo">{activeRepoFullName || 'リポジトリ未選択'}</div>
        </div>
        <div className="fx-files-list" data-testid="files-list">
          {rootLoading ? <p className="fx-mini">ファイル一覧を読み込み中...</p> : null}
          {rootError ? <p className="fx-mini">読み込み失敗: {rootError}</p> : null}
          {!rootLoading && !rootError && rootItems.length === 0 ? <p className="fx-mini">表示できるファイルがありません。</p> : null}
          {!rootLoading && !rootError
            ? rootItems.map((node) => (
                <FileTreeNode key={node.path} node={node} depth={0} treeState={treeState} openRepoFile={openRepoFile} />
              ))
            : null}
        </div>
      </PageContent>
    </Page>
  );
}
