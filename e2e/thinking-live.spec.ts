import { expect, test } from '@playwright/test';
import { bootstrapChatState, installApiMocks } from './helpers';

test('思考ログのみ表示され、完了時に消える @smoke', async ({ page }) => {
  await bootstrapChatState(page);
  await installApiMocks(page);
  const state = { restored: false };

  await page.unroute('**/api/threads/messages**');
  await page.route('**/api/threads/messages**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: state.restored
          ? [
              {
                id: 'turn-thinking-1:user:0',
                role: 'user',
                type: 'plain',
                text: '動作確認'
              },
              {
                id: 'turn-thinking-1:assistant:0',
                role: 'assistant',
                type: 'markdown',
                text: '回答を開始します',
                answer: '回答を開始します',
                plan: ''
              }
            ]
          : []
      })
    });
  });

  await page.unroute('**/api/turns/stream');
  await page.route('**/api/turns/stream', async (route) => {
    state.restored = true;
    await new Promise((resolve) => setTimeout(resolve, 500));
    const ndjson = [
      JSON.stringify({ type: 'started', turnId: 'turn-thinking-1' }),
      JSON.stringify({
        type: 'turn_state',
        seq: 1,
        turnId: 'turn-thinking-1',
        liveReasoningText: 'セクション1\n検討中です',
        items: []
      }),
      JSON.stringify({
        type: 'turn_state',
        seq: 2,
        turnId: 'turn-thinking-1',
        liveReasoningText: 'セクション2\n確定表示候補です',
        items: []
      }),
      JSON.stringify({
        type: 'turn_state',
        seq: 3,
        turnId: 'turn-thinking-1',
        liveReasoningText: '',
        items: [
          {
            id: 'turn-thinking-1:user:0',
            role: 'user',
            type: 'plain',
            text: '動作確認'
          },
          {
            id: 'turn-thinking-1:assistant:0',
            role: 'assistant',
            type: 'markdown',
            text: '回答を開始します',
            answer: '回答を開始します',
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

  await page.goto('/chat/');
  await page.getByTestId('composer-textarea').fill('動作確認');
  await page.getByTestId('send-button').click();
  await expect(page.getByTestId('stream-loading-indicator')).toBeVisible();
  await expect(page.locator('.fx-msg-assistant .fx-msg-bubble')).toHaveCount(0);

  await expect(page.locator('.fx-msg-assistant .fx-msg-bubble')).toContainText('回答を開始します');
  await expect(page.getByTestId('thinking-live-content')).toHaveCount(0);
  await expect(page.locator('.fx-chat-scroll')).not.toContainText('処理中...');
  await expect(page.locator('.fx-chat-scroll')).not.toContainText('思考中');
  await expect(page.locator('.fx-chat-scroll')).not.toContainText('出力中');
  await expect(page.getByTestId('thinking-live-panel')).toHaveCount(0);
});

test('reasoningイベントが無い場合は回答本文の見出しだけを表示する', async ({ page }) => {
  await bootstrapChatState(page);
  await installApiMocks(page);
  const state = { restored: false };

  await page.unroute('**/api/threads/messages**');
  await page.route('**/api/threads/messages**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: state.restored
          ? [
              {
                id: 'turn-answer-only-1:user:0',
                role: 'user',
                type: 'plain',
                text: '見出し確認'
              },
              {
                id: 'turn-answer-only-1:assistant:0',
                role: 'assistant',
                type: 'markdown',
                text: '**回答見出し**\n本文です。',
                answer: '**回答見出し**\n本文です。',
                plan: ''
              }
            ]
          : []
      })
    });
  });

  await page.unroute('**/api/turns/stream');
  await page.route('**/api/turns/stream', async (route) => {
    state.restored = true;
    await new Promise((resolve) => setTimeout(resolve, 300));
    const ndjson = [
      JSON.stringify({ type: 'started', turnId: 'turn-answer-only-1' }),
      JSON.stringify({
        type: 'turn_state',
        seq: 1,
        turnId: 'turn-answer-only-1',
        liveReasoningText: '',
        items: [
          {
            id: 'turn-answer-only-1:user:0',
            role: 'user',
            type: 'plain',
            text: '見出し確認'
          },
          {
            id: 'turn-answer-only-1:assistant:0',
            role: 'assistant',
            type: 'markdown',
            text: '**回答見出し**\n本文です。',
            answer: '**回答見出し**\n本文です。',
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

  await page.goto('/chat/');
  await page.getByTestId('composer-textarea').fill('見出し確認');
  await page.getByTestId('send-button').click();
  await expect(page.getByTestId('stream-loading-indicator')).toBeVisible();

  await expect(page.locator('.fx-msg-assistant .fx-msg-bubble')).toContainText('回答見出し');
  await expect(page.locator('.fx-msg-assistant .fx-msg-bubble')).toContainText('本文です。');
  await expect(page.getByTestId('thinking-live-panel')).toHaveCount(0);
});

test('ユーザー入力要求が表示されている間は思考パネルを残さない', async ({ page }) => {
  await bootstrapChatState(page);
  await installApiMocks(page);
  const state = { pending: false };

  await page.unroute('**/api/approvals/pending**');
  await page.route('**/api/approvals/pending**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        requests: state.pending
          ? [
              {
                requestId: 'req-1',
                threadId: 'thread-e2e-1',
                turnId: 'turn-1',
                itemId: 'item-1',
                createdAt: '2026-03-30T00:00:00.000Z',
                questions: [
                  {
                    id: 'q1',
                    header: '方針確認',
                    question: '進め方を選んでください。',
                    options: [
                      { label: '案A', description: '速度優先です。' },
                      { label: '案B', description: '安全性優先です。' }
                    ]
                  }
                ]
              }
            ]
          : []
      })
    });
  });

  await page.unroute('**/api/turns/stream');
  await page.route('**/api/turns/stream', async (route) => {
    state.pending = true;
    await new Promise((resolve) => setTimeout(resolve, 300));
    const ndjson = [
      JSON.stringify({ type: 'started', turnId: 'turn-1' }),
      JSON.stringify({
        type: 'turn_state',
        seq: 1,
        turnId: 'turn-1',
        liveReasoningText: '方針整理\n選択肢をまとめます',
        items: []
      }),
      JSON.stringify({
        type: 'request_user_input',
        requestId: 'req-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        questions: [
          {
            id: 'q1',
            header: '方針確認',
            question: '進め方を選んでください。',
            options: [
              { label: '案A', description: '速度優先です。' },
              { label: '案B', description: '安全性優先です。' }
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

  await page.goto('/chat/');
  await page.getByTestId('composer-textarea').fill('方針確認');
  await page.getByTestId('send-button').click();

  await expect(page.locator('.fx-user-input-card')).toContainText('方針確認');
  await expect(page.locator('.fx-user-input-card')).toContainText('進め方を選んでください。');
  await expect(page.getByTestId('thinking-live-panel')).toHaveCount(0);
});
