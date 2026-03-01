const { test, expect } = require('@playwright/test');
const { bootstrapChatState, installApiMocks } = require('./helpers');

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
