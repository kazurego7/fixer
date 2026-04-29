import assert from 'node:assert/strict';
import test from 'node:test';

const {
  buildFileRenderLines,
  findVirtualLineIndex,
  parseUnifiedHunks,
  splitFileContentLines
} = require('../web/src/fileViewModel') as typeof import('../web/src/fileViewModel');

test('splitFileContentLines は末尾の空行だけ表示対象から外す', () => {
  assert.deepEqual(splitFileContentLines('a\nb\n'), ['a', 'b']);
  assert.deepEqual(splitFileContentLines('a\n\nb'), ['a', '', 'b']);
});

test('parseUnifiedHunks は unified diff の hunk 本文を抽出する', () => {
  assert.deepEqual(
    parseUnifiedHunks(['diff --git a/a.txt b/a.txt', '@@ -1,2 +1,2 @@', ' old', '-gone', '+new'].join('\n')),
    [{ oldStart: 1, newStart: 1, lines: [' old', '-gone', '+new'] }]
  );
});

test('buildFileRenderLines は差分行と通常行を表示モデルへ変換する', () => {
  const lines = buildFileRenderLines('keep\nnew\nlast\n', '@@ -1,3 +1,3 @@\n keep\n-gone\n+new\n last');

  assert.deepEqual(
    lines.map((line) => ({ kind: line.kind, oldLine: line.oldLine, newLine: line.newLine, text: line.text })),
    [
      { kind: 'context', oldLine: 1, newLine: 1, text: 'keep' },
      { kind: 'removed', oldLine: 2, newLine: null, text: 'gone' },
      { kind: 'added', oldLine: null, newLine: 2, text: 'new' },
      { kind: 'context', oldLine: 3, newLine: 3, text: 'last' }
    ]
  );
});

test('findVirtualLineIndex は scroll offset に対応する行 index を返す', () => {
  assert.equal(findVirtualLineIndex([0, 10, 20, 30], 0), 0);
  assert.equal(findVirtualLineIndex([0, 10, 20, 30], 19), 1);
  assert.equal(findVirtualLineIndex([0, 10, 20, 30], 30), 2);
});
