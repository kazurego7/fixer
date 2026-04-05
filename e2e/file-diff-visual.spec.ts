import { expect, test } from '@playwright/test';
import { bootstrapChatState, buildDefaultFileView, installApiMocks, saveVisualScreenshot } from './helpers';

test('差分詳細画面の見た目をスクリーンショットで確認できる', async ({ page }, testInfo) => {
  await bootstrapChatState(page);
  await installApiMocks(page);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.route('**/api/repos/files**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        repoFullName: 'owner/repo',
        repoPath: '/tmp/owner__repo',
        items: [
          {
            path: 'src/app.ts',
            hasDiff: true,
            changeKind: 'modified',
            isBinary: false,
            additions: 12,
            deletions: 3
          },
          {
            path: 'src/feature.ts',
            hasDiff: true,
            changeKind: 'added',
            isBinary: false,
            additions: 8,
            deletions: 0
          },
          {
            path: 'README.md',
            hasDiff: false,
            changeKind: 'unchanged',
            isBinary: false,
            additions: 0,
            deletions: 0
          }
        ]
      })
    });
  });

  await page.route('**/api/repos/file-view**', async (route) => {
    const url = new URL(route.request().url());
    const filePath = String(url.searchParams.get('path') || 'src/app.ts');
    const payload =
      filePath === 'README.md'
        ? {
            ...buildDefaultFileView('owner/repo', 'README.md'),
            content: '# README\n\n差分のないファイルです。'
          }
        : filePath === 'src/feature.ts'
          ? {
              ...buildDefaultFileView('owner/repo', 'src/feature.ts'),
              path: 'src/feature.ts',
              changeKind: 'added',
              additions: 8,
              deletions: 0,
              content: 'export function featureFlag() {\n  return true;\n}\n',
              diff: 'diff --git a/src/feature.ts b/src/feature.ts\n@@ -0,0 +1,3 @@\n+export function featureFlag() {\n+  return true;\n+}'
            }
        : {
            ...buildDefaultFileView('owner/repo', 'src/app.ts'),
            additions: 12,
            deletions: 3,
            content: 'const value = 1;\nconsole.log(value);\nexport const ready = true;\n',
            diff: 'diff --git a/src/app.ts b/src/app.ts\n@@ -1,2 +1,3 @@\n-const value = 0;\n+const value = 1;\n+export const ready = true;'
          };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(payload)
    });
  });

  await page.goto('/files/view/?path=src%2Fapp.ts&line=2');

  await expect(page.getByTestId('file-view-path')).toContainText('app.ts');
  await expect(page.getByTestId('file-content-panel')).toContainText('export const ready = true;');
  await expect(page.getByTestId('file-content-panel')).toContainText('const value = 0;');
  await expect(page.locator('[data-file-line="2"]')).toHaveClass(/is-target/);
  await expect(page.getByTestId('file-content-panel').locator('.fx-file-line.is-added')).toHaveCount(2);
  await expect(page.getByTestId('file-content-panel').locator('.fx-file-line.is-removed')).toHaveCount(1);

  await saveVisualScreenshot(page, testInfo, 'file-diff-changed.png', {
    attachmentName: 'file-diff-changed'
  });

  await page.getByTestId('file-next-diff-button').click();
  await expect(page.getByTestId('file-view-path')).toContainText('feature.ts');
  await expect(page.getByTestId('file-content-panel')).toContainText('featureFlag');
  await expect(page.getByTestId('file-content-panel').locator('.fx-file-line.is-added')).toHaveCount(3);

  await saveVisualScreenshot(page, testInfo, 'file-diff-next.png', {
    attachmentName: 'file-diff-next'
  });

  await page.getByTestId('file-prev-diff-button').click();
  await expect(page.getByTestId('file-view-path')).toContainText('app.ts');
  await expect(page.getByTestId('file-content-panel')).toContainText('export const ready = true;');

  await saveVisualScreenshot(page, testInfo, 'file-diff-prev.png', {
    attachmentName: 'file-diff-prev'
  });

  await page.goto('/files/view/?path=README.md');

  await expect(page.getByTestId('file-view-path')).toContainText('README.md');
  await expect(page.getByTestId('file-content-panel')).toContainText('差分のないファイルです。');
  await expect(page.locator('[data-testid="file-diff-panel"]')).toHaveCount(0);

  await saveVisualScreenshot(page, testInfo, 'file-diff-unchanged.png', {
    attachmentName: 'file-diff-unchanged'
  });

  await page.route('**/api/repos/file-view?**path=dist%2Fapp.js**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        repoFullName: 'owner/repo',
        repoPath: '/tmp/owner__repo',
        path: 'dist/app.js',
        hasDiff: false,
        changeKind: 'ignored',
        isBinary: false,
        isDeleted: false,
        additions: 0,
        deletions: 0,
        content: 'console.log("ignored");\n',
        diff: ''
      })
    });
  });

  await page.goto('/files/view/?path=dist%2Fapp.js');

  await expect(page.getByTestId('file-view-path')).toContainText('dist/app.js');
  await expect(page.getByTestId('file-content-panel')).toContainText('console.log("ignored");');
  await expect(page.getByTestId('file-content-panel').locator('.fx-file-line.is-added')).toHaveCount(0);
  await expect(page.getByTestId('file-content-panel').locator('.fx-file-line.is-removed')).toHaveCount(0);

  await saveVisualScreenshot(page, testInfo, 'file-diff-ignored.png', {
    attachmentName: 'file-diff-ignored'
  });
});
