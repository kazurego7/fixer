const { test, expect } = require('@playwright/test');
const { bootstrapChatState, installApiMocks } = require('./helpers');

test('ヘッダーボタンが表示されクリック可能 @smoke', async ({ page }) => {
  await bootstrapChatState(page);
  await installApiMocks(page);
  await page.goto('/chat/');

  await expect(page.getByTestId('back-button')).toBeVisible();
  await expect(page.getByTestId('new-thread-button')).toBeVisible();

  await page.getByTestId('new-thread-button').click();
  await expect(page.getByTestId('composer-textarea')).toBeVisible();
});
