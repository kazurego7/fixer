const test = require('node:test');
const assert = require('node:assert/strict');

test('extractDisplayReasoningText は最初の見出しを即時表示する', async () => {
  const { extractDisplayReasoningText } = await import('../web/src/reasoning.mjs');
  assert.equal(extractDisplayReasoningText('**見出し1** 検討中です'), '見出し1\n検討中です');
});

test('extractDisplayReasoningText は最新の見出しを表示する', async () => {
  const { extractDisplayReasoningText } = await import('../web/src/reasoning.mjs');
  assert.equal(
    extractDisplayReasoningText('**見出し1** 検討中です\n**見出し2** 確定表示候補です'),
    '見出し2\n確定表示候補です'
  );
});

test('extractDisplayReasoningText は見出しがなければ本文をそのまま返す', async () => {
  const { extractDisplayReasoningText } = await import('../web/src/reasoning.mjs');
  assert.equal(extractDisplayReasoningText('単なる進捗テキストです'), '単なる進捗テキストです');
});

test('extractDisplayReasoningText は本文が未着でも最新見出しだけを返す', async () => {
  const { extractDisplayReasoningText } = await import('../web/src/reasoning.mjs');
  assert.equal(extractDisplayReasoningText('**見出しだけ**'), '見出しだけ');
});
