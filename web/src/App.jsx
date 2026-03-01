import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import { App, Page, PageContent, Button, f7ready, f7 } from 'framework7-react';

marked.setOptions({ gfm: true, breaks: true });

const CLONE_TIMEOUT_MS = 180000;
const LAST_THREAD_ID_KEY = 'fx:lastThreadId';
const LAST_REPO_FULLNAME_KEY = 'fx:lastRepoFullName';
const THREAD_BY_REPO_KEY = 'fx:threadByRepo';
const AppCtx = createContext(null);

function formatFileSize(size) {
  const bytes = Number(size || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('file_read_failed'));
    reader.readAsDataURL(file);
  });
}

function normalizePath(rawPath) {
  if (rawPath === '/chat' || rawPath === '/chat/') return '/chat/';
  return '/repos/';
}

function getCurrentPath() {
  if (typeof window === 'undefined') return '/repos/';
  const hash = window.location.hash || '';
  if (hash.startsWith('#!/')) return normalizePath(hash.slice(2));
  return normalizePath(window.location.pathname || '/');
}

function pushPath(path, replace = false) {
  const target = normalizePath(path);
  if (typeof window === 'undefined') return target;
  if (replace) window.history.replaceState({}, '', target);
  else window.history.pushState({}, '', target);
  return target;
}

function threadMessagesKey(threadId) {
  return `fx:threadMessages:${threadId}`;
}

function loadJsonFromStorage(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function loadThreadMessages(threadId) {
  if (!threadId || typeof window === 'undefined') return [];
  const items = loadJsonFromStorage(threadMessagesKey(threadId), []);
  return Array.isArray(items) ? items : [];
}

function ReposPage() {
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
  } = useContext(AppCtx);

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
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    fetchRepos(e.target.value).catch((err) => {
                      f7.toast.create({ text: `読み込み失敗: ${err.message}`, closeTimeout: 1400, position: 'center' }).open();
                    });
                  }
                }}
                placeholder="リポジトリ名で検索"
              />
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

function renderAssistant(item, pending = false) {
  const answer = typeof item.answer === 'string' ? item.answer : String(item.text || '');
  const statusText = !answer ? String(item.status || item.text || '').trim() : '';

  if (item.type === 'diff') {
    return <pre className="fx-diff">{answer}</pre>;
  }
  if (pending && answer) {
    return <pre className="fx-stream-live">{answer}</pre>;
  }
  if (pending && !answer && !statusText) return null;
  if (statusText === '・・・') return null;
  if (!answer && statusText) return <div className="fx-stream-status">{statusText}</div>;
  return <div dangerouslySetInnerHTML={{ __html: marked.parse(answer) }} />;
}

function extractDisplayReasoningText(raw) {
  const source = String(raw || '');
  const marker = /\*\*([^*\n][^*\n]*)\*\*/g;
  const matches = [];
  let found = marker.exec(source);
  while (found) {
    matches.push({
      index: found.index,
      markerEnd: marker.lastIndex,
      title: String(found[1] || '').trim()
    });
    found = marker.exec(source);
  }
  if (matches.length === 0) return source.trim();
  if (matches.length === 1) {
    const current = matches[0];
    const body = source.slice(current.markerEnd).trim();
    return [current.title, body].filter(Boolean).join('\n').trim();
  }
  const committed = matches[matches.length - 2];
  const next = matches[matches.length - 1];
  const body = source.slice(committed.markerEnd, next.index).trim();
  return [committed.title, body].filter(Boolean).join('\n').trim();
}

function expandAssistantItems(items) {
  const src = Array.isArray(items) ? items : [];
  const out = [];
  for (const item of src) {
    if (item?.role === 'assistant') {
      const answer =
        typeof item.answer === 'string' && item.answer.length > 0
          ? item.answer
          : String(item.text || '');
      out.push({
        ...item,
        answer,
        text: answer,
        reasoning: ''
      });
      continue;
    }
    out.push(item);
  }
  return out;
}

function withAutoAssistantSeparators(items) {
  const src = Array.isArray(items) ? items : [];
  const out = [];
  let prev = null;
  for (const item of src) {
    const current = item && typeof item === 'object' ? item : null;
    if (!current) continue;

    if (
      prev &&
      prev.type !== 'separator' &&
      current.type !== 'separator' &&
      prev.role === 'assistant' &&
      current.role === 'assistant'
    ) {
      out.push({
        id: `auto-sep:${prev.id}->${current.id}`,
        role: 'system',
        type: 'separator',
        text: ''
      });
    }

    out.push(current);
    prev = current;
  }
  return out;
}

function ChatPage() {
  const {
    connected,
    busy,
    chatVisible,
    navigate,
    activeRepoFullName,
    message,
    setMessage,
    pendingAttachments,
    addImageAttachments,
    removePendingAttachment,
    outputItems,
    outputRef,
    streaming,
    streamingAssistantId,
    liveReasoningText,
    awaitingFirstStreamChunk,
    hasReasoningStarted,
    hasAnswerStarted,
    sendTurn,
    cancelTurn,
    startNewThread
  } = useContext(AppCtx);
  const canSend = (message.trim().length > 0 || pendingAttachments.length > 0) && !streaming;
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [previewIndex, setPreviewIndex] = useState(null);
  const composerInputRef = useRef(null);
  const fileInputRef = useRef(null);
  const swipeStartXRef = useRef(null);
  const swipeStartYRef = useRef(null);
  const displayItems = useMemo(() => withAutoAssistantSeparators(outputItems), [outputItems]);
  const thinkingText = typeof liveReasoningText === 'string' ? liveReasoningText : '';
  const showInitialLoading = streaming && awaitingFirstStreamChunk;
  const showThinkingWorking = streaming && hasReasoningStarted;
  const previewAttachment =
    previewIndex !== null && previewIndex >= 0 && previewIndex < pendingAttachments.length
      ? pendingAttachments[previewIndex]
      : null;
  const canGoPrev = previewIndex !== null && previewIndex > 0;
  const canGoNext = previewIndex !== null && previewIndex < pendingAttachments.length - 1;
  const keepComposerFocus = (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.closest('.fx-attachments-bar')) return;
    if (target.closest('textarea,button,input,select,a,[role="button"]')) return;
    event.preventDefault();
    composerInputRef.current?.focus();
  };
  const closePreview = () => setPreviewIndex(null);
  const openPreviewAt = (idx) => {
    if (idx < 0 || idx >= pendingAttachments.length) return;
    setPreviewIndex(idx);
  };
  const showPrevPreview = () => {
    setPreviewIndex((prev) => {
      if (prev === null || prev <= 0) return prev;
      return prev - 1;
    });
  };
  const showNextPreview = () => {
    setPreviewIndex((prev) => {
      if (prev === null || prev >= pendingAttachments.length - 1) return prev;
      return prev + 1;
    });
  };
  const onPreviewPointerDown = (event) => {
    swipeStartXRef.current = event.clientX;
    swipeStartYRef.current = event.clientY;
  };
  const onPreviewPointerUp = (event) => {
    if (swipeStartXRef.current === null || swipeStartYRef.current === null) return;
    const dx = event.clientX - swipeStartXRef.current;
    const dy = event.clientY - swipeStartYRef.current;
    swipeStartXRef.current = null;
    swipeStartYRef.current = null;
    if (Math.abs(dx) < 40 || Math.abs(dx) <= Math.abs(dy)) return;
    if (dx < 0) showNextPreview();
    else showPrevPreview();
  };
  const onPreviewPointerCancel = () => {
    swipeStartXRef.current = null;
    swipeStartYRef.current = null;
  };

  useEffect(() => {
    if (connected && !chatVisible) navigate('/repos/', true);
  }, [connected, chatVisible, navigate]);

  useEffect(() => {
    if (previewIndex === null) return;
    if (pendingAttachments.length === 0) {
      setPreviewIndex(null);
      return;
    }
    if (previewIndex > pendingAttachments.length - 1) {
      setPreviewIndex(pendingAttachments.length - 1);
    }
  }, [previewIndex, pendingAttachments.length]);

  useEffect(() => {
    if (previewIndex === null) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        closePreview();
        return;
      }
      if (event.key === 'ArrowLeft') {
        showPrevPreview();
        return;
      }
      if (event.key === 'ArrowRight') {
        showNextPreview();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [previewIndex, pendingAttachments.length]);

  if (!chatVisible) {
    return (
      <Page noNavbar>
        <PageContent className="fx-page">
          <p className="fx-mini">接続を準備しています...</p>
        </PageContent>
      </Page>
    );
  }

  return (
    <Page noNavbar>
      <PageContent className="fx-page fx-page-chat">
        <div className="fx-chat-head">
          <button
            className="fx-back-icon"
            type="button"
            onClick={() => navigate('/repos/')}
            data-testid="back-button"
          >
            ←
          </button>
          <span className="fx-repo-pill">{activeRepoFullName}</span>
          <button
            className="fx-new-thread-icon"
            type="button"
            onClick={startNewThread}
            disabled={busy || streaming}
            aria-label="新規スレッド"
            title="新規スレッド"
            data-testid="new-thread-button"
          >
            <svg
              className="fx-new-thread-icon-svg"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <path
                d="M16.8617 4.48667L18.5492 2.79917C19.2814 2.06694 20.4686 2.06694 21.2008 2.79917C21.9331 3.53141 21.9331 4.71859 21.2008 5.45083L10.5822 16.0695C10.0535 16.5981 9.40144 16.9868 8.68489 17.2002L6 18L6.79978 15.3151C7.01323 14.5986 7.40185 13.9465 7.93052 13.4178L16.8617 4.48667ZM16.8617 4.48667L19.5 7.12499M18 14V18.75C18 19.9926 16.9926 21 15.75 21H5.25C4.00736 21 3 19.9926 3 18.75V8.24999C3 7.00735 4.00736 5.99999 5.25 5.99999H10"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>

        <article className="fx-chat-scroll" ref={outputRef}>
          {displayItems.map((item) => {
            if (item.type === 'separator') {
              return <div key={item.id} className="fx-turn-separator" />;
            }
            if (item.role !== 'assistant' && item.role !== 'user') {
              return (
                <div key={item.id} className="fx-msg fx-msg-system">
                  <div className="fx-msg-bubble">
                    <pre className="fx-system-line">{String(item.text || '')}</pre>
                  </div>
                </div>
              );
            }
            if (item.role === 'assistant' && streaming && item.id === streamingAssistantId) {
              const currentAnswer = typeof item.answer === 'string' ? item.answer : String(item.text || '');
              const currentStatus = !currentAnswer ? String(item.status || item.text || '').trim() : '';
              if (!currentAnswer.trim() && !currentStatus.trim()) return null;
            }
            return (
              <div key={item.id} className={`fx-msg fx-msg-${item.role}`}>
                <div className="fx-msg-bubble">
                  {item.role === 'assistant'
                    ? renderAssistant(item, streaming && item.id === streamingAssistantId)
                    : (
                      <>
                        {item.text ? <p className="fx-user-line">{item.text}</p> : null}
                        {Array.isArray(item.attachments) && item.attachments.length > 0 ? (
                          <div className="fx-user-attachments">
                            {item.attachments.map((att, idx) => (
                              <span key={`${item.id}:att:${idx}`} className="fx-user-attachment-chip">
                                画像: {String(att?.name || 'image')} ({formatFileSize(att?.size)})
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </>
                    )}
                </div>
              </div>
            );
          })}
          {showInitialLoading ? (
            <div className="fx-thinking-live-panel fx-working-panel" data-testid="stream-loading-indicator" aria-live="polite">
              <div className="fx-working-dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
            </div>
          ) : null}
          {showThinkingWorking ? (
            <div className="fx-thinking-live-panel fx-working-panel" data-testid="thinking-working-indicator" aria-live="polite">
              <div className="fx-working-dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
              {thinkingText ? <pre className="fx-thinking-live-text" data-testid="thinking-live-content">{thinkingText}</pre> : null}
            </div>
          ) : null}
        </article>

        <div className="fx-composer" onPointerDownCapture={keepComposerFocus} data-testid="composer">
          {pendingAttachments.length > 0 ? (
            <div className="fx-attachments-bar" data-testid="attachments-bar">
              <div className="fx-attachments-list" data-testid="attachments-list">
                {pendingAttachments.map((att, idx) => (
                  <div
                    key={`${att.name}:${att.size}:${idx}`}
                    className="fx-attachment-item"
                    role="button"
                    tabIndex={0}
                    onClick={() => openPreviewAt(idx)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        openPreviewAt(idx);
                      }
                    }}
                    aria-label={`プレビュー: ${att.name}`}
                    title="プレビュー"
                    data-testid={`attachment-item-${idx}`}
                  >
                    <img
                      src={att.dataUrl}
                      alt={att.name}
                      className="fx-attachment-thumb"
                      data-testid={`attachment-thumb-${idx}`}
                    />
                    <div className="fx-attachment-meta">
                      <span className="fx-attachment-name">{att.name}</span>
                      <span className="fx-attachment-size">{formatFileSize(att.size)}</span>
                    </div>
                    <button
                      type="button"
                      className="fx-attachment-remove"
                      onClick={(e) => {
                        e.stopPropagation();
                        removePendingAttachment(idx);
                      }}
                      aria-label={`添付解除: ${att.name}`}
                      title="添付解除"
                      data-testid={`attachment-remove-${idx}`}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          <div className="fx-composer-inner">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="fx-file-input"
              data-testid="attachment-input"
              onChange={async (e) => {
                await addImageAttachments(e.target.files);
                e.target.value = '';
                composerInputRef.current?.focus();
              }}
            />
            <Button
              tonal
              className="fx-icon-btn fx-attach-btn"
              onClick={() => fileInputRef.current?.click()}
              aria-label="画像を添付"
              title="画像を添付"
              data-testid="attachment-add-button"
            >
              ＋
            </Button>
            <textarea
              ref={composerInputRef}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={1}
              placeholder="指示を入力"
              onFocus={() => setIsInputFocused(true)}
              onBlur={() => setIsInputFocused(false)}
              data-testid="composer-textarea"
            />
            <div
              className={`fx-composer-actions${
                !isInputFocused && !streaming && message.trim().length === 0 && pendingAttachments.length === 0
                  ? ' is-hidden'
                  : ''
              }`}
            >
              {streaming ? (
                <Button
                  tonal
                  className="fx-icon-btn"
                  onClick={cancelTurn}
                  aria-label="停止"
                  title="停止"
                >
                  ■
                </Button>
              ) : (
                <Button
                  fill
                  className="fx-icon-btn"
                  onClick={sendTurn}
                  disabled={!canSend}
                  aria-label="送信"
                  title="送信"
                  data-testid="send-button"
                >
                  <svg
                    className="fx-send-icon-svg"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    xmlns="http://www.w3.org/2000/svg"
                    aria-hidden="true"
                  >
                    <path
                      d="M3.105 3.105a.75.75 0 0 1 .826-.164l17.25 8.25a.75.75 0 0 1 0 1.356l-17.25 8.25a.75.75 0 0 1-1.059-.86L4.56 13.5H12a.75.75 0 0 0 0-1.5H4.56L2.872 4.063a.75.75 0 0 1 .233-.958Z"
                    />
                  </svg>
                </Button>
              )}
            </div>
          </div>
        </div>
        {previewAttachment ? (
          <div
            className="fx-image-preview-overlay"
            role="dialog"
            aria-modal="true"
            onClick={closePreview}
            data-testid="image-preview-overlay"
          >
            <div
              className="fx-image-preview-panel"
              onClick={(e) => e.stopPropagation()}
              onPointerDown={onPreviewPointerDown}
              onPointerUp={onPreviewPointerUp}
              onPointerCancel={onPreviewPointerCancel}
              data-testid="image-preview-panel"
            >
              <button
                type="button"
                className="fx-image-preview-close"
                onClick={closePreview}
                aria-label="プレビューを閉じる"
                title="閉じる"
                data-testid="image-preview-close"
              >
                ×
              </button>
              <button
                type="button"
                className="fx-image-preview-nav is-left"
                onClick={showPrevPreview}
                disabled={!canGoPrev}
                aria-label="前の画像"
                title="前の画像"
                data-testid="image-preview-prev"
              >
                ‹
              </button>
              <img
                src={previewAttachment.dataUrl}
                alt={previewAttachment.name}
                className="fx-image-preview-img"
                data-testid="image-preview-img"
              />
              <button
                type="button"
                className="fx-image-preview-nav is-right"
                onClick={showNextPreview}
                disabled={!canGoNext}
                aria-label="次の画像"
                title="次の画像"
                data-testid="image-preview-next"
              >
                ›
              </button>
              <div className="fx-image-preview-caption" data-testid="image-preview-caption">
                <span className="fx-image-preview-name">{previewAttachment.name}</span>
                <span className="fx-image-preview-index">
                  {previewIndex + 1} / {pendingAttachments.length}
                </span>
              </div>
            </div>
          </div>
        ) : null}
      </PageContent>
    </Page>
  );
}

export default function AppRoot() {
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const [query, setQuery] = useState('');
  const [repos, setRepos] = useState([]);
  const [repoFilter, setRepoFilter] = useState('all');
  const [selectedRepo, setSelectedRepo] = useState(null);

  const initialThreadId = typeof window !== 'undefined' ? window.localStorage.getItem(LAST_THREAD_ID_KEY) : null;
  const initialRepoFullName = typeof window !== 'undefined' ? window.localStorage.getItem(LAST_REPO_FULLNAME_KEY) : null;
  const [activeThreadId, setActiveThreadId] = useState(initialThreadId);
  const [activeRepoFullName, setActiveRepoFullName] = useState(initialRepoFullName);
  const [chatVisible, setChatVisible] = useState(Boolean(initialThreadId && initialRepoFullName));

  const [message, setMessage] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const [outputItems, setOutputItems] = useState([]);
  const [streaming, setStreaming] = useState(false);
  const [streamingAssistantId, setStreamingAssistantId] = useState(null);
  const [liveReasoningText, setLiveReasoningText] = useState('');
  const [awaitingFirstStreamChunk, setAwaitingFirstStreamChunk] = useState(false);
  const [hasReasoningStarted, setHasReasoningStarted] = useState(false);
  const [hasAnswerStarted, setHasAnswerStarted] = useState(false);
  const [currentPath, setCurrentPath] = useState(getCurrentPath());
  const [threadByRepo, setThreadByRepo] = useState(() => {
    if (typeof window === 'undefined') return {};
    const map = loadJsonFromStorage(THREAD_BY_REPO_KEY, {});
    if (initialRepoFullName && initialThreadId && !map[initialRepoFullName]) {
      map[initialRepoFullName] = initialThreadId;
    }
    return map;
  });

  const outputRef = useRef(null);
  const autoScrollRef = useRef(true);
  const streamAbortRef = useRef(null);
  const didBootstrapRef = useRef(false);
  const lastPathRef = useRef(getCurrentPath());
  const activeThreadRef = useRef(activeThreadId);

  function toast(text) {
    f7?.toast?.create({ text, closeTimeout: 1400, position: 'center' }).open();
  }

  async function addImageAttachments(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    const next = [];

    for (const file of files) {
      if (!file.type || !file.type.startsWith('image/')) {
        toast(`画像のみ添付できます: ${file.name}`);
        continue;
      }
      try {
        const dataUrl = await readFileAsDataUrl(file);
        if (!dataUrl) throw new Error('empty_data_url');
        next.push({
          type: 'image',
          name: String(file.name || 'image'),
          mime: String(file.type || 'image/*'),
          size: Number(file.size || 0),
          dataUrl
        });
      } catch {
        toast(`画像読み込み失敗: ${file.name}`);
      }
    }

    if (next.length > 0) setPendingAttachments((prev) => [...prev, ...next]);
  }

  function removePendingAttachment(index) {
    setPendingAttachments((prev) => prev.filter((_, idx) => idx !== index));
  }

  function notifyResponseComplete() {
    const title = 'Fixer';
    const body = '返答が完了しました';
    if (typeof window === 'undefined') return;
    if (!('Notification' in window)) return;

    if (Notification.permission === 'granted') {
      new Notification(title, { body });
      return;
    }

    if (Notification.permission === 'default') {
      Notification.requestPermission().then((permission) => {
        if (permission === 'granted') new Notification(title, { body });
      });
    }
  }

  async function checkAuthStatus() {
    const res = await fetch('/api/github/auth/status');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'auth_status_failed');
    return data;
  }

  async function fetchRepos(nextQuery = query) {
    const res = await fetch(`/api/github/repos?query=${encodeURIComponent(nextQuery.trim())}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.hint || data.error || 'repo_load_failed');
    setRepos(data.repos || []);
  }

  async function fetchThreadMessages(threadId) {
    const res = await fetch(`/api/threads/messages?threadId=${encodeURIComponent(threadId)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'thread_messages_failed');
    return expandAssistantItems(Array.isArray(data.items) ? data.items : []);
  }

  async function ensureThread(repoFullName, preferredThreadId = null) {
    const res = await fetch('/api/threads/ensure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoFullName,
        preferred_thread_id: preferredThreadId || undefined
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'thread_ensure_failed');
    const id = data.id || data.thread_id;
    if (!id) throw new Error('thread_id_missing');
    return id;
  }

  function isRecoverableThreadError(text) {
    const raw = String(text || '');
    return (
      raw.includes('thread not found') ||
      raw.includes('thread_not_found') ||
      raw.includes('no rollout found for thread id')
    );
  }

  function looksLikeDiff(text) {
    return /^diff --git/m.test(text) || /^@@/m.test(text) || /^\+\+\+/m.test(text);
  }

  async function bootstrapConnection() {
    setConnected(false);
    setError(null);
    setRepos([]);
    setSelectedRepo(null);
    try {
      const auth = await checkAuthStatus();
      if (!auth.available) {
        setError({ title: 'gh CLIが利用できません', cause: auth.hint || 'gh のインストール状況を確認してください。' });
        return;
      }
      if (!auth.connected) {
        setError({ title: 'GitHubに未ログインです', cause: auth.hint || '`gh auth login` を実行してください。' });
        return;
      }
      setConnected(true);
      await fetchRepos('');
    } catch (e) {
      setError({ title: '接続確認に失敗しました', cause: e.message || 'unknown_error' });
    }
  }

  async function refreshCloneState(fullName) {
    const res = await fetch(`/api/repos/clone-status?fullName=${encodeURIComponent(fullName)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'clone_status_failed');
    return data;
  }

  async function cloneSelectedRepo(repo) {
    const res = await fetch('/api/repos/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullName: repo.fullName, cloneUrl: repo.cloneUrl })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'clone_failed');
    return data;
  }

  async function waitForClone(fullName, timeoutMs = CLONE_TIMEOUT_MS) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const data = await refreshCloneState(fullName);
      if (data.status === 'cloned') return data;
      if (data.status === 'failed') throw new Error(data.error || 'clone_failed');
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`clone_timeout_${Math.floor(timeoutMs / 1000)}s`);
  }

  async function createThread(repoFullName) {
    const res = await fetch('/api/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoFullName, title: `thread-${Date.now()}` })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'thread_create_failed');
    const id = data.id || data.thread_id;
    if (!id) throw new Error('thread_id_missing');
    return id;
  }

  function restoreOutputForThread(threadId) {
    if (!threadId) return;
    // スレッド切替直後でも、到着した履歴を破棄しないよう即時更新する。
    activeThreadRef.current = threadId;
    const cached = loadThreadMessages(threadId);
    setOutputItems(cached);
    fetchThreadMessages(threadId)
      .then((items) => {
        if (activeThreadRef.current !== threadId) return;
        setOutputItems(items);
      })
      .catch(() => {
        // API取得に失敗した場合はキャッシュ表示を維持する。
      });
  }

  async function startWithRepo(repo) {
    setBusy(true);
    try {
      setPendingAttachments([]);
      setSelectedRepo(repo);
      if (repo.cloneState?.status !== 'cloned') {
        await cloneSelectedRepo(repo);
        await waitForClone(repo.fullName);
        setRepos((prev) =>
          prev.map((item) =>
            item.fullName === repo.fullName
              ? { ...item, cloneState: { ...(item.cloneState || {}), status: 'cloned' } }
              : item
          )
        );
      }
      let threadId = threadByRepo[repo.fullName] || null;
      threadId = await ensureThread(repo.fullName, threadId);

      if (!threadId) throw new Error('thread_not_found');
      setActiveThreadId(threadId);
      setActiveRepoFullName(repo.fullName);
      setChatVisible(true);
      setThreadByRepo((prev) => ({ ...prev, [repo.fullName]: threadId }));
      restoreOutputForThread(threadId);
      toast('接続しました');
      return true;
    } catch (e) {
      toast(`接続失敗: ${String(e.message || 'unknown_error')}`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function sendTurn() {
    if (streaming) return;
    if (!activeRepoFullName) {
      toast('リポジトリが未選択です');
      return;
    }
    if (!activeThreadId) {
      try {
        const created = await ensureThread(activeRepoFullName, null);
        setActiveThreadId(created);
        setThreadByRepo((prev) => ({ ...prev, [activeRepoFullName]: created }));
        restoreOutputForThread(created);
      } catch (e) {
        toast(`Thread準備失敗: ${String(e.message || 'unknown_error')}`);
        return;
      }
    }
    const prompt = message.trim();
    if (!prompt && pendingAttachments.length === 0) return;
    const attachmentsToSend = pendingAttachments;

    let threadIdToUse = activeThreadId || threadByRepo[activeRepoFullName];
    if (!threadIdToUse) return;

    try {
      const ensured = await ensureThread(activeRepoFullName, threadIdToUse);
      threadIdToUse = ensured;
      if (ensured !== activeThreadId) {
        setActiveThreadId(ensured);
        setThreadByRepo((prev) => ({ ...prev, [activeRepoFullName]: ensured }));
        restoreOutputForThread(ensured);
      }
    } catch (e) {
      toast(`Thread再接続失敗: ${String(e.message || 'unknown_error')}`);
      return;
    }

    setMessage('');
    setPendingAttachments([]);
    setLiveReasoningText('');
    setAwaitingFirstStreamChunk(true);
    setHasReasoningStarted(false);
    setHasAnswerStarted(false);
    setStreaming(true);

    const userId = `u-${Date.now()}`;
    const assistantId = `a-${Date.now() + 1}`;
    const attachmentMeta = attachmentsToSend.map((att) => ({
      type: 'image',
      name: att.name,
      size: att.size,
      mime: att.mime
    }));
    setStreamingAssistantId(assistantId);
    setOutputItems((prev) => [
      ...prev,
      { id: userId, role: 'user', type: 'plain', text: prompt, attachments: attachmentMeta },
      { id: assistantId, role: 'assistant', type: 'markdown', text: '', status: '', answer: '' }
    ]);

    const controller = new AbortController();
    streamAbortRef.current = controller;
    let completedNormally = false;

    try {
      async function postTurn(targetThreadId) {
        return fetch('/api/turns/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            thread_id: targetThreadId,
            input: prompt,
            attachments: attachmentsToSend
          }),
          signal: controller.signal
        });
      }

      let res = await postTurn(threadIdToUse);
      if (!res.ok) {
        const firstErr = await res.text();
        if (isRecoverableThreadError(firstErr)) {
          const recovered = await ensureThread(activeRepoFullName, null);
          threadIdToUse = recovered;
          setActiveThreadId(recovered);
          setThreadByRepo((prev) => ({ ...prev, [activeRepoFullName]: recovered }));
          restoreOutputForThread(recovered);
          res = await postTurn(threadIdToUse);
        } else {
          throw new Error(firstErr || 'send_failed');
        }
      }

      if (!res.ok || !res.body) {
        const err = await res.text();
        throw new Error(err || 'send_failed');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let answerCommitted = '';
      let reasoningRaw = '';
      let lineBuf = '';

      function updateAssistant(patch) {
        setOutputItems((prev) =>
          prev.map((item) => {
            if (item.id !== assistantId) return item;
            const merged = typeof patch === 'function' ? patch(item) : { ...item, ...patch };
            return merged;
          })
        );
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        lineBuf += decoder.decode(value, { stream: true });
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const evt = JSON.parse(trimmed);
            if (evt.type === 'reasoning_delta' && evt.delta) {
              setAwaitingFirstStreamChunk(false);
              setHasReasoningStarted(true);
              reasoningRaw += evt.delta;
              const displayReasoning = extractDisplayReasoningText(reasoningRaw);
              if (displayReasoning) setLiveReasoningText(displayReasoning);
              continue;
            }
            if (evt.type === 'answer_delta' && evt.delta) {
              setAwaitingFirstStreamChunk(false);
              setHasAnswerStarted(true);
              answerCommitted += evt.delta;
              const nextType = looksLikeDiff(answerCommitted) ? 'diff' : 'plain';
              updateAssistant({ type: nextType, answer: answerCommitted, text: answerCommitted, status: '' });
              continue;
            }
            if (evt.type === 'started') {
              continue;
            }
            if (evt.type === 'status' && (evt.phase === 'starting' || evt.phase === 'reconnecting')) {
              continue;
            }
            if (evt.type === 'error') {
              throw new Error(String(evt.message || 'unknown_error'));
            }
          } catch {
            setAwaitingFirstStreamChunk(false);
            setHasAnswerStarted(true);
            answerCommitted += `${line}\n`;
            const nextType = looksLikeDiff(answerCommitted) ? 'diff' : 'plain';
            updateAssistant({ type: nextType, answer: answerCommitted, text: answerCommitted, status: '' });
          }
        }
      }

      if (lineBuf.trim()) {
        try {
          const evt = JSON.parse(lineBuf.trim());
          if (evt.type === 'answer_delta' && evt.delta) {
            setAwaitingFirstStreamChunk(false);
            setHasAnswerStarted(true);
            answerCommitted += evt.delta;
            const nextType = looksLikeDiff(answerCommitted) ? 'diff' : 'plain';
            updateAssistant({ type: nextType, answer: answerCommitted, text: answerCommitted, status: '' });
          }
        } catch {
          setAwaitingFirstStreamChunk(false);
          setHasAnswerStarted(true);
          answerCommitted += lineBuf;
        }
      }

      const finalAnswer = answerCommitted.trim() ? answerCommitted : '(応答なし)';
      const finalType = looksLikeDiff(finalAnswer) ? 'diff' : 'markdown';
      setOutputItems((prev) => {
        const next = prev.map((item) =>
          item.id === assistantId
            ? { ...item, type: finalType, status: '', answer: finalAnswer, text: finalAnswer }
            : item
        );
        next.push({ id: `${assistantId}:sep`, role: 'system', type: 'separator', text: '' });
        return next;
      });
      completedNormally = true;
    } catch (e) {
      if (e.name === 'AbortError') {
        setOutputItems((prev) =>
          prev.map((item) => (item.id === assistantId ? { ...item, text: '(停止しました)' } : item))
        );
      } else {
        setOutputItems((prev) =>
          prev.map((item) =>
            item.id === assistantId
              ? { ...item, text: `送信失敗: ${String(e.message || 'unknown_error')}` }
              : item
          )
        );
        toast('送信に失敗しました');
      }
    } finally {
      setStreaming(false);
      setStreamingAssistantId(null);
      setLiveReasoningText('');
      setAwaitingFirstStreamChunk(false);
      setHasReasoningStarted(false);
      setHasAnswerStarted(false);
      streamAbortRef.current = null;
      if (completedNormally) notifyResponseComplete();
    }
  }

  async function startNewThread() {
    if (streaming) return;
    if (!activeRepoFullName) {
      toast('リポジトリが未選択です');
      return;
    }
    setBusy(true);
    try {
      const id = await createThread(activeRepoFullName);
      setActiveThreadId(id);
      setThreadByRepo((prev) => ({ ...prev, [activeRepoFullName]: id }));
      setOutputItems([]);
      setMessage('');
      setPendingAttachments([]);
      toast('新規スレッドを開始しました');
    } catch (e) {
      toast(`新規スレッド開始失敗: ${String(e.message || 'unknown_error')}`);
    } finally {
      setBusy(false);
    }
  }

  function cancelTurn() {
    if (!streamAbortRef.current) return;
    streamAbortRef.current.abort();
  }

  function navigate(path, replace = false) {
    const next = pushPath(path, replace);
    setCurrentPath(next);
  }

  useEffect(() => {
    if (didBootstrapRef.current) return;
    didBootstrapRef.current = true;
    f7ready(() => {
      if (window.location.pathname === '/') navigate(chatVisible ? '/chat/' : '/repos/', true);
      else setCurrentPath(getCurrentPath());
      bootstrapConnection();
    });
  }, []);

  useEffect(() => {
    const onPopState = () => setCurrentPath(getCurrentPath());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (currentPath === '/chat/' && !chatVisible && connected) navigate('/repos/', true);
  }, [currentPath, chatVisible, connected]);

  useEffect(() => {
    if (!connected) return;
    const prevPath = lastPathRef.current;
    lastPathRef.current = currentPath;
    if (currentPath !== '/repos/' || prevPath === '/repos/') return;
    setSelectedRepo(null);
    fetchRepos(query).catch(() => {});
  }, [currentPath, connected, query]);

  useEffect(() => {
    activeThreadRef.current = activeThreadId;
  }, [activeThreadId]);

  useEffect(() => {
    if (activeThreadId && activeRepoFullName) {
      window.localStorage.setItem(LAST_THREAD_ID_KEY, activeThreadId);
      window.localStorage.setItem(LAST_REPO_FULLNAME_KEY, activeRepoFullName);
      return;
    }
    window.localStorage.removeItem(LAST_THREAD_ID_KEY);
    window.localStorage.removeItem(LAST_REPO_FULLNAME_KEY);
  }, [activeThreadId, activeRepoFullName]);

  useEffect(() => {
    if (!activeRepoFullName || !activeThreadId) return;
    setThreadByRepo((prev) => {
      if (prev[activeRepoFullName] === activeThreadId) return prev;
      return { ...prev, [activeRepoFullName]: activeThreadId };
    });
  }, [activeRepoFullName, activeThreadId]);

  useEffect(() => {
    window.localStorage.setItem(THREAD_BY_REPO_KEY, JSON.stringify(threadByRepo));
  }, [threadByRepo]);

  useEffect(() => {
    if (!activeThreadId) return;
    window.localStorage.setItem(threadMessagesKey(activeThreadId), JSON.stringify(outputItems.slice(-200)));
  }, [activeThreadId, outputItems]);

  useEffect(() => {
    if (!autoScrollRef.current || !outputRef.current) return;
    outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [outputItems]);

  useEffect(() => {
    if (!activeThreadId) return;
    restoreOutputForThread(activeThreadId);
  }, [activeThreadId]);

  const clonedRepos = repos.filter((repo) => repo.cloneState?.status === 'cloned');
  const notClonedRepos = repos.filter((repo) => repo.cloneState?.status !== 'cloned');
  const filteredRepos = repoFilter === 'cloned' ? clonedRepos : repoFilter === 'not_cloned' ? notClonedRepos : repos;

  const ctx = useMemo(
    () => ({
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
      outputItems,
      outputRef,
      message,
      setMessage,
      pendingAttachments,
      addImageAttachments,
      removePendingAttachment,
      streaming,
      streamingAssistantId,
      liveReasoningText,
      awaitingFirstStreamChunk,
      hasReasoningStarted,
      hasAnswerStarted,
      navigate,
      bootstrapConnection,
      fetchRepos,
      startWithRepo,
      sendTurn,
      cancelTurn,
      startNewThread
    }),
    [
      connected,
      error,
      busy,
      query,
      repos,
      repoFilter,
      selectedRepo,
      clonedRepos,
      notClonedRepos,
      filteredRepos,
      activeRepoFullName,
      activeThreadId,
      chatVisible,
      outputItems,
      message,
      pendingAttachments,
      streaming,
      liveReasoningText,
      awaitingFirstStreamChunk,
      hasReasoningStarted,
      hasAnswerStarted,
      navigate
    ]
  );

  return (
    <App theme="auto">
      <AppCtx.Provider value={ctx}>
        {currentPath === '/chat/' ? <ChatPage /> : <ReposPage />}
      </AppCtx.Provider>
    </App>
  );
}
