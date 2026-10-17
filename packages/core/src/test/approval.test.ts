import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AgentEvent, ApprovalManager } from '../index.js';

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
