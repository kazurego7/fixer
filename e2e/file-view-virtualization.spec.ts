import { expect, test } from '@playwright/test';
import { bootstrapChatState, buildDefaultFileView, installApiMocks } from './helpers';

test('大きいファイル詳細は可視範囲付近だけ描画し、スクロール先の行を表示できる', async ({ page }) => {
  await bootstrapChatState(page);
  await installApiMocks(page);

  const lines = Array.from({ length: 2000 }, (_, index) => `line ${index + 1}`);
  const content = `${lines.join('\n')}\n`;

  await page.route('**/api/repos/file-view**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...buildDefaultFileView('owner/repo', 'src/huge.ts'),
        path: 'src/huge.ts',
        hasDiff: false,
        changeKind: 'modified',
        additions: 0,
        deletions: 0,
        content,
        diff: ''
      })
    });
  });

  await page.goto('/files/view/?path=src%2Fhuge.ts');

  const contentPanel = page.getByTestId('file-content');
  await expect(contentPanel).toContainText('line 1');
  await expect
    .poll(async () => contentPanel.locator('.fx-file-line').count())
    .toBeLessThan(200);

  await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="file-content"]');
    if (!(panel instanceof HTMLElement)) return;
    panel.scrollTop = panel.scrollHeight;
    panel.dispatchEvent(new Event('scroll', { bubbles: true }));
  });

  await expect(page.locator('[data-file-line="2000"]')).toContainText('line 2000');
  await expect
    .poll(async () => contentPanel.locator('.fx-file-line').count())
    .toBeLessThan(200);
});

test('大きいファイル詳細でも長い行は折り返して表示する', async ({ page }) => {
  await bootstrapChatState(page);
  await installApiMocks(page);

  const longLine = 'wrap-me '.repeat(80);
  const lines = Array.from({ length: 800 }, (_, index) => (index === 420 ? longLine : `line ${index + 1}`));
  const content = `${lines.join('\n')}\n`;

  await page.route('**/api/repos/file-view**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...buildDefaultFileView('owner/repo', 'src/wrap.ts'),
        path: 'src/wrap.ts',
        hasDiff: false,
        changeKind: 'modified',
        additions: 0,
        deletions: 0,
        content,
        diff: ''
      })
    });
  });

  await page.goto('/files/view/?path=src%2Fwrap.ts&line=421');

  const targetLine = page.locator('[data-file-line="421"]');
  await expect(targetLine).toContainText('wrap-me');
  await expect(targetLine.locator('.fx-file-line-text')).toHaveCSS('white-space', 'pre-wrap');
  await expect
    .poll(() =>
      targetLine.evaluate((element) => {
        if (!(element instanceof HTMLElement)) return 0;
        return element.clientHeight;
      })
    )
    .toBeGreaterThan(40);
});
