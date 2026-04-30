import { type ChangeEvent } from 'react';
import { Button, Page, PageContent, f7 } from 'framework7-react';
import { useAppCtx } from '../../../app/AppContext';
import { getClientErrorMessage } from '../../../lib/appUtils';

export function ReposPage() {
  const {
    connected,
    error,
    busy,
    query,
    setQuery,
    repos,
    repoFilter,
    setRepoFilter,
    selectedRepo,
    setSelectedRepo,
    clonedRepos,
    notClonedRepos,
    filteredRepos,
    activeRepoFullName,
    activeThreadId,
    chatVisible,
    navigate,
    bootstrapConnection,
    fetchRepos,
    startWithRepo
  } = useAppCtx();

  return (
    <Page noNavbar>
      <PageContent className="fx-page fx-page-repos">
        {!connected && error ? (
          <section className="fx-error-panel">
            <h2>GitHub接続エラー</h2>
            <p>{error.title}</p>
            <pre className="fx-code">{error.cause}</pre>
            <div className="fx-actions">
              <Button fill onClick={bootstrapConnection}>再試行</Button>
              <Button tonal onClick={() => f7.dialog.alert('gh auth login', 'ログイン手順')}>ログイン手順</Button>
            </div>
          </section>
        ) : null}

        {connected ? (
          <section className="fx-repos-shell">
            <div className="fx-repos-toolbar">
              <div className="fx-repos-search-row">
                <Button
                  className="fx-repo-create-nav-btn"
                  type="button"
                  onClick={() => navigate('/repos/new/')}
                  aria-label="新規リポジトリ作成"
                >
                  ＋
                </Button>
                <input
                  value={query}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setQuery(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      fetchRepos(e.currentTarget.value).catch((err: unknown) => {
                        f7.toast.create({ text: `読み込み失敗: ${getClientErrorMessage(err)}`, closeTimeout: 1400, position: 'center' }).open();
                      });
                    }
                  }}
                  placeholder="リポジトリ名で検索"
                />
              </div>
              <div className="fx-filter">
                <Button small fill={repoFilter === 'all'} tonal={repoFilter !== 'all'} onClick={() => setRepoFilter('all')}>
                  すべて {repos.length}
                </Button>
                <Button small fill={repoFilter === 'cloned'} tonal={repoFilter !== 'cloned'} onClick={() => setRepoFilter('cloned')}>
                  クローン済み {clonedRepos.length}
                </Button>
                <Button small fill={repoFilter === 'not_cloned'} tonal={repoFilter !== 'not_cloned'} onClick={() => setRepoFilter('not_cloned')}>
                  未クローン {notClonedRepos.length}
                </Button>
              </div>
            </div>

            <div className="fx-repo-scroll">
              {filteredRepos.map((repo) => {
                const isSelected = selectedRepo?.id === repo.id;
                const cloned = repo.cloneState?.status === 'cloned';
                const [owner = '', repoName = repo.fullName] = String(repo.fullName || '').split('/');
                return (
                  <button
                    key={repo.id}
                    className={`fx-repo-tile${isSelected ? ' is-selected' : ''}`}
                    type="button"
                    onClick={async () => {
                      if (busy) return;
                      setSelectedRepo(repo);
                      if (chatVisible && activeRepoFullName === repo.fullName && activeThreadId) {
                        navigate('/chat/');
                        return;
                      }
                      const ok = await startWithRepo(repo);
                      if (ok) navigate('/chat/');
                    }}
                  >
                    <div className="fx-repo-line">
                      <div className="fx-repo-text">
                        <div className="fx-repo-name">{repoName}</div>
                        <div className="fx-repo-owner">{owner}</div>
                      </div>
                      <span className={`fx-chip${cloned ? ' is-ok' : ''}`}>{cloned ? 'クローン済み' : '未クローン'}</span>
                    </div>
                    <div className="fx-mini">最終更新: {repo.updatedAt ? new Date(repo.updatedAt).toLocaleDateString('ja-JP') : '不明'}</div>
                  </button>
                );
              })}
              {filteredRepos.length === 0 ? <p className="fx-mini">一致するリポジトリはありません</p> : null}
            </div>
          </section>
        ) : null}
      </PageContent>
    </Page>
  );
}
