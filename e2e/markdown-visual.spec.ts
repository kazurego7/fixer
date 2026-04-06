import { expect, test } from '@playwright/test';
import { E2E_MOBILE_VIEWPORT, bootstrapChatState, installApiMocks, saveVisualScreenshot } from './helpers';

test.use({ viewport: E2E_MOBILE_VIEWPORT });

test('さまざまなマークダウン書式をスクリーンショット確認できる', async ({ page }, testInfo) => {
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
            id: 'assistant-markdown-visual-1',
            role: 'assistant',
            type: 'markdown',
            text: [
              '## マークダウン確認',
              '',
              '**太字** / *斜体* / ~~打ち消し~~ / [リンク](https://example.com)',
              '',
              '> 引用ブロックの表示',
              '',
              '- 箇条書き 1',
              '- 箇条書き 2',
              '',
              '1. 番号付き 1',
              '2. 番号付き 2',
              '',
              '- [ ] 未完了タスク',
              '- [x] 完了タスク',
              '',
              'リテラル比較: `[-]` と `[x]`',
              '',
              '| 列 | 値 |',
              '| --- | --- |',
              '| A | 1 |',
              '| B | 2 |',
              '',
              '```ts',
              "const state = 'ok';",
              'console.log(state);',
              '```'
            ].join('\n'),
            answer: [
              '## マークダウン確認',
              '',
              '**太字** / *斜体* / ~~打ち消し~~ / [リンク](https://example.com)',
              '',
              '> 引用ブロックの表示',
              '',
              '- 箇条書き 1',
              '- 箇条書き 2',
              '',
              '1. 番号付き 1',
              '2. 番号付き 2',
              '',
              '- [ ] 未完了タスク',
              '- [x] 完了タスク',
              '',
              'リテラル比較: `[-]` と `[x]`',
              '',
              '| 列 | 値 |',
              '| --- | --- |',
              '| A | 1 |',
              '| B | 2 |',
              '',
              '```ts',
              "const state = 'ok';",
              'console.log(state);',
              '```'
            ].join('\n'),
            plan: ''
          }
        ]
      })
    });
  });

  await page.goto('/chat/');

  const bubble = page.locator('.fx-msg-assistant .fx-msg-bubble').last();
  await expect(bubble.locator('h2')).toHaveText('マークダウン確認');
  await expect(bubble.locator('ul li')).toHaveCount(4);
  await expect(bubble.locator('ol li')).toHaveCount(2);
  await expect(bubble.locator('input[type="checkbox"]')).toHaveCount(2);
  await expect(bubble.locator('table')).toHaveCount(1);
  await expect(bubble.locator('pre code')).toContainText("const state = 'ok';");
  await expect(bubble).toContainText('リテラル比較:');
  await expect(bubble.getByText('[-]', { exact: true })).toBeVisible();
  await expect(bubble.getByText('[x]', { exact: true })).toBeVisible();

  await saveVisualScreenshot(page, testInfo, 'markdown-visual-overview.png', {
    attachmentName: 'markdown-visual-overview'
  });
});
