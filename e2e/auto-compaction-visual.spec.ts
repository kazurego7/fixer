import { expect, test } from '@playwright/test';
import { E2E_MOBILE_VIEWPORT, bootstrapChatState, installApiMocks, saveVisualScreenshot } from './helpers';

test.use({ viewport: E2E_MOBILE_VIEWPORT });

test('オートコンパクション状態を表示する', async ({ page }, testInfo) => {
  await bootstrapChatState(page);
  await installApiMocks(page);

  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.includes('/api/turns/stream')) {
        return originalFetch(input, init);
      }

      const encoder = new TextEncoder();
      const chunks = [
        JSON.stringify({ type: 'started', turnId: 'turn-auto-compact-1' }) + '\n',
        JSON.stringify({ type: 'status', phase: 'compacting', message: '会話履歴を圧縮しています...' }) + '\n',
        JSON.stringify({ type: 'status', phase: 'compacted', message: '会話履歴を圧縮しました' }) + '\n',
        JSON.stringify({
          type: 'turn_state',
          seq: 1,
          turnId: 'turn-auto-compact-1',
          liveReasoningText: '',
          items: [
            {
              id: 'turn-auto-compact-1:user:0',
              role: 'user',
              type: 'plain',
              text: '長い会話の続き'
            },
            {
              id: 'turn-auto-compact-1:assistant:0',
              role: 'assistant',
              type: 'markdown',
              text: '圧縮後の回答です',
              answer: '圧縮後の回答です',
              plan: ''
            }
          ]
        }) + '\n',
        JSON.stringify({ type: 'done' }) + '\n'
      ];

      let index = 0;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const pushNext = () => {
            if (index >= chunks.length) {
              controller.close();
              return;
            }
            controller.enqueue(encoder.encode(chunks[index]));
            index += 1;
            const delay = index === 1 ? 120 : index === 2 ? 700 : index === 3 ? 500 : 60;
            window.setTimeout(pushNext, delay);
          };
          pushNext();
        }
      });

      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson; charset=utf-8' }
      });
    };
  });

  await page.goto('/chat/');
  await page.getByTestId('composer-textarea').fill('長い会話の続き');
  await page.getByTestId('send-button').click();

  await expect(page.getByTestId('compaction-status-panel')).toBeVisible();
  await expect(page.getByTestId('compaction-status-text')).toContainText('会話履歴を圧縮しています');
  await saveVisualScreenshot(page, testInfo, 'auto-compaction-running.png', {
    attachmentName: 'auto-compaction-running'
  });

  await expect(page.getByTestId('compaction-status-panel')).toHaveClass(/is-completed/);
  await expect(page.getByTestId('compaction-status-text')).toContainText('会話履歴を圧縮しました');
  await saveVisualScreenshot(page, testInfo, 'auto-compaction-completed.png', {
    attachmentName: 'auto-compaction-completed'
  });
});
