import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MemoryHost,
  getGitStatus, getGitDiff, gitDiffTool, type ProcessResult, type Host
} from '../index.js';

test('Git 查询：状态解析与差异失败/截断不能作为完整证据', async () => {
  const host = new MemoryHost();
  host.process.run = async (cmd: string) => {
    if (cmd.includes('git status --porcelain=v1 -b --ahead-behind')) {
      return {
        code: 0,
        stdout: [
          '## feature/git-inspector...origin/feature/git-inspector [ahead 2, behind 1]',
          'M  src/App.tsx',
          ' M src/index.ts',
          '?? newfile.txt',
        ].join('\n'),
        stderr: '',
      };
    }
    if (cmd.includes('git diff --cached --numstat')) {
      return {
        code: 0,
        stdout: '10\t2\tsrc/App.tsx\n',
        stderr: '',
      };
    }
    if (cmd.includes('git diff --numstat')) {
      return {
        code: 0,
        stdout: '5\t0\tsrc/index.ts\n',
        stderr: '',
      };
    }
    return { code: 0, stdout: '', stderr: '' };
  };

  const status = await getGitStatus(host, '/mock-ws');
  assert.equal(status.isGit, true);
  assert.equal(status.branch, 'feature/git-inspector');
  assert.equal(status.clean, false);
  assert.equal(status.ahead, 2);
  assert.equal(status.behind, 1);
  assert.equal(status.stagedCount, 1);
  assert.equal(status.unstagedCount, 1);
  assert.equal(status.untrackedCount, 1);
  assert.equal(status.totalChanges, 3);
  assert.equal(status.insertions, 15);
  assert.equal(status.deletions, 2);

  const stagedApp = status.files.find((f) => f.path === 'src/App.tsx');
  assert.ok(stagedApp);
  assert.equal(stagedApp.staged, true);
  assert.equal(stagedApp.status, 'M');
  assert.equal(stagedApp.insertions, 10);
  assert.equal(stagedApp.deletions, 2);

  const untracked = status.files.find((f) => f.path === 'newfile.txt');
  assert.ok(untracked);
  assert.equal(untracked.staged, false);
  assert.equal(untracked.status, '?');

  const results: ProcessResult[] = [
    { code: 1, stdout: 'partial diff', stderr: 'broken pipe' },
    { code: 0, stdout: 'partial diff', stderr: '', truncated: true },
    { code: 0, stdout: 'partial diff', stderr: '', timedOut: true },
    { code: 0, stdout: 'partial diff', stderr: '', outputError: true },
  ];
  const queryHost: Host = host;
  for (const result of results) {
    queryHost.process.run = async () => result;
    const diff = await getGitDiff(host, '/mock-ws');
    assert.ok(diff.error, '失败/不完整的结果必须显式标记');
    assert.notEqual(diff.diff, result.stdout, '不得返回未标记的局部差异');
    await assert.rejects(gitDiffTool.execute({}, { host, workspace: '/mock-ws', signal: new AbortController().signal }), /失败|截断|超时|不完整/);
  }
  host.process.run = async () => ({ code: 0, stdout: 'complete diff', stderr: '' });
  assert.equal((await getGitDiff(host, '/mock-ws')).diff, 'complete diff');
});
