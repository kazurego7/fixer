import { expect, test } from '@playwright/test';
import { bootstrapChatState, installApiMocks } from './helpers';

test('ファイルツリーの各状態をスクリーンショットで確認できる', async ({ page }, testInfo) => {
  await bootstrapChatState(page);
  await installApiMocks(page);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.route('**/api/repos/files**', async (route) => {
    const url = new URL(route.request().url());
    const includeUnchanged = url.searchParams.get('includeUnchanged') === '1';
    const items = [
      {
        path: 'src/app.ts',
        hasDiff: true,
        changeKind: 'modified',
        isBinary: false,
        additions: 12,
        deletions: 3
      },
      {
        path: 'src/components/FileTree.tsx',
        hasDiff: true,
        changeKind: 'added',
        isBinary: false,
        additions: 28,
        deletions: 0
      },
      {
        path: 'src/components/oldTree.tsx',
        hasDiff: true,
        changeKind: 'deleted',
        isBinary: false,
        additions: 0,
        deletions: 14
      },
      {
        path: 'src/components/FileTreeItem.tsx',
        hasDiff: false,
        changeKind: 'unchanged',
        isBinary: false,
        additions: 0,
        deletions: 0
      },
      {
        path: 'docs/spec.md',
        hasDiff: false,
        changeKind: 'unchanged',
        isBinary: false,
        additions: 0,
        deletions: 0
      },
      {
        path: 'dist/',
        hasDiff: false,
        changeKind: 'ignored',
        isBinary: false,
        additions: 0,
        deletions: 0
      },
      {
        path: 'package.json',
        hasDiff: true,
        changeKind: 'modified',
        isBinary: false,
        additions: 4,
        deletions: 1
      }
    ];

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        repoFullName: 'owner/repo',
        repoPath: '/tmp/owner__repo',
        items: includeUnchanged ? items : items.filter((item) => item.hasDiff)
      })
    });
  });

  await page.goto('/files/');

  await expect(page.getByTestId('files-list')).toContainText('src');
  await expect(page.getByTestId('files-list')).toContainText('package.json');
  await expect(page.getByTestId('file-row-stats-src_app_ts')).toContainText('+12');
  await expect(page.getByTestId('file-row-stats-src_app_ts')).toContainText('-3');
  await expect(page.getByTestId('file-row-stats-src_components_FileTree_tsx')).toContainText('+28');
  await expect(page.getByTestId('file-row-stats-src_components_oldTree_tsx')).toContainText('-14');
  await expect(page.getByTestId('file-tree-label-src').locator('.fx-file-tree-label')).toHaveClass(/is-deleted/);
  await expect(page.getByTestId('file-row-label-package_json')).toHaveClass(/is-modified/);

  const diffOnlyPath = testInfo.outputPath('file-tree-diff-only.png');
  await page.screenshot({ path: diffOnlyPath, fullPage: false });
  await testInfo.attach('file-tree-diff-only', {
    path: diffOnlyPath,
    contentType: 'image/png'
  });

  await page.getByTestId('files-include-unchanged-toggle').click();
  await expect(page.getByTestId('files-list')).toContainText('docs');
  await expect(page.getByTestId('files-list')).toContainText('FileTreeItem.tsx');
  await expect(page.getByTestId('files-list')).toContainText('dist');
  await expect(page.getByTestId('files-list')).not.toContainText('差分なし');
  await expect(page.getByTestId('files-list')).not.toContainText('diff なし');
  await expect(page.getByTestId('file-tree-label-dist').locator('.fx-file-tree-label')).toHaveClass(/is-ignored/);
  await expect(page.getByTestId('file-row-label-src_components_FileTreeItem_tsx')).toHaveClass(/is-normal/);

  const includeUnchangedPath = testInfo.outputPath('file-tree-include-unchanged.png');
  await page.screenshot({ path: includeUnchangedPath, fullPage: false });
  await testInfo.attach('file-tree-include-unchanged', {
    path: includeUnchangedPath,
    contentType: 'image/png'
  });
});
