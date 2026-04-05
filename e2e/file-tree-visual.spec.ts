import { expect, test } from '@playwright/test';
import { bootstrapChatState, installApiMocks } from './helpers';

test('ファイルツリーの各状態をスクリーンショットで確認できる', async ({ page }, testInfo) => {
  await bootstrapChatState(page);
  await installApiMocks(page);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.route('**/api/repos/file-tree**', async (route) => {
    const url = new URL(route.request().url());
    const includeUnchanged = url.searchParams.get('includeUnchanged') === '1';
    const parentPath = String(url.searchParams.get('path') || '');
    const base = {
      repoFullName: 'owner/repo',
      repoPath: '/tmp/owner__repo',
      parentPath: parentPath || null
    };
    let items;
    if (!parentPath) {
      items = includeUnchanged
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
              hasChildren: true
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
              hasChildren: true
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
              hasChildren: true
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
              hasChildren: true
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
              hasChildren: true
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
    } else if (parentPath === 'src') {
      items = [
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
          hasChildren: true
        }
      ];
    } else if (parentPath === 'src/components') {
      items = includeUnchanged
        ? [
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
        : [
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
          ];
    } else if (parentPath === 'docs' && includeUnchanged) {
      items = [
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
      ];
    } else if (parentPath === 'notes' && includeUnchanged) {
      items = [
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
      ];
    } else if (parentPath === 'dist' && includeUnchanged) {
      items = [
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
          hasChildren: true
        }
      ];
    } else if (parentPath === 'dist/assets' && includeUnchanged) {
      items = [
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
      ];
    } else {
      items = [];
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...base, items })
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
  await expect(page.getByTestId('file-tree-src')).toHaveAttribute('open', '');
  await expect(page.getByTestId('files-list')).not.toContainText('notes');

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
  await expect(page.getByTestId('files-list')).toContainText('notes');
  await expect(page.getByTestId('files-list')).not.toContainText('差分なし');
  await expect(page.getByTestId('files-list')).not.toContainText('diff なし');
  await expect(page.getByTestId('file-tree-label-dist').locator('.fx-file-tree-label')).toHaveClass(/is-ignored/);
  await expect(page.getByTestId('file-row-label-src_components_FileTreeItem_tsx')).toHaveClass(/is-normal/);
  await expect(page.getByTestId('file-tree-dist')).not.toHaveAttribute('open', '');
  await expect(page.getByTestId('file-tree-notes')).not.toHaveAttribute('open', '');

  const includeUnchangedPath = testInfo.outputPath('file-tree-include-unchanged.png');
  await page.screenshot({ path: includeUnchangedPath, fullPage: false });
  await testInfo.attach('file-tree-include-unchanged', {
    path: includeUnchangedPath,
    contentType: 'image/png'
  });

  await page.getByTestId('file-tree-label-dist').click();
  await expect(page.getByTestId('file-tree-dist')).toHaveAttribute('open', '');
  await expect(page.getByTestId('files-list')).toContainText('build.js');
  await page.getByTestId('file-tree-label-dist_assets').click();
  await expect(page.getByTestId('file-tree-dist_assets')).toHaveAttribute('open', '');
  await expect(page.getByTestId('files-list')).toContainText('app.css');

  const ignoredExpandedPath = testInfo.outputPath('file-tree-ignored-expanded.png');
  await page.screenshot({ path: ignoredExpandedPath, fullPage: false });
  await testInfo.attach('file-tree-ignored-expanded', {
    path: ignoredExpandedPath,
    contentType: 'image/png'
  });
});
