import { expect, test } from '@playwright/test';
import { bootstrapChatState, installApiMocks, saveVisualScreenshot } from './helpers';

test('ワークスペースタブでチャット、ファイル、課題を往復できる @smoke', async ({ page }, testInfo) => {
  await bootstrapChatState(page);
  await installApiMocks(page);

  await page.goto('/chat/');
  await expect(page.getByTestId('workspace-tabs')).toBeVisible();
  await saveVisualScreenshot(page, testInfo, 'workspace-tabs-chat.png', { fullPage: true });

  await page.getByTestId('workspace-tab-files').click();
  await expect(page).toHaveURL(/\/files\/$/);
  await expect(page.getByTestId('files-page-title')).toContainText('repo');
  await saveVisualScreenshot(page, testInfo, 'workspace-tabs-files.png', { fullPage: true });

  await page.getByTestId('workspace-tab-issues').click();
  await expect(page).toHaveURL(/\/issues\/$/);
  await expect(page.getByTestId('issues-page-title')).toContainText('repo');
  await saveVisualScreenshot(page, testInfo, 'workspace-tabs-issues.png', { fullPage: true });

  await page.getByTestId('workspace-tab-chat').click();
  await expect(page).toHaveURL(/\/chat\/$/);
  await expect(page.getByTestId('composer')).toBeVisible();
});

test('ファイル一覧と課題一覧の戻るボタンで直前の画面へ戻れる', async ({ page }) => {
  await bootstrapChatState(page);
  await installApiMocks(page);

  await page.goto('/chat/');
  await page.getByTestId('workspace-tab-files').click();
  await page.getByTestId('files-back-button').click();
  await expect(page).toHaveURL(/\/chat\/$/);

  await page.getByTestId('workspace-tab-files').click();
  await page.getByTestId('workspace-tab-issues').click();
  await page.getByTestId('issues-back-button').click();
  await expect(page).toHaveURL(/\/files\/$/);

  await page.getByTestId('files-back-button').click();
  await expect(page).toHaveURL(/\/chat\/$/);
});

test('ファイル差分画面でもファイルタブはファイル一覧へ戻る', async ({ page }) => {
  await bootstrapChatState(page);
  await installApiMocks(page);

  await page.goto('/files/');
  await page.getByTestId('file-row-src_app_ts').click();
  await expect(page).toHaveURL(/\/files\/view\//);

  await page.getByTestId('workspace-tab-files').click();
  await expect(page).toHaveURL(/\/files\/$/);
  await expect(page.getByTestId('files-list')).toBeVisible();
});
