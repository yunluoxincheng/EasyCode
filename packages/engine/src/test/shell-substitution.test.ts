/**
 * PR #9 第九轮复审回归：Shell 命令替换绕过 + 桌面端信任查询走物理身份。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  ApprovalManager,
  MemoryHost,
  createBuiltinTools,
  describeCommandParseRisk,
  evaluatePermission,
  executeTool,
  matchCommandPattern,
  normalizeShellCommand,
  resolveApprovalRequirement,
  type PermissionRule,
} from '@easycode/core';
import { NodeHost } from '@easycode/host-node';
import { AgentServer } from '../index.js';

/**
 * 发现本机可用的 POSIX Shell（真实语义验证需要它才能执行）。
 *
 * 不能写死安装路径：Git Bash 在 Windows 上可能装在 `Program Files`、`Program Files (x86)`、
 * `%LOCALAPPDATA%\Programs\Git` 或仅存在于 `PATH`；macOS / Linux 则是 `/bin/bash` 等。
 * 找不到时返回 null，由调用方跳过该用例（纯函数层已覆盖同一语义）。
 * 可用 `EASYCODE_TEST_SHELL` 显式指定。
 */
function findPosixShell(): string | null {
  // 候选必须是 POSIX Shell：`--version` 能正常退出且不报错即可视为可用
  const usable = (candidate: string): boolean => {
    try {
      execFileSync(candidate, ['-c', 'printf OK'], { encoding: 'utf8', timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  };

  const explicit = process.env.EASYCODE_TEST_SHELL?.trim();
  if (explicit) return usable(explicit) ? explicit : null;

  const candidates: string[] = [];
  if (process.platform === 'win32') {
    const roots = [
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : undefined,
    ];
    for (const root of roots) {
      if (!root) continue;
      candidates.push(path.join(root, 'Git', 'bin', 'bash.exe'));
      candidates.push(path.join(root, 'Git', 'usr', 'bin', 'bash.exe'));
    }
    // 仅靠 PATH 解析：交给 execFileSync 尝试，存在即可用
    candidates.push('bash.exe', 'bash');
  } else {
    candidates.push('/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', 'bash', 'sh');
  }

  for (const candidate of candidates) {
    // 绝对路径先做存在性预筛，避免逐个 spawn 拖慢测试
    if (path.isAbsolute(candidate) && !fs.existsSync(candidate)) continue;
    if (usable(candidate)) return candidate;
  }
  return null;
}

/* -------------------- P1：$() / 反引号命令替换 -------------------- */

const SUBSTITUTION_BYPASS = [
  'FOO=$(printf x) rm -rf build',
  'FOO=$(printf "a b") rm -rf build',
  'FOO=$(echo $(date)) rm -rf build',
  'FOO=$(printf x)bar rm -rf build',
  'FOO="$(printf x)" rm -rf build',
  'FOO=`printf x` rm -rf build',
  'FOO=x`printf a b` rm -rf build',
];

test('【P1 九轮】$() 与反引号赋值前缀被完整消费（不再截断成 x) rm …）', () => {
  for (const cmd of SUBSTITUTION_BYPASS) {
    assert.equal(normalizeShellCommand(cmd), 'rm -rf build', `归一化失败: ${cmd}`);
    assert.equal(matchCommandPattern('rm', cmd), true, `绕过 deny: ${cmd}`);
    // 这些写法本身是完全可解析的，不应被当成"不可信命令"反复打扰
    assert.equal(describeCommandParseRisk(cmd), null, `误判为不可解析: ${cmd}`);
  }

  // 合法的命令替换用法不得被误伤
  assert.equal(describeCommandParseRisk('git commit -m "$(date)"'), null);
  assert.equal(normalizeShellCommand('git commit -m "$(date)"'), 'git commit -m "$(date)"');
  // 单引号内的 $( ) 是字面量，不影响前缀剥离
  assert.equal(matchCommandPattern('rm', "FOO='$(printf x)' rm -rf build"), true);
});

test('【P1 九轮】deny rm 对命令替换前缀端到端生效', () => {
  const rules: PermissionRule[] = [{ tool: 'run_command', pattern: 'rm', decision: 'deny' }];
  for (const command of SUBSTITUTION_BYPASS) {
    const decision = evaluatePermission(rules, 'run_command', { command });
    assert.equal(decision?.decision, 'deny', `未拦截: ${command}`);
  }
});

test('【P1 九轮】无法可靠解析的命令不得当作安全未命中（保守审批）', () => {
  const unparseable = [
    'FOO="unclosed rm -rf build',
    'FOO=$(unclosed rm -rf build',
    'FOO=`unclosed rm -rf build',
    'rm -rf build "unclosed',
  ];
  for (const command of unparseable) {
    const risk = describeCommandParseRisk(command);
    assert.ok(risk, `应识别为不可解析: ${command}`);
    // 即使没有任何规则命中，也不能直接放行
    const requirement = resolveApprovalRequirement(
      evaluatePermission(undefined, 'run_command', { command }),
      true,
      { parseRisk: risk },
    );
    assert.equal(requirement.needApproval, true, `应要求审批: ${command}`);
    assert.equal(requirement.force, true, `应强制审批: ${command}`);
  }

  // 显式 deny 仍然优先（不因解析失败而放宽）
  const denyRequirement = resolveApprovalRequirement(
    { decision: 'deny', rule: { tool: 'run_command', decision: 'deny' } },
    true,
    { parseRisk: '双引号未闭合' },
  );
  assert.equal(denyRequirement.needApproval, false, 'deny 由调用方短路，不转成审批');

  // 可解析的命令不受影响：allow 规则照常免审批
  const allowOk = resolveApprovalRequirement(
    { decision: 'allow', rule: { tool: 'run_command', decision: 'allow' } },
    true,
    { parseRisk: null },
  );
  assert.equal(allowOk.needApproval, false);
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

test('【P1 九轮】真实 bash 确认命令替换写法执行的是赋值后的程序', (t) => {
  const shell = findPosixShell();
  if (!shell) {
    // 依赖宿主机安装的 POSIX Shell：缺失时跳过而不是失败，
    // 语义正确性已由上方的纯函数用例保证（Windows/macOS/Linux 均可跑）
    t.skip('未发现可用的 POSIX Shell（可用 EASYCODE_TEST_SHELL 指定）');
    return;
  }
  t.diagnostic(`使用 POSIX Shell: ${shell}`);
  const probe = (command: string): boolean => {
    // 用 printf 替代 rm，保证无破坏性
    const safe = command.replace('rm -rf build', 'printf EXEC');
    try {
      return execFileSync(shell, ['-c', safe], { encoding: 'utf8' }).includes('EXEC');
    } catch {
      return false;
    }
  };
  for (const cmd of ['FOO=$(printf x) rm -rf build', 'FOO=`printf x` rm -rf build']) {
    assert.equal(probe(cmd), true, `真实 shell 应执行赋值后的程序: ${cmd}`);
    assert.equal(matchCommandPattern('rm', cmd), true, `必须被 deny 命中: ${cmd}`);
  }
});

/* -------------------- P2：信任查询走物理身份 -------------------- */

test('【P2 九轮】桌面端信任查询必须使用可刷新物理身份的异步接口', async () => {
  const desktopMain = await fsp.readFile(
    path.resolve(process.cwd(), 'packages/desktop/src/main.ts'),
    'utf8',
  );
  const tauriHost = await fsp.readFile(
    path.resolve(process.cwd(), 'packages/host-tauri/src/index.ts'),
    'utf8',
  );
  const uiClient = await fsp.readFile(
    path.resolve(process.cwd(), 'packages/ui/src/client.ts'),
    'utf8',
  );
  for (const [name, src] of [
    ['desktop/main.ts', desktopMain],
    ['host-tauri/index.ts', tauriHost],
    ['ui/client.ts', uiClient],
  ] as const) {
    // 同步版本只读缓存，符号链接改指后会给过期答案：
    // 任何直接调用 `server.isProjectTrusted(` 的宿主适配层都必须改掉
    assert.ok(
      !/server\.isProjectTrusted\(/.test(src),
      `${name} 不应再直接调用同步的 server.isProjectTrusted`,
    );
  }
  // 两个宿主适配层必须真正走到异步物理身份查询
  for (const [name, src] of [
    ['desktop/main.ts', desktopMain],
    ['host-tauri/index.ts', tauriHost],
  ] as const) {
    assert.ok(
      src.includes('getProjectTrust('),
      `${name} 必须调用 getProjectTrust（可刷新物理身份）`,
    );
  }
  // UI 客户端保持既有 IPC 方法名，但要确认它没有绕过宿主直接查引擎
  assert.ok(uiClient.includes("'is-project-trusted'"), 'ui/client.ts 应通过 IPC 委托宿主');
});

test('【P2 九轮】IPC 语义：链接改指后查询立即反映新项目状态', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'easycode-r9-'));
  try {
    const projA = path.join(base, 'projA');
    const projB = path.join(base, 'projB');
    await fsp.mkdir(projA, { recursive: true });
    await fsp.mkdir(projB, { recursive: true });
    const wsLink = path.join(base, 'ws-link');
    await fsp.symlink(projA, wsLink, 'junction');

    const host = new NodeHost({ dataDir: path.join(base, 'data') });
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
      permissions: { enabled: true, trustedWorkspaces: [], rules: [] },
    });

    await server.setProjectTrust(wsLink, true);
    // 模拟「设置页查询」这一用户可见入口
    const before = await server.getProjectTrust(wsLink);
    assert.equal(before, true);

    await fsp.unlink(wsLink);
    await fsp.symlink(projB, wsLink, 'junction');
    // 关键：不触发其它刷新动作，直接查询也必须反映新项目
    const after = await server.getProjectTrust(wsLink);
    assert.equal(after, false, '改指后用户可见状态必须立即变为未信任');
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});
