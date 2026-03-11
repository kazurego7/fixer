import { expect, test } from '@playwright/test';
import { bootstrapChatState, installApiMocks } from './helpers';

test('思考ログのみ表示され、完了時に消える @smoke', async ({ page }) => {
  await bootstrapChatState(page);
  await installApiMocks(page);

  await page.unroute('**/api/turns/stream');
  await page.route('**/api/turns/stream', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const ndjson = [
      JSON.stringify({ type: 'started' }),
      JSON.stringify({ type: 'reasoning_delta', delta: '**セクション1** 検討中です' }),
      JSON.stringify({ type: 'reasoning_delta', delta: '\n**セクション2** 確定表示候補です' }),
      JSON.stringify({ type: 'answer_delta', delta: '回答を開始します' }),
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

  await page.unroute('**/api/turns/stream');
  await page.route('**/api/turns/stream', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const ndjson = [
      JSON.stringify({ type: 'started' }),
      JSON.stringify({ type: 'answer_delta', delta: '**回答見出し**\n本文です。' }),
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

  await page.unroute('**/api/turns/stream');
  await page.route('**/api/turns/stream', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const ndjson = [
      JSON.stringify({ type: 'started', turnId: 'turn-1' }),
      JSON.stringify({ type: 'reasoning_delta', delta: '**方針整理** 選択肢をまとめます' }),
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
