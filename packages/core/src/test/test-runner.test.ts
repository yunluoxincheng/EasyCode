import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryHost } from '../host.js';
import {
  detectTestCommand,
  extractFailureExcerpt,
  parseTestOutput,
} from '../test-runner.js';

test('detectTestCommand：package.json + 锁文件推断包管理器', async () => {
  const base = {
    '/ws/package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
  };
  const pnpm = new MemoryHost({ ...base, '/ws/pnpm-lock.yaml': '' });
  assert.deepEqual(await detectTestCommand(pnpm, '/ws'), {
    command: 'pnpm test',
    framework: 'node',
    source: 'package.json scripts.test',
  });

  const npm = new MemoryHost({ ...base, '/ws/package-lock.json': '{}' });
  assert.equal((await detectTestCommand(npm, '/ws'))?.command, 'npm test');

  const yarn = new MemoryHost({ ...base, '/ws/yarn.lock': '' });
  assert.equal((await detectTestCommand(yarn, '/ws'))?.command, 'yarn test');

  const bun = new MemoryHost({ ...base, '/ws/bun.lockb': '' });
  assert.equal((await detectTestCommand(bun, '/ws'))?.command, 'bun run test');
});

test('detectTestCommand：无 scripts.test 时继续向下探测', async () => {
  const noTestScript = new MemoryHost({
    '/ws/package.json': JSON.stringify({ scripts: { build: 'tsc' } }),
    '/ws/Cargo.toml': '[package]\nname = "x"\n',
  });
  assert.equal((await detectTestCommand(noTestScript, '/ws'))?.command, 'cargo test');

  const go = new MemoryHost({ '/ws/go.mod': 'module x\n' });
  const goDetected = await detectTestCommand(go, '/ws');
  assert.equal(goDetected?.command, 'go test ./...');
  assert.equal(goDetected?.framework, 'go');

  const py = new MemoryHost({ '/ws/pyproject.toml': '[project]\nname="x"\n' });
  const pyDetected = await detectTestCommand(py, '/ws');
  assert.equal(pyDetected?.command, 'python -m pytest');
  assert.equal(pyDetected?.source, 'pyproject.toml');
});

test('detectTestCommand：显式命令优先，未识别项目返回 null', async () => {
  const host = new MemoryHost({
    '/ws/package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
  });
  assert.deepEqual(await detectTestCommand(host, '/ws', 'pnpm test:unit'), {
    command: 'pnpm test:unit',
    framework: 'custom',
    source: '自定义命令',
  });
  const empty = new MemoryHost({ '/ws/readme.md': '# x' });
  assert.equal(await detectTestCommand(empty, '/ws'), null);
  assert.equal(await detectTestCommand(host, ''), null);
});

test('parseTestOutput：vitest 汇总与失败用例', () => {
  const output = [
    ' RUN  v1.6.0 E:/proj',
    '',
    ' ❯ src/a.test.ts (2 tests | 1 failed) 12ms',
    '   × adds numbers 5ms',
    '     → expected 3 to be 4',
    ' FAIL  src/a.test.ts > math > adds numbers',
    '',
    ' Test Files  1 failed (1)',
    '      Tests  1 failed | 1 passed (2)',
  ].join('\n');
  const summary = parseTestOutput(output);
  assert.equal(summary.failed, 1);
  assert.equal(summary.passed, 1);
  assert.equal(summary.total, 2);
  assert.ok(summary.failures.some((f) => f.includes('src/a.test.ts')));
});

test('parseTestOutput：jest 汇总行', () => {
  const output = [
    'FAIL src/sum.test.js',
    '  ✕ adds 1 + 2 (5 ms)',
    '',
    'Tests:       1 failed, 2 passed, 3 total',
  ].join('\n');
  const summary = parseTestOutput(output);
  assert.equal(summary.failed, 1);
  assert.equal(summary.passed, 2);
  assert.equal(summary.total, 3);
  assert.ok(summary.failures.some((f) => f.startsWith('src/sum.test.js')));
});

test('parseTestOutput：pytest 汇总与 FAILED 行', () => {
  const output = [
    'tests/test_math.py::test_add PASSED',
    'tests/test_math.py::test_sub FAILED',
    '',
    '========================= 1 failed, 1 passed in 0.12s =========================',
  ].join('\n');
  const summary = parseTestOutput(output);
  assert.equal(summary.failed, 1);
  assert.equal(summary.passed, 1);
  assert.equal(summary.total, 2);
  assert.deepEqual(summary.failures.length > 0, true);
});

test('parseTestOutput：cargo 失败清单', () => {
  const output = [
    'running 2 tests',
    'test tests::ok ... ok',
    'test tests::bad ... FAILED',
    '',
    'failures:',
    '',
    '    tests::bad',
    '',
    'test result: FAILED. 1 passed; 1 failed; 0 ignored',
  ].join('\n');
  const summary = parseTestOutput(output);
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 1);
  assert.ok(summary.failures.includes('tests::bad'));
});

test('parseTestOutput：go test 无汇总行时按 --- FAIL 识别', () => {
  const output = ['--- FAIL: TestAdd (0.00s)', '    math_test.go:9: got 3 want 4', 'FAIL', 'FAIL\texample.com/x\t0.012s'].join('\n');
  const summary = parseTestOutput(output);
  assert.equal(summary.failed, 1);
  assert.ok(summary.failures.includes('TestAdd'));
});

test('parseTestOutput：Node 内置 runner（spec reporter ℹ 多行汇总）', () => {
  // 真实 `node --test` 输出（含 ✖ 用例行、✖ failing tests: 分节标题与耗时后缀）
  const output = [
    '✖ add(2, 3) 应等于 5 (2.0765ms)',
    'ℹ tests 1',
    'ℹ suites 0',
    'ℹ pass 0',
    'ℹ fail 1',
    'ℹ cancelled 0',
    'ℹ skipped 0',
    'ℹ todo 0',
    'ℹ duration_ms 163.0328',
    '',
    '✖ failing tests:',
    '',
    '✖ add(2, 3) 应等于 5 (2.0765ms)',
    '  AssertionError [ERR_ASSERTION]: -1 !== 5',
  ].join('\n');
  const summary = parseTestOutput(output);
  assert.equal(summary.total, 1);
  assert.equal(summary.passed, 0);
  assert.equal(summary.failed, 1);
  // 分节标题不得被当作失败用例，耗时后缀必须剥离，且不得重复计数
  assert.deepEqual(summary.failures, ['add(2, 3) 应等于 5']);
});

test('parseTestOutput：Node TAP reporter（# 汇总 + not ok）', () => {
  const output = [
    'TAP version 13',
    'ok 1 - 通过用例',
    'not ok 2 - 失败用例',
    '  ---',
    '  error: expected 3 to be 4',
    '  ...',
    'not ok 3 - 跳过的用例 # SKIP',
    'not ok 4 - 待办用例 # TODO',
    '1..4',
    '# tests 4',
    '# pass 1',
    '# fail 3',
  ].join('\n');
  const summary = parseTestOutput(output);
  assert.equal(summary.total, 4);
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 3);
  // # TODO / # SKIP 不是真实失败
  assert.deepEqual(summary.failures, ['失败用例']);
});

test('parseTestOutput：全绿时失败清单为空且不猜测数字', () => {
  const summary = parseTestOutput('all good, nothing to report');
  assert.deepEqual(summary, { failures: [] });
});

test('extractFailureExcerpt：清理 ANSI 转义并保留失败区域', () => {
  const output = [
    '\u001b[32mPASS\u001b[0m src/ok.test.ts',
    '\u001b[31mFAIL\u001b[0m src/bad.test.ts',
    '\u001b[31m  × explodes\u001b[0m',
    'AssertionError: expected true to be false',
  ].join('\n');
  const excerpt = extractFailureExcerpt(output);
  assert.ok(!excerpt.includes('\u001b['));
  assert.ok(excerpt.includes('FAIL'));
  assert.ok(excerpt.includes('AssertionError'));
});

test('extractFailureExcerpt：无失败标记时取尾部并受长度上限约束', () => {
  const long = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
  const excerpt = extractFailureExcerpt(long, 40);
  assert.ok(excerpt.length <= 40);
  assert.ok(excerpt.includes('line 49'));
});
