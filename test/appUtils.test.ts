import assert from 'node:assert/strict';
import test from 'node:test';

const {
  formatFileSize,
  formatIssueStatus,
  getClientErrorMessage,
  normalizeModelOptions,
  outputItemTurnId,
  parseTurnStreamEvent,
  threadMessagesKey
} = require('../web/src/appUtils') as typeof import('../web/src/appUtils');

test('getClientErrorMessage は Error と fallback を処理する', () => {
  assert.equal(getClientErrorMessage(new Error('failed')), 'failed');
  assert.equal(getClientErrorMessage({}, 'fallback'), 'fallback');
});

test('parseTurnStreamEvent は type のある JSON 行だけ返す', () => {
  assert.deepEqual(parseTurnStreamEvent('{"type":"done"}'), { type: 'done' });
  assert.equal(parseTurnStreamEvent('{"ok":true}'), null);
  assert.equal(parseTurnStreamEvent('not json'), null);
});

test('formatFileSize は byte 表示を丸める', () => {
  assert.equal(formatFileSize(0), '0 B');
  assert.equal(formatFileSize(512), '512 B');
  assert.equal(formatFileSize(1536), '1.5 KB');
  assert.equal(formatFileSize(1024 * 1024 * 2), '2.0 MB');
});

test('formatIssueStatus は UI 表示ラベルへ変換する', () => {
  assert.equal(formatIssueStatus('open'), '未対応');
  assert.equal(formatIssueStatus('summarizing'), '要約中');
  assert.equal(formatIssueStatus('failed'), '失敗');
  assert.equal(formatIssueStatus('resolved'), '解決済み');
  assert.equal(formatIssueStatus('pending'), '待機中');
});

test('outputItemTurnId と threadMessagesKey は保存用 key を安定生成する', () => {
  assert.equal(outputItemTurnId({ id: 'turn-1:item-1', role: 'assistant', type: 'plain', text: '' }), 'turn-1');
  assert.equal(outputItemTurnId(null), '');
  assert.equal(threadMessagesKey('thread-1'), 'fx:threadMessages:thread-1');
});

test('normalizeModelOptions は重複と不正値を除く', () => {
  assert.deepEqual(
    normalizeModelOptions([
      { id: 'gpt-1', name: 'GPT 1', description: 'old' },
      { id: 'gpt-1', name: 'duplicate' },
      { id: '' },
      null
    ]),
    [{ id: 'gpt-1', name: 'GPT 1', description: 'old' }]
  );
});
