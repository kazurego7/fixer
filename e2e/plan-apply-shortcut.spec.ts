import { expect, test } from '@playwright/test';
import { bootstrapChatState, installApiMocks } from './helpers';

test('planモードで最新プランがある場合のみプラン実現ボタンを表示する', async ({ page }) => {
  await bootstrapChatState(page);
  await installApiMocks(page);

  await page.addInitScript(() => {
    window.localStorage.setItem('fx:collaborationModeByRepo', JSON.stringify({ 'owner/repo': 'plan' }));
  });

  await page.unroute('**/api/threads/messages**');
  await page.route('**/api/threads/messages**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          {
            id: 'a-plan-1',
            role: 'assistant',
            type: 'markdown',
            text: '計画案です',
            answer: '計画案です',
            plan: '1. 調査\n2. 実装'
          }
        ]
      })
    });
  });

  await page.goto('/chat/');
  await expect(page.getByTestId('plan-apply-button')).toBeVisible();
  await expect(page.locator('.fx-msg-assistant .fx-msg-bubble [data-testid="plan-apply-button"]')).toHaveCount(1);
  await expect(page.getByTestId('plan-inline-block')).toContainText('1. 調査');
});

test('defaultモードではプランを返答カード内に表示し、実現ボタンは出さない', async ({ page }) => {
  await bootstrapChatState(page);
  await installApiMocks(page);

  await page.unroute('**/api/threads/messages**');
  await page.route('**/api/threads/messages**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          {
            id: 'a-plan-default-1',
            role: 'assistant',
            type: 'markdown',
            text: '途中の考えです',
            answer: '途中の考えです',
            plan: '1. 調査\n2. 実装'
          }
        ]
      })
    });
  });

  await page.goto('/chat/');
  await expect(page.getByTestId('plan-inline-block')).toContainText('1. 調査');
  await expect(page.getByTestId('plan-apply-button')).toHaveCount(0);
  await expect(page.getByTestId('plan-edit-help')).toHaveCount(0);
});

test('プラン実現ボタン押下でdefaultモードで短文を自動送信する', async ({ page }) => {
  await bootstrapChatState(page);
  const state = await installApiMocks(page);

  await page.addInitScript(() => {
    window.localStorage.setItem('fx:collaborationModeByRepo', JSON.stringify({ 'owner/repo': 'plan' }));
  });

  await page.unroute('**/api/threads/messages**');
  await page.route('**/api/threads/messages**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          {
            id: 'a-plan-1',
            role: 'assistant',
            type: 'markdown',
            text: '計画案です',
            answer: '計画案です',
            plan: '1. 調査\n2. 実装'
          }
        ]
      })
    });
  });

  await page.goto('/chat/');
  await expect(page.getByTestId('plan-apply-button')).toHaveCSS('background-color', 'rgb(37, 99, 235)');
  await expect(page.getByTestId('plan-apply-button')).toHaveCSS('color', 'rgb(255, 255, 255)');
  await page.getByTestId('plan-apply-button').click();

  await expect.poll(() => state.lastTurnStreamBody?.input || '').toBe('このプランを実現して');
  await expect.poll(() => state.lastTurnStreamBody?.collaboration_mode || '').toBe('default');
});

test('追加質問で最新応答にプランがない場合はプラン実現ボタンを非表示にする', async ({ page }) => {
  await bootstrapChatState(page);
  await installApiMocks(page);

  await page.addInitScript(() => {
    window.localStorage.setItem('fx:collaborationModeByRepo', JSON.stringify({ 'owner/repo': 'plan' }));
  });

  await page.unroute('**/api/threads/messages**');
  await page.route('**/api/threads/messages**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          {
            id: 'a-plan-1',
            role: 'assistant',
            type: 'markdown',
            text: '計画案です',
            answer: '計画案です',
            plan: '1. 調査\n2. 実装'
          }
        ]
      })
    });
  });

  await page.goto('/chat/');
  await expect(page.getByTestId('plan-apply-button')).toBeVisible();
  await expect(page.getByTestId('plan-edit-help')).toBeVisible();

  await page.getByTestId('composer-textarea').fill('追加で確認');
  await page.getByTestId('send-button').click();

  await expect(page.getByTestId('plan-apply-button')).toHaveCount(0);
  await expect(page.getByTestId('plan-edit-help')).toHaveCount(0);
});
