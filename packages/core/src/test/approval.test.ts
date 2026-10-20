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

test('ApprovalManager：同步拒绝同样生效且不残留未决请求', async () => {
  let manager: ApprovalManager;
  manager = new ApprovalManager((event) => {
    if (event.type === 'approval_request') manager.resolve(event.requestId, false);
  }, 'ask');
  const approved = await withTimeout(manager.request('write_file', { path: 'a.ts' }), 1000);
  assert.equal(approved, false);
  assert.equal(manager.pendingCount, 0);
});

test('ApprovalManager：yolo 模式仅在 force 时强制审批', async () => {
  const events: AgentEvent[] = [];
  const manager = new ApprovalManager((event) => events.push(event), 'yolo');
  assert.equal(await manager.request('run_command', { command: 'ls' }), true);
  assert.equal(events.length, 0, 'yolo 免审批时不应派发事件');

  const forced = manager.request('run_command', { command: 'rm -rf build' }, {
    force: true,
    reason: '权限规则: run_command ~ "rm"',
  });
  const request = events.at(-1);
  assert.ok(request && request.type === 'approval_request');
  assert.equal(request.reason, '权限规则: run_command ~ "rm"');
  manager.resolve(request.requestId, false);
  assert.equal(await withTimeout(forced, 1000), false);
  assert.equal(manager.pendingCount, 0);
});

test('ApprovalManager：订阅者抛错时按拒绝收尾而非悬挂', async () => {
  const manager = new ApprovalManager(() => {
    throw new Error('emitter broken');
  }, 'ask');
  // 派发故障不能把回合卡死在审批上；保守按拒绝返回，且不残留未决请求
  const approved = await withTimeout(manager.request('run_command', { command: 'ls' }), 1000);
  assert.equal(approved, false);
  assert.equal(manager.pendingCount, 0);
});

test('ApprovalManager：denyAll 拒绝全部未决请求（中止路径）', async () => {
  const events: AgentEvent[] = [];
  const manager = new ApprovalManager((event) => events.push(event), 'ask');
  const first = manager.request('run_command', { command: 'pnpm test' });
  const second = manager.request('write_file', { path: 'a.ts' });
  assert.equal(manager.pendingCount, 2);
  manager.denyAll();
  assert.equal(await withTimeout(first, 1000), false);
  assert.equal(await withTimeout(second, 1000), false);
  assert.equal(manager.pendingCount, 0);
  assert.equal(events.filter((e) => e.type === 'approval_resolved').length, 2);
  // 迟到的应答必须被忽略，不能抛出
  manager.resolve('ap_missing', true);
});

test('executeTool：所有前置拒绝均提供未执行计时', async (t) => {
  const cases = [
    { label: '未知工具', name: 'missing_tool', input: {}, workspace: '/ws', message: /未知工具/ },
    { label: '未绑定工作区', name: 'read_file', input: { path: 'file.txt' }, workspace: '', message: /未绑定工作区/ },
    { label: '参数校验失败', name: 'read_file', input: {}, workspace: '/ws', message: /参数校验失败/ },
    { label: '真实路径守卫拒绝', name: 'read_file', input: { path: '../outside.txt' }, workspace: '/ws', message: /工作区|越界/ },
    { label: '权限 deny', name: 'read_file', input: { path: 'file.txt' }, workspace: '/ws',
      rules: [{ tool: 'read_file', decision: 'deny' as const }], message: /权限规则拒绝/ },
  ];
  for (const scenario of cases) {
    await t.test(scenario.label, async () => {
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
      assert.match(result.content, scenario.message);
      assert.equal(started, 0);
      assert.deepEqual(result.timing, { approvalMs: 0 });
      assert.equal(result.timing.executionMs, undefined);
      assert.equal(Object.hasOwn(result.timing, 'executionMs'), false);
    });
  }
});

for (const fails of [false, true]) {
  test(`executeTool：实际执行${fails ? '失败' : '成功'}的 0ms 不等于未执行`, async (t) => {
    t.mock.method(performance, 'now', () => 100);
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
  });
}

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
