const { test, expect } = require('@playwright/test');
const { bootstrapChatState, installApiMocks, buildImageFile } = require('./helpers');

test('添付バー領域の操作で入力フォーカスが勝手に戻らない @smoke', async ({ page }) => {
  await bootstrapChatState(page);
  await installApiMocks(page);
  await page.goto('/chat/');

  await page.getByTestId('attachment-input').setInputFiles([buildImageFile('focus.png')]);
  await expect(page.getByTestId('attachments-bar')).toBeVisible();

  const textarea = page.getByTestId('composer-textarea');
  await textarea.focus();
  await expect
    .poll(async () => textarea.evaluate((el) => document.activeElement === el))
    .toBe(true);

  await page.locator('.fx-chat-scroll').click({ position: { x: 12, y: 12 } });
  await expect
    .poll(async () => textarea.evaluate((el) => document.activeElement === el))
    .toBe(false);

  await page.getByTestId('attachments-bar').evaluate((el) => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 10, clientY: 10 }));
  });
  await expect
    .poll(async () => textarea.evaluate((el) => document.activeElement === el))
    .toBe(false);
});
