import { expect, test } from '@playwright/test';
import { installApiMocks } from './helpers';

test('リポジトリ一覧から新規リポジトリ作成画面へ遷移して作成できる', async ({ page }) => {
  await installApiMocks(page);

  let createdRepoName = '';
  let createdVisibility = '';

  await page.route('**/api/github/repos**', async (route) => {
    if (route.request().method() === 'POST') {
      const raw = route.request().postDataJSON() as { name?: string; visibility?: string };
      createdRepoName = String(raw.name || '');
      createdVisibility = String(raw.visibility || '');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          repo: {
            id: 99,
            name: createdRepoName,
            fullName: `owner/${createdRepoName}`,
            private: createdVisibility === 'private',
            cloneUrl: `https://github.com/owner/${createdRepoName}.git`,
            defaultBranch: 'main',
            updatedAt: new Date().toISOString(),
            cloneState: { status: 'not_cloned' }
          }
        })
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        repos: createdRepoName
          ? [
              {
                id: 99,
                name: createdRepoName,
                fullName: `owner/${createdRepoName}`,
                private: createdVisibility === 'private',
                cloneUrl: `https://github.com/owner/${createdRepoName}.git`,
                defaultBranch: 'main',
                updatedAt: new Date().toISOString(),
                cloneState: { status: 'not_cloned' }
              }
            ]
          : [
              {
                id: 1,
                fullName: 'owner/repo',
                cloneUrl: 'https://github.com/owner/repo.git',
                updatedAt: new Date().toISOString(),
                cloneState: { status: 'cloned' }
              }
            ]
      })
    });
  });

  await page.goto('/repos/');

  await page.getByRole('button', { name: '新規リポジトリ作成' }).click();
  await expect(page).toHaveURL(/\/repos\/new\/$/);
  await expect(page.getByTestId('repo-create-name-input')).toBeVisible();

  await page.getByTestId('repo-create-name-input').fill('new-repo');
  await page.getByTestId('repo-create-public').click();
  await page.getByTestId('repo-create-submit').click();

  await expect(page).toHaveURL(/\/repos\/$/);
  await expect(page.getByRole('button', { name: /new-repo/ })).toBeVisible();
  expect(createdRepoName).toBe('new-repo');
  expect(createdVisibility).toBe('public');
});
