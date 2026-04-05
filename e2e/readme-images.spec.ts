import { expect, test } from '@playwright/test';
import { E2E_MOBILE_VIEWPORT, bootstrapChatState, installApiMocks, saveVisualScreenshot } from './helpers';

test('README 用の画面イメージを出力する', async ({ page }, testInfo) => {
  await installApiMocks(page);
  await page.setViewportSize(E2E_MOBILE_VIEWPORT);

  await page.unroute('**/api/github/repos**');
  await page.route('**/api/github/repos**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        repos: [
          {
            id: 1,
            fullName: 'kazurego7/fixer',
            cloneUrl: 'https://github.com/kazurego7/fixer.git',
            updatedAt: '2026-04-05T08:00:00.000Z',
            cloneState: { status: 'cloned' }
          },
          {
            id: 2,
            fullName: 'openai/playground',
            cloneUrl: 'https://github.com/openai/playground.git',
            updatedAt: '2026-04-04T08:00:00.000Z',
            cloneState: { status: 'cloned' }
          },
          {
            id: 3,
            fullName: 'example/mobile-demo',
            cloneUrl: 'https://github.com/example/mobile-demo.git',
            updatedAt: '2026-04-02T08:00:00.000Z',
            cloneState: { status: 'not_cloned' }
          }
        ]
      })
    });
  });

  await page.goto('/repos/');
  await expect(page.getByPlaceholder('リポジトリ名で検索')).toBeVisible();
  await expect(page.getByText('fixer')).toBeVisible();
  await expect(page.getByText('mobile-demo')).toBeVisible();
  await saveVisualScreenshot(page, testInfo, 'readme-repos.png', {
    attachmentName: 'readme-repos'
  });

  await bootstrapChatState(page, 'kazurego7/fixer', 'thread-readme-chat');

  await page.unroute('**/api/threads/messages**');
  await page.route('**/api/threads/messages**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [] })
    });
  });

  await page.unroute('**/api/repos/git-status**');
  await page.route('**/api/repos/git-status**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        repoFullName: 'kazurego7/fixer',
        repoPath: '/tmp/kazurego7__fixer',
        branch: 'main',
        upstream: 'origin/main',
        ahead: 0,
        behind: 0,
        stagedCount: 0,
        unstagedCount: 1,
        untrackedCount: 0,
        conflictedCount: 0,
        hasChanges: true,
        actionRecommended: true,
        tone: 'warning',
        summary: '変更あり: 未反映 1'
      })
    });
  });

  await page.unroute('**/api/turns/stream');
  await page.route('**/api/turns/stream', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const ndjson = [JSON.stringify({ type: 'started', turnId: 'turn-readme-stream-1' }), JSON.stringify({ type: 'done' })].join('\n') + '\n';
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
      body: ndjson
    });
  });

  await page.unroute('**/api/turns/running**');
  await page.route('**/api/turns/running**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        running: true,
        threadId: 'thread-readme-chat',
        turnId: 'turn-readme-running-1'
      })
    });
  });

  await page.unroute('**/api/turns/live-state**');
  await page.route('**/api/turns/live-state**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        running: true,
        threadId: 'thread-readme-chat',
        turnId: 'turn-readme-running-1',
        seq: 0,
        liveReasoningText: '',
        items: [
          {
            id: 'turn-readme-running-1:user:0',
            role: 'user',
            type: 'plain',
            text: 'このアプリの紹介文をわかりやすく直して'
          },
          {
            id: 'turn-readme-running-1:assistant:0',
            role: 'assistant',
            type: 'markdown',
            text: [
              'README.md の紹介文を確認します。',
              '',
              'いまの説明は目的は伝わりますが、「何ができるか」と「どう使い始めるか」が少し見えにくいです。',
              'まずは、スマホから使えることと、GitHub のリポジトリを選んでそのまま作業に入れることが先に伝わる書き方にすると分かりやすくなります。',
              'たとえば、Fixer は'
            ].join('\n'),
            answer: [
              'README.md の紹介文を確認します。',
              '',
              'いまの説明は目的は伝わりますが、「何ができるか」と「どう使い始めるか」が少し見えにくいです。',
              'まずは、スマホから使えることと、GitHub のリポジトリを選んでそのまま作業に入れることが先に伝わる書き方にすると分かりやすくなります。',
              'たとえば、Fixer は'
            ].join('\n'),
            plan: ''
          }
        ]
      })
    });
  });

  await page.route('**/api/turns/stream/resume**', async () => {
    await new Promise((resolve) => setTimeout(resolve, 10000));
  });

  await page.goto('/chat/');
  await expect(page.getByText('README.md の紹介文を確認します。').first()).toBeVisible();
  await expect(page.getByTestId('stop-button')).toBeVisible();

  await saveVisualScreenshot(page, testInfo, 'readme-chat-streaming.png', {
    attachmentName: 'readme-chat-streaming'
  });

  const composer = page.getByTestId('composer-textarea');
  await composer.fill('返答中でも追加で指示できることも入れて');
  await expect(page.getByTestId('followup-button')).toBeVisible();

  await saveVisualScreenshot(page, testInfo, 'readme-chat-followup.png', {
    attachmentName: 'readme-chat-followup'
  });
});
