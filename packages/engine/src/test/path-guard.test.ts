import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { NodeHost } from '@easycode/host-node';
import {
  ApprovalManager,
  createBuiltinTools,
  evaluatePermission,
  executeTool,
  resolveRealPathInWorkspace,
} from '@easycode/core';

/** 真实文件系统夹具：临时工作区 + 真实符号链接 */
async function makeWorkspace(): Promise<{ root: string; host: NodeHost; cleanup: () => Promise<void> }> {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'easycode-symlink-'));
  const root = path.join(base, 'ws');
  await fsp.mkdir(path.join(root, 'private'), { recursive: true });
  await fsp.mkdir(path.join(root, 'public'), { recursive: true });
  await fsp.writeFile(path.join(root, 'private', 'key.txt'), 'TOP-SECRET', 'utf8');
  await fsp.writeFile(path.join(root, 'public', 'ok.txt'), 'PUBLIC', 'utf8');
  const host = new NodeHost({ dataDir: path.join(base, 'data') });
  return {
    root,
    host,
    cleanup: async () => {
      await fsp.rm(base, { recursive: true, force: true });
    },
  };
}

const DENY_PRIVATE = [
  { tool: 'read_file' as const, pattern: 'private/**', decision: 'deny' as const, source: 'project' as const },
];

test('【P1 复审】符号链接别名不得绕过针对真实目标的 deny 规则', async () => {
  const { root, host, cleanup } = await makeWorkspace();
  try {
    // public/key.txt -> ../private/key.txt（真实 symlink）
    await fsp.symlink(path.join(root, 'private', 'key.txt'), path.join(root, 'public', 'key.txt'));

    // 词法层面 public/key.txt 不命中 private/**，但真实目标是 private/key.txt
    const guard = await resolveRealPathInWorkspace(host, root, 'public/key.txt', host.paths);
    assert.equal(guard.ok, true);
    assert.ok(guard.ok);
    assert.equal(guard.value.realRelative, 'private/key.txt', '真实目标必须归一为 private/key.txt');

    // 真实工具调用：必须被 deny 拦住，且不得读到密钥内容
    const result = await executeTool(
      createBuiltinTools(),
      'read_file',
      { path: 'public/key.txt' },
      {
        host,
        workspace: root,
        signal: new AbortController().signal,
        approval: new ApprovalManager(() => {}, 'yolo'),
        permissionRules: DENY_PRIVATE,
      },
    );
    assert.equal(result.approved, false);
    assert.match(result.content, /权限规则拒绝执行/);
    assert.ok(!result.content.includes('TOP-SECRET'), '不得泄露目标内容');
  } finally {
    await cleanup();
  }
});

test('【P1 复审】指向工作区外部的符号链接必须被拒绝（访问边界）', async () => {
  const { root, host, cleanup } = await makeWorkspace();
  try {
    const outside = path.join(path.dirname(root), 'outside-secret.txt');
    await fsp.writeFile(outside, 'OUTSIDE-SECRET', 'utf8');
    await fsp.symlink(outside, path.join(root, 'public', 'escape.txt'));

    const guard = await resolveRealPathInWorkspace(host, root, 'public/escape.txt', host.paths);
    assert.equal(guard.ok, false);
    assert.ok(!guard.ok);
    assert.equal(guard.reason, 'escape');

    const result = await executeTool(
      createBuiltinTools(),
      'read_file',
      { path: 'public/escape.txt' },
      {
        host,
        workspace: root,
        signal: new AbortController().signal,
        approval: new ApprovalManager(() => {}, 'yolo'),
        permissionRules: [], // 无规则也必须拦截（这是访问边界，不只是规则）
      },
    );
    assert.equal(result.approved, false);
    assert.match(result.content, /路径越界/);
    assert.ok(!result.content.includes('OUTSIDE-SECRET'));
  } finally {
    await cleanup();
  }
});

test('【P1 复审】新建文件时校验最近存在的父目录（父目录为 symlink 也要拦截）', async () => {
  const { root, host, cleanup } = await makeWorkspace();
  try {
    const outsideDir = path.join(path.dirname(root), 'outside-dir');
    await fsp.mkdir(outsideDir, { recursive: true });
    // 工作区内 linkdir -> 工作区外目录；写入 linkdir/new.txt 实际落在工作区外
    await fsp.symlink(outsideDir, path.join(root, 'linkdir'), 'junction');

    const guard = await resolveRealPathInWorkspace(host, root, 'linkdir/new.txt', host.paths);
    assert.equal(guard.ok, false);
    assert.ok(!guard.ok);
    assert.equal(guard.reason, 'escape');

    // 工作区内正常新建仍可用
    const okGuard = await resolveRealPathInWorkspace(host, root, 'public/brand-new.txt', host.paths);
    assert.equal(okGuard.ok, true);
    assert.ok(okGuard.ok);
    assert.equal(okGuard.value.existedAtResolution, false);
    assert.equal(okGuard.value.realRelative, 'public/brand-new.txt');
  } finally {
    await cleanup();
  }
});

test('【P1 复审】宿主不支持 realpath 时保守拒绝，不假装安全', async () => {
  const { root, host, cleanup } = await makeWorkspace();
  try {
    const noRealpath = {
      ...host,
      fs: { ...host.fs, realpath: undefined },
    } as unknown as typeof host;
    const guard = await resolveRealPathInWorkspace(noRealpath, root, 'public/ok.txt', host.paths);
    assert.equal(guard.ok, false);
    assert.ok(!guard.ok);
    assert.equal(guard.reason, 'unsupported');
  } finally {
    await cleanup();
  }
});

test('【P1 复审】普通路径与既有规则裁决保持原语义（不吃掉正常放行）', async () => {
  const { root, host, cleanup } = await makeWorkspace();
  try {
    const result = await executeTool(
      createBuiltinTools(),
      'read_file',
      { path: 'public/ok.txt' },
      {
        host,
        workspace: root,
        signal: new AbortController().signal,
        approval: new ApprovalManager(() => {}, 'yolo'),
        permissionRules: DENY_PRIVATE,
      },
    );
    assert.equal(result.approved, true);
    assert.match(result.content, /PUBLIC/);
    // 真实路径下 private 仍被拒
    assert.equal(
      evaluatePermission(DENY_PRIVATE, 'read_file', { path: 'private/key.txt' }, root, host.paths)
        ?.decision,
      'deny',
    );
  } finally {
    await cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* 第四轮复审：真实文件系统安全边界                                     */
/* ------------------------------------------------------------------ */

test('【P1 四轮】悬空符号链接不得让 write_file 在工作区外创建文件', async () => {
  const { root, host, cleanup } = await makeWorkspace();
  try {
    const outsideTarget = path.join(path.dirname(root), 'outside-created.txt');
    // workspace/dangling.txt -> ../outside-created.txt（目标一开始不存在）
    await fsp.symlink(outsideTarget, path.join(root, 'dangling.txt'));
    assert.equal(await fsp.realpath(path.join(root, 'dangling.txt')).catch(() => null), null);

    // 守卫必须识别为悬空链接，而不是「可新建的普通文件」
    const guard = await resolveRealPathInWorkspace(host, root, 'dangling.txt', host.paths);
    assert.equal(guard.ok, false);
    if (!guard.ok) assert.equal(guard.reason, 'dangling-symlink');

    // 真实工具调用：拒绝写入，工作区外文件必须始终不存在
    const result = await executeTool(
      createBuiltinTools(),
      'write_file',
      { path: 'dangling.txt', content: 'SENTINEL' },
      {
        host,
        workspace: root,
        signal: new AbortController().signal,
        approval: new ApprovalManager(() => {}, 'yolo'),
        permissionRules: [],
      },
    );
    assert.equal(result.approved, false);
    assert.match(result.content, /悬空符号链接/);
    await assert.rejects(() => fsp.access(outsideTarget), '工作区外文件不得被创建');
  } finally {
    await cleanup();
  }
});

test('【P1 四轮】悬空链接的父目录同样不得穿越（深层路径）', async () => {
  const { root, host, cleanup } = await makeWorkspace();
  try {
    const outsideDir = path.join(path.dirname(root), 'outside-newdir');
    // workspace/linkdir -> 工作区外目录（该目录此刻不存在 → 悬空）
    await fsp.symlink(outsideDir, path.join(root, 'linkdir'), 'junction');
    const guard = await resolveRealPathInWorkspace(host, root, 'linkdir/deep/file.txt', host.paths);
    assert.equal(guard.ok, false);
    if (!guard.ok) assert.equal(guard.reason, 'dangling-symlink');

    const result = await executeTool(
      createBuiltinTools(),
      'write_file',
      { path: 'linkdir/deep/file.txt', content: 'X' },
      {
        host,
        workspace: root,
        signal: new AbortController().signal,
        approval: new ApprovalManager(() => {}, 'yolo'),
        permissionRules: [],
      },
    );
    assert.equal(result.approved, false);
    await assert.rejects(() => fsp.access(path.join(outsideDir, 'deep', 'file.txt')));
  } finally {
    await cleanup();
  }
});

test('【P1 四轮】search_files 递归不得读取工作区外的符号链接文件', async () => {
  const { root, host, cleanup } = await makeWorkspace();
  try {
    const outsideSecret = path.join(path.dirname(root), 'outside-secret.txt');
    await fsp.writeFile(outsideSecret, 'OUTSIDE-SECRET-MARKER', 'utf8');
    // 工作区内放一个指向外部文件的链接 + 一个正常文件
    await fsp.symlink(outsideSecret, path.join(root, 'leak.txt'));
    await fsp.writeFile(path.join(root, 'local.txt'), 'LOCAL-OK', 'utf8');

    const result = await executeTool(
      createBuiltinTools(),
      'search_files',
      { pattern: 'SECRET|LOCAL', path: '.' },
      {
        host,
        workspace: root,
        signal: new AbortController().signal,
        approval: new ApprovalManager(() => {}, 'yolo'),
        permissionRules: [],
      },
    );

    assert.ok(!result.content.includes('OUTSIDE-SECRET-MARKER'), '不得读到工作区外内容');
    assert.match(result.content, /LOCAL-OK/, '工作区内文件仍应正常命中');
    assert.match(result.content, /已跳过 1 个真实目标在工作区外的符号链接文件/, '必须报告跳过数量');
  } finally {
    await cleanup();
  }
});

test('【P1 四轮】search_files 逐文件拦截也覆盖子目录内的外部链接', async () => {
  const { root, host, cleanup } = await makeWorkspace();
  try {
    const outsideSecret = path.join(path.dirname(root), 'nested-secret.txt');
    await fsp.writeFile(outsideSecret, 'NESTED-SECRET-MARKER', 'utf8');
    await fsp.mkdir(path.join(root, 'sub', 'deeper'), { recursive: true });
    await fsp.symlink(outsideSecret, path.join(root, 'sub', 'deeper', 'leak.txt'));
    await fsp.writeFile(path.join(root, 'sub', 'deeper', 'ok.txt'), 'NORMAL-CONTENT', 'utf8');

    const result = await executeTool(
      createBuiltinTools(),
      'search_files',
      { pattern: 'SECRET|NORMAL', path: '.' },
      {
        host,
        workspace: root,
        signal: new AbortController().signal,
        approval: new ApprovalManager(() => {}, 'yolo'),
        permissionRules: [],
      },
    );
    assert.ok(!result.content.includes('NESTED-SECRET-MARKER'));
    assert.match(result.content, /NORMAL-CONTENT/);
  } finally {
    await cleanup();
  }
});

test('【P1 四轮】正常新建文件与普通读取不受影响', async () => {
  const { root, host, cleanup } = await makeWorkspace();
  try {
    const created = await executeTool(
      createBuiltinTools(),
      'write_file',
      { path: 'public/new.txt', content: 'NEW-FILE' },
      {
        host,
        workspace: root,
        signal: new AbortController().signal,
        approval: new ApprovalManager(() => {}, 'yolo'),
        permissionRules: [],
      },
    );
    assert.equal(created.approved, true);
    assert.equal(await fsp.readFile(path.join(root, 'public', 'new.txt'), 'utf8'), 'NEW-FILE');

    const read = await executeTool(
      createBuiltinTools(),
      'read_file',
      { path: 'public/new.txt' },
      {
        host,
        workspace: root,
        signal: new AbortController().signal,
        approval: new ApprovalManager(() => {}, 'yolo'),
        permissionRules: [],
      },
    );
    assert.equal(read.approved, true);
    assert.match(read.content, /NEW-FILE/);
  } finally {
    await cleanup();
  }
});
