const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  buildTurnStartOverrides,
  buildToolUserInputResponsePayload,
  buildCollaborationMode,
  repoFolderFromFullName,
  repoPathFromFullName,
  normalizeCollaborationMode,
  parseV2TurnNotification,
  parseLegacyTurnNotification,
  parseTurnTerminalNotification,
  selectTurnStreamUpdate,
  normalizeThreadMessages
} = require('../server');

test('normalizeCollaborationMode normalizes valid values', () => {
  assert.equal(normalizeCollaborationMode('plan'), 'plan');
  assert.equal(normalizeCollaborationMode('default'), 'default');
  assert.equal(normalizeCollaborationMode('normal'), 'default');
  assert.equal(normalizeCollaborationMode('  PLAN  '), 'plan');
});

test('normalizeCollaborationMode rejects unknown values', () => {
  assert.equal(normalizeCollaborationMode('foo'), null);
  assert.equal(normalizeCollaborationMode(''), null);
  assert.equal(normalizeCollaborationMode(null), null);
});

test('buildCollaborationMode returns turn/start payload shape', () => {
  const out = buildCollaborationMode('plan', 'gpt-5-codex');
  assert.deepEqual(out, {
    mode: 'plan',
    settings: {
      model: 'gpt-5-codex',
      reasoning_effort: null,
      developer_instructions: null
    }
  });
});

test('buildTurnStartOverrides always requests concise reasoning summary', async () => {
  const out = await buildTurnStartOverrides('thread-1', {});
  assert.deepEqual(out, {
    summary: 'concise'
  });
});

test('buildTurnStartOverrides includes selected model and collaboration mode', async () => {
  const out = await buildTurnStartOverrides('thread-1', {
    selectedModel: 'gpt-5-codex',
    collaborationMode: 'plan'
  });
  assert.deepEqual(out, {
    summary: 'concise',
    model: 'gpt-5-codex',
    collaborationMode: {
      mode: 'plan',
      settings: {
        model: 'gpt-5-codex',
        reasoning_effort: null,
        developer_instructions: null
      }
    }
  });
});

test('repoFolderFromFullName replaces slash', () => {
  assert.equal(repoFolderFromFullName('org/repo'), 'org__repo');
});

test('repoPathFromFullName resolves under workspace root', () => {
  const repoPath = repoPathFromFullName('org/repo');
  assert.equal(path.basename(repoPath), 'org__repo');
  assert.match(repoPath, /workspace/);
});

test('parseV2TurnNotification parses delta notification', () => {
  const parsed = parseV2TurnNotification({
    method: 'item/agentMessage/delta',
    params: { threadId: 't1', turnId: 'u1', delta: 'abc' }
  });
  assert.equal(parsed.method, 'item/agentMessage/delta');
  assert.equal(parsed.threadId, 't1');
  assert.equal(parsed.turnId, 'u1');
  assert.equal(parsed.delta, 'abc');
});

test('parseV2TurnNotification falls back to turn.id when turnId is absent', () => {
  const parsed = parseV2TurnNotification({
    method: 'turn/completed',
    params: { threadId: 't1', turn: { id: 'u-from-turn', status: 'Completed' } }
  });
  assert.equal(parsed.turnId, 'u-from-turn');
});

test('parseLegacyTurnNotification parses codex event', () => {
  const parsed = parseLegacyTurnNotification({
    method: 'codex/event/agent_message_delta',
    params: {
      conversationId: 't1',
      msg: { type: 'agent_message_delta', turn_id: 'u1', delta: 'abc' }
    }
  });
  assert.equal(parsed.type, 'agent_message_delta');
  assert.equal(parsed.threadId, 't1');
  assert.equal(parsed.turnId, 'u1');
  assert.equal(parsed.delta, 'abc');
});

test('selectTurnStreamUpdate maps legacy reasoning delta', () => {
  const out = selectTurnStreamUpdate(
    {
      method: 'codex/event/reasoning_delta',
      params: {
        conversationId: 't1',
        msg: { type: 'reasoning_delta', turn_id: 'u1', delta: '**見出し** legacy' }
      }
    },
    { threadId: 't1', turnId: 'u1', preferV2: false }
  );
  assert.equal(out.matched, true);
  assert.deepEqual(out.streamEvent, { type: 'reasoning_delta', delta: '**見出し** legacy' });
});

test('parseTurnTerminalNotification maps v2 completed to done terminal', () => {
  const parsed = parseTurnTerminalNotification({
    method: 'turn/completed',
    params: { threadId: 't1', turn: { id: 'u1', status: 'Completed' } }
  });
  assert.deepEqual(parsed, {
    threadId: 't1',
    turnId: 'u1',
    kind: 'done',
    message: null
  });
});

test('parseTurnTerminalNotification maps v2 error without retry to error terminal', () => {
  const parsed = parseTurnTerminalNotification({
    method: 'error',
    params: { threadId: 't1', turnId: 'u1', willRetry: false, error: { message: 'boom' } }
  });
  assert.deepEqual(parsed, {
    threadId: 't1',
    turnId: 'u1',
    kind: 'error',
    message: 'boom'
  });
});

test('parseTurnTerminalNotification maps legacy turn_complete to done terminal', () => {
  const parsed = parseTurnTerminalNotification({
    method: 'codex/event/turn_complete',
    params: { conversationId: 't1', msg: { type: 'turn_complete', turn_id: 'u1' } }
  });
  assert.deepEqual(parsed, {
    threadId: 't1',
    turnId: 'u1',
    kind: 'done',
    message: null
  });
});

test('selectTurnStreamUpdate maps v2 answer delta', () => {
  const out = selectTurnStreamUpdate(
    {
      method: 'item/agentMessage/delta',
      params: { threadId: 't1', turnId: 'u1', delta: 'A' }
    },
    { threadId: 't1', turnId: 'u1', preferV2: false }
  );
  assert.equal(out.matched, true);
  assert.equal(out.nextPreferV2, true);
  assert.deepEqual(out.streamEvent, { type: 'answer_delta', delta: 'A' });
});

test('selectTurnStreamUpdate maps v2 reasoning summaryTextDelta', () => {
  const out = selectTurnStreamUpdate(
    {
      method: 'item/reasoning/summaryTextDelta',
      params: { threadId: 't1', turnId: 'u1', itemId: 'r1', delta: '**見出し** 検討中' }
    },
    { threadId: 't1', turnId: 'u1', preferV2: false }
  );
  assert.equal(out.matched, true);
  assert.equal(out.nextPreferV2, true);
  assert.deepEqual(out.streamEvent, { type: 'reasoning_delta', delta: '**見出し** 検討中' });
});

test('selectTurnStreamUpdate maps v2 reasoning textDelta', () => {
  const out = selectTurnStreamUpdate(
    {
      method: 'item/reasoning/textDelta',
      params: { threadId: 't1', turnId: 'u1', itemId: 'r1', delta: '補足本文' }
    },
    { threadId: 't1', turnId: 'u1', preferV2: false }
  );
  assert.equal(out.matched, true);
  assert.equal(out.nextPreferV2, true);
  assert.deepEqual(out.streamEvent, { type: 'reasoning_delta', delta: '補足本文' });
});

test('selectTurnStreamUpdate ignores v2 event for another thread', () => {
  const out = selectTurnStreamUpdate(
    {
      method: 'item/reasoning/summaryTextDelta',
      params: { threadId: 't-other', turnId: 'u1', itemId: 'r1', delta: '**見出し** 検討中' }
    },
    { threadId: 't1', turnId: 'u1', preferV2: false }
  );
  assert.equal(out.matched, false);
  assert.equal(out.nextPreferV2, false);
});

test('selectTurnStreamUpdate maps v2 plan delta', () => {
  const out = selectTurnStreamUpdate(
    {
      method: 'item/plan/delta',
      params: { threadId: 't1', turnId: 'u1', itemId: 'p1', delta: '計画の差分' }
    },
    { threadId: 't1', turnId: 'u1', preferV2: false }
  );
  assert.equal(out.matched, true);
  assert.equal(out.nextPreferV2, true);
  assert.deepEqual(out.streamEvent, { type: 'plan_delta', delta: '計画の差分' });
});

test('selectTurnStreamUpdate maps v2 turn plan updated', () => {
  const out = selectTurnStreamUpdate(
    {
      method: 'turn/plan/updated',
      params: {
        threadId: 't1',
        turnId: 'u1',
        explanation: '方針',
        plan: [
          { step: '調査', status: 'completed' },
          { step: '実装', status: 'inProgress' }
        ]
      }
    },
    { threadId: 't1', turnId: 'u1', preferV2: true }
  );
  assert.equal(out.matched, true);
  assert.deepEqual(out.streamEvent, {
    type: 'plan_snapshot',
    text: '方針\n[x] 調査\n[-] 実装'
  });
});

test('selectTurnStreamUpdate maps request user input event', () => {
  const out = selectTurnStreamUpdate(
    {
      jsonrpc: '2.0',
      id: 77,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 't1',
        turnId: 'u1',
        itemId: 'i1',
        questions: [
          {
            id: 'q1',
            header: '確認',
            question: 'どちらにしますか？',
            isOther: false,
            isSecret: false,
            options: [{ label: 'はい', description: '進める' }, { label: 'いいえ', description: '止める' }]
          }
        ]
      }
    },
    { threadId: 't1', turnId: 'u1', preferV2: false }
  );
  assert.equal(out.matched, true);
  assert.equal(out.nextPreferV2, true);
  assert.deepEqual(out.streamEvent, {
    type: 'request_user_input',
    requestId: 77,
    turnId: 'u1',
    itemId: 'i1',
    questions: [
      {
        id: 'q1',
        header: '確認',
        question: 'どちらにしますか？',
        isOther: false,
        isSecret: false,
        options: [{ label: 'はい', description: '進める' }, { label: 'いいえ', description: '止める' }]
      }
    ]
  });
});

test('selectTurnStreamUpdate maps v2 completed as done', () => {
  const out = selectTurnStreamUpdate(
    {
      method: 'turn/completed',
      params: { threadId: 't1', turn: { id: 'u1', status: 'Completed' } }
    },
    { threadId: 't1', turnId: 'u1', preferV2: true }
  );
  assert.equal(out.matched, true);
  assert.deepEqual(out.terminal, { kind: 'done' });
});

test('selectTurnStreamUpdate maps v2 failed as error', () => {
  const out = selectTurnStreamUpdate(
    {
      method: 'turn/completed',
      params: { threadId: 't1', turn: { id: 'u1', status: 'Failed' } }
    },
    { threadId: 't1', turnId: 'u1', preferV2: true }
  );
  assert.equal(out.matched, true);
  assert.deepEqual(out.terminal, { kind: 'error', message: 'turn_failed' });
});

test('selectTurnStreamUpdate maps v2 interrupted as error', () => {
  const out = selectTurnStreamUpdate(
    {
      method: 'turn/completed',
      params: { threadId: 't1', turn: { id: 'u1', status: 'Interrupted' } }
    },
    { threadId: 't1', turnId: 'u1', preferV2: true }
  );
  assert.equal(out.matched, true);
  assert.deepEqual(out.terminal, { kind: 'error', message: 'turn_interrupted' });
});

test('selectTurnStreamUpdate maps v2 cancelled as error', () => {
  const out = selectTurnStreamUpdate(
    {
      method: 'turn/completed',
      params: { threadId: 't1', turn: { id: 'u1', status: 'Cancelled' } }
    },
    { threadId: 't1', turnId: 'u1', preferV2: true }
  );
  assert.equal(out.matched, true);
  assert.deepEqual(out.terminal, { kind: 'error', message: 'turn_cancelled' });
});

test('selectTurnStreamUpdate maps v2 retryable error to reconnect status', () => {
  const out = selectTurnStreamUpdate(
    {
      method: 'error',
      params: {
        threadId: 't1',
        turnId: 'u1',
        willRetry: true,
        error: { message: 'Reconnecting...2/5' }
      }
    },
    { threadId: 't1', turnId: 'u1', preferV2: true }
  );
  assert.equal(out.matched, true);
  assert.deepEqual(out.streamEvent, {
    type: 'status',
    phase: 'reconnecting',
    message: 'Reconnecting...2/5'
  });
});

test('selectTurnStreamUpdate ignores legacy when v2 preferred', () => {
  const out = selectTurnStreamUpdate(
    {
      method: 'codex/event/agent_message_delta',
      params: {
        conversationId: 't1',
        msg: { type: 'agent_message_delta', turn_id: 'u1', delta: 'legacy' }
      }
    },
    { threadId: 't1', turnId: 'u1', preferV2: true }
  );
  assert.equal(out.matched, false);
  assert.equal(out.nextPreferV2, true);
});

test('selectTurnStreamUpdate handles legacy completion', () => {
  const out = selectTurnStreamUpdate(
    {
      method: 'codex/event/task_complete',
      params: { conversationId: 't1', msg: { type: 'task_complete', turn_id: 'u1' } }
    },
    { threadId: 't1', turnId: 'u1', preferV2: false }
  );
  assert.equal(out.matched, true);
  assert.deepEqual(out.terminal, { kind: 'done' });
});

test('normalizeThreadMessages keeps assistant as single message unit even with reasoning items', () => {
  const readResult = {
    thread: {
      turns: [
        {
          id: 't1',
          input: [{ type: 'text', text: 'ユーザー質問' }],
          items: [
            { type: 'agentMessage', text: '本文1' },
            { type: 'reasoning', summary: ['thinking'] },
            { type: 'agentMessage', text: '本文2' },
            { type: 'reasoning', summary: ['thinking2'] },
            { type: 'agentMessage', text: '本文3' }
          ]
        }
      ]
    }
  };

  const out = normalizeThreadMessages(readResult);
  assert.deepEqual(
    out.map((item) => [item.id, item.role, item.type, item.text]),
    [
      ['t1:user', 'user', 'plain', 'ユーザー質問'],
      ['t1:assistant', 'assistant', 'markdown', '本文1\n本文2\n本文3'],
      ['t1:sep', 'system', 'separator', '']
    ]
  );
});

test('normalizeThreadMessages keeps single assistant segment when reasoning is absent', () => {
  const readResult = {
    thread: {
      turns: [
        {
          id: 't2',
          input: [{ type: 'text', text: 'q' }],
          items: [{ type: 'agentMessage', text: 'a1' }, { type: 'agentMessage', text: 'a2' }]
        }
      ]
    }
  };

  const out = normalizeThreadMessages(readResult);
  assert.deepEqual(
    out.map((item) => [item.id, item.role, item.type, item.text]),
    [
      ['t2:user', 'user', 'plain', 'q'],
      ['t2:assistant', 'assistant', 'markdown', 'a1\na2'],
      ['t2:sep', 'system', 'separator', '']
    ]
  );
});

test('normalizeThreadMessages keeps plan items in dedicated field', () => {
  const readResult = {
    thread: {
      turns: [
        {
          id: 't2p',
          input: [{ type: 'text', text: 'q' }],
          items: [{ type: 'plan', text: '手順1' }, { type: 'agentMessage', text: '最終回答' }]
        }
      ]
    }
  };

  const out = normalizeThreadMessages(readResult);
  assert.deepEqual(
    out.map((item) => [item.id, item.role, item.type, item.text]),
    [
      ['t2p:user', 'user', 'plain', 'q'],
      ['t2p:assistant', 'assistant', 'markdown', '最終回答'],
      ['t2p:sep', 'system', 'separator', '']
    ]
  );
  const assistant = out.find((item) => item.id === 't2p:assistant');
  assert.equal(assistant.plan, '手順1');
});

test('normalizeThreadMessages marks diff segment as diff', () => {
  const readResult = {
    thread: {
      turns: [
        {
          id: 't3',
          input: [{ type: 'text', text: 'q' }],
          items: [{ type: 'agentMessage', text: 'diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b' }]
        }
      ]
    }
  };
  const out = normalizeThreadMessages(readResult);
  const assistant = out.find((item) => item.id === 't3:assistant');
  assert.ok(assistant);
  assert.equal(assistant.type, 'diff');
});

test('buildToolUserInputResponsePayload normalizes single and array answers', () => {
  const out = buildToolUserInputResponsePayload({
    q1: '案A',
    q2: ['x', '', 'y'],
    q3: { answers: [' one ', ''] }
  });
  assert.deepEqual(out, {
    answers: {
      q1: { answers: ['案A'] },
      q2: { answers: ['x', 'y'] },
      q3: { answers: ['one'] }
    }
  });
});

test('buildToolUserInputResponsePayload drops empty answers', () => {
  const out = buildToolUserInputResponsePayload({
    q1: '',
    q2: [],
    q3: { answers: [''] }
  });
  assert.deepEqual(out, { answers: {} });
});
