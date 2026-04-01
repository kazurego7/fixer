import { expect, test } from '@playwright/test';
import { bootstrapChatState, installApiMocks } from './helpers';

test('長い返答でも assistant カードが横にはみ出さない', async ({ page }) => {
  await bootstrapChatState(page);
  await installApiMocks(page);

  const longToken = 'LONGTOKEN_'.repeat(28);
  const longMarkdown = [
    '長い連続文字列の確認:',
    '',
    longToken,
    '',
    `\`${longToken}\``,
    '',
    '```',
    longToken,
    '```'
  ].join('\n');

  await page.unroute('**/api/threads/messages**');
  await page.route('**/api/threads/messages**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          {
            id: 'assistant-wrap-1',
            role: 'assistant',
            type: 'markdown',
            text: longMarkdown,
            answer: longMarkdown,
            plan: ''
          }
        ]
      })
    });
  });

  await page.goto('/chat/');
  await expect(page.locator('.fx-msg-assistant .fx-msg-bubble')).toContainText('長い連続文字列の確認:');

  const metrics = await page.evaluate(() => {
    const scroll = document.querySelector('.fx-chat-scroll') as HTMLElement | null;
    const bubble = document.querySelector('.fx-msg-assistant .fx-msg-bubble') as HTMLElement | null;
    const pre = bubble?.querySelector('pre') as HTMLElement | null;
    const inlineCode = bubble?.querySelector('p code') as HTMLElement | null;

    return {
      chatOverflow: scroll ? scroll.scrollWidth - scroll.clientWidth : null,
      bubbleOverflow: bubble ? bubble.scrollWidth - bubble.clientWidth : null,
      preOverflow: pre ? pre.scrollWidth - pre.clientWidth : null,
      inlineCodeRightGap:
        bubble && inlineCode ? inlineCode.getBoundingClientRect().right - bubble.getBoundingClientRect().right : null,
      preRightGap: bubble && pre ? pre.getBoundingClientRect().right - bubble.getBoundingClientRect().right : null
    };
  });

  expect(metrics.chatOverflow).not.toBeNull();
  expect(metrics.bubbleOverflow).not.toBeNull();
  expect(metrics.chatOverflow ?? 0).toBeLessThanOrEqual(1);
  expect(metrics.bubbleOverflow ?? 0).toBeLessThanOrEqual(1);
  expect(metrics.inlineCodeRightGap ?? 0).toBeLessThanOrEqual(1);
  expect(metrics.preRightGap ?? 0).toBeLessThanOrEqual(1);
});
