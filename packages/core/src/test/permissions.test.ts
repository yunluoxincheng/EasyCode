import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describePermissionRule,
  evaluatePermission,
  matchCommandPattern,
  matchPathGlob,
  normalizeShellCommand,
  resolveApprovalRequirement,
  resolveWorkspaceRelative,
  type PathApi,
  type PermissionEvaluation,
  type PermissionRule,
} from '../permissions.js';
import { extractStructuredOperationFact } from '../tools/index.js';

test('normalizeShellCommand 剥离环境变量前缀并解包 shell 包装', () => {
  assert.equal(normalizeShellCommand('  FOO=1 BAR=2 rm -rf x  '), 'rm -rf x');
  assert.equal(normalizeShellCommand('powershell -c "git status"'), 'git status');
  assert.equal(normalizeShellCommand('cmd /c "npm run build"'), 'npm run build');
  assert.equal(normalizeShellCommand('bash -lc "FOO=1 pnpm test"'), 'pnpm test');
  assert.equal(normalizeShellCommand(undefined), '');
});

test('命令归一化与结构化操作事实共用同一实现（不出现两套规则漂移）', () => {
  const fact = extractStructuredOperationFact('run_command', {
    command: 'FOO=1 powershell -c "rm -rf build"',
  });
  assert.equal(fact.operationCategory, 'shell_rm');
  assert.equal(normalizeShellCommand('FOO=1 powershell -c "rm -rf build"'), 'rm -rf build');
});

test('matchCommandPattern 为前缀匹配且带词边界', () => {
  assert.equal(matchCommandPattern('git status', 'git status -s'), true);
  assert.equal(matchCommandPattern('git status', 'git status'), true);
  assert.equal(matchCommandPattern('git status', 'git stash'), false);
  // 词边界：rm 不得命中 rmdir
  assert.equal(matchCommandPattern('rm', 'rm -rf build'), true);
  assert.equal(matchCommandPattern('rm', 'rmdir build'), false);
  // 通配符
  assert.equal(matchCommandPattern('pnpm *', 'pnpm test --watch'), true);
  assert.equal(matchCommandPattern('npm run test*', 'npm run test:unit'), true);
  // 环境变量前缀不能绕过
  assert.equal(matchCommandPattern('rm', 'FOO=1 rm -rf /'), true);
  assert.equal(matchCommandPattern('rm', 'powershell -c "rm -rf /"'), true);
});

test('matchPathGlob 支持单段与跨目录通配', () => {
  assert.equal(matchPathGlob('.env', '.env'), true);
  assert.equal(matchPathGlob('**/.env', '.env'), true);
  assert.equal(matchPathGlob('**/.env', 'src/config/.env'), true);
  assert.equal(matchPathGlob('src/**', 'src/a/b.ts'), true);
  assert.equal(matchPathGlob('src/*.ts', 'src/a.ts'), true);
  assert.equal(matchPathGlob('src/*.ts', 'src/a/b.ts'), false);
  assert.equal(matchPathGlob('*.ts', 'src/a.ts'), false);
});

test('evaluatePermission：deny 优先于 allow，顺序无关', () => {
  const rules: PermissionRule[] = [
    { tool: 'run_command', pattern: 'git *', decision: 'allow' },
    { tool: 'run_command', pattern: 'git push', decision: 'deny' },
  ];
  const first = evaluatePermission(rules, 'run_command', { command: 'git push --force' });
  assert.equal(first?.decision, 'deny');
  assert.equal(first?.rule.pattern, 'git push');

  const reversed = evaluatePermission([...rules].reverse(), 'run_command', {
    command: 'git push --force',
  });
  assert.equal(reversed?.decision, 'deny');
  // 未被 deny 命中的同类命令仍走 allow
  assert.equal(
    evaluatePermission(rules, 'run_command', { command: 'git status' })?.decision,
    'allow',
  );
});

test('evaluatePermission：ask 优先于 allow，且工具级规则可命中任意参数', () => {
  const rules: PermissionRule[] = [
    { tool: 'run_command', decision: 'allow' },
    { tool: 'run_command', pattern: 'rm', decision: 'ask' },
  ];
  assert.equal(
    evaluatePermission(rules, 'run_command', { command: 'rm -rf node_modules' })?.decision,
    'ask',
  );
  assert.equal(evaluatePermission(rules, 'run_command', { command: 'ls' })?.decision, 'allow');
});

test('evaluatePermission：路径工具支持工作区相对路径与绝对路径', () => {
  const rules: PermissionRule[] = [
    { tool: 'read_file', pattern: '**/.env', decision: 'deny' },
    { tool: 'write_file', pattern: 'src/**', decision: 'allow' },
  ];
  assert.equal(evaluatePermission(rules, 'read_file', { path: '.env' }, '/ws')?.decision, 'deny');
  assert.equal(
    evaluatePermission(rules, 'read_file', { path: 'src/.env' }, '/ws')?.decision,
    'deny',
  );
  // 绝对路径折算为工作区相对路径后仍命中
  assert.equal(
    evaluatePermission(rules, 'read_file', { path: '/ws/config/.env' }, '/ws')?.decision,
    'deny',
  );
  assert.equal(
    evaluatePermission(rules, 'write_file', { path: 'src/a.ts' }, '/ws')?.decision,
    'allow',
  );
  assert.equal(evaluatePermission(rules, 'write_file', { path: 'docs/a.md' }, '/ws'), null);
});

test('evaluatePermission：非命令/路径类工具忽略 pattern（不制造假限制）', () => {
  const rules: PermissionRule[] = [
    { tool: 'todo_write', pattern: 'anything', decision: 'deny' },
    { tool: 'todo_write', decision: 'ask' },
  ];
  assert.equal(evaluatePermission(rules, 'todo_write', { todos: [] })?.decision, 'ask');
});

test('evaluatePermission：空规则与不匹配工具返回 null', () => {
  assert.equal(evaluatePermission(undefined, 'run_command', { command: 'ls' }), null);
  assert.equal(evaluatePermission([], 'run_command', { command: 'ls' }), null);
  assert.equal(
    evaluatePermission([{ tool: 'write_file', decision: 'deny' }], 'run_command', {
      command: 'ls',
    }),
    null,
  );
  // 非法条目被跳过
  const invalid = [{ tool: '', decision: 'deny' }, { tool: 'run_command', decision: 'nope' }] as unknown as PermissionRule[];
  assert.equal(evaluatePermission(invalid, 'run_command', { command: 'ls' }), null);
});

test('describePermissionRule 标注来源与模式', () => {
  assert.equal(
    describePermissionRule({ tool: 'run_command', pattern: 'rm', decision: 'deny', source: 'global' }),
    '全局规则: run_command ~ "rm"',
  );
  assert.equal(
    describePermissionRule({
      tool: 'write_file',
      decision: 'ask',
      source: 'project',
      note: '审查后写入',
    }),
    '项目规则: write_file（全部调用） · 审查后写入',
  );
});

/* ------------------------------------------------------------------ */
/* PR #9 审查返工回归（P1 / P2）                                        */
/* ------------------------------------------------------------------ */

test('【P1 命令绕过】带引号的环境变量赋值不得绕过 deny 规则', () => {
  // 值含空格：早期用 `\S*` 会在空格处断开，导致 rm 没被识别成命令
  assert.equal(normalizeShellCommand('FOO="hello world" rm -rf build'), 'rm -rf build');
  assert.equal(normalizeShellCommand("FOO='hello world' rm -rf build"), 'rm -rf build');
  assert.equal(normalizeShellCommand('A=1 B="x y" C=3 rm -rf build'), 'rm -rf build');
  // 双引号内的转义不能提前收尾
  assert.equal(normalizeShellCommand('FOO="a \\" b" rm -rf build'), 'rm -rf build');

  const rules: PermissionRule[] = [
    { tool: 'run_command', pattern: 'rm', decision: 'deny' },
  ];
  assert.equal(
    evaluatePermission(rules, 'run_command', { command: 'FOO="hello world" rm -rf build' })
      ?.decision,
    'deny',
  );
  // 无法可靠解析的写法（引号未闭合）原样返回，不假装已清洗
  assert.equal(normalizeShellCommand('FOO="unterminated rm -rf x'), 'FOO="unterminated rm -rf x');
});

test('【P1 路径绕过】.. 路径段必须归一化后才做 glob 匹配', () => {
  const rules: PermissionRule[] = [
    { tool: 'read_file', pattern: 'src/private/**', decision: 'deny' },
  ];
  assert.equal(
    evaluatePermission(rules, 'read_file', { path: 'src/tmp/../private/key.json' }, '/ws')
      ?.decision,
    'deny',
  );
  assert.equal(
    evaluatePermission(rules, 'read_file', { path: './src/a/../private/key.json' }, '/ws')
      ?.decision,
    'deny',
  );
  // 反斜杠写法同样归一化
  assert.equal(
    evaluatePermission(rules, 'read_file', { path: 'src\\tmp\\..\\private\\key.json' }, '/ws')
      ?.decision,
    'deny',
  );
  // 绝对路径中的 .. 同样解析
  assert.equal(
    evaluatePermission(rules, 'read_file', { path: '/ws/src/x/../private/k.json' }, '/ws')
      ?.decision,
    'deny',
  );
  // 正常路径不受影响
  assert.equal(
    evaluatePermission(rules, 'read_file', { path: 'src/public/a.json' }, '/ws'),
    null,
  );
});

test('【P1 路径绕过】省略 path 时按各工具真实默认作用域求值', () => {
  const rules: PermissionRule[] = [
    { tool: 'list_dir', pattern: '.', decision: 'deny' },
    { tool: 'search_files', pattern: 'src/private/**', decision: 'ask' },
  ];
  // list_dir 省略 path 实际列工作区根 → 命中作用于根的规则
  assert.equal(evaluatePermission(rules, 'list_dir', {}, '/ws')?.decision, 'deny');
  // list_dir 指定子目录时不再命中根规则
  assert.equal(evaluatePermission(rules, 'list_dir', { path: 'docs' }, '/ws'), null);
  // search_files 省略 path 会递归整个工作区 → 指向子目录的规则同样必须命中
  assert.equal(
    evaluatePermission(rules, 'search_files', { pattern: 'secret' }, '/ws')?.decision,
    'ask',
  );
  // 收窄到无关子目录时不命中
  assert.equal(
    evaluatePermission(rules, 'search_files', { pattern: 'secret', path: 'docs' }, '/ws'),
    null,
  );
});

test('【P1 路径绕过】子树推断只收紧不放宽（allow 不得凭前缀放宽）', () => {
  const allowOnly: PermissionRule[] = [
    { tool: 'search_files', pattern: 'src/*.ts', decision: 'allow' },
  ];
  // 递归搜索省略 path 时，allow 不能因为「可能搜到 src」就免审批
  assert.equal(evaluatePermission(allowOnly, 'search_files', { pattern: 'x' }, '/ws'), null);
  // 显式限定到 src 也不放宽：allow 只认精确命中，不做前缀推断
  assert.equal(
    evaluatePermission(allowOnly, 'search_files', { pattern: 'x', path: 'src' }, '/ws'),
    null,
  );
  // allow 只在精确命中作用域本身时生效
  assert.equal(
    evaluatePermission(
      [{ tool: 'search_files', pattern: 'src', decision: 'allow' }],
      'search_files',
      { pattern: 'x', path: 'src' },
      '/ws',
    )?.decision,
    'allow',
  );
});

test('【P2 统一裁决】resolveApprovalRequirement 三态语义', () => {
  const asRule = (decision: 'allow' | 'ask' | 'deny'): PermissionEvaluation => ({
    decision,
    rule: { tool: 'run_command', decision, source: 'global' },
  });
  // allow → 免审批（即使处于 ask 模式，由调用方按 needApproval=false 直接放行）
  assert.deepEqual(resolveApprovalRequirement(asRule('allow'), true), {
    needApproval: false,
    force: false,
  });
  // ask → 强制审批（即使在 yolo 模式）
  const ask = resolveApprovalRequirement(asRule('ask'), true);
  assert.equal(ask.needApproval, true);
  assert.equal(ask.force, true);
  assert.match(ask.reason ?? '', /全局规则: run_command/);
  // 无规则：敏感能力跟随会话模式，只读能力直接放行
  assert.deepEqual(resolveApprovalRequirement(null, true), { needApproval: true, force: false });
  assert.deepEqual(resolveApprovalRequirement(null, false), { needApproval: false, force: false });
  // deny 由调用方先短路
  assert.equal(resolveApprovalRequirement(asRule('deny'), true).needApproval, false);
});

/** Windows 路径语义（用于验证「先离开再进入」在两种平台下都被正确拒绝） */
const winPathApi: PathApi = {
  resolve: (...parts: string[]): string => {
    let out = '';
    for (const part of parts) {
      if (!part) continue;
      const normalized = part.replace(/\//g, '\\');
      if (/^[A-Za-z]:\\/.test(normalized) || normalized.startsWith('\\\\')) {
        out = normalized;
        continue;
      }
      out = out ? `${out.replace(/\\+$/, '')}\\${normalized}` : normalized;
    }
    const drive = /^([A-Za-z]:)/.exec(out)?.[1] ?? '';
    const rest = out.slice(drive.length).replace(/\\/g, '/');
    const segs: string[] = [];
    for (const seg of rest.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') {
        if (segs.length > 0) segs.pop();
        continue;
      }
      segs.push(seg);
    }
    return `${drive}\\${segs.join('\\')}`;
  },
  isAbsolute: (p: string): boolean => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\'),
  sep: '\\',
};

test('resolveWorkspaceRelative 按宿主语义解析（POSIX）', () => {
  assert.equal(resolveWorkspaceRelative('/ws', 'a/./b'), 'a/b');
  assert.equal(resolveWorkspaceRelative('/ws', 'a/b/../c'), 'a/c');
  assert.equal(resolveWorkspaceRelative('/ws', 'a//b///c'), 'a/b/c');
  assert.equal(resolveWorkspaceRelative('/ws', '.\\a\\b'), 'a/b');
  assert.equal(resolveWorkspaceRelative('/ws', '.'), '.');
  assert.equal(resolveWorkspaceRelative('/ws', ''), null);
  // 真正越界 → null
  assert.equal(resolveWorkspaceRelative('/ws', '../../etc/passwd'), null);
  assert.equal(resolveWorkspaceRelative('/ws', '/etc/passwd'), null);
});

test('【P1 复审】「先离开再进入」的路径必须在 POSIX 与 Windows 下都被拦截', () => {
  const posixRules: PermissionRule[] = [
    { tool: 'read_file', pattern: 'private/**', decision: 'deny' },
  ];
  // POSIX：../ws/private/key.json 在 /ws 下解析回 /ws/private/key.json
  assert.equal(
    resolveWorkspaceRelative('/ws', '../ws/private/key.json'),
    'private/key.json',
  );
  assert.equal(
    evaluatePermission(posixRules, 'read_file', { path: '../ws/private/key.json' }, '/ws')
      ?.decision,
    'deny',
  );
  // 多段绕行同样命中
  assert.equal(
    evaluatePermission(
      posixRules,
      'read_file',
      { path: './sub/../../ws/private/key.json' },
      '/ws',
    )?.decision,
    'deny',
  );

  // Windows：同名反例（大小写与分隔符同时变化）
  const winRules: PermissionRule[] = [
    { tool: 'read_file', pattern: 'private/**', decision: 'deny' },
  ];
  assert.equal(
    resolveWorkspaceRelative('C:\\WS', '..\\ws\\private\\key.json', winPathApi),
    'private/key.json',
  );
  assert.equal(
    evaluatePermission(
      winRules,
      'read_file',
      { path: '..\\ws\\private\\key.json' },
      'C:\\WS',
      winPathApi,
    )?.decision,
    'deny',
  );
  // 真正越出工作区（到 C:\Windows）→ 不命中规则，但文件工具会直接报「路径越界」
  assert.equal(
    resolveWorkspaceRelative('C:\\WS', '..\\Windows\\System32\\config', winPathApi),
    null,
  );
});

test('【P1 复审】权限层与 resolveWorkspacePath 使用同一套解析语义', async () => {
  const { MemoryHost } = await import('../host.js');
  const { resolveWorkspacePath } = await import('../tools/index.js');
  const host = new MemoryHost({ '/ws/private/key.json': '{"secret":true}' });
  const rel = '../ws/private/key.json';

  // 文件工具真实解析结果
  const abs = resolveWorkspacePath('/ws', rel, host);
  assert.equal(abs, host.paths.resolve('/ws', rel));

  // 权限层折算出的相对路径必须与「文件工具实际访问位置」一致
  const mapped = resolveWorkspaceRelative('/ws', rel, host.paths);
  assert.ok(mapped);
  assert.equal(host.paths.resolve('/ws', mapped), abs);
});
