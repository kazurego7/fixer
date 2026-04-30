import { Page, PageContent } from 'framework7-react';
import { useAppCtx } from '../../../app/AppContext';
import { formatIssueStatus, formatRepoDisplayName } from '../../../lib/appUtils';
import { RepoWorkspaceNav } from '../RepoWorkspaceNav';

export function IssuesPage() {
  const { activeRepoFullName, issueItems, issueLoading, issueError, useIssuePrompt, resolveIssue, navigate } = useAppCtx();
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
      <PageContent className="fx-page fx-page-issues">
        <RepoWorkspaceNav
          activeTab="issues"
          onBack={goBack}
          backTestId="issues-back-button"
          title={repoDisplayName}
          titleTestId="issues-page-title"
        />
        <div className="fx-issues-page-body" data-testid="issues-page">
          {issueLoading ? <div className="fx-issue-empty">読み込み中...</div> : null}
          {issueError ? <div className="fx-issue-error">{issueError}</div> : null}
          {!issueLoading && !issueError && issueItems.length === 0 ? (
            <div className="fx-issue-empty">課題はまだありません。</div>
          ) : null}
          {!issueLoading && !issueError && issueItems.length > 0 ? (
            <div className="fx-issue-list">
              {issueItems.map((issue) => (
                <article key={issue.id} className={`fx-issue-item is-${issue.status}`} data-testid="issue-item">
                  <div className="fx-issue-item-head">
                    <h4>{issue.title}</h4>
                    <span className="fx-issue-status">{formatIssueStatus(issue.status)}</span>
                  </div>
                  <p>{issue.summary}</p>
                  <div className="fx-issue-actions">
                    <button
                      type="button"
                      className="fx-issue-action"
                      onClick={() => useIssuePrompt(issue)}
                      disabled={!issue.nextPrompt || issue.status !== 'open'}
                      data-testid="issue-use-button"
                    >
                      対応する
                    </button>
                    <button
                      type="button"
                      className="fx-issue-action is-muted"
                      onClick={() => resolveIssue(issue)}
                      disabled={issue.status !== 'open'}
                      data-testid="issue-resolve-button"
                    >
                      解決済み
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : null}
        </div>
      </PageContent>
    </Page>
  );
}
