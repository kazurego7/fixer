import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import { App, Page, PageContent, Button, f7ready, f7 } from 'framework7-react';

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
  if (pending) {
    return (
      <div className="fx-typing" aria-label="応答中">
        <span />
        <span />
        <span />
      </div>
    );
  }
  if (item.type === 'diff') {
    return <pre className="fx-diff">{item.text}</pre>;
  }
  return <div dangerouslySetInnerHTML={{ __html: marked.parse(item.text || '') }} />;
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
    sendTurn,
    cancelTurn,
    startNewThread
  } = useContext(AppCtx);
  const canSend = message.trim().length > 0 && !streaming;
  const [isInputFocused, setIsInputFocused] = useState(false);

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
          {outputItems.map((item) => (
            <div key={item.id} className={`fx-msg fx-msg-${item.role}`}>
              <div className="fx-msg-bubble">
                {item.role === 'assistant'
                  ? renderAssistant(item, streaming && !item.text)
                  : <p>{item.text}</p>}
              </div>
            </div>
          ))}
        </article>

        <div className="fx-composer">
          <div className="fx-composer-inner">
            <textarea
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

  async function fetchThreads(repoFullName) {
    const res = await fetch(`/api/threads?repoFullName=${encodeURIComponent(repoFullName)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'thread_list_failed');
    const items = Array.isArray(data.items) ? data.items : [];
    return items.sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime());
  }

  async function fetchThreadMessages(threadId) {
    const res = await fetch(`/api/threads/messages?threadId=${encodeURIComponent(threadId)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'thread_messages_failed');
    return Array.isArray(data.items) ? data.items : [];
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

  async function resolveThreadId(repoFullName, preferredThreadId, options = {}) {
    const { allowCreate = true, preferLatest = false, preferPreferred = false } = options;
    if (preferPreferred && preferredThreadId) return preferredThreadId;
    const threads = await fetchThreads(repoFullName);
    if (preferLatest && threads[0]?.id) return threads[0].id;
    if (preferredThreadId && threads.some((t) => t.id === preferredThreadId)) return preferredThreadId;
    if (threads[0]?.id) return threads[0].id;
    if (!allowCreate) return preferredThreadId || null;
    return createThread(repoFullName);
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
        await fetchRepos(query);
      }
      const threadId = await resolveThreadId(repo.fullName, threadByRepo[repo.fullName] || null, {
        allowCreate: true,
        preferPreferred: true
      });

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

  function looksLikeDiff(text) {
    return /^diff --git/m.test(text) || /^@@/m.test(text) || /^\+\+\+/m.test(text);
  }

  async function sendTurn() {
    if (streaming) return;
    if (!activeRepoFullName) {
      toast('リポジトリが未選択です');
      return;
    }
    if (!activeThreadId) {
      toast('Threadの準備ができていません');
      return;
    }
    const prompt = message.trim();
    if (!prompt) return;

    let threadIdToUse = activeThreadId;
    try {
      const resolved = await resolveThreadId(activeRepoFullName, activeThreadId, {
        allowCreate: true,
        preferPreferred: true
      });
      if (!resolved) throw new Error('thread_not_found');
      threadIdToUse = resolved;
      if (resolved !== activeThreadId) {
        setActiveThreadId(resolved);
        setThreadByRepo((prev) => ({ ...prev, [activeRepoFullName]: resolved }));
      }
    } catch (e) {
      toast(`Thread再接続失敗: ${String(e.message || 'unknown_error')}`);
      return;
    }

    setMessage('');
    setStreaming(true);

    const userId = `u-${Date.now()}`;
    const assistantId = `a-${Date.now() + 1}`;
    setOutputItems((prev) => [
      ...prev,
      { id: userId, role: 'user', type: 'plain', text: prompt },
      { id: assistantId, role: 'assistant', type: 'markdown', text: '' }
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
        if (firstErr.includes('thread not found') || firstErr.includes('thread_not_found')) {
          const resolved = await resolveThreadId(activeRepoFullName, threadIdToUse, { allowCreate: true });
          if (!resolved) throw new Error(firstErr || 'thread_not_found');
          threadIdToUse = resolved;
          setActiveThreadId(resolved);
          setThreadByRepo((prev) => ({ ...prev, [activeRepoFullName]: resolved }));
          res = await postTurn(threadIdToUse);
        }
      }

      if (!res.ok || !res.body) {
        const err = await res.text();
        throw new Error(err || 'send_failed');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let aggregated = '';
      let reasoning = '';
      let lineBuf = '';

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
              reasoning += evt.delta;
              const composed = reasoning
                ? `**思考**\n\n${reasoning}\n\n---\n\n${aggregated}`
                : aggregated;
              setOutputItems((prev) =>
                prev.map((item) =>
                  item.id === assistantId ? { ...item, text: composed } : item
                )
              );
              continue;
            }
            if (evt.type === 'answer_delta' && evt.delta) {
              aggregated += evt.delta;
              const composed = reasoning
                ? `**思考**\n\n${reasoning}\n\n---\n\n${aggregated}`
                : aggregated;
              setOutputItems((prev) =>
                prev.map((item) => (item.id === assistantId ? { ...item, text: composed } : item))
              );
              continue;
            }
            if (evt.type === 'error') {
              throw new Error(String(evt.message || 'unknown_error'));
            }
          } catch {
            aggregated += trimmed;
            setOutputItems((prev) =>
              prev.map((item) => (item.id === assistantId ? { ...item, text: aggregated } : item))
            );
          }
        }
      }

      const finalText = reasoning
        ? `**思考**\n\n${reasoning}\n\n---\n\n${aggregated}`
        : aggregated;
      const kind = looksLikeDiff(aggregated) ? 'diff' : 'markdown';
      setOutputItems((prev) =>
        prev.map((item) => (item.id === assistantId ? { ...item, type: kind, text: finalText } : item))
      );
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
    if (!connected || !activeRepoFullName || !activeThreadId) return;
    let disposed = false;
    (async () => {
      try {
        const resolved = await resolveThreadId(activeRepoFullName, activeThreadId, {
          allowCreate: false,
          preferPreferred: true
        });
        if (disposed || !resolved || resolved === activeThreadId) return;
        setActiveThreadId(resolved);
        setThreadByRepo((prev) => ({ ...prev, [activeRepoFullName]: resolved }));
        restoreOutputForThread(resolved);
      } catch {
        // 現状維持。送信時エラーでユーザーに通知される。
      }
    })();
    return () => {
      disposed = true;
    };
  }, [connected, activeRepoFullName, activeThreadId]);

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
      chatVisible,
      outputItems,
      outputRef,
      message,
      setMessage,
      streaming,
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
