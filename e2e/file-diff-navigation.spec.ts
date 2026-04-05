import { expect, test } from '@playwright/test';
import { bootstrapChatState, buildDefaultFileList, buildDefaultFileView, installApiMocks } from './helpers';

test.describe('diff 中心のファイル閲覧', () => {
  test('Git ステータスラインから diff 一覧へ遷移し、トグルで差分なしファイルも表示できる', async ({ page }) => {
    await bootstrapChatState(page);
    await installApiMocks(page);

    await page.goto('/chat/');

    await page.getByTestId('git-status-line').click();
    await expect(page).toHaveURL(/\/files\/$/);
    await expect(page.getByTestId('files-list')).toContainText('src');
    await expect(page.getByTestId('files-list')).toContainText('app.ts');
    await expect(page.getByTestId('file-row-stats-src_app_ts')).toContainText('+1');
    await expect(page.getByTestId('file-row-stats-src_app_ts')).toContainText('-1');
    await expect(page.getByTestId('files-list')).not.toContainText('README.md');

    await page.getByTestId('files-include-unchanged-toggle').click();
    await expect(page.getByTestId('files-list')).toContainText('README.md');
  });

  test('ファイル一覧から全文と diff を見られ、前後の diff 移動ができる', async ({ page }) => {
    await bootstrapChatState(page);
    await installApiMocks(page);

    await page.route('**/api/repos/files**', async (route) => {
      const url = new URL(route.request().url());
      const includeUnchanged = url.searchParams.get('includeUnchanged') === '1';
      const repo = 'owner/repo';
      const base = buildDefaultFileList(repo);
      const items = [
        base.items[0],
        {
          path: 'src/feature.ts',
          hasDiff: true,
          changeKind: 'added',
          isBinary: false,
          additions: 1,
          deletions: 0
        },
        base.items[1]
      ];
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...base,
          items: includeUnchanged ? items : items.filter((item) => item.hasDiff)
        })
      });
    });

    await page.route('**/api/repos/file-view**', async (route) => {
      const url = new URL(route.request().url());
      const repo = 'owner/repo';
      const filePath = String(url.searchParams.get('path') || 'src/app.ts');
      const payload =
        filePath === 'src/feature.ts'
          ? {
              ...buildDefaultFileView(repo, filePath),
              path: filePath,
              changeKind: 'added',
              additions: 1,
              deletions: 0,
              content: 'export const feature = true;\n',
              diff: 'diff --git a/src/feature.ts b/src/feature.ts\n@@ -0,0 +1 @@\n+export const feature = true;'
            }
          : buildDefaultFileView(repo, filePath);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(payload)
      });
    });

    await page.goto('/files/');

    await page.getByTestId('file-row-src_app_ts').click();
    await expect(page).toHaveURL(/\/files\/view\/\?path=src%2Fapp\.ts/);
    await expect(page.getByTestId('file-content-panel')).toContainText('const value = 1;');
    await expect(page.getByTestId('file-content-panel').locator('.fx-file-line.is-added')).toHaveCount(1);
    await expect(page.getByTestId('file-content-panel').locator('.fx-file-line.is-removed')).toHaveCount(1);

    await page.getByTestId('file-next-diff-button').click();
    await expect(page).toHaveURL(/\/files\/view\/\?path=src%2Ffeature\.ts/);
    await expect(page.getByTestId('file-content-panel')).toContainText('feature = true');

    await page.getByTestId('file-prev-diff-button').click();
    await expect(page).toHaveURL(/\/files\/view\/\?path=src%2Fapp\.ts/);
  });

  test('差分なしファイルでも全文を表示し、diff は差分なしと出す', async ({ page }) => {
    await bootstrapChatState(page);
    await installApiMocks(page);

    await page.goto('/files/');
    await page.getByTestId('files-include-unchanged-toggle').click();
    await page.getByTestId('file-row-README_md').click();

    await expect(page).toHaveURL(/\/files\/view\/\?path=README\.md/);
    await expect(page.getByTestId('file-content-panel')).toContainText('# README');
    await expect(page.locator('[data-testid="file-diff-panel"]')).toHaveCount(0);
  });

  test('除外ファイルは本文だけを表示し、新規 diff のようには見せない', async ({ page }) => {
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

    await page.goto('/files/view/?path=dist%2Fapp.js');

    await expect(page.getByTestId('file-view-path')).toContainText('dist/app.js');
    await expect(page.getByTestId('file-content-panel')).toContainText('console.log("ignored");');
    await expect(page.getByTestId('file-content-panel').locator('.fx-file-line.is-added')).toHaveCount(0);
    await expect(page.getByTestId('file-content-panel').locator('.fx-file-line.is-removed')).toHaveCount(0);
    await expect(page.getByText('除外')).toBeVisible();
  });

  test('チャット返答のローカルファイルリンクは diff 詳細へ飛び、外部リンクは新規タブで開く', async ({ page }) => {
    await bootstrapChatState(page);
    await page.addInitScript(() => {
      const calls: Array<[string | undefined, string | undefined, string | undefined]> = [];
      Object.defineProperty(window, '__fxOpenCalls', {
        value: calls,
        configurable: true
      });
      window.open = ((url?: string | URL, target?: string, features?: string) => {
        calls.push([typeof url === 'string' ? url : String(url || ''), target, features]);
        return null;
      }) as typeof window.open;
    });
    await installApiMocks(page);

    await page.route('**/api/threads/messages**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              id: 'assistant-local-link',
              role: 'assistant',
              type: 'markdown',
              text: '[src/app.ts:2](/tmp/owner__repo/src/app.ts:2)\n\n[外部リンク](https://example.com/docs)',
              answer: '[src/app.ts:2](/tmp/owner__repo/src/app.ts:2)\n\n[外部リンク](https://example.com/docs)',
              plan: ''
            }
          ]
        })
      });
    });

    await page.goto('/chat/');

    await page.getByRole('link', { name: 'src/app.ts:2' }).click();
    await expect(page).toHaveURL(/\/files\/view\/\?path=src%2Fapp\.ts&line=2/);
    await expect(page.locator('[data-file-line="2"]')).toHaveClass(/is-target/);

    await page.goto('/chat/');
    await page.getByRole('link', { name: '外部リンク' }).click();
    await expect
      .poll(() =>
        page.evaluate(() => ((window as Window & { __fxOpenCalls?: Array<[string, string, string]> }).__fxOpenCalls || [])[0] || null)
      )
      .toEqual(['https://example.com/docs', '_blank', 'noopener,noreferrer']);
  });
});
