/**
 * 测试运行探知与失败解析（TODOS #39）：仅做「命令探测 + 输出解析」这类纯逻辑，
 * 具体进程执行由调用方注入 Host，保证 core 零运行时依赖。
 */

import type { Host } from './host.js';

export type TestFramework = 'node' | 'cargo' | 'pytest' | 'go' | 'custom';

/** 探测到的测试命令 */
export interface TestCommandDetection {
  command: string;
  framework: TestFramework;
  /** 人类可读的来源说明（设置页自定义 / 项目配置 / package.json / Cargo.toml / go.mod / pyproject.toml） */
  source: string;
}

/** 单轮测试结果摘要（解析不出数字时保持 undefined，绝不猜测） */
export interface TestRunSummary {
  total?: number;
  passed?: number;
  failed?: number;
  /** 失败用例名（已去重、限长、限条数） */
  failures: string[];
}

const MAX_FAILURE_ITEMS = 10;
const MAX_FAILURE_NAME = 200;
const DEFAULT_EXCERPT_CHARS = 6000;

/** ANSI 转义序列（含 SGR 与光标控制），终端日志摘录前必须清理 */
const ANSI_RE = /\u001b\[[0-9;?]*[a-zA-Z]/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

async function readTextFile(host: Host, path: string): Promise<string | null> {
  try {
    const stat = await host.fs.stat(path);
    if (!stat || stat.isDirectory) return null;
    return await host.fs.readFile(path);
  } catch {
    return null;
  }
}

async function fileExists(host: Host, path: string): Promise<boolean> {
  try {
    const stat = await host.fs.stat(path);
    return !!stat && !stat.isDirectory;
  } catch {
    return false;
  }
}

async function detectPackageManager(host: Host, root: string): Promise<string> {
  const join = host.paths.join;
  if (await fileExists(host, join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await fileExists(host, join(root, 'yarn.lock'))) return 'yarn';
  if (
    (await fileExists(host, join(root, 'bun.lockb'))) ||
    (await fileExists(host, join(root, 'bun.lock')))
  ) {
    return 'bun';
  }
  if (await fileExists(host, join(root, 'package-lock.json'))) return 'npm';
  return 'npm';
}

/** Node/TS 项目：读取 package.json 的 scripts.test，并按锁文件推断包管理器 */
async function detectNodeCommand(host: Host, root: string): Promise<string | null> {
  const raw = await readTextFile(host, host.paths.join(root, 'package.json'));
  if (!raw) return null;
  let pkg: unknown;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return null;
  }
  const scripts = (pkg as { scripts?: Record<string, unknown> } | null)?.scripts;
  const test = typeof scripts?.test === 'string' ? scripts.test.trim() : '';
  if (!test) return null;
  const pm = await detectPackageManager(host, root);
  if (pm === 'npm') return 'npm test';
  if (pm === 'bun') return 'bun run test';
  return `${pm} test`;
}

/**
 * 探测工作区的测试命令：
 * 优先使用显式覆盖（设置页 / 项目级 `.easycode/test.json`），
 * 否则按 Node → Cargo → Go → Python 的通用顺序识别项目类型。
 */
export async function detectTestCommand(
  host: Host,
  workspaceRoot: string,
  override?: string,
): Promise<TestCommandDetection | null> {
  const root = workspaceRoot?.trim();
  if (!root) return null;
  const explicit = override?.trim();
  if (explicit) return { command: explicit, framework: 'custom', source: '自定义命令' };

  const node = await detectNodeCommand(host, root);
  if (node) return { command: node, framework: 'node', source: 'package.json scripts.test' };

  if (await fileExists(host, host.paths.join(root, 'Cargo.toml'))) {
    return { command: 'cargo test', framework: 'cargo', source: 'Cargo.toml' };
  }
  if (await fileExists(host, host.paths.join(root, 'go.mod'))) {
    return { command: 'go test ./...', framework: 'go', source: 'go.mod' };
  }
  const pythonMarkers = [
    'pyproject.toml',
    'pytest.ini',
    'tox.ini',
    'setup.cfg',
    'setup.py',
    'requirements.txt',
  ];
  for (const marker of pythonMarkers) {
    if (await fileExists(host, host.paths.join(root, marker))) {
      return { command: 'python -m pytest', framework: 'pytest', source: marker };
    }
  }
  return null;
}

function toCount(segment: string | undefined): number | undefined {
  if (!segment) return undefined;
  const n = Number.parseInt(segment, 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Node 内置 test runner 的汇总分散在多行（spec reporter 用 `ℹ` 前缀，TAP 用 `#`）：
 *   ℹ tests 3 / ℹ pass 2 / ℹ fail 1      |      # tests 3 / # pass 2 / # fail 1
 * 因此必须跨行聚合，不能按单行匹配。
 */
const NODE_SUMMARY_RE = /^(?:ℹ\s*|#\s*)(tests|pass|fail)\s+(\d+)\s*$/;

function parseNodeSummary(
  lines: string[],
): { passed?: number; failed?: number; total?: number } | null {
  const found = new Map<string, number>();
  // 从尾部向前扫，取最近一组完整结果（同一份输出可能含多轮历史）
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = NODE_SUMMARY_RE.exec(lines[i].trim());
    if (!m) continue;
    if (!found.has(m[1])) found.set(m[1], Number.parseInt(m[2], 10));
    if (found.size >= 3) break;
  }
  if (found.size === 0) return null;
  const total = found.get('tests');
  const passed = found.get('pass');
  const failed = found.get('fail');
  return {
    passed,
    failed,
    total: total ?? (passed !== undefined || failed !== undefined
      ? (passed ?? 0) + (failed ?? 0)
      : undefined),
  };
}

/** 从各类测试框架的汇总行提取通过/失败/总数 */
function parseSummaryLine(line: string): { passed?: number; failed?: number; total?: number } | null {
  const trimmed = line.trim();
  // vitest：Tests  2 failed | 3 passed (5) / Tests  5 passed (5)
  if (/^Tests\b/.test(trimmed)) {
    const failed = toCount(/(\d+)\s+failed/.exec(trimmed)?.[1]);
    const passed = toCount(/(\d+)\s+passed/.exec(trimmed)?.[1]);
    const total = toCount(/\((\d+)\)\s*$/.exec(trimmed)?.[1]);
    if (failed === undefined && passed === undefined) return null;
    return { passed, failed, total: total ?? (passed !== undefined || failed !== undefined
      ? (passed ?? 0) + (failed ?? 0)
      : undefined) };
  }
  // jest：Tests:       1 failed, 2 passed, 3 total
  if (/^Tests:/.test(trimmed)) {
    const failed = toCount(/(\d+)\s+failed/.exec(trimmed)?.[1]);
    const passed = toCount(/(\d+)\s+passed/.exec(trimmed)?.[1]);
    const total = toCount(/(\d+)\s+total/.exec(trimmed)?.[1]);
    if (failed === undefined && passed === undefined) return null;
    return { passed, failed, total };
  }
  // cargo：test result: FAILED. 3 passed; 1 failed; 0 ignored
  if (/^test result:/.test(trimmed)) {
    return {
      passed: toCount(/(\d+)\s+passed/.exec(trimmed)?.[1]),
      failed: toCount(/(\d+)\s+failed/.exec(trimmed)?.[1]),
    };
  }
  // pytest：= 1 failed, 10 passed in 0.30s =
  if (/\bin\s+\d+(?:\.\d+)?s\b/.test(trimmed) && /passed|failed/.test(trimmed)) {
    const passed = toCount(/(\d+)\s+passed/.exec(trimmed)?.[1]);
    const failed = toCount(/(\d+)\s+failed/.exec(trimmed)?.[1]);
    if (passed === undefined && failed === undefined) return null;
    const total = passed !== undefined || failed !== undefined
      ? (passed ?? 0) + (failed ?? 0)
      : undefined;
    return { passed, failed, total };
  }
  return null;
}

/** 归一化失败用例名：去前缀、单行化、去掉 reporter 追加的耗时后缀、限长 */
function cleanFailureName(raw: string): string {
  const name = raw
    .trim()
    .replace(/\s+/g, ' ')
    // Node spec reporter 会在用例名后追加耗时：`add(2, 3) 应等于 5 (2.0765ms)`
    .replace(/\s*\(\d+(?:\.\d+)?\s*(?:ns|µs|ms|s)\)$/, '');
  return name.slice(0, MAX_FAILURE_NAME);
}

/** reporter 的分节标题不是失败用例名（`✖ failing tests:` / `✖ failing suites:`） */
const FAILURE_SECTION_LABELS = new Set([
  'failing tests:',
  'failing suites:',
  'failing tests',
  'failing suites',
]);

/** 从测试输出中提取失败用例名（覆盖 vitest / jest / pytest / cargo / go / node TAP） */
function extractFailureNames(lines: string[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string): void => {
    const name = cleanFailureName(raw);
    if (!name || FAILURE_SECTION_LABELS.has(name.toLowerCase()) || seen.has(name)) return;
    seen.add(name);
    names.push(name);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // TAP（node --test）：not ok 3 - 用例名；带 # TODO / # SKIP 的不是真实失败，跳过
    const tapFail = /^not ok\s+\d+\s*-\s*(.+)$/.exec(line.trim());
    if (tapFail) {
      if (/#\s*(?:TODO|SKIP)\b/i.test(tapFail[1])) continue;
      push(tapFail[1].replace(/\s*#\s*(?:TODO|SKIP)\b.*$/i, ''));
      continue;
    }
    // vitest / jest：FAIL  src/foo.test.ts > suite > case ；✕ case
    const vitestFail = /^(?:FAIL|✖|✕|×)\s+(.+)$/.exec(line.trim());
    if (vitestFail) {
      // go test 的包级汇总行形如 `FAIL\texample.com/x\t0.012s`（含制表符），不是失败用例名
      if (!vitestFail[1].includes('\t')) push(vitestFail[1]);
      continue;
    }
    // pytest：FAILED tests/test_x.py::test_y - AssertionError: ...
    const pytestFail = /^FAILED\s+([^-\n]+?)(?:\s+-\s+.*)?$/.exec(line.trim());
    if (pytestFail) {
      push(pytestFail[1]);
      continue;
    }
    // go：--- FAIL: TestFoo (0.00s)
    const goFail = /^---\s+FAIL:\s+(\S+)/.exec(line.trim());
    if (goFail) {
      push(goFail[1]);
      continue;
    }
    // cargo：failures: 之后逐行列出用例名，直到空行或结果行
    if (/^failures:$/.test(line.trim())) {
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j];
        if (!next.trim()) continue;
        if (/^test result:/.test(next.trim()) || /^failures:$/.test(next.trim())) break;
        if (/^\s{2,}\S/.test(next)) push(next);
        else break;
      }
    }
  }
  return names.slice(0, MAX_FAILURE_ITEMS);
}

/**
 * 解析测试命令输出：汇总计数 + 失败用例名。
 * 解析不到的内容保持 undefined / 空数组，绝不用估算值冒充真实结果。
 */
export function parseTestOutput(output: string): TestRunSummary {
  const text = stripAnsi(output ?? '');
  const lines = text.split(/\r?\n/);
  // Node 内置 runner（`node --test`）的汇总跨多行，优先跨行聚合；
  // 其余框架仍走单行汇总匹配（从尾部取最近一次结果）
  let summary: { passed?: number; failed?: number; total?: number } | null =
    parseNodeSummary(lines);
  if (!summary) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const parsed = parseSummaryLine(lines[i]);
      if (parsed) {
        summary = parsed;
        break;
      }
    }
  }
  const failures = extractFailureNames(lines);
  const result: TestRunSummary = { failures };
  if (summary) {
    if (summary.passed !== undefined) result.passed = summary.passed;
    if (summary.failed !== undefined) result.failed = summary.failed;
    const total = summary.total ?? (summary.passed !== undefined || summary.failed !== undefined
      ? (summary.passed ?? 0) + (summary.failed ?? 0)
      : undefined);
    if (total !== undefined) result.total = total;
  } else if (failures.length > 0) {
    // 无汇总行但识别出失败用例（如 go test）：只回填可确定的失败数
    result.failed = failures.length;
  }
  // 识别不出任何失败用例但汇总行显示失败时，补一条占位说明，避免"失败 1 但无清单"的空洞卡片
  if (result.failed !== undefined && result.failed > 0 && result.failures.length === 0) {
    result.failures.push('（未从输出中解析出具体失败用例名，请展开原始日志查看）');
  }
  return result;
}

/**
 * 失败标记：`FAIL` / `FAILED` / `--- FAIL` 需要词边界（避免误命中 `FAILOVER`），
 * 而 `✖` / `✕` / `×` / `●` 是符号类标记，**不能**加 `\b`——符号本身是非单词字符，
 * `\b` 在「符号 + 空格」之间恒为假，会导致 `✖ broken test` 完全匹配不到
 * （历史缺陷：长日志退回尾部 80 行，真正的失败位置被丢掉，直接拖累自愈质量）。
 */
const FAILURE_MARKER_RE = /(?:^|\s)(?:FAIL(?:ED)?\b|---\s+FAIL\b|[✖✕×●])/u;

/**
 * 提取失败日志摘录：优先从首个失败标记处截取，否则取输出尾部；
 * 统一清理 ANSI 转义并限制长度，防止超长构建日志挤爆上下文与卡片。
 */
export function extractFailureExcerpt(
  output: string,
  maxChars = DEFAULT_EXCERPT_CHARS,
): string {
  const text = stripAnsi(output ?? '').trim();
  if (!text) return '';
  const lines = text.split(/\r?\n/);
  const markerIdx = lines.findIndex((line) => FAILURE_MARKER_RE.test(line.trim()));
  // `>= 0`：标记正好落在首行时同样从首行截取（早期写成 `> 0` 会整段丢弃开头）
  const startLine = markerIdx >= 0 ? markerIdx : Math.max(0, lines.length - 80);
  let excerpt = lines.slice(startLine).join('\n').trim();
  if (excerpt.length > maxChars) excerpt = excerpt.slice(excerpt.length - maxChars);
  return excerpt;
}
