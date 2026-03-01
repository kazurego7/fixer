const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  repoFolderFromFullName,
  repoPathFromFullName,
  parseV2TurnNotification,
  parseLegacyTurnNotification,
  parseTurnTerminalNotification,
  selectTurnStreamUpdate,
  normalizeThreadMessages
} = require('../server');

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
