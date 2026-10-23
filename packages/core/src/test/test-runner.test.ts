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

test('parseTestOutput：Node spec/TAP 汇总均剔除非失败标题、跳过和待办', () => {
  const cases = [
    {
      output: [
        '✖ add(2, 3) 应等于 5 (2.0765ms)',
        'ℹ tests 1', 'ℹ suites 0', 'ℹ pass 0', 'ℹ fail 1',
        'ℹ cancelled 0', 'ℹ skipped 0', 'ℹ todo 0', 'ℹ duration_ms 163.0328',
        '', '✖ failing tests:', '', '✖ add(2, 3) 应等于 5 (2.0765ms)',
        '  AssertionError [ERR_ASSERTION]: -1 !== 5',
      ],
      total: 1, passed: 0, failed: 1, failures: ['add(2, 3) 应等于 5'],
    },
    {
      output: [
        'TAP version 13', 'ok 1 - 通过用例', 'not ok 2 - 失败用例',
        '  ---', '  error: expected 3 to be 4', '  ...',
        'not ok 3 - 跳过的用例 # SKIP', 'not ok 4 - 待办用例 # TODO',
        '1..4', '# tests 4', '# pass 1', '# fail 3',
      ],
      total: 4, passed: 1, failed: 3, failures: ['失败用例'],
    },
  ];
  for (const item of cases) {
    const summary = parseTestOutput(item.output.join('\n'));
    assert.equal(summary.total, item.total);
    assert.equal(summary.passed, item.passed);
    assert.equal(summary.failed, item.failed);
    assert.deepEqual(summary.failures, item.failures);
  }
});

test('【P2 复审】长日志必须同时保留失败点上下文与末尾汇总', () => {
  // 失败点之后还有大量输出：单纯保留尾部会把最关键的断言信息挤掉
  const lines = [
    'RUN v1.6.0',
    ...Array.from({ length: 300 }, (_, i) => `setup line ${i}`),
    'FAIL  src/a.test.ts > math > adds numbers',
    '  AssertionError: expected 3 to be 4',
    '    at src/a.test.ts:12:9',
    ...Array.from({ length: 600 }, (_, i) => `noise ${i} `.repeat(8)),
    '      Tests  1 failed | 5 passed (6)',
    '   Duration  1.23s',
  ].join('\n');
  const excerpt = extractFailureExcerpt(lines, 2000);

  assert.ok(excerpt.length <= 2000, `超预算: ${excerpt.length}`);
  // 失败点上下文必须保留（这是早期「只留尾部」会丢掉的部分）
  assert.ok(excerpt.includes('AssertionError'), '失败断言信息被丢弃');
  assert.ok(excerpt.includes('adds numbers'), '失败用例名被丢弃');
  // 末尾汇总同样必须在场
  assert.ok(excerpt.includes('Tests  1 failed | 5 passed (6)'), '末尾汇总被丢弃');
  // 中间省略需有明确标注，且省略字符数不得为负数
  assert.match(excerpt, /…（中间 \d+ 字符已省略）…/);
  const omitted = Number(/中间 (\d+) 字符/.exec(excerpt)?.[1]);
  assert.ok(omitted > 0, `省略字符数异常: ${omitted}`);
});
