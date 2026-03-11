import { expect, test } from '@playwright/test';
import { bootstrapChatState, installApiMocks } from './helpers';

test('チャット表示時に最後の自分の指示が先頭に来る', async ({ page }) => {
  await bootstrapChatState(page);
  await installApiMocks(page);

  await page.unroute('**/api/threads/messages**');
  await page.route('**/api/threads/messages**', async (route) => {
    const items = [];
    for (let i = 1; i <= 12; i += 1) {
      items.push({ id: `u-${i}`, role: 'user', type: 'plain', text: `user-${i}` });
      items.push({ id: `a-${i}`, role: 'assistant', type: 'markdown', text: `assistant-${i}` });
    }
    items.push({ id: 'u-last', role: 'user', type: 'plain', text: 'user-last' });
    for (let i = 1; i <= 80; i += 1) {
      items.push({ id: `a-tail-${i}`, role: 'assistant', type: 'markdown', text: `tail-${i}` });
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items })
    });
  });

  await page.goto('/chat/');

  await expect(page.locator('[data-msg-role="user"][data-msg-id="u-last"]')).toHaveCount(1);
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const container = document.querySelector('.fx-chat-scroll');
        const target = document.querySelector('[data-msg-role="user"][data-msg-id="u-last"]');
        if (!(container instanceof HTMLElement) || !(target instanceof HTMLElement)) return 9999;
        return Math.abs(target.getBoundingClientRect().top - container.getBoundingClientRect().top);
      })
    )
    .toBeLessThan(4);
});

test('自分の指示がない場合はチャット表示時に位置を変えない', async ({ page }) => {
  await bootstrapChatState(page);
  await installApiMocks(page);

  await page.unroute('**/api/threads/messages**');
  await page.route('**/api/threads/messages**', async (route) => {
    const items = [];
    for (let i = 1; i <= 80; i += 1) {
      items.push({ id: `assistant-only-${i}`, role: 'assistant', type: 'markdown', text: `assistant-only-${i}` });
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items })
    });
  });

  await page.goto('/chat/');

  await expect(page.locator('.fx-msg-assistant')).toHaveCount(80);
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const container = document.querySelector('.fx-chat-scroll');
        if (!(container instanceof HTMLElement)) return -1;
        return container.scrollTop;
      })
    )
    .toBe(0);
});
