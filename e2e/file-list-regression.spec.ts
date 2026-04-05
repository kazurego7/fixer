import { expect, test } from '@playwright/test';
import { bootstrapChatState, buildDefaultFileTree, installApiMocks } from './helpers';

test.describe('ファイル一覧の回帰', () => {
  test('差分ありフォルダだけを初期展開し、必要な子だけ遅延取得する', async ({ page }) => {
    await bootstrapChatState(page);
    await installApiMocks(page);

    const requests: Array<{ path: string; includeUnchanged: boolean }> = [];

    await page.route('**/api/repos/file-tree-diff**', async (route) => {
      requests.push({ path: 'diff', includeUnchanged: false });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(buildDefaultFileTree('owner/repo', false))
      });
    });

    await page.route('**/api/repos/file-tree-all**', async (route) => {
      requests.push({ path: 'all', includeUnchanged: true });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(buildDefaultFileTree('owner/repo', true))
      });
    });

    await page.goto('/files/');

    await expect(page.locator('.fx-files-title')).toHaveText('ファイル一覧');
    await expect(page.getByTestId('files-include-unchanged-toggle')).toContainText('変更差分なしも表示');

    await expect(page.getByTestId('file-tree-src')).toHaveAttribute('open', '');
    await expect(page.getByTestId('files-list')).toContainText('app.ts');
    await expect
      .poll(() => requests.some((item) => item.path === 'diff' && item.includeUnchanged === false))
      .toBe(true);
    await expect
      .poll(() => requests.some((item) => item.path === 'src' && item.includeUnchanged === false))
      .toBe(false);
    await expect
      .poll(() => requests.some((item) => item.path === 'dist' && item.includeUnchanged === false))
      .toBe(false);

    await page.getByTestId('files-include-unchanged-toggle').click();
    await expect(page.getByTestId('files-list')).toContainText('dist');
    await expect(page.getByTestId('file-tree-dist')).not.toHaveAttribute('open', '');
    await expect
      .poll(() => requests.some((item) => item.path === 'all' && item.includeUnchanged === true))
      .toBe(true);
    await expect
      .poll(() => requests.some((item) => item.path === 'src' && item.includeUnchanged === true))
      .toBe(false);

    await page.getByTestId('file-tree-label-dist').click();
    await expect(page.getByTestId('file-tree-dist')).toHaveAttribute('open', '');
    await expect(page.getByTestId('files-list')).toContainText('app.js');
    await expect
      .poll(() => requests.some((item) => item.path === 'dist' && item.includeUnchanged === true))
      .toBe(false);

    await page.getByText('変更差分なしも表示').click();
    await expect(page.locator('#files-include-unchanged')).not.toBeChecked();
  });

  test('未先読みフォルダでも展開時に読み込み中を表示しない', async ({ page }) => {
    await bootstrapChatState(page);
    await installApiMocks(page);

    await page.route('**/api/repos/file-tree-diff**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(buildDefaultFileTree('owner/repo', false))
      });
    });

    await page.route('**/api/repos/file-tree-all**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          repoFullName: 'owner/repo',
          repoPath: '/tmp/owner__repo',
          items: [
            {
              name: 'public',
              path: 'public',
              type: 'directory',
              hasDiff: false,
              changeKind: 'ignored',
              isBinary: false,
              additions: 0,
              deletions: 0,
              hasChildren: true,
              children: [
                {
                  name: 'index.html',
                  path: 'public/index.html',
                  type: 'file',
                  hasDiff: false,
                  changeKind: 'ignored',
                  isBinary: false,
                  additions: 0,
                  deletions: 0,
                  hasChildren: false
                }
              ]
            },
            {
              name: 'node_modules',
              path: 'node_modules',
              type: 'directory',
              hasDiff: false,
              changeKind: 'ignored',
              isBinary: false,
              additions: 0,
              deletions: 0,
              hasChildren: true,
              children: [
                {
                  name: '.bin',
                  path: 'node_modules/.bin',
                  type: 'directory',
                  hasDiff: false,
                  changeKind: 'ignored',
                  isBinary: false,
                  additions: 0,
                  deletions: 0,
                  hasChildren: true,
                  children: []
                }
              ]
            }
          ]
        })
      });
    });

    await page.goto('/files/');
    await page.getByTestId('files-include-unchanged-toggle').click();

    await expect(page.getByTestId('files-list')).toContainText('public');
    await expect(page.getByTestId('files-list')).toContainText('node_modules');
    await page.getByTestId('file-tree-label-node_modules').click();
    await expect(page.getByTestId('files-list')).not.toContainText('読み込み中...');
    await expect(page.getByTestId('files-list')).toContainText('.bin');
    await expect(page.getByTestId('files-list')).not.toContainText('読み込み中...');

    await page.getByTestId('file-tree-label-public').click();
    await expect(page.getByTestId('files-list')).toContainText('index.html');
    await expect(page.getByTestId('files-list')).not.toContainText('読み込み中...');
  });

  test('閉じている大量フォルダは子要素を DOM に載せない', async ({ page }) => {
    await bootstrapChatState(page);
    await installApiMocks(page);

    const largeChildren = Array.from({ length: 400 }, (_, index) => ({
      name: `pkg-${String(index + 1).padStart(4, '0')}.js`,
      path: `node_modules/pkg-${String(index + 1).padStart(4, '0')}.js`,
      type: 'file' as const,
      hasDiff: false,
      changeKind: 'ignored' as const,
      isBinary: false,
      additions: 0,
      deletions: 0,
      hasChildren: false
    }));

    await page.route('**/api/repos/file-tree-diff**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(buildDefaultFileTree('owner/repo', false))
      });
    });

    await page.route('**/api/repos/file-tree-all**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          repoFullName: 'owner/repo',
          repoPath: '/tmp/owner__repo',
          items: [
            {
              name: 'node_modules',
              path: 'node_modules',
              type: 'directory',
              hasDiff: false,
              changeKind: 'ignored',
              isBinary: false,
              additions: 0,
              deletions: 0,
              hasChildren: true,
              children: largeChildren
            }
          ]
        })
      });
    });

    await page.goto('/files/');
    await page.getByTestId('files-include-unchanged-toggle').click();

    await expect(page.getByTestId('file-tree-node_modules')).not.toHaveAttribute('open', '');
    await expect(page.getByTestId('file-row-node_modules_pkg-0001_js')).toHaveCount(0);
    await expect(page.getByTestId('file-row-node_modules_pkg-0400_js')).toHaveCount(0);

    await page.getByTestId('file-tree-label-node_modules').click();

    await expect(page.getByTestId('file-tree-node_modules')).toHaveAttribute('open', '');
    await expect(page.getByTestId('file-row-node_modules_pkg-0001_js')).toBeVisible();
    await expect(page.getByTestId('file-row-node_modules_pkg-0400_js')).toBeVisible();
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
    await expect(page.getByTestId('file-view-path')).toContainText('app.js');
    await expect(page.locator('.fx-file-row-chip')).toContainText('除外');
    await expect(page.getByTestId('file-content-panel')).toContainText('console.log("ignored");');
    await expect(page.getByTestId('file-content-panel').locator('.fx-file-line.is-added')).toHaveCount(0);
    await expect(page.getByTestId('file-content-panel').locator('.fx-file-line.is-removed')).toHaveCount(0);
  });
});
