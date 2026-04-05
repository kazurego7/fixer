import { expect, test } from '@playwright/test';
import { E2E_MOBILE_VIEWPORT, bootstrapChatState, installApiMocks, saveVisualScreenshot } from './helpers';

test('ファイルツリーの各状態をスクリーンショットで確認できる', async ({ page }, testInfo) => {
  await bootstrapChatState(page);
  await installApiMocks(page);
  await page.setViewportSize(E2E_MOBILE_VIEWPORT);

  const fulfillTree = async (route: { fulfill: (input: { status: number; contentType: string; body: string }) => Promise<void> }, includeUnchanged: boolean) => {
    const base = {
      repoFullName: 'owner/repo',
      repoPath: '/tmp/owner__repo'
    };
    const items = includeUnchanged
      ? [
          {
            name: 'src',
            path: 'src',
            type: 'directory',
            hasDiff: true,
            changeKind: 'deleted',
            isBinary: false,
            additions: 40,
            deletions: 17,
            hasChildren: true,
            children: [
              {
                name: 'app.ts',
                path: 'src/app.ts',
                type: 'file',
                hasDiff: true,
                changeKind: 'modified',
                isBinary: false,
                additions: 12,
                deletions: 3,
                hasChildren: false
              },
              {
                name: 'components',
                path: 'src/components',
                type: 'directory',
                hasDiff: true,
                changeKind: 'deleted',
                isBinary: false,
                additions: 28,
                deletions: 14,
                hasChildren: true,
                children: [
                  {
                    name: 'FileTree.tsx',
                    path: 'src/components/FileTree.tsx',
                    type: 'file',
                    hasDiff: true,
                    changeKind: 'added',
                    isBinary: false,
                    additions: 28,
                    deletions: 0,
                    hasChildren: false
                  },
                  {
                    name: 'oldTree.tsx',
                    path: 'src/components/oldTree.tsx',
                    type: 'file',
                    hasDiff: true,
                    changeKind: 'deleted',
                    isBinary: false,
                    additions: 0,
                    deletions: 14,
                    hasChildren: false
                  },
                  {
                    name: 'FileTreeItem.tsx',
                    path: 'src/components/FileTreeItem.tsx',
                    type: 'file',
                    hasDiff: false,
                    changeKind: 'unchanged',
                    isBinary: false,
                    additions: 0,
                    deletions: 0,
                    hasChildren: false
                  }
                ]
              }
            ]
          },
          {
            name: 'package.json',
            path: 'package.json',
            type: 'file',
            hasDiff: true,
            changeKind: 'modified',
            isBinary: false,
            additions: 4,
            deletions: 1,
            hasChildren: false
          },
          {
            name: 'dist',
            path: 'dist',
            type: 'directory',
            hasDiff: false,
            changeKind: 'ignored',
            isBinary: false,
            additions: 0,
            deletions: 0,
            hasChildren: true,
            children: [
              {
                name: 'build.js',
                path: 'dist/build.js',
                type: 'file',
                hasDiff: false,
                changeKind: 'ignored',
                isBinary: false,
                additions: 0,
                deletions: 0,
                hasChildren: false
              },
              {
                name: 'assets',
                path: 'dist/assets',
                type: 'directory',
                hasDiff: false,
                changeKind: 'ignored',
                isBinary: false,
                additions: 0,
                deletions: 0,
                hasChildren: true,
                children: [
                  {
                    name: 'app.css',
                    path: 'dist/assets/app.css',
                    type: 'file',
                    hasDiff: false,
                    changeKind: 'ignored',
                    isBinary: false,
                    additions: 0,
                    deletions: 0,
                    hasChildren: false
                  }
                ]
              }
            ]
          },
          {
            name: 'docs',
            path: 'docs',
            type: 'directory',
            hasDiff: false,
            changeKind: 'unchanged',
            isBinary: false,
            additions: 0,
            deletions: 0,
            hasChildren: true,
            children: [
              {
                name: 'spec.md',
                path: 'docs/spec.md',
                type: 'file',
                hasDiff: false,
                changeKind: 'unchanged',
                isBinary: false,
                additions: 0,
                deletions: 0,
                hasChildren: false
              }
            ]
          },
          {
            name: 'notes',
            path: 'notes',
            type: 'directory',
            hasDiff: false,
            changeKind: 'unchanged',
            isBinary: false,
            additions: 0,
            deletions: 0,
            hasChildren: true,
            children: [
              {
                name: 'todo.md',
                path: 'notes/todo.md',
                type: 'file',
                hasDiff: false,
                changeKind: 'unchanged',
                isBinary: false,
                additions: 0,
                deletions: 0,
                hasChildren: false
              }
            ]
          }
        ]
      : [
          {
            name: 'src',
            path: 'src',
            type: 'directory',
            hasDiff: true,
            changeKind: 'deleted',
            isBinary: false,
            additions: 40,
            deletions: 17,
            hasChildren: true,
            children: [
              {
                name: 'app.ts',
                path: 'src/app.ts',
                type: 'file',
                hasDiff: true,
                changeKind: 'modified',
                isBinary: false,
                additions: 12,
                deletions: 3,
                hasChildren: false
              },
              {
                name: 'components',
                path: 'src/components',
                type: 'directory',
                hasDiff: true,
                changeKind: 'deleted',
                isBinary: false,
                additions: 28,
                deletions: 14,
                hasChildren: true,
                children: [
                  {
                    name: 'FileTree.tsx',
                    path: 'src/components/FileTree.tsx',
                    type: 'file',
                    hasDiff: true,
                    changeKind: 'added',
                    isBinary: false,
                    additions: 28,
                    deletions: 0,
                    hasChildren: false
                  },
                  {
                    name: 'oldTree.tsx',
                    path: 'src/components/oldTree.tsx',
                    type: 'file',
                    hasDiff: true,
                    changeKind: 'deleted',
                    isBinary: false,
                    additions: 0,
                    deletions: 14,
                    hasChildren: false
                  }
                ]
              }
            ]
          },
          {
            name: 'package.json',
            path: 'package.json',
            type: 'file',
            hasDiff: true,
            changeKind: 'modified',
            isBinary: false,
            additions: 4,
            deletions: 1,
            hasChildren: false
          }
        ];

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...base, items })
    });
  };

  await page.route('**/api/repos/file-tree-diff**', async (route) => {
    await fulfillTree(route, false);
  });

  await page.route('**/api/repos/file-tree-all**', async (route) => {
    await fulfillTree(route, true);
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
  await expect(page.getByTestId('file-tree-src')).toHaveAttribute('open', '');
  await expect(page.getByTestId('files-list')).not.toContainText('notes');

  await saveVisualScreenshot(page, testInfo, 'file-tree-diff-only.png', {
    attachmentName: 'file-tree-diff-only'
  });

  await page.getByTestId('files-include-unchanged-toggle').click();
  await expect(page.getByTestId('files-list')).toContainText('docs');
  await expect(page.getByTestId('files-list')).toContainText('FileTreeItem.tsx');
  await expect(page.getByTestId('files-list')).toContainText('dist');
  await expect(page.getByTestId('files-list')).toContainText('notes');
  await expect(page.getByTestId('files-list')).not.toContainText('差分なし');
  await expect(page.getByTestId('files-list')).not.toContainText('diff なし');
  await expect(page.getByTestId('file-tree-label-dist').locator('.fx-file-tree-label')).toHaveClass(/is-ignored/);
  await expect(page.getByTestId('file-row-label-src_components_FileTreeItem_tsx')).toHaveClass(/is-normal/);
  await expect(page.getByTestId('file-tree-dist')).not.toHaveAttribute('open', '');
  await expect(page.getByTestId('file-tree-notes')).not.toHaveAttribute('open', '');

  await saveVisualScreenshot(page, testInfo, 'file-tree-include-unchanged.png', {
    attachmentName: 'file-tree-include-unchanged'
  });

  await page.getByTestId('file-tree-label-dist').click();
  await expect(page.getByTestId('file-tree-dist')).toHaveAttribute('open', '');
  await expect(page.getByTestId('files-list')).toContainText('build.js');
  await page.getByTestId('file-tree-label-dist_assets').click();
  await expect(page.getByTestId('file-tree-dist_assets')).toHaveAttribute('open', '');
  await expect(page.getByTestId('files-list')).toContainText('app.css');

  await saveVisualScreenshot(page, testInfo, 'file-tree-ignored-expanded.png', {
    attachmentName: 'file-tree-ignored-expanded'
  });
});
