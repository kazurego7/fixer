import { expect, test } from '@playwright/test';
import { DEFAULT_REPO, bootstrapChatState, installApiMocks, saveVisualScreenshot } from './helpers';

test('完了済みターンの Bad 目印から課題一覧を開き、課題を入力欄へ転記できる', async ({ page }, testInfo) => {
  await bootstrapChatState(page);
  await installApiMocks(page);

  let markerBody: { repoFullName?: string; threadId?: string; turnId?: string } | null = null;
  let issues = [
    {
      id: 'issue-e2e-1',
      repoFullName: DEFAULT_REPO,
      title: '送信後に止まる',
      summary: 'Bad が押されたターンで応答が進まない状態を確認する必要があります。',
      nextPrompt: '送信後に応答が進まない原因を調べて修正して',
      markerIds: ['marker-e2e-1'],
      sourceThreadId: 'thread-e2e-1',
      sourceTurnId: 'turn-bad-1',
      status: 'open',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  ];

  await page.unroute('**/api/issues?**');
  await page.route('**/api/issues**', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ issues })
      });
      return;
    }
    if (request.method() === 'POST' && request.url().includes('/api/issues/markers')) {
      markerBody = JSON.parse(request.postData() || '{}');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          marker: {
            id: 'marker-e2e-1',
            repoFullName: DEFAULT_REPO,
            sourceThreadId: markerBody?.threadId,
            sourceTurnId: markerBody?.turnId,
            status: 'pending',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        })
      });
      return;
    }
    if (request.method() === 'PATCH') {
      issues = [];
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ issue: { id: 'issue-e2e-1', status: 'resolved' } })
      });
      return;
    }
    await route.fallback();
  });

  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    let completed = false;
    const completedItems = [
      { id: 'turn-bad-1:user:0', role: 'user', type: 'plain', text: '調査して' },
      { id: 'turn-bad-1:assistant:0', role: 'assistant', type: 'markdown', text: '確認中', answer: '確認中' }
    ];
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/api/threads/messages')) {
        return new Response(JSON.stringify({ items: completed ? completedItems : [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (!url.includes('/api/turns/stream')) return originalFetch(input, init);
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`${JSON.stringify({ type: 'started', turnId: 'turn-bad-1' })}\n`));
          window.setTimeout(() => {
            controller.enqueue(
              encoder.encode(
                `${JSON.stringify({
                  type: 'turn_state',
                  seq: 1,
                  turnId: 'turn-bad-1',
                  liveReasoningText: '',
                  items: [
                    { id: 'turn-bad-1:user:0', role: 'user', type: 'plain', text: '調査して' },
                    { id: 'turn-bad-1:assistant:0', role: 'assistant', type: 'markdown', text: '確認中', answer: '確認中' }
                  ]
                })}\n`
              )
            );
          }, 200);
          window.setTimeout(() => {
            completed = true;
            controller.enqueue(encoder.encode(`${JSON.stringify({ type: 'done' })}\n`));
            controller.close();
          }, 900);
        }
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson; charset=utf-8' }
      });
    };
  });

  await page.goto('/chat/');
  await page.getByTestId('composer-textarea').fill('調査して');
  await page.getByTestId('send-button').click();

  await page.waitForTimeout(350);
  await expect(page.getByTestId('bad-marker-button')).toHaveCount(0);

  await expect(page.getByTestId('bad-marker-button')).toBeVisible();
  await page.getByTestId('bad-marker-button').click();
  await expect.poll(() => markerBody?.turnId || '').toBe('turn-bad-1');
  await expect(page.getByTestId('bad-marker-button')).toBeDisabled();

  await page.getByTestId('issues-open-button').click();
  await expect(page.getByTestId('issues-panel')).toBeVisible();
  await expect(page.getByText('送信後に止まる')).toBeVisible();
  await saveVisualScreenshot(page, testInfo, 'issues-panel-after.png', { fullPage: true });

  await page.getByTestId('issue-use-button').click();
  await expect(page.getByTestId('issues-panel')).toHaveCount(0);
  await expect(page.getByTestId('composer-textarea')).toHaveValue('送信後に応答が進まない原因を調べて修正して');
  await saveVisualScreenshot(page, testInfo, 'issue-prompt-after.png', { fullPage: true });
});
