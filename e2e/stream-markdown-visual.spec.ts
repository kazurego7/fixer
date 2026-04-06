import { expect, test } from '@playwright/test';
import { E2E_MOBILE_VIEWPORT, bootstrapChatState, installApiMocks, saveVisualScreenshot } from './helpers';

test.use({ viewport: E2E_MOBILE_VIEWPORT });

test('ストリーミング途中のマークダウン整形表示を確認する', async ({ page }, testInfo) => {
  await bootstrapChatState(page);
  await installApiMocks(page);

  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.includes('/api/turns/stream')) return originalFetch(input, init);

      const encoder = new TextEncoder();
      const chunks = [
        JSON.stringify({ type: 'started', turnId: 'turn-stream-markdown-visual-1' }) + '\n',
        JSON.stringify({
          type: 'turn_state',
          seq: 1,
          turnId: 'turn-stream-markdown-visual-1',
          liveReasoningText: '',
          items: [
            {
              id: 'turn-stream-markdown-visual-1:user:0',
              role: 'user',
              type: 'plain',
              text: '途中の整形を見たい'
            },
            {
              id: 'turn-stream-markdown-visual-1:assistant:0',
              role: 'assistant',
              type: 'markdown',
              text: [
                '**進行中の整理**',
                '',
                '- 重要な確認事項',
                '- 次に見るポイント',
                '',
                '`npm test` はまだ未実行です。'
              ].join('\n'),
              answer: [
                '**進行中の整理**',
                '',
                '- 重要な確認事項',
                '- 次に見るポイント',
                '',
                '`npm test` はまだ未実行です。'
              ].join('\n'),
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
            const delay = index === 1 ? 40 : index === 2 ? 1200 : 40;
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
  await page.getByTestId('composer-textarea').fill('途中の整形を見たい');
  await page.getByTestId('send-button').click();

  await expect(page.getByTestId('stream-loading-indicator')).toBeVisible();
  await expect(page.locator('.fx-msg-assistant .fx-msg-bubble strong')).toHaveText('進行中の整理');
  await expect(page.locator('.fx-msg-assistant .fx-msg-bubble ul li')).toHaveCount(2);
  await expect(page.locator('.fx-msg-assistant .fx-msg-bubble code')).toContainText('npm test');

  await saveVisualScreenshot(page, testInfo, 'stream-markdown-live.png', {
    attachmentName: 'stream-markdown-live'
  });
});
