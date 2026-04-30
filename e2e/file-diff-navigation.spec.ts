import { expect, test } from '@playwright/test';
import { bootstrapChatState, buildDefaultFileList, buildDefaultFileView, installApiMocks } from './helpers';

test.describe('diff 中心のファイル閲覧', () => {
  test('ファイルタブから diff 一覧へ遷移し、トグルで差分なしファイルも表示できる', async ({ page }) => {
    await bootstrapChatState(page);
    await installApiMocks(page);

    await page.goto('/chat/');

    await page.getByTestId('workspace-tab-files').click();
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
      ].filter((item): item is (typeof base.items)[number] => Boolean(item));
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
              content: `${Array.from({ length: 119 }, (_, index) => `before ${index + 1}`).join('\n')}\nexport const feature = true;\n`,
              diff:
                'diff --git a/src/feature.ts b/src/feature.ts\n@@ -0,0 +120,1 @@\n+export const feature = true;'
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
    await expect(page).toHaveURL(/\/files\/view\/\?path=src%2Ffeature\.ts(?:&jump=first-diff)?/);
    await expect(page.getByTestId('file-content-panel')).toContainText('feature = true');
    await expect(page.locator('[data-file-line="120"]')).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const panel = document.querySelector('[data-testid="file-content"]');
          if (!(panel instanceof HTMLElement)) return -1;
          return panel.scrollTop;
        })
      )
      .toBeGreaterThan(2200);

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

    await expect(page.getByTestId('file-view-path')).toContainText('app.js');
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

  test('チャット起点のファイル詳細から戻るとチャット画面と元のスクロール位置へ戻る', async ({ page }) => {
    await bootstrapChatState(page);
    await installApiMocks(page);

    await page.unroute('**/api/threads/messages**');
    await page.route('**/api/threads/messages**', async (route) => {
      const items: Array<Record<string, string>> = [];
      for (let i = 1; i <= 16; i += 1) {
        items.push({ id: `u-${i}`, role: 'user', type: 'plain', text: `user-${i}` });
        items.push({ id: `a-${i}`, role: 'assistant', type: 'markdown', text: `assistant-${i}` });
      }
      items.push({ id: 'a-link', role: 'assistant', type: 'markdown', text: '[src/app.ts:2](/tmp/owner__repo/src/app.ts:2)' });
      items.push({ id: 'u-last', role: 'user', type: 'plain', text: 'user-last' });
      for (let i = 1; i <= 40; i += 1) {
        items.push({ id: `tail-${i}`, role: 'assistant', type: 'markdown', text: `tail-${i}` });
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items })
      });
    });

    await page.goto('/chat/');
    const fileLink = page.getByRole('link', { name: 'src/app.ts:2' });
    await expect(fileLink).toBeVisible();

    const scrollTopBefore = await page.evaluate(() => {
      const container = document.querySelector('.fx-chat-scroll');
      if (!(container instanceof HTMLElement)) return -1;
      container.scrollTop = Math.max(0, Math.floor(container.scrollHeight * 0.32));
      return container.scrollTop;
    });
    expect(scrollTopBefore).toBeGreaterThan(0);

    await fileLink.click();
    await expect(page).toHaveURL(/\/files\/view\/\?path=src%2Fapp\.ts&line=2/);

    await page.getByTestId('file-view-back-button').click();
    await expect(page).toHaveURL(/\/chat\/$/);

    await expect
      .poll(async () =>
        page.evaluate(() => {
          const container = document.querySelector('.fx-chat-scroll');
          if (!(container instanceof HTMLElement)) return -1;
          return container.scrollTop;
        })
      )
      .toBe(scrollTopBefore);
    await expect(fileLink).toBeVisible();
  });

  test('チャット起点のファイル詳細からチャットタブで戻っても元のスクロール位置へ戻る', async ({ page }) => {
    await bootstrapChatState(page);
    await installApiMocks(page);

    await page.unroute('**/api/threads/messages**');
    await page.route('**/api/threads/messages**', async (route) => {
      const items: Array<Record<string, string>> = [];
      for (let i = 1; i <= 16; i += 1) {
        items.push({ id: `u-${i}`, role: 'user', type: 'plain', text: `user-${i}` });
        items.push({ id: `a-${i}`, role: 'assistant', type: 'markdown', text: `assistant-${i}` });
      }
      items.push({ id: 'a-link', role: 'assistant', type: 'markdown', text: '[src/app.ts:2](/tmp/owner__repo/src/app.ts:2)' });
      items.push({ id: 'u-last', role: 'user', type: 'plain', text: 'user-last' });
      for (let i = 1; i <= 40; i += 1) {
        items.push({ id: `tail-${i}`, role: 'assistant', type: 'markdown', text: `tail-${i}` });
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items })
      });
    });

    await page.goto('/chat/');
    const fileLink = page.getByRole('link', { name: 'src/app.ts:2' });
    await expect(fileLink).toBeVisible();

    const scrollTopBefore = await page.evaluate(() => {
      const container = document.querySelector('.fx-chat-scroll');
      if (!(container instanceof HTMLElement)) return -1;
      container.scrollTop = Math.max(0, Math.floor(container.scrollHeight * 0.32));
      return container.scrollTop;
    });
    expect(scrollTopBefore).toBeGreaterThan(0);

    await fileLink.click();
    await expect(page).toHaveURL(/\/files\/view\/\?path=src%2Fapp\.ts&line=2/);

    await page.getByTestId('workspace-tab-chat').click();
    await expect(page).toHaveURL(/\/chat\/$/);

    await expect
      .poll(async () =>
        page.evaluate(() => {
          const container = document.querySelector('.fx-chat-scroll');
          if (!(container instanceof HTMLElement)) return -1;
          return container.scrollTop;
        })
      )
      .toBe(scrollTopBefore);
    await expect(fileLink).toBeVisible();
  });

  test('チャット返答のリンクは下線付きでリンクらしく表示される', async ({ page }) => {
    await bootstrapChatState(page);
    await installApiMocks(page);

    await page.route('**/api/threads/messages**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              id: 'assistant-link-style',
              role: 'assistant',
              type: 'markdown',
              text: '[外部リンク](https://example.com/docs)',
              answer: '[外部リンク](https://example.com/docs)',
              plan: ''
            }
          ]
        })
      });
    });

    await page.goto('/chat/');

    const link = page.getByRole('link', { name: '外部リンク' });
    await expect(link).toBeVisible();
    await expect(link).toHaveCSS('text-decoration-line', 'underline');
    await expect(link).not.toHaveCSS('color', 'rgb(15, 23, 42)');
  });
});
