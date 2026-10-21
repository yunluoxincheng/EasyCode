/**
 * Shell 命令替换前缀的权限裁决与不可解析命令的保守审批。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ApprovalManager,
  MemoryHost,
  createBuiltinTools, evaluatePermission,
  executeTool, type PermissionRule
} from '@easycode/core';


/* -------------------- P1：$() / 反引号命令替换 -------------------- */

const SUBSTITUTION_BYPASS = [
  'FOO="hello "world rm -rf build',
  'FOO=$(printf x) rm -rf build',
  'FOO=$(printf "a b") rm -rf build',
  'FOO=$(echo $(date)) rm -rf build',
  'FOO=$(printf x)bar rm -rf build',
  'FOO="$(printf x)" rm -rf build',
  'FOO=`printf x` rm -rf build',
  'FOO=x`printf a b` rm -rf build',
];

test('【P1 九轮】deny rm 对命令替换前缀端到端生效', () => {
  const rules: PermissionRule[] = [{ tool: 'run_command', pattern: 'rm', decision: 'deny' }];
  for (const command of SUBSTITUTION_BYPASS) {
    const decision = evaluatePermission(rules, 'run_command', { command });
    assert.equal(decision?.decision, 'deny', `未拦截: ${command}`);
  }
});

test('【P1 九轮】executeTool 对不可解析命令强制审批（即使 yolo）', async () => {
  const host = new MemoryHost({ '/ws/a.txt': 'x' });
  const requests: string[] = [];
  // yolo 模式下普通敏感命令本应免审批；含未闭合引号的命令必须弹窗
  const approval = new ApprovalManager((event) => {
    if (event.type === 'approval_request') {
      requests.push(event.requestId);
      approval.resolve(event.requestId, false);
    }
  }, 'yolo');

  const result = await executeTool(
    createBuiltinTools(),
    'run_command',
    { command: 'echo "unclosed rm -rf build' },
    {
      host,
      workspace: '/ws',
      signal: new AbortController().signal,
      approval,
      permissionRules: [],
    },
  );
  assert.equal(requests.length, 1, '不可解析命令必须走审批');
  assert.equal(result.approved, false, '拒绝后不得执行');
  assert.match(result.content, /取消|拒绝/);

  // 可解析命令在 yolo 下仍然免审批
  const ok = await executeTool(
    createBuiltinTools(),
    'run_command',
    { command: 'echo hello' },
    {
      host,
      workspace: '/ws',
      signal: new AbortController().signal,
      approval,
      permissionRules: [],
    },
  );
  assert.equal(requests.length, 1, '可解析命令不得额外弹窗');
  assert.equal(ok.approved, true);
});
