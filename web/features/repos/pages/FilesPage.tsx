import { Page, PageContent } from 'framework7-react';
import { useAppCtx } from '../../../app/AppContext';
import { formatRepoDisplayName } from '../../../lib/appUtils';
import { FileTreeNode, useFileTreeState } from '../fileTree';
import { RepoWorkspaceNav } from '../RepoWorkspaceNav';

export function FilesPage() {
  const { activeRepoFullName, fileListIncludeUnchanged, setFileListIncludeUnchanged, openRepoFile, navigate } = useAppCtx();
  const treeState = useFileTreeState({
    repoFullName: activeRepoFullName,
    includeUnchanged: fileListIncludeUnchanged
  });
  const { rootItems, rootLoading, rootError } = treeState;
  const repoDisplayName = formatRepoDisplayName(activeRepoFullName);
  const goBack = () => {
    if (typeof window !== 'undefined' && window.history.length > 1) {
      window.history.back();
      return;
    }
    navigate('/chat/');
  };

  return (
    <Page noNavbar>
      <PageContent className="fx-page fx-page-files">
        <RepoWorkspaceNav
          activeTab="files"
          onBack={goBack}
          backTestId="files-back-button"
          title={repoDisplayName}
          titleTestId="files-page-title"
        />
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
