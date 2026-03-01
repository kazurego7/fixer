const { test, expect } = require('@playwright/test');
const { bootstrapChatState, installApiMocks, buildImageFile } = require('./helpers');

test('画像プレビューで前後移動でき、端で停止する @smoke', async ({ page }) => {
  await bootstrapChatState(page);
  await installApiMocks(page);
  await page.goto('/chat/');

  await page.getByTestId('attachment-input').setInputFiles([buildImageFile('a.png'), buildImageFile('b.png')]);

  await page.getByTestId('attachment-item-0').click();
  await expect(page.getByTestId('image-preview-overlay')).toBeVisible();
  await expect(page.getByTestId('image-preview-caption')).toContainText('1 / 2');
  await expect(page.getByTestId('image-preview-prev')).toBeDisabled();

  await page.getByTestId('image-preview-next').click();
  await expect(page.getByTestId('image-preview-caption')).toContainText('2 / 2');
  await expect(page.getByTestId('image-preview-next')).toBeDisabled();

  const panel = page.getByTestId('image-preview-panel');
  await panel.dispatchEvent('pointerdown', { clientX: 220, clientY: 120 });
  await panel.dispatchEvent('pointerup', { clientX: 80, clientY: 120 });
  await expect(page.getByTestId('image-preview-caption')).toContainText('2 / 2');

  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('image-preview-caption')).toContainText('1 / 2');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('image-preview-caption')).toContainText('1 / 2');

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('image-preview-overlay')).toHaveCount(0);
});
