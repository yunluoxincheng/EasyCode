import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { NodeHost } from '@easycode/host-node';
import { ApprovalManager, createBuiltinTools, executeTool } from '@easycode/core';
import { AgentServer } from '../index.js';

async function makeWorkspace() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'easycode-r6-'));
  const root = path.join(base, 'ws');
  await fsp.mkdir(path.join(root, 'public'), { recursive: true });
  await fsp.writeFile(path.join(root, 'public', 'ok.txt'), 'OK-CONTENT', 'utf8');
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

async function makeServer(host: NodeHost) {
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
    permissions: { enabled: true, trustedWorkspaces: [], rules: [] },
  });
  return server;
}

test('【P1 六轮】自动加载的项目规则不得经符号链接读取工作区外内容', async () => {
  const { base, root, host, cleanup } = await makeWorkspace();
  try {
    const outside = path.join(base, 'outside-notes.txt');
    await fsp.writeFile(outside, 'OUTSIDE-RULES-SECRET', 'utf8');
    // 克隆仓库里 AGENTS.md 指向工作区外的文件：无需用户操作即被读取并拼进系统提示词
    await fsp.symlink(outside, path.join(root, 'AGENTS.md'));

    const server = await makeServer(host);
    const rules = await server.getProjectRules(root);
    assert.equal(rules, null, '指向工作区外的规则文件必须被忽略');

    // 工作区内普通规则文件仍正常加载。
    // 用独立工作区避免命中 getProjectRules 的 3 秒 TTL 缓存（缓存 key 为工作区路径）。
    const okRoot = path.join(base, 'ws-ok');
    await fsp.mkdir(okRoot, { recursive: true });
    await fsp.writeFile(path.join(okRoot, 'AGENTS.md'), '# 项目规范\n使用 pnpm。\n', 'utf8');
    const ok = await server.getProjectRules(okRoot);
    assert.ok(ok, '普通 AGENTS.md 必须正常加载');
    assert.match(ok.content, /使用 pnpm/);
    assert.ok(!ok.content.includes('OUTSIDE-RULES-SECRET'));
  } finally {
    await cleanup();
  }
});

test('【P1 六轮】自定义指令模板同样不得经符号链接读取工作区外内容', async () => {
  const { base, root, host, cleanup } = await makeWorkspace();
  try {
    const outside = path.join(base, 'outside-prompt.md');
    await fsp.writeFile(outside, 'OUTSIDE-PROMPT-SECRET', 'utf8');
    await fsp.mkdir(path.join(root, '.easycode', 'prompts'), { recursive: true });
    await fsp.symlink(outside, path.join(root, '.easycode', 'prompts', 'leak.md'));
    await fsp.writeFile(
      path.join(root, '.easycode', 'prompts', 'ok.md'),
      '# 正常指令\n执行构建。\n',
      'utf8',
    );

    const server = await makeServer(host);
    const prompts = await server.listCustomPrompts(root);
    assert.equal(prompts.length, 1, '越界模板必须被跳过');
    assert.equal(prompts[0].id, 'ok');
    assert.ok(prompts.every((p) => !p.template.includes('OUTSIDE-PROMPT-SECRET')));
  } finally {
    await cleanup();
  }
});

test('【P1 六轮】项目信任撤销后，全量保存其它设置不得恢复授权', async () => {
  const { root, host, cleanup } = await makeWorkspace();
  try {
    await fsp.mkdir(path.join(root, '.easycode'), { recursive: true });
    await fsp.writeFile(
      path.join(root, '.easycode', 'permissions.json'),
      JSON.stringify({ rules: [{ tool: 'run_command', decision: 'allow' }] }),
      'utf8',
    );

    const server = await makeServer(host);
    await server.createSession({ workspaceRoot: root, providerId: 'mock' });

    // 信任 → 撤销
    await server.setProjectTrust(root, true);
    assert.equal(server.isProjectTrusted(root), true);
    await server.setProjectTrust(root, false);
    assert.equal(server.isProjectTrusted(root), false);

    // 模拟 UI 普通「保存设置」：patch 里**不应**携带 trustedWorkspaces
    // （UI 侧 saveSettings 已剥离该字段，此处验证引擎在缺省该字段时保持既有授权状态）
    const current = await server.getSettings();
    const { trustedWorkspaces: _ignored, ...restPermissions } = current.permissions ?? {};
    await server.updateSettings({
      maxSteps: 123,
      permissions: { ...restPermissions, rules: current.permissions?.rules ?? [] },
    });

    assert.equal(
      server.isProjectTrusted(root),
      false,
      '普通保存不得恢复已撤销的项目信任',
    );
    assert.equal((await server.getSettings()).maxSteps, 123, '其它设置正常保存');

    // 再次显式信任仍可用
    await server.setProjectTrust(root, true);
    assert.equal(server.isProjectTrusted(root), true);
    assert.equal(
      (await server.resolvePermissionRules(root))?.some((r) => r.decision === 'allow'),
      true,
    );
  } finally {
    await cleanup();
  }
});

test('【P1 六轮】审批期间工作区根被改指到另一项目时必须拒绝（比较绝对目标）', async () => {
  const { base, cleanup } = await makeWorkspace();
  try {
    // 两个项目各有一份同名文件
    const projA = path.join(base, 'projA');
    const projB = path.join(base, 'projB');
    await fsp.mkdir(projA, { recursive: true });
    await fsp.mkdir(projB, { recursive: true });
    await fsp.writeFile(path.join(projA, 'config.txt'), 'FROM-A', 'utf8');
    await fsp.writeFile(path.join(projB, 'config.txt'), 'FROM-B', 'utf8');

    // ws-link -> projA（工作区根本身是符号链接）
    const wsLink = path.join(base, 'ws-link');
    await fsp.symlink(projA, wsLink, 'junction');

    const host = new NodeHost({ dataDir: path.join(base, 'data') });

    // 审批期间把 ws-link 改指到 projB
    let swapped = false;
    const approval = new ApprovalManager((e) => {
      if (e.type !== 'approval_request' || swapped) return;
      swapped = true;
      void (async () => {
        await fsp.unlink(wsLink);
        await fsp.symlink(projB, wsLink, 'junction');
      })().then(() => approval.resolve(e.requestId, true));
    }, 'ask');

    const result = await executeTool(
      createBuiltinTools(),
      'write_file',
      { path: 'config.txt', content: 'OVERWRITTEN' },
      {
        host,
        workspace: wsLink,
        signal: new AbortController().signal,
        approval,
        permissionRules: [],
      },
    );

    assert.equal(swapped, true, '审批必须被触发');
    assert.equal(result.approved, false, '工作区物理身份漂移后不得执行');
    assert.match(result.content, /路径在审批期间发生变化/);
    // 另一个项目必须原样保留（相对路径相同，只有绝对目标能分辨）
    assert.equal(await fsp.readFile(path.join(projB, 'config.txt'), 'utf8'), 'FROM-B');
  } finally {
    await cleanup();
  }
});
