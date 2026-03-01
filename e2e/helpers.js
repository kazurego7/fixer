const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6p8dQAAAAASUVORK5CYII=';

const DEFAULT_REPO = 'owner/repo';
const DEFAULT_THREAD_ID = 'thread-e2e-1';

function buildImageFile(name) {
  return {
    name,
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_BASE64, 'base64')
  };
}

async function bootstrapChatState(page, repo = DEFAULT_REPO, threadId = DEFAULT_THREAD_ID) {
  await page.addInitScript(
    ({ targetRepo, targetThreadId }) => {
      window.localStorage.setItem('fx:lastRepoFullName', targetRepo);
      window.localStorage.setItem('fx:lastThreadId', targetThreadId);
      window.localStorage.setItem('fx:threadByRepo', JSON.stringify({ [targetRepo]: targetThreadId }));
      window.localStorage.setItem(`fx:threadMessages:${targetThreadId}`, JSON.stringify([]));
    },
    { targetRepo: repo, targetThreadId: threadId }
  );
}

async function installApiMocks(page, options = {}) {
  const repo = options.repoFullName || DEFAULT_REPO;
  const threadId = options.threadId || DEFAULT_THREAD_ID;
  const state = { lastTurnStreamBody: null };

  await page.route('**/api/github/auth/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ available: true, connected: true })
    });
  });

  await page.route('**/api/github/repos**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        repos: [
          {
            id: 1,
            fullName: repo,
            cloneUrl: `https://github.com/${repo}.git`,
            updatedAt: new Date().toISOString(),
            cloneState: { status: 'cloned' }
          }
        ]
      })
    });
  });

  await page.route('**/api/threads/messages**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [] })
    });
  });

  await page.route('**/api/threads/ensure', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: threadId, reused: true })
    });
  });

  await page.route('**/api/threads', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'thread-new-e2e' })
    });
  });

  await page.route('**/api/turns/stream', async (route) => {
    const raw = route.request().postData() || '{}';
    state.lastTurnStreamBody = JSON.parse(raw);
    const ndjson = [
      JSON.stringify({ type: 'started' }),
      JSON.stringify({ type: 'answer_delta', delta: 'ok' }),
      JSON.stringify({ type: 'done' })
    ].join('\n') + '\n';
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
      body: ndjson
    });
  });

  return state;
}

module.exports = {
  DEFAULT_REPO,
  DEFAULT_THREAD_ID,
  buildImageFile,
  bootstrapChatState,
  installApiMocks
};
