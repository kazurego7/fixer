import type { Page } from '@playwright/test';

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6p8dQAAAAASUVORK5CYII=';

const DEFAULT_REPO = 'owner/repo';
const DEFAULT_THREAD_ID = 'thread-e2e-1';

interface MockRouteState {
  lastTurnStreamBody:
    | {
        attachments?: Array<{ type?: string; dataUrl?: string }>;
        input?: string;
        collaboration_mode?: string;
        model?: string;
      }
    | null;
}

interface InstallApiMocksOptions {
  repoFullName?: string;
  threadId?: string;
}

function buildImageFile(name: string): { name: string; mimeType: string; buffer: Buffer } {
  return {
    name,
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_BASE64, 'base64')
  };
}

async function bootstrapChatState(page: Page, repo = DEFAULT_REPO, threadId = DEFAULT_THREAD_ID): Promise<void> {
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

async function installApiMocks(page: Page, options: InstallApiMocksOptions = {}): Promise<MockRouteState> {
  const repo = options.repoFullName || DEFAULT_REPO;
  const threadId = options.threadId || DEFAULT_THREAD_ID;
  const state: MockRouteState = { lastTurnStreamBody: null };

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

  await page.route('**/api/repos/git-status**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        repoFullName: repo,
        repoPath: `/tmp/${repo.replace('/', '__')}`,
        branch: 'main',
        upstream: 'origin/main',
        ahead: 0,
        behind: 0,
        stagedCount: 1,
        unstagedCount: 1,
        untrackedCount: 0,
        conflictedCount: 0,
        hasChanges: true,
        actionRecommended: true,
        tone: 'warning',
        summary: '変更あり: ステージ 1 / 未反映 1'
      })
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
    state.lastTurnStreamBody = JSON.parse(raw) as MockRouteState['lastTurnStreamBody'];
    const prompt = String(state.lastTurnStreamBody?.input || '');
    const ndjson = [
      JSON.stringify({ type: 'started', turnId: 'turn-e2e-default-1' }),
      JSON.stringify({
        type: 'turn_state',
        seq: 1,
        turnId: 'turn-e2e-default-1',
        liveReasoningText: '',
        items: [
          {
            id: 'turn-e2e-default-1:user:0',
            role: 'user',
            type: 'plain',
            text: prompt
          },
          {
            id: 'turn-e2e-default-1:assistant:0',
            role: 'assistant',
            type: 'markdown',
            text: 'ok',
            answer: 'ok',
            plan: ''
          }
        ]
      }),
      JSON.stringify({ type: 'done' })
    ].join('\n') + '\n';
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
      body: ndjson
    });
  });

  await page.route('**/api/turns/running**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ running: false, threadId })
    });
  });

  await page.route('**/api/turns/live-state**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ running: false, threadId, seq: 0, items: [], liveReasoningText: '' })
    });
  });

  await page.route('**/api/approvals/pending**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ requests: [] })
    });
  });

  return state;
}

export {
  DEFAULT_REPO,
  DEFAULT_THREAD_ID,
  buildImageFile,
  bootstrapChatState,
  installApiMocks
};
