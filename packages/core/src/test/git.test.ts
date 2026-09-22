import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MemoryHost,
  getGitStatus,
  getGitDiff,
  stageGitFiles,
  discardGitChanges,
  gitStatusTool,
  gitDiffTool,
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

test('getGitStatus: 干净工作区与非 Git 目录识别', async () => {
  const host = new MemoryHost();
  // 1. 非 Git 仓库
  host.process.run = async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository' });
  const notGit = await getGitStatus(host, '/not-git');
  assert.equal(notGit.isGit, false);
  assert.equal(notGit.clean, true);

  // 2. 干净工作区
  host.process.run = async (cmd: string) => {
    if (cmd.includes('git status')) {
      return { code: 0, stdout: '## master...origin/master\n', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const cleanGit = await getGitStatus(host, '/clean-ws');
  assert.equal(cleanGit.isGit, true);
  assert.equal(cleanGit.clean, true);
  assert.equal(cleanGit.totalChanges, 0);
  assert.equal(cleanGit.branch, 'master');
});

test('gitStatusTool & gitDiffTool: Agent 工具执行正常格式化', async () => {
  const host = new MemoryHost();
  host.process.run = async (cmd: string) => {
    if (cmd.includes('git status --porcelain')) {
      return {
        code: 0,
        stdout: '## main\n M src/test.ts\n',
        stderr: '',
      };
    }
    if (cmd.includes('git diff')) {
      return {
        code: 0,
        stdout: 'diff --git a/src/test.ts b/src/test.ts\n+const a = 1;\n',
        stderr: '',
      };
    }
    return { code: 0, stdout: '', stderr: '' };
  };

  const ctx = {
    host,
    workspace: '/my-project',
    signal: new AbortController().signal,
  };

  const statusOut = await gitStatusTool.execute({}, ctx);
  assert.ok(statusOut.includes('分支: main'));
  assert.ok(statusOut.includes('变动文件总计: 1 项'));
  assert.ok(statusOut.includes('src/test.ts'));

  const diffOut = await gitDiffTool.execute({ path: 'src/test.ts' }, ctx);
  assert.ok(diffOut.includes('+const a = 1;'));
});

test('stageGitFiles & discardGitChanges: 调用与容错处理', async () => {
  const host = new MemoryHost();
  const executedCmds: string[] = [];
  host.process.run = async (cmd: string) => {
    executedCmds.push(cmd);
    return { code: 0, stdout: '', stderr: '' };
  };

  const stageRes = await stageGitFiles(host, '/ws', ['file1.ts', 'file2.ts']);
  assert.equal(stageRes.ok, true);
  assert.ok(executedCmds.some((c) => c.includes('git add "file1.ts" "file2.ts"')));

  const discardRes = await discardGitChanges(host, '/ws', ['file1.ts']);
  assert.equal(discardRes.ok, true);
  assert.ok(executedCmds.some((c) => c.includes('git checkout -- "file1.ts"')));
});
