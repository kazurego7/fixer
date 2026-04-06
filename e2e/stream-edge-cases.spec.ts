import { expect, test, type Page } from '@playwright/test';
import { bootstrapChatState, installApiMocks } from './helpers';

async function installVisualViewportMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const listeners = {
      resize: new Set<(event: Event) => void>(),
      scroll: new Set<(event: Event) => void>()
    };
    const viewport = {
      width: window.innerWidth,
      height: window.innerHeight,
      offsetTop: 0,
      offsetLeft: 0,
      pageTop: 0,
      pageLeft: 0,
      scale: 1,
      addEventListener(type: 'resize' | 'scroll', listener: EventListenerOrEventListenerObject | null) {
        if (!listener || (type !== 'resize' && type !== 'scroll')) return;
        const callback =
          typeof listener === 'function' ? listener : (event: Event) => listener.handleEvent(event);
        listeners[type].add(callback);
      },
      removeEventListener(type: 'resize' | 'scroll', listener: EventListenerOrEventListenerObject | null) {
        if (!listener || (type !== 'resize' && type !== 'scroll')) return;
        const callback =
          typeof listener === 'function' ? listener : (event: Event) => listener.handleEvent(event);
        listeners[type].delete(callback);
      }
    };
    const testWindow = window as Window & {
      visualViewport?: typeof viewport;
      __fxTestSetVisualViewport?: (height: number, offsetTop?: number) => void;
    };
    Object.defineProperty(testWindow, 'visualViewport', {
      configurable: true,
      get() {
        return viewport;
      }
    });
    testWindow.__fxTestSetVisualViewport = (height: number, offsetTop = 0) => {
      viewport.height = height;
      viewport.offsetTop = offsetTop;
      const resizeEvent = new Event('resize');
      const scrollEvent = new Event('scroll');
      listeners.resize.forEach((listener) => listener(resizeEvent));
      listeners.scroll.forEach((listener) => listener(scrollEvent));
    };
  });
}

async function setVisualViewportMetrics(page: Page, height: number, offsetTop = 0): Promise<void> {
  await page.evaluate(
    ({ nextHeight, nextOffsetTop }) => {
      const testWindow = window as Window & {
        __fxTestSetVisualViewport?: (height: number, offsetTop?: number) => void;
      };
      testWindow.__fxTestSetVisualViewport?.(nextHeight, nextOffsetTop);
    },
    { nextHeight: height, nextOffsetTop: offsetTop }
  );
}

async function readComposerViewportMetrics(page: Page): Promise<{ bottom: number; paddingBottom: number }> {
  return page.evaluate(() => {
    const composer = document.querySelector('[data-testid="composer"]');
    const scroll = document.querySelector('.fx-chat-scroll');
    if (!(composer instanceof HTMLElement) || !(scroll instanceof HTMLElement)) {
      throw new Error('composer_metrics_missing');
    }
    return {
      bottom: Number.parseFloat(getComputedStyle(composer).bottom || '0'),
      paddingBottom: Number.parseFloat(getComputedStyle(scroll).paddingBottom || '0')
    };
  });
}

test('ライブ出力中に戻っても turn を中断せずリポジトリ一覧へ戻れる', async ({ page }) => {
  await bootstrapChatState(page);
  await installApiMocks(page);
  const state = { restored: false, cancelCalls: 0 };

  await page.unroute('**/api/threads/messages**');
  await page.route('**/api/threads/messages**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: state.restored
          ? [
              {
                id: 'turn-nav-1:user:0',
                role: 'user',
                type: 'plain',
                text: '戻る確認'
              },
              {
                id: 'turn-nav-1:assistant:0',
                role: 'assistant',
                type: 'markdown',
                text: 'バックグラウンドで返答を継続しました',
                answer: 'バックグラウンドで返答を継続しました',
                plan: ''
              }
            ]
          : []
      })
    });
  });

  await page.unroute('**/api/turns/stream');
  await page.route('**/api/turns/stream', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 700));
    state.restored = true;
    const ndjson = [
      JSON.stringify({ type: 'started', turnId: 'turn-nav-1' }),
      JSON.stringify({
        type: 'turn_state',
        seq: 1,
        turnId: 'turn-nav-1',
        liveReasoningText: '',
        items: [
          {
            id: 'turn-nav-1:user:0',
            role: 'user',
            type: 'plain',
            text: '戻る確認'
          },
          {
            id: 'turn-nav-1:assistant:0',
            role: 'assistant',
            type: 'markdown',
            text: 'バックグラウンドで返答を継続しました',
            answer: 'バックグラウンドで返答を継続しました',
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
    state.cancelCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ cancelled: true })
    });
  });

  await page.goto('/chat/');
  await page.getByTestId('composer-textarea').fill('戻る確認');
  await page.getByTestId('send-button').click();

  await expect(page.getByTestId('back-button')).toBeVisible();
  await page.getByTestId('back-button').click();
  await expect(page).toHaveURL(/\/repos\/?$/);
  await page.waitForTimeout(900);
  expect(state.cancelCalls).toBe(0);

  await page.goto('/chat/');
  await expect(page.locator('.fx-msg-assistant .fx-msg-bubble')).toContainText('バックグラウンドで返答を継続しました');
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

test('ライブ出力途中でもマークダウンを整形表示する', async ({ page }) => {
  await bootstrapChatState(page);
  await installApiMocks(page);
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.includes('/api/turns/stream')) return originalFetch(input, init);

      const encoder = new TextEncoder();
      const chunks = [
        JSON.stringify({ type: 'started', turnId: 'turn-live-markdown-1' }) + '\n',
        JSON.stringify({
          type: 'turn_state',
          seq: 1,
          turnId: 'turn-live-markdown-1',
          liveReasoningText: '',
          items: [
            {
              id: 'turn-live-markdown-1:user:0',
              role: 'user',
              type: 'plain',
              text: '途中表示確認'
            },
            {
              id: 'turn-live-markdown-1:assistant:0',
              role: 'assistant',
              type: 'markdown',
              text: '**進行中**\n\n- 項目A\n- 項目B',
              answer: '**進行中**\n\n- 項目A\n- 項目B',
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
            setTimeout(pushNext, index === 1 ? 40 : index === 2 ? 500 : 40);
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
  await page.getByTestId('composer-textarea').fill('途中表示確認');
  await page.getByTestId('send-button').click();

  await expect(page.getByTestId('stream-loading-indicator')).toBeVisible();
  await expect(page.locator('.fx-msg-assistant .fx-msg-bubble strong')).toHaveText('進行中');
  await expect(page.locator('.fx-msg-assistant .fx-msg-bubble ul li')).toHaveCount(2);
  await expect(page.locator('.fx-msg-assistant .fx-msg-bubble')).toContainText('項目A');
  await expect(page.locator('.fx-msg-assistant .fx-msg-bubble')).toContainText('項目B');
});

test('ライブ出力中と完了後の本文スタイルを共通クラスで揃える', async ({ page }) => {
  await bootstrapChatState(page);
  await installApiMocks(page);

  await page.unroute('**/api/threads/messages**');
  await page.route('**/api/threads/messages**', async (route) => {
    const restored = await page.evaluate(() => {
      const win = window as Window & { __fxLiveFontRestored?: boolean };
      return Boolean(win.__fxLiveFontRestored);
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: restored
          ? [
              {
                id: 'turn-live-font-1:user:0',
                role: 'user',
                type: 'plain',
                text: '文字スタイル確認'
              },
              {
                id: 'turn-live-font-1:assistant:0',
                role: 'assistant',
                type: 'markdown',
                text: '**進行中の整理**\n\n- 項目A\n- 項目B',
                answer: '**進行中の整理**\n\n- 項目A\n- 項目B',
                plan: ''
              }
            ]
          : []
      })
    });
  });

  await page.addInitScript(() => {
    const win = window as Window & { __fxLiveFontRestored?: boolean };
    win.__fxLiveFontRestored = false;
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.includes('/api/turns/stream')) return originalFetch(input, init);

      const encoder = new TextEncoder();
      const chunks = [
        JSON.stringify({ type: 'started', turnId: 'turn-live-font-1' }) + '\n',
        JSON.stringify({
          type: 'turn_state',
          seq: 1,
          turnId: 'turn-live-font-1',
          liveReasoningText: '',
          items: [
            {
              id: 'turn-live-font-1:user:0',
              role: 'user',
              type: 'plain',
              text: '文字スタイル確認'
            },
            {
              id: 'turn-live-font-1:assistant:0',
              role: 'assistant',
              type: 'markdown',
              text: '**進行中の整理**\n\n- 項目A\n- 項目B',
              answer: '**進行中の整理**\n\n- 項目A\n- 項目B',
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
            if (index >= chunks.length - 1) {
              win.__fxLiveFontRestored = true;
            }
            window.setTimeout(pushNext, index === 1 ? 40 : index === 2 ? 500 : 40);
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
  await page.getByTestId('composer-textarea').fill('文字スタイル確認');
  await page.getByTestId('send-button').click();

  const bubble = page.locator('.fx-msg-assistant .fx-msg-bubble').last();
  const userLine = page.locator('.fx-user-line').last();
  await expect(page.getByTestId('stream-loading-indicator')).toBeVisible();
  await expect(bubble.locator('strong')).toHaveText('進行中の整理');
  const liveMarkdown = bubble.locator('.fx-message-body-copy');

  const liveStyle = await liveMarkdown.evaluate((node) => {
    const style = window.getComputedStyle(node);
    return {
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      color: style.color
    };
  });
  const userStyle = await userLine.evaluate((node) => {
    const style = window.getComputedStyle(node);
    return {
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      color: style.color
    };
  });

  await expect(page.getByTestId('stream-loading-indicator')).toBeHidden();
  const doneMarkdown = page.locator('.fx-msg-assistant .fx-msg-bubble .fx-message-body-copy').last();
  await expect(doneMarkdown).toBeVisible();

  const doneStyle = await doneMarkdown.evaluate((node) => {
    const style = window.getComputedStyle(node);
    return {
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      color: style.color
    };
  });

  expect(liveStyle).toEqual({
    fontSize: '14.4px',
    lineHeight: '21.6px',
    color: 'rgb(31, 41, 55)'
  });
  expect(doneStyle).toEqual(liveStyle);
  expect(userStyle).toEqual(liveStyle);
});

test('ライブ出力が増え続ける間は末尾へ自動スクロールする', async ({ page }) => {
  await bootstrapChatState(page);
  await installApiMocks(page);
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.includes('/api/turns/stream')) return originalFetch(input, init);

      const lines = Array.from({ length: 28 }, (_, idx) => `行 ${idx + 1}`).join('\n');
      const updatedLines = Array.from({ length: 80 }, (_, idx) => `追記 ${idx + 1}`).join('\n');
      const encoder = new TextEncoder();
      const chunks = [
        JSON.stringify({ type: 'started', turnId: 'turn-autoscroll-1' }) + '\n',
        JSON.stringify({
          type: 'turn_state',
          seq: 1,
          turnId: 'turn-autoscroll-1',
          liveReasoningText: '',
          items: [
            {
              id: 'turn-autoscroll-1:user:0',
              role: 'user',
              type: 'plain',
              text: '自動スクロール確認'
            },
            {
              id: 'turn-autoscroll-1:assistant:0',
              role: 'assistant',
              type: 'markdown',
              text: lines,
              answer: lines,
              plan: ''
            }
          ]
        }) + '\n',
        JSON.stringify({
          type: 'turn_state',
          seq: 2,
          turnId: 'turn-autoscroll-1',
          liveReasoningText: '',
          items: [
            {
              id: 'turn-autoscroll-1:user:0',
              role: 'user',
              type: 'plain',
              text: '自動スクロール確認'
            },
            {
              id: 'turn-autoscroll-1:assistant:0',
              role: 'assistant',
              type: 'markdown',
              text: `${lines}\n${updatedLines}`,
              answer: `${lines}\n${updatedLines}`,
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
            setTimeout(pushNext, index === 1 ? 50 : index === 2 ? 120 : index === 3 ? 250 : 60);
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
  await page.getByTestId('composer-textarea').fill('自動スクロール確認');
  await page.getByTestId('send-button').click();

  await expect(page.locator('.fx-msg-assistant .fx-msg-bubble')).toContainText('追記 80');
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const container = document.querySelector('.fx-chat-scroll');
        if (!(container instanceof HTMLElement)) return 9999;
        return Math.abs(container.scrollHeight - container.clientHeight - container.scrollTop);
      })
    )
    .toBeLessThan(8);
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
  const collapsedHeight = await textarea.evaluate((node) => node.clientHeight);

  await textarea.click();
  await expect(textarea).toBeFocused();
  await expect.poll(() => textarea.evaluate((node) => node.clientHeight)).toBeGreaterThan(collapsedHeight + 40);
  await textarea.fill('最初の入力');
  await page.getByTestId('send-button').click();

  await textarea.click();
  await expect(textarea).toBeFocused();
  const expandedHeight = await textarea.evaluate((node) => node.clientHeight);
  await textarea.fill(['1行目', '2行目', '3行目', '4行目', '5行目'].join('\n'));

  await expect.poll(() => textarea.evaluate((node) => node.clientHeight)).toBeGreaterThanOrEqual(expandedHeight);
  await expect(page.getByTestId('followup-button')).toBeEnabled();
});

test('多行入力が高さ上限を超えたら入力欄内部をスクロールできる', async ({ page }) => {
  await bootstrapChatState(page);
  await installApiMocks(page);
  await page.goto('/chat/');

  const textarea = page.getByTestId('composer-textarea');
  await textarea.click();
  await expect(textarea).toBeFocused();
  await textarea.fill(['1行目', '2行目', '3行目', '4行目', '5行目', '6行目'].join('\n'));

  const sixLineState = await textarea.evaluate((node) => ({
    clientHeight: node.clientHeight,
    scrollHeight: node.scrollHeight,
    overflowY: getComputedStyle(node).overflowY,
    scrollTopBefore: node.scrollTop,
    scrollTopAfter: (() => {
      node.scrollTop = 9999;
      return node.scrollTop;
    })()
  }));

  expect(sixLineState.overflowY).toBe('hidden');
  expect(sixLineState.scrollTopAfter).toBe(sixLineState.scrollTopBefore);

  await textarea.fill(['1行目', '2行目', '3行目', '4行目', '5行目', '6行目', '7行目', '8行目'].join('\n'));

  await expect
    .poll(() =>
      textarea.evaluate((node) => ({
        clientHeight: node.clientHeight,
        scrollHeight: node.scrollHeight,
        overflowY: getComputedStyle(node).overflowY
      }))
    )
    .toEqual(
      expect.objectContaining({
        overflowY: 'auto'
      })
    );

  const scrollState = await textarea.evaluate((node) => {
    const before = node.scrollTop;
    node.scrollTop = 9999;
    return {
      before,
      after: node.scrollTop,
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
      overflowY: getComputedStyle(node).overflowY
    };
  });

  expect(scrollState.scrollHeight).toBeGreaterThan(scrollState.clientHeight);
  expect(scrollState.overflowY).toBe('auto');
  expect(scrollState.after).toBeGreaterThan(scrollState.before);
});

test('初回応答待ち中はvisualViewportのoffsetTop変動で入力欄位置を下げない', async ({ page }) => {
  await installVisualViewportMock(page);
  await bootstrapChatState(page);
  await installApiMocks(page);

  await page.unroute('**/api/turns/stream');
  await page.route('**/api/turns/stream', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const ndjson = [JSON.stringify({ type: 'started', turnId: 'turn-viewport-1' }), JSON.stringify({ type: 'done' })].join('\n') + '\n';
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
      body: ndjson
    });
  });

  await page.goto('/chat/');
  const textarea = page.getByTestId('composer-textarea');
  await textarea.fill('最初の入力');
  await page.getByTestId('send-button').click();
  await expect(page.getByTestId('stream-loading-indicator')).toBeVisible();
  await textarea.click();
  await expect(textarea).toBeFocused();

  const innerHeight = await page.evaluate(() => window.innerHeight);
  await setVisualViewportMetrics(page, innerHeight - 320, 0);
  await expect.poll(() => readComposerViewportMetrics(page).then((metrics) => metrics.bottom)).toBe(320);
  const baseline = await readComposerViewportMetrics(page);

  await setVisualViewportMetrics(page, innerHeight - 320, 110);
  await expect
    .poll(() => readComposerViewportMetrics(page))
    .toMatchObject({
      bottom: baseline.bottom,
      paddingBottom: baseline.paddingBottom
    });
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
