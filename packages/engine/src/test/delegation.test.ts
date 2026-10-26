import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { NodeHost } from '@easycode/host-node';
import type { DelegatedTaskRecord, Provider, TurnResult } from '@easycode/core';
import { DelegatedTaskManager, restoreDelegatedTasks } from '../delegation.js';

test('子任务：真实超限 Git 失败闭合，运行过程检查点、取消和写入失败可恢复', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easycode-delegation-review-'));
  const host = new NodeHost({ dataDir: path.join(directory, 'profile') });
  const manager = new DelegatedTaskManager(host);
  const envKeys = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM'] as const;
  const previous = envKeys.map((key) => process.env[key]);
  process.env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  process.env.GIT_CONFIG_SYSTEM = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  const git = (args: string[]) => new Promise<void>((resolve, reject) => execFile('git', args, { cwd: directory, windowsHide: true, timeout: 10000 }, (error) => error ? reject(error) : resolve()));
  const pending: Promise<unknown>[] = [];
  try {
    await git(['init', '--quiet']);
    await fs.writeFile(path.join(directory, 'large.txt'), 'old\n'.repeat(100000));
    await fs.writeFile(path.join(directory, 'medium.txt'), 'old value\n'.repeat(1000));
    await git(['add', '--', 'large.txt', 'medium.txt']);
    await fs.writeFile(path.join(directory, 'large.txt'), 'new\n'.repeat(100000));
    const output = await host.process.run('node -e "process.stdout.write(\'x\'.repeat(600000));process.stderr.write(\'y\'.repeat(600000))"', { cwd: directory, timeoutMs: 15000 });
    assert.equal(output.code, 0, '超限后必须继续排空，让进程正常退出');
    assert.equal(output.truncated, true);
    assert.equal(output.stdout.length, 200000);
    assert.equal(output.stderr.length, 200000);

    const setup = (name: string, failCheckpoint = false) => {
      const records: DelegatedTaskRecord[] = [];
      const published: string[] = [];
      const file = path.join(directory, `${name}.json`);
      let checkpointResolve!: () => void;
      const checkpoint = new Promise<void>((resolve) => { checkpointResolve = resolve; });
      let runningSnapshot: DelegatedTaskRecord[] = [];
      let writes = 0, activeWrites = 0, maxWrites = 0;
      let failures = failCheckpoint ? 1 : 0;
      return {
        records, published, file, checkpoint,
        snapshot: () => runningSnapshot,
        counts: () => ({ writes, maxWrites }),
        context: {
          sessionId: name, userMessageId: `user-${name}`, workspace: directory,
          systemPrompt: 'readonly regression', contextWindow: 64000, reasoningEffort: '', permissionRules: [],
          records: () => records,
          update: (record: DelegatedTaskRecord, publish = true) => {
            const index = records.findIndex((entry) => entry.id === record.id);
            if (index >= 0) records[index] = record;
            if (publish) published.push(record.status);
          },
          usage: () => {},
          persist: async () => {
            activeWrites++; maxWrites = Math.max(maxWrites, activeWrites); writes++;
            try {
              const hasProgress = records[0]?.status === 'running' && records[0].trace.some((entry) => entry.kind === 'text');
              if (hasProgress && failures-- > 0) throw new Error('checkpoint disk unavailable');
              await fs.writeFile(`${file}.tmp`, JSON.stringify(records));
              await host.fs.rename(`${file}.tmp`, file);
              if (hasProgress) { runningSnapshot = structuredClone(records); checkpointResolve(); }
            } finally { activeWrites--; }
          },
        },
      };
    };
    const abortableReply = (signal: AbortSignal): Promise<TurnResult> => new Promise((_resolve, reject) => {
      const abort = () => reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    });
    const first = setup('checkpoint-cancel');
    let calls = 0;
    let rejectedGit = false;
    const provider: Provider = { id: 'checkpoint-regression', async stream(request, context) {
      if (++calls === 1) return { blocks: [{ type: 'tool_call', id: 'oversized-git', name: 'git_diff', input: {} }] };
      const result = [...request.messages].reverse().find((message) => message.role === 'tool_result');
      assert.ok(result?.role === 'tool_result' && result.isError);
      assert.match(result.content, /截断|不完整|不能作为完整证据/);
      assert.ok(result.content.length < 1000, '不能把宿主的局部差异交给模型');
      if (calls === 2) {
        await fs.writeFile(path.join(directory, 'large.txt'), 'old\n'.repeat(100000));
        await fs.writeFile(path.join(directory, 'medium.txt'), 'new value\n'.repeat(1000));
        return { blocks: [{ type: 'tool_call', id: 'task-budget-git', name: 'git_diff', input: {} }] };
      }
      assert.match(result.content, /8192/);
      rejectedGit = true;
      context.emit({ type: 'text_delta', delta: 'checkpoint-visible-progress' });
      return abortableReply(context.signal);
    } };
    const controller = new AbortController();
    const running = manager.run({ ...first.context, createProvider: async () => provider }, { id: 'call-cancel', messageId: 'message-cancel' }, { description: 'review lifecycle' }, controller.signal);
    void running.catch(() => {}); pending.push(running);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([first.checkpoint, running.then(() => assert.fail('子任务应等待取消')), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('checkpoint deadline')), 20000); })]);
    } finally { clearTimeout(timer); }
    assert.equal(rejectedGit, true);
    const midRun = JSON.parse(await fs.readFile(first.file, 'utf8')) as DelegatedTaskRecord[];
    assert.equal(midRun[0].status, 'running');
    assert.ok(midRun[0].trace.some((entry) => entry.content.includes('checkpoint-visible-progress')));
    controller.abort();
    await assert.rejects(running, /abort|中止/i);
    const ended = JSON.parse(await fs.readFile(first.file, 'utf8')) as DelegatedTaskRecord[];
    assert.equal(ended[0].status, 'aborted');
    assert.equal(first.counts().maxWrites, 1, '检查点与终止保存不能并发覆盖');
    assert.ok(first.counts().writes >= 3);
    const recovered = restoreDelegatedTasks(first.snapshot())[0];
    assert.equal(recovered.status, 'aborted');
    assert.ok(recovered.trace.some((entry) => entry.content.includes('checkpoint-visible-progress')));

    const failure = setup('checkpoint-failure', true);
    const failingProvider: Provider = { id: 'checkpoint-write-failure', async stream(_request, context) {
      context.emit({ type: 'text_delta', delta: 'visible-before-checkpoint-failure' });
      return abortableReply(context.signal);
    } };
    const failed = manager.run({ ...failure.context, createProvider: async () => failingProvider }, { id: 'call-failure', messageId: 'message-failure' }, { description: 'checkpoint failure' }, new AbortController().signal);
    pending.push(failed);
    await assert.rejects(failed, /检查点保存失败/);
    assert.equal(failure.records[0].status, 'error');
    assert.equal(failure.records[0].summary, undefined);
    assert.equal(failure.published.includes('completed'), false);
    assert.equal((JSON.parse(await fs.readFile(failure.file, 'utf8')) as DelegatedTaskRecord[])[0].status, 'error');
    assert.equal(failure.counts().maxWrites, 1);
  } finally {
    await manager.dispose();
    await Promise.allSettled(pending);
    envKeys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    // 保留本例唯一创建的 Git/过程目录供诊断；不递归删除生成目录。
  }
});
