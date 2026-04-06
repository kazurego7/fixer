import { expect, test } from '@playwright/test';
import { E2E_MOBILE_VIEWPORT, bootstrapChatState, installApiMocks, saveVisualScreenshot } from './helpers';

test('プラン表示を返答カード内でスクリーンショット確認できる', async ({ page }, testInfo) => {
  await bootstrapChatState(page);
  await installApiMocks(page);
  await page.setViewportSize(E2E_MOBILE_VIEWPORT);
  const state = { mode: 'default' as 'default' | 'plan' };

  await page.unroute('**/api/threads/messages**');
  await page.route('**/api/threads/messages**', async (route) => {
    const body =
      state.mode === 'plan'
        ? {
            items: [
              {
                id: 'a-plan-1',
                role: 'assistant',
                type: 'markdown',
                text: '調査結果を踏まえた提案です。',
                answer: '調査結果を踏まえた提案です。',
                plan: [
                  '## 実施プラン',
                  '',
                  '1. 影響範囲を確認',
                  '2. UI を修正',
                  '3. `npm test` で固定',
                  '',
                  '- [ ] 差分確認',
                  '- [x] 原因特定',
                  '',
                  '| 項目 | 状態 |',
                  '| --- | --- |',
                  '| UI | 対応中 |',
                  '| Test | 未実行 |'
                ].join('\n')
              }
            ]
          }
        : {
            items: [
              {
                id: 'a-plan-2',
                role: 'assistant',
                type: 'markdown',
                text: '途中の整理です。',
                answer: '途中の整理です。',
                plan: [
                  '- 原因を切り分け',
                  '- 表示位置を調整',
                  '',
                  'リテラル確認: `[-]` と `[x]`'
                ].join('\n')
              }
            ]
          };

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body)
    });
  });

  await page.goto('/chat/');
  state.mode = 'plan';
  await page.evaluate(() => {
    window.localStorage.setItem('fx:collaborationModeByRepo', JSON.stringify({ 'owner/repo': 'plan' }));
  });
  await page.goto('/chat/');
  await expect(page.getByTestId('plan-inline-block')).toContainText('影響範囲を確認');
  await expect(page.getByTestId('plan-inline-block')).toContainText('## 実施プラン');
  await expect(page.getByTestId('plan-inline-block')).toContainText('1. 影響範囲を確認');
  await expect(page.getByTestId('plan-inline-block')).toContainText('3. `npm test` で固定');
  await expect(page.getByTestId('plan-inline-block')).toContainText('- [ ] 差分確認');
  await expect(page.getByTestId('plan-inline-block')).toContainText('| 項目 | 状態 |');
  await expect(page.getByTestId('plan-apply-button')).toBeVisible();
  await saveVisualScreenshot(page, testInfo, 'plan-inline-plan-mode.png', {
    attachmentName: 'plan-inline-plan-mode'
  });

  state.mode = 'default';
  await page.evaluate(() => {
    window.localStorage.setItem('fx:collaborationModeByRepo', JSON.stringify({ 'owner/repo': 'default' }));
  });
  await page.goto('/chat/');
  await expect(page.getByTestId('plan-inline-block')).toContainText('- 原因を切り分け');
  await expect(page.getByTestId('plan-inline-block')).toContainText('- 表示位置を調整');
  await expect(page.getByTestId('plan-inline-block')).toContainText('リテラル確認: `[-]` と `[x]`');
  await expect(page.getByTestId('plan-apply-button')).toHaveCount(0);
  await saveVisualScreenshot(page, testInfo, 'plan-inline-default-mode.png', {
    attachmentName: 'plan-inline-default-mode'
  });
});
