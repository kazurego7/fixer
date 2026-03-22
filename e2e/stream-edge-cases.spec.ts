import { expect, test } from '@playwright/test';
import { bootstrapChatState, installApiMocks } from './helpers';

test('errorイベント時は送信失敗を表示して思考パネルを消す', async ({ page }) => {
  await bootstrapChatState(page);
  await installApiMocks(page);

  await page.unroute('**/api/turns/stream');
  await page.route('**/api/turns/stream', async (route) => {
    const ndjson = [
      JSON.stringify({ type: 'started', turnId: 'turn-error-1' }),
      JSON.stringify({ type: 'reasoning_delta', delta: '**確認中** 詳細を確認します' }),
      JSON.stringify({ type: 'error', message: 'backend_failed' })
    ].join('\n') + '\n';

    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
      body: ndjson
    });
  });

  await page.goto('/chat/');
  await page.getByTestId('composer-textarea').fill('失敗確認');
  await page.getByTestId('send-button').click();

  await expect(page.locator('.fx-msg-assistant .fx-msg-bubble')).toContainText('送信失敗: backend_failed');
  await expect(page.getByTestId('thinking-live-panel')).toHaveCount(0);
});

test('応答が空でdoneした場合は応答なしを表示する', async ({ page }) => {
  await bootstrapChatState(page);
  await installApiMocks(page);

  await page.unroute('**/api/turns/stream');
  await page.route('**/api/turns/stream', async (route) => {
    const ndjson = [JSON.stringify({ type: 'started', turnId: 'turn-empty-1' }), JSON.stringify({ type: 'done' })].join('\n') + '\n';

    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
      body: ndjson
    });
  });

  await page.goto('/chat/');
  await page.getByTestId('composer-textarea').fill('空応答確認');
  await page.getByTestId('send-button').click();

  await expect(page.locator('.fx-msg-assistant .fx-msg-bubble')).toContainText('(応答なし)');
});

test('停止押下で中断APIを呼び停止表示に切り替える', async ({ page }) => {
  await bootstrapChatState(page);
  await installApiMocks(page);

  const state: { cancelBody: { thread_id?: string } | null } = { cancelBody: null };

  await page.unroute('**/api/turns/stream');
  await page.route('**/api/turns/stream', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const ndjson = [
      JSON.stringify({ type: 'started', turnId: 'turn-cancel-1' }),
      JSON.stringify({ type: 'answer_delta', delta: 'この応答は中断されます' }),
      JSON.stringify({ type: 'done' })
    ].join('\n') + '\n';

    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
      body: ndjson
    });
  });

  await page.unroute('**/api/turns/cancel');
  await page.route('**/api/turns/cancel', async (route) => {
    state.cancelBody = JSON.parse(route.request().postData() || '{}');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ cancelled: true })
    });
  });

  await page.goto('/chat/');
  await page.getByTestId('composer-textarea').fill('停止確認');
  await page.getByTestId('send-button').click();
  await expect(page.getByLabel('停止')).toBeVisible();
  await page.getByLabel('停止').click();

  await expect.poll(() => state.cancelBody?.thread_id || '').toBe('thread-e2e-1');
  await expect(page.locator('.fx-msg-assistant .fx-msg-bubble')).toContainText('(停止しました)');
});

test('複数質問の回答送信後にresumeストリームを再開する', async ({ page }) => {
  await bootstrapChatState(page);
  await installApiMocks(page);

  const state: {
    approvalBody: { answers?: Record<string, { answers: string[] }> } | null;
    restored: boolean;
  } = { approvalBody: null, restored: false };

  await page.unroute('**/api/threads/messages**');
  await page.route('**/api/threads/messages**', async (route) => {
    const items = state.restored
      ? [
          {
            id: 'resume-answer-1',
            role: 'assistant',
            type: 'markdown',
            text: '再開後の回答です',
            answer: '再開後の回答です',
            plan: ''
          }
        ]
      : [];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items })
    });
  });

  await page.unroute('**/api/turns/stream');
  await page.route('**/api/turns/stream', async (route) => {
    const ndjson =
      [
        JSON.stringify({ type: 'started', turnId: 'turn-question-1' }),
        JSON.stringify({ type: 'answer_delta', delta: '確認前の回答です' }),
        JSON.stringify({
          type: 'request_user_input',
          requestId: 'req-2',
          turnId: 'turn-question-1',
          itemId: 'item-2',
          questions: [
            {
              id: 'q1',
              header: '確認1',
              question: '最初の選択をしてください。',
              options: [
                { label: '案A', description: 'Aを選びます。' },
                { label: '案B', description: 'Bを選びます。' }
              ]
            },
            {
              id: 'q2',
              header: '確認2',
              question: '次の選択をしてください。',
              options: [
                { label: '案C', description: 'Cを選びます。' },
                { label: '案D', description: 'Dを選びます。' }
              ]
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

  await page.unroute('**/api/approvals/respond');
  await page.route('**/api/approvals/respond', async (route) => {
    state.approvalBody = JSON.parse(route.request().postData() || '{}');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true })
    });
  });

  await page.unroute('**/api/turns/running**');
  await page.route('**/api/turns/running**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ running: true, threadId: 'thread-e2e-1', turnId: 'turn-resume-1' })
    });
  });

  await page.route('**/api/turns/stream/resume**', async (route) => {
    state.restored = true;
    const ndjson = [
      JSON.stringify({ type: 'started', turnId: 'turn-resume-1' }),
      JSON.stringify({ type: 'reasoning_delta', delta: '**再開見出し** 最終応答へ進みます' }),
      JSON.stringify({ type: 'answer_delta', delta: '再開後の回答です' }),
      JSON.stringify({ type: 'done' })
    ].join('\n') + '\n';

    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
      body: ndjson
    });
  });

  await page.goto('/chat/');
  await page.getByTestId('composer-textarea').fill('複数質問確認');
  await page.getByTestId('send-button').click();

  await expect(page.locator('.fx-user-input-card')).toContainText('確認1');
  await page.getByTestId('user-input-option-q1').first().click();
  await expect(page.locator('.fx-user-input-card')).toContainText('確認2');
  await page.getByTestId('user-input-option-q2').first().click();

  await expect.poll(() => JSON.stringify(state.approvalBody?.answers || {})).toBe(
    JSON.stringify({
      q1: { answers: ['案A'] },
      q2: { answers: ['案C'] }
    })
  );
  await expect(page.locator('.fx-msg-assistant .fx-msg-bubble')).toHaveCount(2);
  await expect(page.locator('.fx-msg-assistant .fx-msg-bubble').nth(0)).toContainText('確認前の回答です');
  await expect(page.locator('.fx-msg-assistant .fx-msg-bubble').nth(1)).toContainText('再開後の回答です');
  await expect(page.locator('.fx-msg-assistant .fx-msg-bubble').nth(0)).not.toContainText('再開後の回答です');
  await expect(page.locator('.fx-msg-assistant .fx-msg-bubble').nth(1)).not.toContainText('確認前の回答です');
  await expect(page.getByTestId('thinking-live-panel')).toHaveCount(0);
});

test('末尾改行なしのrequest_user_inputも処理する', async ({ page }) => {
  await bootstrapChatState(page);
  await installApiMocks(page);

  await page.unroute('**/api/turns/stream');
  await page.route('**/api/turns/stream', async (route) => {
    const ndjson = [
      JSON.stringify({ type: 'started', turnId: 'turn-buffer-1' }),
      JSON.stringify({
        type: 'request_user_input',
        requestId: 'req-buffer-1',
        turnId: 'turn-buffer-1',
        itemId: 'item-buffer-1',
        questions: [
          {
            id: 'q-buffer',
            header: '末尾確認',
            question: '末尾バッファを処理できますか？',
            options: [{ label: 'はい', description: '処理できます。' }]
          }
        ]
      })
    ].join('\n');

    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
      body: ndjson
    });
  });

  await page.goto('/chat/');
  await page.getByTestId('composer-textarea').fill('末尾バッファ確認');
  await page.getByTestId('send-button').click();

  await expect(page.locator('.fx-user-input-card')).toContainText('末尾確認');
  await expect(page.locator('.fx-user-input-card')).toContainText('末尾バッファを処理できますか？');
});
