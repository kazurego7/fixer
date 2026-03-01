const { test, expect } = require('@playwright/test');
const { bootstrapChatState, installApiMocks, buildImageFile } = require('./helpers');

test('画像添付を送信payloadへ含め、送信後に添付バーが消える @smoke', async ({ page }) => {
  await bootstrapChatState(page);
  const state = await installApiMocks(page);
  await page.goto('/chat/');

  const fileInput = page.getByTestId('attachment-input');
  await fileInput.setInputFiles([buildImageFile('cat.png')]);
  await expect(page.getByTestId('attachments-bar')).toBeVisible();

  await page.getByTestId('composer-textarea').fill('画像付きで送信');
  await page.getByTestId('send-button').click();

  await expect.poll(() => state.lastTurnStreamBody?.attachments?.length || 0).toBe(1);
  await expect.poll(() => state.lastTurnStreamBody?.attachments?.[0]?.type || '').toBe('image');
  await expect.poll(() => String(state.lastTurnStreamBody?.attachments?.[0]?.dataUrl || '').startsWith('data:image/')).toBe(
    true
  );

  await expect(page.getByTestId('attachments-bar')).toHaveCount(0);
});
