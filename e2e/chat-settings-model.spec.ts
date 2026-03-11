import { expect, test } from '@playwright/test';
import { bootstrapChatState, installApiMocks } from './helpers';

test('チャットタイトル押下で設定を開き、モデル一覧を表示できる', async ({ page }) => {
  await bootstrapChatState(page);
  await installApiMocks(page);

  await page.route('**/api/models', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        models: [
          { id: 'gpt-5-codex', name: 'GPT-5 Codex', description: 'default' },
          { id: 'gpt-5', name: 'GPT-5', description: 'general' }
        ]
      })
    });
  });

  await page.goto('/chat/');
  await page.getByTestId('chat-settings-trigger').click();

  await expect(page.getByTestId('chat-settings-modal')).toBeVisible();
  await expect(page.getByTestId('model-list')).toBeVisible();
  await expect(page.getByTestId('model-option-gpt-5-codex')).toBeVisible();
  await expect(page.getByTestId('model-option-gpt-5')).toBeVisible();
});

test('設定で選んだモデルが送信payloadに反映される', async ({ page }) => {
  await bootstrapChatState(page);
  const state = await installApiMocks(page);

  await page.route('**/api/models', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        models: [
          { id: 'gpt-5-codex', name: 'GPT-5 Codex' },
          { id: 'gpt-5', name: 'GPT-5' }
        ]
      })
    });
  });

  await page.goto('/chat/');
  await page.getByTestId('chat-settings-trigger').click();
  await page.getByTestId('model-option-gpt-5').click();
  await page.getByTestId('chat-settings-close').click();

  await page.getByTestId('composer-textarea').fill('モデル指定で送信');
  await page.getByTestId('send-button').click();

  await expect.poll(() => state.lastTurnStreamBody?.model || '').toBe('gpt-5');
});
