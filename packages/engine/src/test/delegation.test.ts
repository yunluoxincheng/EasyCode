import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { NodeHost } from '@easycode/host-node';
import { MemoryHost, type ChatMessage, type DelegatedTaskRecord, type Provider, type TurnResult, type SessionData } from '@easycode/core';
import { DelegatedTaskManager, restoreDelegatedTasks } from '../delegation.js';
import { AgentServer } from '../server.js';

test('子任务：Git/检查点/取消闭合，冷恢复补齐三协议结果且不重放', async (t) => {
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

    // 使用真实运行中检查点记录模拟异常退出，不依赖 OpenAI 适配器的临时占位补全。
    const RecoveryServer = process.env.EASYCODE_RECOVERY_SERVER_URL
      ? (await import(process.env.EASYCODE_RECOVERY_SERVER_URL)).AgentServer as typeof AgentServer : AgentServer;
    for (const kind of ['openai-compatible', 'anthropic', 'responses'] as const) {
      const task = first.snapshot()[0];
      const messages: ChatMessage[] = [
        { role: 'user', id: task.parentUserMessageId, content: '分析项目结构' },
        { role: 'assistant', id: task.parentMessageId, blocks: [
          { type: 'tool_call', id: 'read-before', name: 'read_file', input: { path: 'file.txt' } },
          { type: 'tool_call', id: task.parentCallId, name: 'task', input: { description: task.description } },
          { type: 'tool_call', id: 'list-after', name: 'list_dir', input: {} },
        ] },
        { role: 'tool_result', id: 'existing-read', toolCallId: 'read-before', toolName: 'read_file', approved: true, content: 'existing result' },
      ];
      const checkpoint: SessionData = {
        meta: { id: 's_cold', title: 'checkpoint recovery', workspaceRoot: '/ws', providerId: 'cold', model: 'cold-test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        messages, history: structuredClone(messages), delegatedTasks: first.snapshot(),
      };
      const file = '/easycode-demo/sessions/s_cold.json';
      const recoveryHost = new MemoryHost({ '/ws/file.txt': 'safe', [file]: JSON.stringify(checkpoint) });
      const boot = new RecoveryServer(recoveryHost);
      await boot.updateSettings({ providers: { cold: { kind, baseURL: 'https://example.invalid/v1', models: [{ name: 'cold-test', capabilities: ['system'] }] } }, defaultProvider: 'cold' });
      await boot.listSessions();
      const restored = await boot.getSession('s_cold');
      const results = restored.messages.filter((message) => message.role === 'tool_result');
      assert.equal(results.length, 3, `${kind}: 同批缺失结果也必须闭合`);
      assert.equal(results.find((message) => message.toolCallId === 'read-before')?.content, 'existing result');
      for (const result of results.filter((message) => message.toolCallId !== 'read-before')) {
        assert.equal(result.isError, true);
        assert.match(result.content, /应用异常退出/);
        assert.equal(result.approved, undefined, '恢复结果不推断执行许可');
        const historyResult = restored.history?.find((message) => message.id === result.id);
        assert.deepEqual(historyResult, result, '模型视图和原文历史使用同一恢复身份');
        assert.notEqual(historyResult, result, '两个视图不能共享可变结果对象');
      }
      assert.equal(restored.delegatedTasks?.[0].status, 'aborted');
      const saved = await recoveryHost.fs.readFile(file);
      assert.equal((JSON.parse(saved) as SessionData).messages.filter((message) => message.role === 'tool_result').length, 3);
      const restarted = new RecoveryServer(recoveryHost);
      await restarted.listSessions();
      assert.equal(await recoveryHost.fs.readFile(file), saved, '重复恢复不重复补写');
      let requests = 0, taskEvents = 0;
      restarted.onEvent(({ event }) => { if (event.type === 'delegated_task' || (event.type === 'tool_call_start' && event.call.name === 'task')) taskEvents++; });
      const checkPairing = (sequence: Array<{ type: 'call' | 'result' | 'user'; id?: string }>) => {
        const waiting = new Set<string>();
        for (const item of sequence) {
          if (item.type === 'call') { assert.ok(item.id && !waiting.has(item.id)); waiting.add(item.id); }
          else if (item.type === 'result') { assert.ok(item.id && waiting.delete(item.id), `${kind}: 结果必须匹配当前调用`); }
          else assert.equal(waiting.size, 0, `${kind}: 新用户消息前不得留未闭合调用`);
        }
        assert.equal(waiting.size, 0);
      };
      t.mock.method(globalThis, 'fetch', async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        requests++;
        const body = JSON.parse(String(init?.body));
        type Wire = { role?: string; type?: string; id?: string; call_id?: string; tool_call_id?: string; tool_use_id?: string; content?: Wire[]; tool_calls?: Wire[] };
        const sequence: Array<{ type: 'call' | 'result' | 'user'; id?: string }> = [];
        for (const item of (kind === 'responses' ? body.input : body.messages) as Wire[]) {
          if (kind === 'responses') {
            if (item.type === 'function_call') sequence.push({ type: 'call', id: item.call_id });
            else if (item.type === 'function_call_output') sequence.push({ type: 'result', id: item.call_id });
            else if (item.role === 'user') sequence.push({ type: 'user' });
          } else if (kind === 'anthropic') {
            for (const block of item.content ?? []) {
              if (block.type === 'tool_use') sequence.push({ type: 'call', id: block.id });
              else if (block.type === 'tool_result') sequence.push({ type: 'result', id: block.tool_use_id });
              else if (item.role === 'user') sequence.push({ type: 'user' });
            }
          } else {
            if (item.role === 'assistant') for (const call of item.tool_calls ?? []) sequence.push({ type: 'call', id: call.id });
            else if (item.role === 'tool') sequence.push({ type: 'result', id: item.tool_call_id });
            else if (item.role === 'user') sequence.push({ type: 'user' });
          }
        }
        checkPairing(sequence);
        const stream = kind === 'responses'
          ? 'data: {"type":"response.output_text.delta","delta":"recovered"}\n\ndata: {"type":"response.completed","response":{"output":[]}}\n\n'
          : kind === 'anthropic' ? 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"recovered"}}\n\n'
          : 'data: {"choices":[{"delta":{"content":"recovered"}}]}\n\ndata: [DONE]\n\n';
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      });
      try { await restarted.sendMessage('s_cold', '继续'); }
      finally { t.mock.restoreAll(); }
      const resumed = await restarted.getSession('s_cold');
      assert.equal(requests, 1, '恢复后只请求当前新回合，不请求旧子任务');
      assert.equal(taskEvents, 0);
      assert.equal(resumed.delegatedTasks?.length, 1);
      assert.equal(resumed.delegatedTasks?.[0].status, 'aborted');
      const answer = resumed.messages[resumed.messages.length - 1];
      assert.ok(answer.role === 'assistant' && answer.blocks.some((block) => block.type === 'text' && block.text === 'recovered'));
      await restarted.stopAllBackgroundTasks(); await boot.stopAllBackgroundTasks();
    }
  } finally {
    await manager.dispose();
    await Promise.allSettled(pending);
    envKeys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    // 保留本例唯一创建的 Git/过程目录供诊断；不递归删除生成目录。
  }
});
