import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describePermissionRule,
  evaluatePermission,
  matchCommandPattern,
  matchPathGlob,
  normalizeShellCommand,
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
