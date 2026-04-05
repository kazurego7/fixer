import { expect, test } from '@playwright/test';
import { bootstrapChatState, buildDefaultFileTree, installApiMocks } from './helpers';

test.describe('ファイル一覧の回帰', () => {
  test('差分ありフォルダだけを初期展開し、必要な子だけ遅延取得する', async ({ page }) => {
    await bootstrapChatState(page);
    await installApiMocks(page);

    const requests: Array<{ path: string; includeUnchanged: boolean }> = [];

    await page.route('**/api/repos/file-tree**', async (route) => {
      const url = new URL(route.request().url());
      const includeUnchanged = url.searchParams.get('includeUnchanged') === '1';
      const parentPath = String(url.searchParams.get('path') || '');
      requests.push({ path: parentPath, includeUnchanged });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(buildDefaultFileTree('owner/repo', parentPath, includeUnchanged))
      });
    });

    await page.goto('/files/');

    await expect(page.getByTestId('file-tree-src')).toHaveAttribute('open', '');
    await expect(page.getByTestId('files-list')).toContainText('app.ts');
    await expect
      .poll(() => requests.some((item) => item.path === '' && item.includeUnchanged === false))
      .toBe(true);
    await expect
      .poll(() => requests.some((item) => item.path === 'src' && item.includeUnchanged === false))
      .toBe(true);
    await expect
      .poll(() => requests.some((item) => item.path === 'dist' && item.includeUnchanged === false))
      .toBe(false);

    await page.getByTestId('files-include-unchanged-toggle').click();
    await expect(page.getByTestId('files-list')).toContainText('dist');
    await expect(page.getByTestId('file-tree-dist')).not.toHaveAttribute('open', '');
    await expect(page.getByTestId('files-list')).not.toContainText('app.js');
    await expect
      .poll(() => requests.some((item) => item.path === '' && item.includeUnchanged === true))
      .toBe(true);
    await expect
      .poll(() => requests.some((item) => item.path === 'src' && item.includeUnchanged === true))
      .toBe(true);
    await expect
      .poll(() => requests.some((item) => item.path === 'dist' && item.includeUnchanged === true))
      .toBe(false);

    await page.getByTestId('file-tree-label-dist').click();
    await expect(page.getByTestId('file-tree-dist')).toHaveAttribute('open', '');
    await expect(page.getByTestId('files-list')).toContainText('app.js');
    await expect
      .poll(() => requests.some((item) => item.path === 'dist' && item.includeUnchanged === true))
      .toBe(true);
  });

  test('差分なしと除外ファイルをトグルで表示し、除外ファイル詳細は本文のみ表示する', async ({ page }) => {
    await bootstrapChatState(page);
    await installApiMocks(page);

    await page.route('**/api/repos/file-view**', async (route) => {
      const url = new URL(route.request().url());
      const filePath = String(url.searchParams.get('path') || '');
      if (filePath !== 'dist/app.js') {
        await route.fallback();
        return;
      }
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

    await page.goto('/files/');

    await expect(page.getByTestId('files-list')).not.toContainText('README.md');
    await page.getByTestId('files-include-unchanged-toggle').click();
    await expect(page.getByTestId('files-list')).toContainText('README.md');
    await expect(page.getByTestId('files-list')).toContainText('dist');

    await page.getByTestId('file-tree-label-dist').click();
    await page.getByTestId('file-row-dist_app_js').click();

    await expect(page).toHaveURL(/\/files\/view\/\?path=dist%2Fapp\.js/);
    await expect(page.getByTestId('file-view-path')).toContainText('dist/app.js');
    await expect(page.locator('.fx-file-row-chip')).toContainText('除外');
    await expect(page.getByTestId('file-content-panel')).toContainText('console.log("ignored");');
    await expect(page.getByTestId('file-content-panel').locator('.fx-file-line.is-added')).toHaveCount(0);
    await expect(page.getByTestId('file-content-panel').locator('.fx-file-line.is-removed')).toHaveCount(0);
  });
});
