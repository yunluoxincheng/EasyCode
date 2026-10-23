import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AgentEvent, ApprovalManager, MemoryHost, ToolRegistry, createBuiltinTools, executeTool } from '../index.js';

/**
 * 审批时序回归（TODOS #39 联调时暴露的真实缺陷）：
 * 事件订阅者若在 approval_request 回调里同步应答（CLI / 演示模式 / 同进程宿主），
 * resolver 必须在派发事件之前登记，否则应答被静默丢弃、审批 promise 永久悬挂。
 */
test('ApprovalManager：订阅者同步应答不会丢失', async () => {
  const events: AgentEvent[] = [];
  let manager: ApprovalManager;
  manager = new ApprovalManager((event) => {
    events.push(event);
    if (event.type === 'approval_request') {
      manager.resolve(event.requestId, true);
    }
  }, 'ask');
  // 若时序错反，这里会永久 pending；用超时把它变成明确失败而不是挂死测试进程
  const approved = await withTimeout(manager.request('run_command', { command: 'pnpm test' }), 1000);
  assert.equal(approved, true);
  assert.equal(manager.pendingCount, 0);
  assert.deepEqual(
    events.map((e) => e.type),
    ['approval_request', 'approval_resolved'],
  );
});

test('executeTool：前置拒绝与实际执行的 0ms 采用不同计时契约', async (t) => {
  const cases = [
    { label: '未知工具', name: 'missing_tool', input: {}, workspace: '/ws', message: /未知工具/ },
    { label: '未绑定工作区', name: 'read_file', input: { path: 'file.txt' }, workspace: '', message: /未绑定工作区/ },
    { label: '参数校验失败', name: 'read_file', input: {}, workspace: '/ws', message: /参数校验失败/ },
    { label: '真实路径守卫拒绝', name: 'read_file', input: { path: '../outside.txt' }, workspace: '/ws', message: /工作区|越界/ },
    { label: '权限 deny', name: 'read_file', input: { path: 'file.txt' }, workspace: '/ws',
      rules: [{ tool: 'read_file', decision: 'deny' as const }], message: /权限规则拒绝/ },
  ];
  for (const scenario of cases) {
    let started = 0;
    const approval = new ApprovalManager(() => assert.fail('前置拒绝不应请求审批'), 'ask');
    const result = await executeTool(createBuiltinTools(), scenario.name, scenario.input, {
      host: new MemoryHost({ '/ws/file.txt': 'content' }),
      workspace: scenario.workspace,
      signal: new AbortController().signal,
      approval,
      permissionRules: scenario.rules,
      onExecutionStart: () => { started++; },
    });
    assert.match(result.content, scenario.message, scenario.label);
    assert.equal(started, 0);
    assert.deepEqual(result.timing, { approvalMs: 0 });
    assert.equal(Object.hasOwn(result.timing, 'executionMs'), false);
  }
  t.mock.method(performance, 'now', () => 100);
  for (const fails of [false, true]) {
    let called = 0;
    let started = 0;
    const tools = new ToolRegistry().register({
      spec: { name: 'timing_probe', description: 'timing contract', parameters: { type: 'object' } },
      requiresWorkspace: false,
      execute: async () => {
        called++;
        if (fails) throw new Error('execution failed');
        return 'completed';
      },
    });
    const result = await executeTool(tools, 'timing_probe', {}, {
      host: new MemoryHost(), workspace: '', signal: new AbortController().signal,
      approval: new ApprovalManager(() => assert.fail('非敏感工具不应审批'), 'ask'),
      onExecutionStart: () => { started++; },
    });
    assert.equal(called, 1);
    assert.equal(started, 1);
    assert.equal(result.approved, true);
    assert.equal(result.isError, fails);
    assert.equal(result.timing.executionMs, 0);
    assert.equal(Object.hasOwn(result.timing, 'executionMs'), true);
  }
});


/** 给可能悬挂的 promise 加确定性超时，避免缺陷把测试进程拖死 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待超过 ${ms}ms 仍无结果`)), ms);
      timer.unref?.();
    }),
  ]);
}
