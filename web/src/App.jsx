import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import { App, Page, PageContent, Button, f7ready, f7 } from 'framework7-react';

marked.setOptions({ gfm: true, breaks: true });

const CLONE_TIMEOUT_MS = 180000;
const LAST_THREAD_ID_KEY = 'fx:lastThreadId';
const LAST_REPO_FULLNAME_KEY = 'fx:lastRepoFullName';
const THREAD_BY_REPO_KEY = 'fx:threadByRepo';
const AppCtx = createContext(null);

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
  if (pending || statusText === '・・・') {
    return (
      <div className="fx-ellipsis" aria-label="応答中">
        <span>・</span>
        <span>・</span>
        <span>・</span>
      </div>
    );
  }
  if (!answer && statusText) return <div className="fx-stream-status">{statusText}</div>;
  return <div dangerouslySetInnerHTML={{ __html: marked.parse(answer) }} />;
}

function extractFirstBold(text) {
  const source = String(text || '');
  const match = source.match(/\*\*([^*\n][^*\n]*)\*\*/);
  return match ? match[1].trim() : '';
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
    outputItems,
    outputRef,
    streaming,
    streamingAssistantId,
    sendTurn,
    cancelTurn,
    startNewThread
  } = useContext(AppCtx);
  const canSend = message.trim().length > 0 && !streaming;
  const [isInputFocused, setIsInputFocused] = useState(false);
  const composerInputRef = useRef(null);
  const displayItems = useMemo(() => withAutoAssistantSeparators(outputItems), [outputItems]);
  const keepComposerFocus = (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.closest('textarea,button,input,select,a,[role="button"]')) return;
    event.preventDefault();
    composerInputRef.current?.focus();
  };

  useEffect(() => {
    if (connected && !chatVisible) navigate('/repos/', true);
  }, [connected, chatVisible, navigate]);

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
          <button className="fx-back-icon" type="button" onClick={() => navigate('/repos/')}>←</button>
          <span className="fx-repo-pill">{activeRepoFullName}</span>
          <button
            className="fx-new-thread-icon"
            type="button"
            onClick={startNewThread}
            disabled={busy || streaming}
            aria-label="新規スレッド"
            title="新規スレッド"
          >
            ＋
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
            return (
              <div key={item.id} className={`fx-msg fx-msg-${item.role}`}>
                <div className="fx-msg-bubble">
                  {item.role === 'assistant'
                    ? renderAssistant(item, streaming && item.id === streamingAssistantId)
                    : <p className="fx-user-line">{item.text}</p>}
                </div>
              </div>
            );
          })}
        </article>

        <div className="fx-composer" onPointerDownCapture={keepComposerFocus}>
          <div className="fx-composer-inner">
            <textarea
              ref={composerInputRef}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={1}
              placeholder="指示を入力"
              onFocus={() => setIsInputFocused(true)}
              onBlur={() => setIsInputFocused(false)}
            />
            <div
              className={`fx-composer-actions${
                !isInputFocused && !streaming && message.trim().length === 0 ? ' is-hidden' : ''
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
                >
                  ↗
                </Button>
              )}
            </div>
          </div>
        </div>
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
  const [outputItems, setOutputItems] = useState([]);
  const [streaming, setStreaming] = useState(false);
  const [streamingAssistantId, setStreamingAssistantId] = useState(null);
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
    if (!prompt) return;

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
    setStreaming(true);

    const userId = `u-${Date.now()}`;
    const assistantId = `a-${Date.now() + 1}`;
    setStreamingAssistantId(assistantId);
    setOutputItems((prev) => [
      ...prev,
      { id: userId, role: 'user', type: 'plain', text: prompt },
      { id: assistantId, role: 'assistant', type: 'markdown', text: '', status: '・・・', answer: '' }
    ]);

    const controller = new AbortController();
    streamAbortRef.current = controller;
    let completedNormally = false;

    try {
      async function postTurn(targetThreadId) {
        return fetch('/api/turns/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ thread_id: targetThreadId, input: prompt, attachments: [] }),
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
      let statusText = '';
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
              reasoningRaw += evt.delta;
              const header = extractFirstBold(reasoningRaw);
              statusText = header ? `考え中: ${header}` : '・・・';
              if (!answerCommitted) updateAssistant({ status: statusText, text: statusText });
              continue;
            }
            if (evt.type === 'answer_delta' && evt.delta) {
              statusText = '';
              answerCommitted += evt.delta;
              const nextType = looksLikeDiff(answerCommitted) ? 'diff' : 'plain';
              updateAssistant({ type: nextType, answer: answerCommitted, text: answerCommitted, status: '' });
              continue;
            }
            if (evt.type === 'started') {
              statusText = '・・・';
              updateAssistant({ status: statusText, text: statusText });
              continue;
            }
            if (evt.type === 'status' && (evt.phase === 'starting' || evt.phase === 'reconnecting')) {
              statusText = evt.phase === 'reconnecting' ? String(evt.message || '再接続中...') : '・・・';
              if (!answerCommitted) updateAssistant({ status: statusText, text: statusText });
              continue;
            }
            if (evt.type === 'error') {
              throw new Error(String(evt.message || 'unknown_error'));
            }
          } catch {
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
            answerCommitted += evt.delta;
            const nextType = looksLikeDiff(answerCommitted) ? 'diff' : 'plain';
            updateAssistant({ type: nextType, answer: answerCommitted, text: answerCommitted, status: '' });
          }
        } catch {
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
      streaming,
      streamingAssistantId,
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
      streaming,
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
