import { expect, test } from '@playwright/test';
import { bootstrapChatState, installApiMocks } from './helpers';

test('モード切替の見た目をスクリーンショットで確認できる', async ({ page }, testInfo) => {
  await bootstrapChatState(page);
  await installApiMocks(page);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto('/chat/');
  await page.getByTestId('composer-textarea').click();
  await page.getByTestId('mode-plan-button').click();

  await expect(page.getByTestId('mode-plan-button')).toHaveCSS('background-color', 'rgb(76, 175, 80)');
  await expect(page.getByTestId('mode-plan-button')).toHaveCSS('color', 'rgb(255, 255, 255)');

  const screenshotPath = testInfo.outputPath('mode-toggle-plan.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach('mode-toggle-plan', {
    path: screenshotPath,
    contentType: 'image/png'
  });
});
