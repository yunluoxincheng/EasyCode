import test from 'node:test';
import assert from 'node:assert/strict';
import { runCommandTool } from '../tools/shell.js';
import { getToolExecutionOutcome } from '../tools/index.js';
import type { Host, ProcessResult, ProcessRunOptions } from '../host.js';

function createMockHost(result: ProcessResult, onRun?: (cmd: string, opts: ProcessRunOptions) => void): Host {
  return {
    fs: {
      readFile: async () => '',
      writeFile: async () => {},
      appendFile: async () => {},
      mkdir: async () => {},
      readdir: async () => [],
      stat: async () => null,
    },
    process: {
      run: async (command: string, options: ProcessRunOptions) => {
        onRun?.(command, options);
        return result;
      },
    },
    paths: {
      join: (...p: string[]) => p.join('/'),
      resolve: (...p: string[]) => p.join('/'),
      dirname: (p: string) => p.split('/').slice(0, -1).join('/'),
      basename: (p: string) => p.split('/').pop() ?? '',
      isAbsolute: (p: string) => p.startsWith('/'),
      sep: '/',
    },
    env: {
      dataDir: () => '/data',
    },
  };
}

test('runCommandTool透传shell、cwd与timeoutMs', async () => {
  let capturedCmd = '';
  let capturedOpts: ProcessRunOptions | undefined;

  const host = createMockHost(
    { code: 0, stdout: 'total 42\n', stderr: '' },
    (cmd, opts) => {
      capturedCmd = cmd;
      capturedOpts = opts;
    },
  );

  const out = await runCommandTool.execute(
    { command: 'ls -la', timeout_ms: 5000 },
    {
      host,
      workspace: '/test/workspace',
      signal: new AbortController().signal,
      shell: 'git-bash',
    },
  );

  assert.equal(capturedCmd, 'ls -la');
  assert.equal(capturedOpts?.cwd, '/test/workspace');
  assert.equal(capturedOpts?.timeoutMs, 5000);
  assert.equal(capturedOpts?.shell, 'git-bash');
  assert.match(out, /退出码: 0/);
  assert.match(out, /total 42/);
});

test('旁路结果以命令退出码为准，拒绝执行不记为成功', () => {
  const base = { approved: true, isError: false, durationMs: 1 };
  assert.equal(getToolExecutionOutcome('run_command', { ...base, content: '退出码: 0\nstdout:\nok' }).status, 'success');
  assert.equal(getToolExecutionOutcome('run_command', { ...base, content: '退出码: 1\nstderr:\nfailed' }).status, 'failure');
  assert.equal(getToolExecutionOutcome('run_command', { ...base, content: '退出码: signal' }).status, 'failure');
  assert.equal(getToolExecutionOutcome('run_command', { ...base, content: 'no exit code' }).status, 'unknown');
  assert.equal(getToolExecutionOutcome('run_command', { ...base, approved: false, content: '退出码: 0' }).status, 'unknown');
});

test('runCommandTool在未显式传shell时透传undefined或auto', async () => {
  let capturedOpts: ProcessRunOptions | undefined;

  const host = createMockHost(
    { code: 1, stdout: '', stderr: 'command failed' },
    (_cmd, opts) => {
      capturedOpts = opts;
    },
  );

  const out = await runCommandTool.execute(
    { command: 'cat non-exist' },
    {
      host,
      workspace: '/test/workspace',
      signal: new AbortController().signal,
    },
  );

  assert.equal(capturedOpts?.shell, undefined);
  assert.match(out, /退出码: 1/);
  assert.match(out, /stderr:\ncommand failed/);
});
