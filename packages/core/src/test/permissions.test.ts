import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluatePermission,
  matchCommandPattern, resolveWorkspaceRelative,
  type PathApi, type PermissionRule
} from '../permissions.js';

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
  // P1：带空格的引号赋值曾使前缀剥离截断，必须保留 deny 裁决。
  assert.equal(evaluatePermission([{ tool: 'run_command', pattern: 'rm', decision: 'deny' }],
    'run_command', { command: 'A=1 FOO="hello world" rm -rf build' })?.decision, 'deny');
});

test('evaluatePermission：deny/ask 优先于 allow，顺序无关且保留工具级匹配', () => {
  const cases = [
    { decision: 'deny', pattern: 'git push', command: 'git push --force', allowed: 'git status', allowPattern: 'git *' },
    { decision: 'ask', pattern: 'rm', command: 'rm -rf node_modules', allowed: 'ls', allowPattern: undefined },
  ] as const;
  for (const item of cases) {
    const rules: PermissionRule[] = [
      { tool: 'run_command', pattern: item.allowPattern, decision: 'allow' },
      { tool: 'run_command', pattern: item.pattern, decision: item.decision },
    ];
    for (const ordered of [rules, [...rules].reverse()]) {
      const result = evaluatePermission(ordered, 'run_command', { command: item.command });
      assert.equal(result?.decision, item.decision);
      assert.equal(result?.rule.pattern, item.pattern);
      assert.equal(evaluatePermission(ordered, 'run_command', { command: item.allowed })?.decision, 'allow');
    }
  }
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
  dirname: (p: string): string => {
    const idx = p.lastIndexOf('\\');
    if (idx < 0) return '.';
    if (idx === 2 && /^[A-Za-z]:/.test(p)) return `${p.slice(0, 2)}\\`;
    return p.slice(0, idx);
  },
  basename: (p: string): string => {
    const idx = p.lastIndexOf('\\');
    return idx < 0 ? p : p.slice(idx + 1);
  },
  sep: '\\',
};

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
