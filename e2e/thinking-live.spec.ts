import { expect, test } from '@playwright/test';
import { bootstrapChatState, installApiMocks } from './helpers';

test('思考ログのみ表示され、完了時に消える @smoke', async ({ page }) => {
  await bootstrapChatState(page);
  await installApiMocks(page);
  const state = { restored: false };

  await page.unroute('**/api/threads/messages**');
  await page.route('**/api/threads/messages**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: state.restored
          ? [
              {
                id: 'turn-thinking-1:user:0',
                role: 'user',
                type: 'plain',
                text: '動作確認'
              },
              {
                id: 'turn-thinking-1:assistant:0',
                role: 'assistant',
                type: 'markdown',
                text: '回答を開始します',
                answer: '回答を開始します',
                plan: ''
              }
            ]
          : []
      })
    });
  });

  await page.unroute('**/api/turns/stream');
  await page.route('**/api/turns/stream', async (route) => {
    state.restored = true;
    await new Promise((resolve) => setTimeout(resolve, 500));
    const ndjson = [
      JSON.stringify({ type: 'started', turnId: 'turn-thinking-1' }),
      JSON.stringify({
        type: 'turn_state',
        seq: 1,
        turnId: 'turn-thinking-1',
        liveReasoningText: 'セクション1\n検討中です',
        items: []
      }),
      JSON.stringify({
        type: 'turn_state',
        seq: 2,
        turnId: 'turn-thinking-1',
        liveReasoningText: 'セクション2\n確定表示候補です',
        items: []
      }),
      JSON.stringify({
        type: 'turn_state',
        seq: 3,
        turnId: 'turn-thinking-1',
        liveReasoningText: '',
        items: [
          {
            id: 'turn-thinking-1:user:0',
            role: 'user',
            type: 'plain',
            text: '動作確認'
          },
          {
            id: 'turn-thinking-1:assistant:0',
            role: 'assistant',
            type: 'markdown',
            text: '回答を開始します',
            answer: '回答を開始します',
            plan: ''
          }
        ]
      }),
      JSON.stringify({ type: 'done' })
    ].join('\n') + '\n';

    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
      body: ndjson
    });
  });

  await page.goto('/chat/');
  await page.getByTestId('composer-textarea').fill('動作確認');
  await page.getByTestId('send-button').click();
  await expect(page.getByTestId('stream-loading-indicator')).toBeVisible();
  await expect(page.locator('.fx-msg-assistant .fx-msg-bubble')).toHaveCount(0);

  await expect(page.locator('.fx-msg-assistant .fx-msg-bubble')).toContainText('回答を開始します');
  await expect(page.getByTestId('thinking-live-content')).toHaveCount(0);
  await expect(page.locator('.fx-chat-scroll')).not.toContainText('処理中...');
  await expect(page.locator('.fx-chat-scroll')).not.toContainText('思考中');
  await expect(page.locator('.fx-chat-scroll')).not.toContainText('出力中');
  await expect(page.getByTestId('thinking-live-panel')).toHaveCount(0);
});

test('reasoningイベントが無い場合は回答本文の見出しだけを表示する', async ({ page }) => {
  await bootstrapChatState(page);
  await installApiMocks(page);
  const state = { restored: false };

  await page.unroute('**/api/threads/messages**');
  await page.route('**/api/threads/messages**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: state.restored
          ? [
              {
                id: 'turn-answer-only-1:user:0',
                role: 'user',
                type: 'plain',
                text: '見出し確認'
              },
              {
                id: 'turn-answer-only-1:assistant:0',
                role: 'assistant',
                type: 'markdown',
                text: '**回答見出し**\n本文です。',
                answer: '**回答見出し**\n本文です。',
                plan: ''
              }
            ]
          : []
      })
    });
  });

  await page.unroute('**/api/turns/stream');
  await page.route('**/api/turns/stream', async (route) => {
    state.restored = true;
    await new Promise((resolve) => setTimeout(resolve, 300));
    const ndjson = [
      JSON.stringify({ type: 'started', turnId: 'turn-answer-only-1' }),
      JSON.stringify({
        type: 'turn_state',
        seq: 1,
        turnId: 'turn-answer-only-1',
        liveReasoningText: '',
        items: [
          {
            id: 'turn-answer-only-1:user:0',
            role: 'user',
            type: 'plain',
            text: '見出し確認'
          },
          {
            id: 'turn-answer-only-1:assistant:0',
            role: 'assistant',
            type: 'markdown',
            text: '**回答見出し**\n本文です。',
            answer: '**回答見出し**\n本文です。',
            plan: ''
          }
        ]
      }),
      JSON.stringify({ type: 'done' })
    ].join('\n') + '\n';

    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
      body: ndjson
    });
  });

  await page.goto('/chat/');
  await page.getByTestId('composer-textarea').fill('見出し確認');
  await page.getByTestId('send-button').click();
  await expect(page.getByTestId('stream-loading-indicator')).toBeVisible();

  await expect(page.locator('.fx-msg-assistant .fx-msg-bubble')).toContainText('回答見出し');
  await expect(page.locator('.fx-msg-assistant .fx-msg-bubble')).toContainText('本文です。');
  await expect(page.getByTestId('thinking-live-panel')).toHaveCount(0);
});

test('ユーザー入力要求が表示されている間は思考パネルを残さない', async ({ page }) => {
  await bootstrapChatState(page);
  await installApiMocks(page);
  const state = { pending: false };

  await page.unroute('**/api/approvals/pending**');
  await page.route('**/api/approvals/pending**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        requests: state.pending
          ? [
              {
                requestId: 'req-1',
                threadId: 'thread-e2e-1',
                turnId: 'turn-1',
                itemId: 'item-1',
                createdAt: '2026-03-30T00:00:00.000Z',
                questions: [
                  {
                    id: 'q1',
                    header: '方針確認',
                    question: '進め方を選んでください。',
                    options: [
                      { label: '案A', description: '速度優先です。' },
                      { label: '案B', description: '安全性優先です。' }
                    ]
                  }
                ]
              }
            ]
          : []
      })
    });
  });

  await page.unroute('**/api/turns/stream');
  await page.route('**/api/turns/stream', async (route) => {
    state.pending = true;
    await new Promise((resolve) => setTimeout(resolve, 300));
    const ndjson = [
      JSON.stringify({ type: 'started', turnId: 'turn-1' }),
      JSON.stringify({
        type: 'turn_state',
        seq: 1,
        turnId: 'turn-1',
        liveReasoningText: '方針整理\n選択肢をまとめます',
        items: []
      }),
      JSON.stringify({
        type: 'request_user_input',
        requestId: 'req-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        questions: [
          {
            id: 'q1',
            header: '方針確認',
            question: '進め方を選んでください。',
            options: [
              { label: '案A', description: '速度優先です。' },
              { label: '案B', description: '安全性優先です。' }
            ]
          }
        ]
      }),
      JSON.stringify({ type: 'done' })
    ].join('\n') + '\n';

    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
      body: ndjson
    });
  });

  await page.goto('/chat/');
  await page.getByTestId('composer-textarea').fill('方針確認');
  await page.getByTestId('send-button').click();

  await expect(page.locator('.fx-user-input-card')).toContainText('方針確認');
  await expect(page.locator('.fx-user-input-card')).toContainText('進め方を選んでください。');
  await expect(page.getByTestId('thinking-live-panel')).toHaveCount(0);
});

test('複数ターン後でも思考更新中に最新の質問表示を維持する', async ({ page }) => {
  await bootstrapChatState(page);
  await installApiMocks(page);

  const historyItems = [
    {
      id: 'turn-old-1:user:0',
      role: 'user',
      type: 'plain',
      text: '最初の質問'
    },
    {
      id: 'turn-old-1:assistant:0',
      role: 'assistant',
      type: 'markdown',
      text: '最初の回答',
      answer: '最初の回答',
      plan: ''
    },
    {
      id: 'turn-old-2:user:0',
      role: 'user',
      type: 'plain',
      text: '次の質問'
    },
    {
      id: 'turn-old-2:assistant:0',
      role: 'assistant',
      type: 'markdown',
      text: '次の回答',
      answer: '次の回答',
      plan: ''
    }
  ];

  await page.unroute('**/api/threads/messages**');
  await page.route('**/api/threads/messages**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: historyItems
      })
    });
  });

  await page.addInitScript((items) => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (!url.includes('/api/turns/stream')) return originalFetch(input, init);

      const encoder = new TextEncoder();
      const chunks = [
        JSON.stringify({ type: 'started', turnId: 'turn-thinking-stable' }) + '\n',
        JSON.stringify({
          type: 'turn_state',
          seq: 1,
          turnId: 'turn-thinking-stable',
          liveReasoningText: '思考1\n整理中です',
          items: [
            ...items,
            {
              id: 'turn-thinking-stable:user:0',
              role: 'user',
              type: 'plain',
              text: '最新の質問'
            }
          ]
        }) + '\n',
        JSON.stringify({
          type: 'turn_state',
          seq: 2,
          turnId: 'turn-thinking-stable',
          liveReasoningText: '思考2\n比較中です',
          items: [
            ...items,
            {
              id: 'turn-thinking-stable:user:0',
              role: 'user',
              type: 'plain',
              text: '最新の質問'
            }
          ]
        }) + '\n',
        JSON.stringify({
          type: 'turn_state',
          seq: 3,
          turnId: 'turn-thinking-stable',
          liveReasoningText: '',
          items: [
            ...items,
            {
              id: 'turn-thinking-stable:user:0',
              role: 'user',
              type: 'plain',
              text: '最新の質問'
            },
            {
              id: 'turn-thinking-stable:assistant:0',
              role: 'assistant',
              type: 'markdown',
              text: '最終回答です',
              answer: '最終回答です',
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
            window.setTimeout(pushNext, index === chunks.length ? 40 : 220);
          };
          pushNext();
        }
      });

      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson; charset=utf-8' }
      });
    };
  }, historyItems);

  await page.goto('/chat/');
  await expect(page.locator('.fx-msg-user')).toHaveCount(2);

  await page.getByTestId('composer-textarea').fill('最新の質問');
  await page.getByTestId('send-button').click();

  await expect(page.getByTestId('thinking-working-indicator')).toBeVisible();
  await expect(page.locator('.fx-msg-user').last()).toContainText('最新の質問');
  await expect(page.locator('.fx-msg-user')).toHaveCount(3);
  await expect(page.getByTestId('thinking-live-content')).toContainText('思考1');

  await expect(page.getByTestId('thinking-live-content')).toContainText('思考2');
  await expect(page.locator('.fx-msg-user').last()).toContainText('最新の質問');
  await expect(page.locator('.fx-msg-user')).toHaveCount(3);

  await expect(page.locator('.fx-msg-assistant .fx-msg-bubble').last()).toContainText('最終回答です');
});
