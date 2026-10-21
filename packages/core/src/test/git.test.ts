import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MemoryHost,
  getGitStatus
} from '../index.js';

test('getGitStatus: 解析分支、增删统计与暂存/工作区/未跟踪文件', async () => {
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
});
