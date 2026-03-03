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
  await expect(page.getByTestId('return-thread-button')).toBeVisible();
  await expect(page.getByTestId('new-thread-button')).toHaveCount(0);
});

test('新規スレッド開始直後は戻るボタンが表示され、戻ると新規ボタンに戻る', async ({ page }) => {
  await bootstrapChatState(page);
  await installApiMocks(page);
  await page.goto('/chat/');

  await page.getByTestId('new-thread-button').click();
  await expect(page.getByTestId('return-thread-button')).toBeVisible();

  await page.getByTestId('return-thread-button').click();
  await expect(page.getByTestId('new-thread-button')).toBeVisible();
  await expect(page.getByTestId('return-thread-button')).toHaveCount(0);
});

test('新規と戻るを繰り返しても毎回戻るボタンが正しく機能する', async ({ page }) => {
  await bootstrapChatState(page);
  await installApiMocks(page);
  await page.goto('/chat/');

  await page.getByTestId('new-thread-button').click();
  await expect(page.getByTestId('return-thread-button')).toBeVisible();
  await page.getByTestId('return-thread-button').click();
  await expect(page.getByTestId('new-thread-button')).toBeVisible();

  await page.getByTestId('new-thread-button').click();
  await expect(page.getByTestId('return-thread-button')).toBeVisible();
  await page.getByTestId('return-thread-button').click();
  await expect(page.getByTestId('new-thread-button')).toBeVisible();
});

test('新規スレッドで送信すると戻るボタンは消えて新規ボタンに戻る', async ({ page }) => {
  await bootstrapChatState(page);
  await installApiMocks(page);
  await page.goto('/chat/');

  await page.getByTestId('new-thread-button').click();
  await expect(page.getByTestId('return-thread-button')).toBeVisible();

  await page.getByTestId('composer-textarea').fill('test message');
  await page.getByTestId('send-button').click();

  await expect(page.getByTestId('new-thread-button')).toBeVisible();
  await expect(page.getByTestId('return-thread-button')).toHaveCount(0);
});
