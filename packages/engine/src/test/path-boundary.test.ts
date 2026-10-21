import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { NodeHost } from '@easycode/host-node';
import {
  ApprovalManager,
  createBuiltinTools,
  resolveCodeRangeMentions,
  executeTool,
} from '@easycode/core';
import { AgentServer } from '../index.js';
import type { WorkspaceLockManager } from '../workspace-lock.js';

async function makeWorkspace() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'easycode-r5-'));
  const root = path.join(base, 'ws');
  await fsp.mkdir(path.join(root, 'sub'), { recursive: true });
  await fsp.writeFile(path.join(root, 'safe.txt'), 'SAFE-CONTENT\nline2\n', 'utf8');
  const host = new NodeHost({ dataDir: path.join(base, 'data') });
  return {
    base,
    root,
    host,
    cleanup: async () => {
      await fsp.rm(base, { recursive: true, force: true });
    },
  };
}

const ctx = (
  host: NodeHost,
  root: string,
  rules: Parameters<typeof executeTool>[3]['permissionRules'] = [],
  approval?: ApprovalManager,
) => ({
  host,
  workspace: root,
  signal: new AbortController().signal,
  approval: approval ?? new ApprovalManager(() => {}, 'yolo'),
  permissionRules: rules,
});

test('【P1 五轮】审批期间替换符号链接必须被拒绝（检查与使用一致）', async () => {
  const { base, root, host, cleanup } = await makeWorkspace();
  try {
    const linkPath = path.join(root, 'link.txt');
    await fsp.symlink(path.join(root, 'safe.txt'), linkPath);

    const outside = path.join(base, 'outside.txt');
    await fsp.writeFile(outside, 'ORIGINAL-OUTSIDE', 'utf8');

    // 在审批回调里把链接改指向工作区外文件 —— 模拟外部进程在审批期间替换链接
    let swapped = false;
    const approval = new ApprovalManager((event) => {
      if (event.type !== 'approval_request') return;
      if (swapped) return;
      swapped = true;
      // 同步替换（ApprovalManager 会先登记 resolver 再派发事件，此处可安全同步应答）
      void (async () => {
        await fsp.unlink(linkPath);
        await fsp.symlink(outside, linkPath);
      })().then(() => approval.resolve(event.requestId, true));
    }, 'ask');

    const result = await executeTool(
      createBuiltinTools(),
      'write_file',
      { path: 'link.txt', content: 'OVERWRITTEN' },
      ctx(host, root, [], approval),
    );

    assert.equal(swapped, true, '审批必须被触发');
    assert.equal(result.approved, false, '路径变化后不得执行写入');
    assert.match(result.content, /路径在审批期间发生变化/);
    // 工作区外文件内容必须原样保留
    assert.equal(await fsp.readFile(outside, 'utf8'), 'ORIGINAL-OUTSIDE');
  } finally {
    await cleanup();
  }
});

test('【P1 五轮】文件工具实际写入的是已验证的真实目标', async () => {
  const { root, host, cleanup } = await makeWorkspace();
  try {
    // link.txt -> safe.txt（工作区内别名）
    await fsp.symlink(path.join(root, 'safe.txt'), path.join(root, 'link.txt'));
    const result = await executeTool(
      createBuiltinTools(),
      'write_file',
      { path: 'link.txt', content: 'WROTE-VIA-ALIAS' },
      ctx(host, root),
    );
    assert.equal(result.approved, true, result.content);
    // 真实目标被更新
    assert.equal(await fsp.readFile(path.join(root, 'safe.txt'), 'utf8'), 'WROTE-VIA-ALIAS');
  } finally {
    await cleanup();
  }
});

test('【P1 五轮】@file 行范围引用不得读取工作区外链接（会进入模型上下文）', async () => {
  const { base, root, host, cleanup } = await makeWorkspace();
  try {
    const secret = path.join(base, 'outside-notes.txt');
    await fsp.writeFile(secret, 'OUTSIDE-NOTES-SECRET\n', 'utf8');
    await fsp.symlink(secret, path.join(root, 'linked.txt'));

    const { enrichedText, snippets } = await resolveCodeRangeMentions(
      host,
      root,
      '帮我解释 @linked.txt:1-5',
    );
    assert.equal(snippets.length, 0, '越界文件不得被切片');
    assert.ok(!enrichedText.includes('OUTSIDE-NOTES-SECRET'), '不得把工作区外内容注入上下文');

    // 工作区内正常文件仍可用
    const ok = await resolveCodeRangeMentions(host, root, '看下 @safe.txt:1-2');
    assert.equal(ok.snippets.length, 1);
    assert.match(ok.enrichedText, /SAFE-CONTENT/);
  } finally {
    await cleanup();
  }
});
test('【P1 五轮】文件预览入口不得读取工作区外链接', async () => {
  const { base, root, host, cleanup } = await makeWorkspace();
  try {
    const secret = path.join(base, 'preview-secret.txt');
    await fsp.writeFile(secret, 'PREVIEW-OUTSIDE-SECRET', 'utf8');
    await fsp.symlink(secret, path.join(root, 'preview.md'));

    const server = new AgentServer(host);
    await server.updateSettings({
      providers: {
        mock: {
          kind: 'mock',
          baseURL: '',
          name: 'Mock',
          enabled: true,
          models: [{ name: 'mock-1', enabled: true }],
        },
      },
      defaultProvider: 'mock',
      defaultApprovalMode: 'yolo',
    });
    const session = await server.createSession({ workspaceRoot: root, providerId: 'mock' });

    await assert.rejects(
      () => server.readWorkspaceFile(session.id, 'preview.md'),
      /路径越界/,
      '预览必须拒绝工作区外目标',
    );
    // 工作区内正常文件仍可预览
    const okPreview = await server.readWorkspaceFile(session.id, 'safe.txt');
    assert.match(okPreview.content, /SAFE-CONTENT/);
  } finally {
    await cleanup();
  }
});

test('【P2 五轮】同一物理工作区的别名路径必须共享同一把锁', async () => {
  const { base, root, host, cleanup } = await makeWorkspace();
  try {
    // 为工作区创建一个指向它的别名（junction 在 Windows 上无需管理员权限）
    const alias = path.join(base, 'ws-alias');
    await fsp.symlink(root, alias, 'junction');

    const server = new AgentServer(host);
    await server.updateSettings({
      providers: {
        mock: {
          kind: 'mock',
          baseURL: '',
          name: 'Mock',
          enabled: true,
          models: [{ name: 'mock-1', enabled: true }],
        },
      },
      defaultProvider: 'mock',
      defaultApprovalMode: 'yolo',
    });

    const idReal = await server.resolveWorkspaceIdentity(root);
    const idAlias = await server.resolveWorkspaceIdentity(alias);
    // workspaceLocks 是私有字段：测试通过受支持的公开入口验证等价性
    const locks = (server as unknown as { workspaceLocks: WorkspaceLockManager }).workspaceLocks;
    assert.equal(
      locks.normalize(idAlias),
      locks.normalize(idReal),
      '真实路径与别名必须归一为同一身份',
    );

    const lockReal = locks.getLock(root);
    const lockAlias = locks.getLock(alias);
    assert.equal(lockReal, lockAlias, '两种写法必须拿到同一个 Mutex 实例');
  } finally {
    await cleanup();
  }
});
