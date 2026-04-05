import { expect, test } from '@playwright/test';
import { bootstrapChatState, installApiMocks } from './helpers';

test('Git アイコン押下で Codex にコミットと push を依頼できる', async ({ page }) => {
  await bootstrapChatState(page);
  const state = await installApiMocks(page);

  await page.goto('/chat/');

  await expect(page.getByTestId('git-status-line')).toContainText('変更あり');
  await expect(page.getByTestId('git-commit-push-button')).toBeEnabled();

  await page.getByTestId('git-commit-push-button').click();

  await expect.poll(() => state.lastTurnStreamBody?.input || '').toBe('commit & push');
  await expect.poll(() => state.lastTurnStreamBody?.collaboration_mode || '').toBe('default');
});

test('Git が同期済みのときはコミットと push ボタンを無効化する', async ({ page }) => {
  await bootstrapChatState(page);
  await installApiMocks(page);

  await page.route('**/api/repos/git-status**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        repoFullName: 'owner/repo',
        repoPath: '/tmp/owner__repo',
        branch: 'main',
        upstream: 'origin/main',
        ahead: 0,
        behind: 0,
        stagedCount: 0,
        unstagedCount: 0,
        untrackedCount: 0,
        conflictedCount: 0,
        hasChanges: false,
        actionRecommended: false,
        tone: 'neutral',
        summary: 'Git は同期済みです'
      })
    });
  });

  await page.goto('/chat/');

  await expect(page.getByTestId('git-status-line')).toContainText('Git は同期済みです');
  await expect(page.getByTestId('git-commit-push-button')).toBeDisabled();
});
