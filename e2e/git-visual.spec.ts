import { expect, test } from '@playwright/test';
import { E2E_MOBILE_VIEWPORT, bootstrapChatState, installApiMocks, saveVisualScreenshot } from './helpers';

type GitVisualScenario = {
  name: string;
  fileSlug: string;
  response:
    | {
        status: number;
        body: Record<string, unknown>;
      }
    | {
        status: number;
        body: Record<string, unknown>;
      };
  expectedText: string;
  buttonEnabled: boolean;
};

const scenarios: GitVisualScenario[] = [
  {
    name: '同期済み',
    fileSlug: 'neutral',
    response: {
      status: 200,
      body: {
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
      }
    },
    expectedText: 'Git は同期済みです',
    buttonEnabled: false
  },
  {
    name: '変更あり',
    fileSlug: 'warning',
    response: {
      status: 200,
      body: {
        repoFullName: 'owner/repo',
        repoPath: '/tmp/owner__repo',
        branch: 'main',
        upstream: 'origin/main',
        ahead: 0,
        behind: 0,
        stagedCount: 1,
        unstagedCount: 2,
        untrackedCount: 1,
        conflictedCount: 0,
        hasChanges: true,
        actionRecommended: true,
        tone: 'warning',
        summary: '変更あり: ステージ 1 / 未反映 2 / 新規追加 1'
      }
    },
    expectedText: '変更あり',
    buttonEnabled: true
  },
  {
    name: '未 push コミットあり',
    fileSlug: 'success',
    response: {
      status: 200,
      body: {
        repoFullName: 'owner/repo',
        repoPath: '/tmp/owner__repo',
        branch: 'feature/git-status',
        upstream: 'origin/feature/git-status',
        ahead: 3,
        behind: 0,
        stagedCount: 0,
        unstagedCount: 0,
        untrackedCount: 0,
        conflictedCount: 0,
        hasChanges: false,
        actionRecommended: true,
        tone: 'success',
        summary: '未 push のコミット 3 件'
      }
    },
    expectedText: '未 push のコミット 3 件',
    buttonEnabled: true
  },
  {
    name: '競合あり',
    fileSlug: 'danger',
    response: {
      status: 200,
      body: {
        repoFullName: 'owner/repo',
        repoPath: '/tmp/owner__repo',
        branch: 'main',
        upstream: 'origin/main',
        ahead: 1,
        behind: 1,
        stagedCount: 0,
        unstagedCount: 0,
        untrackedCount: 0,
        conflictedCount: 2,
        hasChanges: true,
        actionRecommended: true,
        tone: 'danger',
        summary: 'Git 競合 2 件'
      }
    },
    expectedText: 'Git 競合 2 件',
    buttonEnabled: true
  },
  {
    name: '取得失敗',
    fileSlug: 'error',
    response: {
      status: 500,
      body: {
        error: 'git_status_failed',
        detail: 'git status failed'
      }
    },
    expectedText: 'Git 状態取得失敗',
    buttonEnabled: false
  }
];

for (const scenario of scenarios) {
  test(`Git ステータスの見た目を確認できる: ${scenario.name}`, async ({ page }, testInfo) => {
    await bootstrapChatState(page);
    await installApiMocks(page);
    await page.setViewportSize(E2E_MOBILE_VIEWPORT);

    await page.route('**/api/repos/git-status**', async (route) => {
      await route.fulfill({
        status: scenario.response.status,
        contentType: 'application/json',
        body: JSON.stringify(scenario.response.body)
      });
    });

    await page.goto('/chat/');

    const statusLine = page.getByTestId('git-status-line');
    const button = page.getByTestId('git-commit-push-button');

    await expect(statusLine).toContainText(scenario.expectedText);
    if (scenario.buttonEnabled) await expect(button).toBeEnabled();
    else await expect(button).toBeDisabled();

    await saveVisualScreenshot(page, testInfo, `git-status-${scenario.fileSlug}.png`, {
      attachmentName: `git-status-${scenario.fileSlug}`
    });
  });
}
