import { expect, test } from '@playwright/test';
import { bootstrapChatState, installApiMocks } from './helpers';

test('プラン実現ボタン下に操作説明を表示し、問UIでは説明を表示しない', async ({ page }) => {
  await bootstrapChatState(page);
  await installApiMocks(page);

  await page.unroute('**/api/threads/messages**');
  await page.route('**/api/threads/messages**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          {
            id: 'a-plan-1',
            role: 'assistant',
            type: 'markdown',
            text: '計画案です',
            answer: '計画案です',
            plan: '1. 調査\n2. 実装'
          }
        ]
      })
    });
  });

  await page.unroute('**/api/turns/stream');
  await page.route('**/api/turns/stream', async (route) => {
    const ndjson = [
      JSON.stringify({ type: 'started', turnId: 'turn-1' }),
      JSON.stringify({
        type: 'request_user_input',
        requestId: 'req-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        questions: [
          {
            id: 'q1',
            header: '方針確認',
            question: '次に進める方向を選んでください。',
            options: [
              { label: '案A', description: '速度優先で進めます。' },
              { label: '案B', description: '安全性優先で進めます。' }
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
  await expect(page.getByTestId('plan-edit-help')).toContainText('※ プランを修正する場合は');
  await page.getByTestId('composer-textarea').fill('確認したい');
  await page.getByTestId('send-button').click();

  await expect(page.getByTestId('plan-edit-help')).toHaveCount(0);
  await expect(page.locator('.fx-user-input-card [data-testid="plan-edit-help"]')).toHaveCount(0);
  await expect(page.locator('.fx-user-input-option-desc').first()).toContainText('速度優先で進めます。');
  await expect(page.locator('.fx-user-input-option-desc').nth(1)).toContainText('安全性優先で進めます。');
});
