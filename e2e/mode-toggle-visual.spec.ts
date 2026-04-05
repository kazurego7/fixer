import { expect, test } from '@playwright/test';
import { E2E_MOBILE_VIEWPORT, bootstrapChatState, installApiMocks, saveVisualScreenshot } from './helpers';

test('モード切替の見た目をスクリーンショットで確認できる', async ({ page }, testInfo) => {
  await bootstrapChatState(page);
  await installApiMocks(page);
  await page.setViewportSize(E2E_MOBILE_VIEWPORT);

  await page.goto('/chat/');
  await page.getByTestId('composer-textarea').click();
  await page.getByTestId('mode-plan-button').click();

  await expect(page.getByTestId('mode-plan-button')).toHaveCSS('background-color', 'rgb(76, 175, 80)');
  await expect(page.getByTestId('mode-plan-button')).toHaveCSS('color', 'rgb(255, 255, 255)');

  await saveVisualScreenshot(page, testInfo, 'mode-toggle-plan.png', {
    attachmentName: 'mode-toggle-plan',
    fullPage: true
  });
});
