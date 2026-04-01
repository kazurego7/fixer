import { expect, test } from '@playwright/test';
import { bootstrapChatState, buildImageFile, installApiMocks } from './helpers';

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

test('未入力時は入力欄が縮み、フォーカスすると広がる', async ({ page }) => {
  await bootstrapChatState(page);
  await installApiMocks(page);
  await page.goto('/chat/');

  const textarea = page.getByTestId('composer-textarea');
  const attachButton = page.getByTestId('attachment-add-button');
  const collapsedHeight = await textarea.evaluate((el) => el.clientHeight);
  const buttonHeight = await attachButton.evaluate((el) => el.clientHeight);

  expect(Math.abs(collapsedHeight - buttonHeight)).toBeLessThanOrEqual(6);

  await textarea.click();
  await expect(textarea).toBeFocused();
  await expect.poll(() => textarea.evaluate((el) => el.clientHeight)).toBeGreaterThan(collapsedHeight + 40);
  await textarea.fill('入力したまま閉じる');

  await page.locator('.fx-chat-scroll').click({ position: { x: 12, y: 12 } });
  await expect
    .poll(async () => textarea.evaluate((el) => document.activeElement === el))
    .toBe(false);
  await expect.poll(() => textarea.evaluate((el) => el.clientHeight)).toBeLessThan(collapsedHeight + 8);
});
