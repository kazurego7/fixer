const state = {
  selectedRepo: null,
  threads: [],
  activeThreadId: null,
  currentTurnId: null,
  attachedImage: null
};

const el = {
  token: document.getElementById('token'),
  query: document.getElementById('query'),
  loadRepos: document.getElementById('loadRepos'),
  repoList: document.getElementById('repoList'),
  cloneState: document.getElementById('cloneState'),
  cloneBtn: document.getElementById('cloneBtn'),
  loadThreads: document.getElementById('loadThreads'),
  newThread: document.getElementById('newThread'),
  threadList: document.getElementById('threadList'),
  activeThread: document.getElementById('activeThread'),
  imageInput: document.getElementById('imageInput'),
  message: document.getElementById('message'),
  send: document.getElementById('send'),
  cancel: document.getElementById('cancel'),
  autoScroll: document.getElementById('autoScroll'),
  output: document.getElementById('output')
};

el.token.value = localStorage.getItem('githubToken') || '';
el.token.addEventListener('change', () => localStorage.setItem('githubToken', el.token.value.trim()));

function appendOutput(text, role = 'plain') {
  const wrapper = document.createElement('div');
  if (role === 'markdown') {
    try {
      wrapper.innerHTML = marked.parse(text);
    } catch {
      wrapper.textContent = text;
    }
  } else if (role === 'diff') {
    wrapper.className = 'diff';
    wrapper.textContent = text;
  } else {
    wrapper.textContent = text;
  }
  el.output.appendChild(wrapper);
  if (el.autoScroll.checked) {
    el.output.scrollTop = el.output.scrollHeight;
  }
}

function renderRepos(repos) {
  el.repoList.innerHTML = '';
  repos.forEach((repo) => {
    const li = document.createElement('li');
    li.innerHTML = `<strong>${repo.fullName}</strong><br/>状態: ${repo.cloneState.status}`;
    const btn = document.createElement('button');
    btn.textContent = '選択';
    btn.onclick = () => {
      state.selectedRepo = repo;
      el.cloneState.textContent = `${repo.fullName} / ${repo.cloneState.status}`;
      appendOutput(`リポジトリ選択: ${repo.fullName}`);
    };
    li.appendChild(btn);
    el.repoList.appendChild(li);
  });
}

async function loadRepos() {
  const res = await fetch(`/api/github/repos?query=${encodeURIComponent(el.query.value.trim())}`, {
    headers: { 'x-github-token': el.token.value.trim() }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'repo_load_failed');
  renderRepos(data.repos);
}

async function refreshCloneState() {
  if (!state.selectedRepo) return;
  const res = await fetch(`/api/repos/clone-status?fullName=${encodeURIComponent(state.selectedRepo.fullName)}`);
  const data = await res.json();
  el.cloneState.textContent = `${state.selectedRepo.fullName} / ${data.status}`;
}

async function cloneSelectedRepo() {
  if (!state.selectedRepo) return alert('先にリポジトリを選択してください');
  const res = await fetch('/api/repos/clone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fullName: state.selectedRepo.fullName, cloneUrl: state.selectedRepo.cloneUrl })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'clone_failed');
  el.cloneState.textContent = `${state.selectedRepo.fullName} / ${data.status}`;

  const timer = setInterval(async () => {
    await refreshCloneState();
    if (/cloned|failed/.test(el.cloneState.textContent)) clearInterval(timer);
  }, 1000);
}

function normalizeThreads(data) {
  const list = data.threads || data.items || [];
  return list.map((t) => ({ id: t.id || t.thread_id, title: t.title || t.id || 'untitled' }));
}

function renderThreads() {
  el.threadList.innerHTML = '';
  state.threads.forEach((thread) => {
    const li = document.createElement('li');
    li.innerHTML = `<strong>${thread.title}</strong><br/>ID: ${thread.id}`;
    const btn = document.createElement('button');
    btn.textContent = '再開';
    btn.onclick = () => {
      state.activeThreadId = thread.id;
      el.activeThread.textContent = `選択中Thread: ${thread.id}`;
    };
    li.appendChild(btn);
    el.threadList.appendChild(li);
  });
}

async function loadThreads() {
  if (!state.selectedRepo) return alert('先にリポジトリを選択してください');
  const res = await fetch(`/api/threads?repoFullName=${encodeURIComponent(state.selectedRepo.fullName)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'thread_load_failed');
  state.threads = normalizeThreads(data);
  renderThreads();
}

async function createThread() {
  if (!state.selectedRepo) return alert('先にリポジトリを選択してください');
  const res = await fetch('/api/threads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoFullName: state.selectedRepo.fullName, title: `thread-${Date.now()}` })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'thread_create_failed');

  const id = data.id || data.thread_id;
  state.activeThreadId = id;
  el.activeThread.textContent = `選択中Thread: ${id}`;
  await loadThreads();
}

function looksLikeDiff(text) {
  return /^diff --git/m.test(text) || /^@@/m.test(text) || /^\+\+\+/m.test(text);
}

async function toBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function sendTurn() {
  if (!state.activeThreadId) return alert('Threadを選択/作成してください');
  const prompt = el.message.value.trim();
  if (!prompt) return;

  appendOutput(`> ${prompt}`);

  const attachments = [];
  if (state.attachedImage) {
    attachments.push({ type: 'image', name: state.attachedImage.name, dataUrl: await toBase64(state.attachedImage) });
  }

  const res = await fetch('/api/turns/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ thread_id: state.activeThreadId, input: prompt, attachments })
  });

  if (!res.ok || !res.body) {
    const error = await res.text();
    appendOutput(`送信失敗: ${error}`);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let aggregated = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    aggregated += chunk;
    appendOutput(chunk);
  }

  if (looksLikeDiff(aggregated)) {
    appendOutput(aggregated, 'diff');
  } else {
    appendOutput(aggregated, 'markdown');
  }
}

async function cancelTurn() {
  if (!state.currentTurnId) {
    alert('キャンセル対象のTurn IDがありません（サーバー実装に応じて拡張してください）');
    return;
  }
  const res = await fetch('/api/turns/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ turn_id: state.currentTurnId })
  });
  const data = await res.json();
  appendOutput(`キャンセル結果: ${JSON.stringify(data)}`);
}

el.imageInput.addEventListener('change', (e) => {
  state.attachedImage = e.target.files?.[0] || null;
  if (state.attachedImage) appendOutput(`画像添付: ${state.attachedImage.name}`);
});

el.loadRepos.onclick = () => loadRepos().catch((e) => appendOutput(`エラー: ${e.message}`));
el.cloneBtn.onclick = () => cloneSelectedRepo().catch((e) => appendOutput(`エラー: ${e.message}`));
el.loadThreads.onclick = () => loadThreads().catch((e) => appendOutput(`エラー: ${e.message}`));
el.newThread.onclick = () => createThread().catch((e) => appendOutput(`エラー: ${e.message}`));
el.send.onclick = () => sendTurn().catch((e) => appendOutput(`エラー: ${e.message}`));
el.cancel.onclick = () => cancelTurn().catch((e) => appendOutput(`エラー: ${e.message}`));
