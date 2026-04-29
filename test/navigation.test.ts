import assert from 'node:assert/strict';
import test from 'node:test';

const {
  buildFileViewPath,
  extractSearch,
  normalizePath,
  parseLineAnchor,
  resolveRepoRelativeFilePath
} = require('../web/src/navigation') as typeof import('../web/src/navigation');

test('normalizePath はアプリ内 route を正規化する', () => {
  assert.equal(normalizePath('/files?x=1'), '/files/');
  assert.equal(normalizePath('/files/view/#hash'), '/files/view/');
  assert.equal(normalizePath('/chat'), '/chat/');
  assert.equal(normalizePath('/unknown'), '/repos/');
});

test('buildFileViewPath は file view query を組み立てる', () => {
  assert.equal(buildFileViewPath('src/app.ts', 12), '/files/view/?path=src%2Fapp.ts&line=12');
  assert.equal(buildFileViewPath('src/app.ts', null, true), '/files/view/?path=src%2Fapp.ts&jump=first-diff');
});

test('parseLineAnchor は hash と colon の行番号を読む', () => {
  assert.deepEqual(parseLineAnchor('src/app.ts#L42'), { path: 'src/app.ts', line: 42 });
  assert.deepEqual(parseLineAnchor('src/app.ts:12:3'), { path: 'src/app.ts', line: 12 });
});

test('resolveRepoRelativeFilePath は repo 配下のリンクだけ相対パス化する', () => {
  assert.deepEqual(resolveRepoRelativeFilePath('/repo/src/app.ts#L3', '/repo'), { path: 'src/app.ts', line: 3 });
  assert.deepEqual(resolveRepoRelativeFilePath('src/app.ts:9', '/repo'), { path: 'src/app.ts', line: 9 });
  assert.equal(resolveRepoRelativeFilePath('/other/src/app.ts', '/repo'), null);
  assert.equal(resolveRepoRelativeFilePath('https://example.com/src/app.ts', '/repo'), null);
});

test('extractSearch は query 以降を取り出す', () => {
  assert.equal(extractSearch('/files/view/?path=a'), '?path=a');
  assert.equal(extractSearch('/files/view/'), '');
});
