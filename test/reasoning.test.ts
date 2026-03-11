import assert from 'node:assert/strict';
import test from 'node:test';

const { extractDisplayReasoningText } = require('../web/src/reasoning') as typeof import('../web/src/reasoning');

test('extractDisplayReasoningText は最初の見出しを即時表示する', async () => {
  assert.equal(extractDisplayReasoningText('**見出し1** 検討中です'), '見出し1\n検討中です');
});

test('extractDisplayReasoningText は最新の見出しを表示する', async () => {
  assert.equal(
    extractDisplayReasoningText('**見出し1** 検討中です\n**見出し2** 確定表示候補です'),
    '見出し2\n確定表示候補です'
  );
});

test('extractDisplayReasoningText は見出しがなければ本文をそのまま返す', async () => {
  assert.equal(extractDisplayReasoningText('単なる進捗テキストです'), '単なる進捗テキストです');
});

test('extractDisplayReasoningText は本文が未着でも最新見出しだけを返す', async () => {
  assert.equal(extractDisplayReasoningText('**見出しだけ**'), '見出しだけ');
});
