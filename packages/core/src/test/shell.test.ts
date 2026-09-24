import test from 'node:test';
import assert from 'node:assert/strict';
import { runCommandTool } from '../tools/shell.js';
import { getToolExecutionOutcome, extractStructuredOperationFact } from '../tools/index.js';
import { extractStructuredErrorFact } from '../loop.js';
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

test('extractStructuredOperationFact: 白名单动词枚举与安全解包，私有前缀一律收敛至 other', () => {
  // 1. 标准已知动词
  assert.equal(extractStructuredOperationFact('run_command', { command: 'git status' }).operationCategory, 'shell_git');
  assert.equal(extractStructuredOperationFact('run_command', { command: 'pnpm test' }).operationCategory, 'shell_pnpm');
  assert.equal(extractStructuredOperationFact('run_command', { command: 'rm -rf dist' }).operationCategory, 'shell_rm');

  // 2. 剥离环境变量前缀
  assert.equal(extractStructuredOperationFact('run_command', { command: 'MY_TOKEN=secret123 git push' }).operationCategory, 'shell_git');

  // 3. 解包 Windows 包装器
  assert.equal(extractStructuredOperationFact('run_command', { command: 'powershell.exe -Command "rm -rf build"' }).operationCategory, 'shell_rm');
  assert.equal(extractStructuredOperationFact('run_command', { command: 'cmd /c "git pull"' }).operationCategory, 'shell_git');

  // 4. 未知私有命令/自定义前缀，绝不透传私有文本，必须收敛为 shell_other
  assert.equal(extractStructuredOperationFact('run_command', { command: './my-internal-secret-tool --arg=1' }).operationCategory, 'shell_other');
  assert.equal(extractStructuredOperationFact('run_command', { command: 'UNKNOWN_SECRET_TOKEN=abc private_command' }).operationCategory, 'shell_other');

  // 5. 文件写操作白名单扩展名
  assert.equal(extractStructuredOperationFact('write_file', { path: 'src/main.ts' }).operationCategory, 'fs_write_file_ts');
  assert.equal(extractStructuredOperationFact('edit_file', { path: 'config.json' }).operationCategory, 'fs_edit_file_json_cfg');
  assert.equal(extractStructuredOperationFact('write_file', { path: 'some.secret_custom_ext' }).operationCategory, 'fs_write_file_other');
});

test('extractStructuredErrorFact: 结构化错误事实分类测试', () => {
  // 1. 命令未找到 (127 或 not found)
  assert.equal(extractStructuredErrorFact('run_command', '退出码: 127\nstderr:\ncommand not found').errorCategory, 'command_not_found');
  assert.equal(extractStructuredErrorFact('run_command', '退出码: 1\nstderr:\n\'foo\' 不是内部或外部命令').errorCategory, 'command_not_found');

  // 2. 命令超时
  assert.equal(extractStructuredErrorFact('run_command', '退出码: signal\nstderr:\nExecution timed out').errorCategory, 'command_timeout');

  // 3. 权限拒绝
  assert.equal(extractStructuredErrorFact('run_command', '退出码: 1\nstderr:\nPermission denied').errorCategory, 'permission_denied');

  // 4. 普通非零退出码
  assert.equal(extractStructuredErrorFact('run_command', '退出码: 2\nstderr:\nTest failed').errorCategory, 'non_zero_exit_2');

  // 5. 文件未找到
  assert.equal(extractStructuredErrorFact('read_file', 'ENOENT: no such file or directory').errorCategory, 'file_or_dir_not_found');

  // 6. 语法错误
  assert.equal(extractStructuredErrorFact('edit_file', 'Syntax error on line 42').errorCategory, 'content_syntax_error');
});
