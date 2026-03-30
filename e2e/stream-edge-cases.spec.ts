import { expect, test } from '@playwright/test';
import { bootstrapChatState, installApiMocks } from './helpers';

test('ライブ出力中でもリポジトリ一覧へ戻れる', async ({ page }) => {
  await bootstrapChatState(page);
  await installApiMocks(page);

  await page.unroute('**/api/turns/stream');
  await page.route('**/api/turns/stream', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const ndjson = [JSON.stringify({ type: 'started', turnId: 'turn-nav-1' }), JSON.stringify({ type: 'done' })].join('\n') + '\n';
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
      body: ndjson
    });
  });

  await page.goto('/chat/');
  await page.getByTestId('composer-textarea').fill('戻る確認');
  await page.getByTestId('send-button').click();

  await expect(page.getByTestId('new-thread-button')).toBeEnabled();
  await page.getByTestId('back-button').click();
  await expect(page).toHaveURL(/\/repos\/?$/);
});

test('ライブ出力中でも追加入力を送れる', async ({ page }) => {
  await bootstrapChatState(page);
  await installApiMocks(page);

  const state = { streamCalls: 0, restored: false };

  await page.unroute('**/api/threads/messages**');
  await page.route('**/api/threads/messages**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: state.restored
          ? [
              {
                id: 'turn-followup-2:user:0',
                role: 'user',
                type: 'plain',
                text: '追加入力'
              },
              {
                id: 'turn-followup-2:assistant:0',
                role: 'assistant',
                type: 'markdown',
                text: '追加入力を受け付けました',
                answer: '追加入力を受け付けました',
                plan: ''
              }
            ]
          : []
      })
    });
  });

  await page.unroute('**/api/turns/stream');
  await page.route('**/api/turns/stream', async (route) => {
    state.streamCalls += 1;
    if (state.streamCalls === 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const ndjson = [JSON.stringify({ type: 'started', turnId: 'turn-followup-1' }), JSON.stringify({ type: 'done' })].join('\n') + '\n';
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
        body: ndjson
      });
      return;
    }

    state.restored = true;
    const ndjson = [
      JSON.stringify({ type: 'started', turnId: 'turn-followup-2' }),
      JSON.stringify({
        type: 'turn_state',
        seq: 1,
        turnId: 'turn-followup-2',
        liveReasoningText: '',
        items: [
          {
            id: 'turn-followup-2:user:0',
            role: 'user',
            type: 'plain',
            text: '追加入力'
          },
          {
            id: 'turn-followup-2:assistant:0',
            role: 'assistant',
            type: 'markdown',
            text: '追加入力を受け付けました',
            answer: '追加入力を受け付けました',
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
  await page.getByTestId('composer-textarea').fill('最初の入力');
  await page.getByTestId('send-button').click();

  await page.getByTestId('composer-textarea').fill('追加入力');
  await expect(page.getByTestId('followup-button')).toBeEnabled();
  await page.getByTestId('followup-button').click();

  await expect.poll(() => state.streamCalls).toBe(2);
  await expect(page.locator('.fx-msg-assistant .fx-msg-bubble')).toContainText('追加入力を受け付けました');
});

test('ライブ出力中でも入力欄へ再入力できて複数行で広がる', async ({ page }) => {
  await bootstrapChatState(page);
  await installApiMocks(page);

  await page.unroute('**/api/turns/stream');
  await page.route('**/api/turns/stream', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const ndjson = [JSON.stringify({ type: 'started', turnId: 'turn-composer-1' }), JSON.stringify({ type: 'done' })].join('\n') + '\n';
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
      body: ndjson
    });
  });

  await page.goto('/chat/');
  const textarea = page.getByTestId('composer-textarea');

  await textarea.fill('最初の入力');
  const baseHeight = await textarea.evaluate((node) => node.clientHeight);
  await page.getByTestId('send-button').click();

  await textarea.click();
  await expect(textarea).toBeFocused();
  await textarea.fill(['1行目', '2行目', '3行目', '4行目', '5行目'].join('\n'));

  await expect.poll(() => textarea.evaluate((node) => node.clientHeight)).toBeGreaterThan(baseHeight + 24);
  await expect(page.getByTestId('followup-button')).toBeEnabled();
});

test('errorイベント時は送信失敗を表示して思考パネルを消す', async ({ page }) => {
  await bootstrapChatState(page);
  await installApiMocks(page);

  await page.unroute('**/api/turns/stream');
  await page.route('**/api/turns/stream', async (route) => {
    const ndjson = [
      JSON.stringify({ type: 'started', turnId: 'turn-error-1' }),
      JSON.stringify({
        type: 'turn_state',
        seq: 1,
        turnId: 'turn-error-1',
        liveReasoningText: '確認中\n詳細を確認します',
        items: []
      }),
      JSON.stringify({ type: 'error', message: 'backend_failed' })
    ].join('\n') + '\n';

    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
      body: ndjson
    });
  });

  await page.goto('/chat/');
  await page.getByTestId('composer-textarea').fill('失敗確認');
  await page.getByTestId('send-button').click();

  await expect(page.locator('.fx-msg-system .fx-msg-bubble')).toContainText('送信失敗: backend_failed');
  await expect(page.locator('[data-testid="thinking-working-indicator"]')).toHaveCount(0);
});

test('応答が空でdoneした場合はassistantカードを増やさない', async ({ page }) => {
  await bootstrapChatState(page);
  await installApiMocks(page);

  await page.unroute('**/api/turns/stream');
  await page.route('**/api/turns/stream', async (route) => {
    const ndjson = [JSON.stringify({ type: 'started', turnId: 'turn-empty-1' }), JSON.stringify({ type: 'done' })].join('\n') + '\n';

    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
      body: ndjson
    });
  });

  await page.goto('/chat/');
  await page.getByTestId('composer-textarea').fill('空応答確認');
  await page.getByTestId('send-button').click();

  await expect(page.locator('.fx-msg-assistant .fx-msg-bubble')).toHaveCount(0);
});

test('停止押下で中断APIを呼び停止表示に切り替える', async ({ page }) => {
  await bootstrapChatState(page);
  await installApiMocks(page);

  const state: { cancelBody: { thread_id?: string } | null } = { cancelBody: null };

  await page.unroute('**/api/turns/stream');
  await page.route('**/api/turns/stream', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const ndjson = [
      JSON.stringify({ type: 'started', turnId: 'turn-cancel-1' }),
      JSON.stringify({
        type: 'turn_state',
        seq: 1,
        turnId: 'turn-cancel-1',
        liveReasoningText: '',
        items: [
          {
            id: 'turn-cancel-1:user:0',
            role: 'user',
            type: 'plain',
            text: '停止確認'
          },
          {
            id: 'turn-cancel-1:assistant:0',
            role: 'assistant',
            type: 'markdown',
            text: 'この応答は中断されます',
            answer: 'この応答は中断されます',
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

  await page.unroute('**/api/turns/cancel');
  await page.route('**/api/turns/cancel', async (route) => {
    state.cancelBody = JSON.parse(route.request().postData() || '{}');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ cancelled: true })
    });
  });

  await page.goto('/chat/');
  await page.getByTestId('composer-textarea').fill('停止確認');
  await page.getByTestId('send-button').click();
  await expect(page.getByLabel('停止')).toBeVisible();
  await page.getByLabel('停止').click();

  await expect.poll(() => state.cancelBody?.thread_id || '').toBe('thread-e2e-1');
  await expect(page.locator('.fx-msg-system .fx-msg-bubble')).toContainText('停止: 停止しました');
});

test('複数質問の回答送信後にresumeストリームを再開する', async ({ page }) => {
  await bootstrapChatState(page);
  await installApiMocks(page);

  const state: {
    approvalBody: { answers?: Record<string, { answers: string[] }> } | null;
    restored: boolean;
    awaitingResponse: boolean;
    initialTurnDone: boolean;
    resumeUrl: string;
  } = { approvalBody: null, restored: false, awaitingResponse: false, initialTurnDone: false, resumeUrl: '' };

  await page.unroute('**/api/threads/messages**');
  await page.route('**/api/threads/messages**', async (route) => {
    const items = state.restored
      ? [
          {
            id: 'turn-resume-1:user:0',
            role: 'user',
            type: 'plain',
            text: '複数質問確認'
          },
          {
            id: 'turn-resume-1:assistant:0',
            role: 'assistant',
            type: 'markdown',
            text: '確認前の回答です',
            answer: '確認前の回答です',
            plan: ''
          },
          {
            id: 'turn-resume-1:assistant:1',
            role: 'assistant',
            type: 'markdown',
            text: '再開後の回答です',
            answer: '再開後の回答です',
            plan: ''
          }
        ]
      : state.initialTurnDone
        ? [
            {
              id: 'turn-question-1:user:0',
              role: 'user',
              type: 'plain',
              text: '複数質問確認'
            },
            {
              id: 'turn-question-1:assistant:0',
              role: 'assistant',
              type: 'markdown',
              text: '確認前の回答です',
              answer: '確認前の回答です',
              plan: ''
            }
          ]
      : [];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items })
    });
  });

  await page.unroute('**/api/turns/stream');
  await page.route('**/api/turns/stream', async (route) => {
    state.awaitingResponse = true;
    state.initialTurnDone = true;
    const ndjson =
      [
        JSON.stringify({ type: 'started', turnId: 'turn-question-1' }),
        JSON.stringify({
          type: 'turn_state',
          seq: 1,
          turnId: 'turn-question-1',
          liveReasoningText: '',
          items: [
            {
              id: 'turn-question-1:user:0',
              role: 'user',
              type: 'plain',
              text: '複数質問確認'
            },
            {
              id: 'turn-question-1:assistant:0',
              role: 'assistant',
              type: 'markdown',
              text: '確認前の回答です',
              answer: '確認前の回答です',
              plan: ''
            }
          ]
        }),
        JSON.stringify({
          type: 'request_user_input',
          requestId: 'req-2',
          turnId: 'turn-question-1',
          itemId: 'item-2',
          questions: [
            {
              id: 'q1',
              header: '確認1',
              question: '最初の選択をしてください。',
              options: [
                { label: '案A', description: 'Aを選びます。' },
                { label: '案B', description: 'Bを選びます。' }
              ]
            },
            {
              id: 'q2',
              header: '確認2',
              question: '次の選択をしてください。',
              options: [
                { label: '案C', description: 'Cを選びます。' },
                { label: '案D', description: 'Dを選びます。' }
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

  await page.unroute('**/api/approvals/respond');
  await page.route('**/api/approvals/respond', async (route) => {
    state.approvalBody = JSON.parse(route.request().postData() || '{}');
    state.awaitingResponse = false;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true })
    });
  });

  await page.unroute('**/api/approvals/pending**');
  await page.route('**/api/approvals/pending**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        requests: state.awaitingResponse
          ? [
              {
                requestId: 'req-2',
                threadId: 'thread-e2e-1',
                turnId: 'turn-question-1',
                itemId: 'item-2',
                createdAt: '2026-03-30T00:00:00.000Z',
                questions: [
                  {
                    id: 'q1',
                    header: '確認1',
                    question: '最初の選択をしてください。',
                    options: [
                      { label: '案A', description: 'Aを選びます。' },
                      { label: '案B', description: 'Bを選びます。' }
                    ]
                  },
                  {
                    id: 'q2',
                    header: '確認2',
                    question: '次の選択をしてください。',
                    options: [
                      { label: '案C', description: 'Cを選びます。' },
                      { label: '案D', description: 'Dを選びます。' }
                    ]
                  }
                ]
              }
            ]
          : []
      })
    });
  });

  await page.unroute('**/api/turns/running**');
  await page.route('**/api/turns/running**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ running: true, threadId: 'thread-e2e-1', turnId: 'turn-resume-1' })
    });
  });

  await page.unroute('**/api/turns/live-state**');
  await page.route('**/api/turns/live-state**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        running: true,
        threadId: 'thread-e2e-1',
        turnId: 'turn-resume-1',
        seq: 3,
        items: [
          {
            id: 'turn-resume-1:user:0',
            role: 'user',
            type: 'plain',
            text: '複数質問確認'
          },
          {
            id: 'turn-resume-1:assistant:0',
            role: 'assistant',
            type: 'markdown',
            text: '確認前の回答です',
            answer: '確認前の回答です',
            plan: ''
          }
        ],
        liveReasoningText: ''
      })
    });
  });

  await page.route('**/api/turns/stream/resume**', async (route) => {
    state.restored = true;
    state.resumeUrl = route.request().url();
    const ndjson = [
      JSON.stringify({ type: 'started', turnId: 'turn-resume-1' }),
      JSON.stringify({
        type: 'turn_state',
        seq: 4,
        turnId: 'turn-resume-1',
        liveReasoningText: '再開見出し\n最終応答へ進みます',
        items: [
          {
            id: 'turn-resume-1:user:0',
            role: 'user',
            type: 'plain',
            text: '複数質問確認'
          },
          {
            id: 'turn-resume-1:assistant:0',
            role: 'assistant',
            type: 'markdown',
            text: '確認前の回答です',
            answer: '確認前の回答です',
            plan: ''
          },
          {
            id: 'turn-resume-1:assistant:1',
            role: 'assistant',
            type: 'markdown',
            text: '再開後の回答です',
            answer: '再開後の回答です',
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
  await page.getByTestId('composer-textarea').fill('複数質問確認');
  await page.getByTestId('send-button').click();

  await expect(page.locator('.fx-user-input-card')).toContainText('確認1');
  await page.getByTestId('user-input-option-q1').first().click();
  await expect(page.locator('.fx-user-input-card')).toContainText('確認2');
  await page.getByTestId('user-input-option-q2').first().click();

  await expect.poll(() => JSON.stringify(state.approvalBody?.answers || {})).toBe(
    JSON.stringify({
      q1: { answers: ['案A'] },
      q2: { answers: ['案C'] }
    })
  );
  await expect.poll(() => new URL(state.resumeUrl || 'http://127.0.0.1/').searchParams.get('afterSeq')).toBe('3');
  await expect(page.locator('.fx-msg-assistant .fx-msg-bubble')).toHaveCount(2);
  await expect(page.locator('.fx-msg-assistant .fx-msg-bubble').nth(0)).toContainText('確認前の回答です');
  await expect(page.locator('.fx-msg-assistant .fx-msg-bubble').nth(1)).toContainText('再開後の回答です');
  await expect(page.locator('.fx-msg-assistant .fx-msg-bubble').nth(0)).not.toContainText('再開後の回答です');
  await expect(page.locator('.fx-msg-assistant .fx-msg-bubble').nth(1)).not.toContainText('確認前の回答です');
  await expect(page.getByTestId('thinking-live-panel')).toHaveCount(0);
});

test('末尾改行なしのrequest_user_inputも処理する', async ({ page }) => {
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
                requestId: 'req-buffer-1',
                threadId: 'thread-e2e-1',
                turnId: 'turn-buffer-1',
                itemId: 'item-buffer-1',
                createdAt: '2026-03-30T00:00:00.000Z',
                questions: [
                  {
                    id: 'q-buffer',
                    header: '末尾確認',
                    question: '末尾バッファを処理できますか？',
                    options: [{ label: 'はい', description: '処理できます。' }]
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
    const ndjson = [
      JSON.stringify({ type: 'started', turnId: 'turn-buffer-1' }),
      JSON.stringify({
        type: 'request_user_input',
        requestId: 'req-buffer-1',
        turnId: 'turn-buffer-1',
        itemId: 'item-buffer-1',
        questions: [
          {
            id: 'q-buffer',
            header: '末尾確認',
            question: '末尾バッファを処理できますか？',
            options: [{ label: 'はい', description: '処理できます。' }]
          }
        ]
      })
    ].join('\n');

    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
      body: ndjson
    });
  });

  await page.goto('/chat/');
  await page.getByTestId('composer-textarea').fill('末尾バッファ確認');
  await page.getByTestId('send-button').click();

  await expect(page.locator('.fx-user-input-card')).toContainText('末尾確認');
  await expect(page.locator('.fx-user-input-card')).toContainText('末尾バッファを処理できますか？');
});
