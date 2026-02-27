const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { repoFolderFromFullName, repoPathFromFullName } = require('../server');

test('repoFolderFromFullName replaces slash', () => {
  assert.equal(repoFolderFromFullName('org/repo'), 'org__repo');
});

test('repoPathFromFullName resolves under workspace root', () => {
  const repoPath = repoPathFromFullName('org/repo');
  assert.equal(path.basename(repoPath), 'org__repo');
  assert.match(repoPath, /workspace/);
});
