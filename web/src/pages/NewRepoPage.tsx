import { useState, type ChangeEvent } from 'react';
import { Button, Page, PageContent, f7 } from 'framework7-react';
import { getClientErrorMessage } from '../appUtils';
import { useAppCtx } from '../appContext';

export function NewRepoPage() {
  const { connected, busy, navigate, createRepo, fetchRepos } = useAppCtx();
  const [repoName, setRepoName] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'private'>('private');
  const [errorText, setErrorText] = useState('');

  async function handleCreate(): Promise<void> {
    const normalizedName = repoName.trim();
    if (!normalizedName) {
      setErrorText('リポジトリ名を入力してください');
      return;
    }

    setErrorText('');
    try {
      const created = await createRepo(normalizedName, visibility);
      await fetchRepos('');
      f7.toast.create({ text: `作成しました: ${created.fullName}`, closeTimeout: 1600, position: 'center' }).open();
      navigate('/repos/');
    } catch (error: unknown) {
      setErrorText(getClientErrorMessage(error));
    }
  }

  return (
    <Page noNavbar>
      <PageContent className="fx-page fx-page-repos">
        <section className="fx-repo-create-shell">
          <div className="fx-repo-create-card">
            <div className="fx-repo-create-header">
              <Button tonal className="fx-repo-create-back" onClick={() => navigate('/repos/')}>
                ←
              </Button>
              <div>
                <div className="fx-repo-create-title">新規リポジトリ作成</div>
                <div className="fx-mini">リポジトリ名と公開設定を指定します</div>
              </div>
            </div>

            <label className="fx-repo-create-field">
              <span className="fx-repo-create-label">リポジトリ名</span>
              <input
                value={repoName}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setRepoName(e.currentTarget.value)}
                placeholder="example-repo"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                data-testid="repo-create-name-input"
              />
            </label>

            <div className="fx-repo-create-field">
              <span className="fx-repo-create-label">公開設定</span>
              <div className="fx-repo-create-visibility">
                <button
                  type="button"
                  className={`fx-visibility-option${visibility === 'private' ? ' is-selected' : ''}`}
                  onClick={() => setVisibility('private')}
                  data-testid="repo-create-private"
                >
                  Private
                </button>
                <button
                  type="button"
                  className={`fx-visibility-option${visibility === 'public' ? ' is-selected' : ''}`}
                  onClick={() => setVisibility('public')}
                  data-testid="repo-create-public"
                >
                  Public
                </button>
              </div>
            </div>

            {!connected ? <p className="fx-mini">GitHub接続を確認中です</p> : null}
            {errorText ? <div className="fx-repo-create-error">{errorText}</div> : null}

            <div className="fx-repo-create-actions">
              <Button tonal onClick={() => navigate('/repos/')} disabled={busy}>
                キャンセル
              </Button>
              <Button
                fill
                onClick={() => void handleCreate()}
                disabled={busy || !connected || repoName.trim().length === 0}
                data-testid="repo-create-submit"
              >
                作成
              </Button>
            </div>
          </div>
        </section>
      </PageContent>
    </Page>
  );
}
