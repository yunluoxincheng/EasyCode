/**
 * 工具权限规则引擎（TODOS #47）：在审批模式（ask / yolo）之上叠加细粒度
 * `allow` / `ask` / `deny` 策略，使「日常命令免审批、破坏性操作必须确认」成为可能。
 * 纯类型与纯函数实现，零运行时依赖，保持 core 可在浏览器沙箱中脱机运行。
 */

export type PermissionDecision = 'allow' | 'ask' | 'deny';

/** 规则来源：全局设置 / 项目级 .easycode/permissions.json */
export type PermissionRuleSource = 'global' | 'project';

export interface PermissionRule {
  /** 工具名；`*` 表示任意工具 */
  tool: string;
  /**
   * 匹配模式（可选，省略表示该工具的全部调用）：
   * - `run_command`：命令前缀（`*` 通配，自带词边界，`rm` 不会误命中 `rmdir`）
   * - 文件类工具：工作区相对路径 glob（`*` 单段、`**` 跨目录）
   * - 其余工具不支持模式匹配，写了 pattern 视为不命中
   */
  pattern?: string;
  decision: PermissionDecision;
  /** 备注，仅用于界面与提示文案 */
  note?: string;
  /** 规则来源（由引擎在合流时标注；手写规则可省略） */
  source?: PermissionRuleSource;
}

export interface PermissionEvaluation {
  decision: PermissionDecision;
  rule: PermissionRule;
}

/** 裁决优先级：拒绝 > 询问 > 放行（与规则书写顺序无关，安全优先） */
const DECISION_RANK: Record<PermissionDecision, number> = { allow: 0, ask: 1, deny: 2 };

/** 支持路径 glob 匹配的工具体系 */
const PATH_PATTERN_TOOLS = new Set([
  'read_file',
  'write_file',
  'edit_file',
  'list_dir',
  'search_files',
]);

/** 常见 shell 包装命令（powershell -c "..." / cmd /c "..." / bash -lc "..."） */
const SHELL_WRAPPER_RE =
  /^(?:powershell(?:\.exe)?|pwsh(?:\.exe)?|cmd(?:\.exe)?|bash|sh)\s+(?:-[a-zA-Z0-9]+\s+|(?:\/c|\/k)\s+)*["']?([^"']+)["']?/i;

/** 变量赋值名前缀：`FOO=` */
const ENV_ASSIGN_HEAD_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * 剥离命令起始位置的环境变量赋值前缀（`FOO=bar BAZ=1 cmd`）。
 *
 * 必须做**词法解析**而不能用正则一把梭：`FOO="hello world" rm -rf x` 中的值含空格，
 * 早期用 `\S*` 匹配会在空格处断开，导致 `rm` 没有被识别成命令而绕过 deny 规则。
 * 这里按 shell 引号语义消费值：单引号 / 双引号（支持反斜杠转义）/ 裸值直到空白。
 *
 * 遇到无法可靠识别的写法（引号未闭合、赋值与后续字符无空白分隔）时**原样返回**，
 * 绝不假装已经清洗干净——调用方不得把前缀匹配当作危险命令筛查的保证。
 */
function stripEnvAssignments(input: string): string {
  let rest = input;
  for (;;) {
    rest = rest.replace(/^\s+/, '');
    const head = ENV_ASSIGN_HEAD_RE.exec(rest);
    if (!head) return rest;
    let i = head[0].length;
    const quote = rest[i];
    if (quote === '"' || quote === "'") {
      i += 1;
      let closed = false;
      while (i < rest.length) {
        const ch = rest[i];
        // 双引号内的反斜杠转义：连转义字符一起吞掉，避免被 \" 提前收尾
        if (ch === '\\' && quote === '"' && i + 1 < rest.length) {
          i += 2;
          continue;
        }
        if (ch === quote) {
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      // 引号未闭合：写法不可解析，原样返回（保守，不声称已清洗）
      if (!closed) return rest;
    } else {
      while (i < rest.length && !/\s/.test(rest[i])) i += 1;
    }
    // 赋值后必须紧跟空白（或已到结尾），否则是 `FOO=1rm` 这类无法解析的复合写法
    if (i < rest.length && !/\s/.test(rest[i])) return rest;
    rest = rest.slice(i);
  }
}

/**
 * 命令归一化：剥离环境变量前缀并解包常见 shell 包装，使 `FOO=1 rm -rf x`、
 * `FOO="a b" rm -rf x` 这类写法无法绕过针对 `rm` 的 deny 规则。
 *
 * 注意：本函数只做**命令级**归一化。它不解析 `a && b`、管道、`package.json` 脚本等
 * 间接执行路径，因此前缀匹配不能当作进程级沙箱使用（见 README「安全设计」）。
 */
export function normalizeShellCommand(raw: unknown): string {
  let cmd = typeof raw === 'string' ? raw.trim() : '';
  if (!cmd) return '';
  cmd = stripEnvAssignments(cmd).trim();
  const wrapped = SHELL_WRAPPER_RE.exec(cmd);
  if (wrapped) {
    cmd = stripEnvAssignments(wrapped[1].trim()).trim();
  }
  return cmd;
}

/** 转义正则元字符（单字符） */
function escapeRegExpChar(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

function escapeRegExp(input: string): string {
  let out = '';
  for (const ch of input) out += escapeRegExpChar(ch);
  return out;
}

/**
 * 命令前缀匹配：`git status` 命中 `git status -s`，`rm` 不命中 `rmdir`；
 * 模式中的 `*` / `?` 作为通配符（`git *`、`npm run test*`）。
 */
export function matchCommandPattern(pattern: string, command: string): boolean {
  const rawPattern = normalizeShellCommand(pattern).replace(/\s+/g, ' ');
  const rawCommand = normalizeShellCommand(command).replace(/\s+/g, ' ');
  if (!rawPattern || !rawCommand) return false;
  const source = escapeRegExp(rawPattern).replace(/\\\*/g, '.*').replace(/\\\?/g, '.');
  // 词边界断言：模式必须命中所属词汇的起点，杜绝 `rm` 命中 `rmdir`
  return new RegExp(`^${source}(?=\\s|$)`).test(rawCommand);
}

/** 归一化路径：统一正斜杠、去掉 `./` 前缀与重复分隔符（不做 `..` 解析，见 normalizePathSegments） */
export function normalizeRelativePath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/{2,}/g, '/');
}

/**
 * 词法规范化路径（等价于 `path.resolve` 的字符串语义，不触碰文件系统）：
 * 折叠 `.`、消解 `..`、去除重复分隔符，使权限 glob 与实际文件工具看到的路径一致。
 *
 * 这修复了一类真实绕过：规则拒绝 `src/private/**`，但工具参数写成
 * `src/tmp/../private/key.json` 时，朴素字符串匹配命中不了，而 `resolveWorkspacePath()`
 * 会把它解析到 `src/private/key.json` 并成功访问。
 *
 * 相对路径中 `..` 逃出根目录时返回 `null`（无法映射为工作区内路径）；
 * 此时权限规则不命中，回落到审批模式语义（安全默认）。绝对路径的 `..` 按 resolve 语义忽略。
 */
export function normalizePathSegments(value: string): string | null {
  const cleaned = typeof value === 'string' ? value.trim().replace(/\\/g, '/') : '';
  if (!cleaned) return null;
  const absolute = cleaned.startsWith('/');
  const parts: string[] = [];
  for (const raw of cleaned.split('/')) {
    if (!raw || raw === '.') continue;
    if (raw === '..') {
      if (parts.length > 0) parts.pop();
      else if (!absolute) return null;
      continue;
    }
    parts.push(raw);
  }
  const joined = parts.join('/');
  if (absolute) return `/${joined}`;
  return joined || '.';
}

/** 省略 path 参数时实际访问工作区根目录的工具（权限规则必须按 `.` 求值） */
const DEFAULT_PATH_BY_TOOL: Record<string, string> = {
  list_dir: '.',
  search_files: '.',
};

/** 递归遍历作用域的工具：省略 path 时会触达整个工作区子树 */
const SUBTREE_SCOPE_TOOLS = new Set(['search_files']);

/** 取出路径 glob 的字面前缀（第一个通配符之前的部分） */
function globLiteralPrefix(pattern: string): string {
  const norm = normalizeRelativePath(pattern);
  const idx = norm.search(/[*?]/);
  const prefix = idx < 0 ? norm : norm.slice(0, idx);
  return prefix.replace(/\/+$/, '');
}

/** 取出用于权限匹配的路径参数；缺省时回落到该工具的真实默认路径 */
function toolPathArg(toolName: string, args: Record<string, unknown>): string {
  const raw = typeof args.path === 'string' ? args.path.trim() : '';
  if (raw) return raw;
  return DEFAULT_PATH_BY_TOOL[toolName] ?? '';
}

/**
 * 判断路径类规则是否命中一次调用：
 * - 先按规范化后的精确路径做 glob 匹配；
 * - 对**递归搜索**类工具额外做子树推断：规则指向 `src/private/**` 时，从工作区根发起的
 *   `search_files` 同样会读到这些文件，因此必须命中。
 *   该放大只作用于 `deny` / `ask`（收紧权限），`allow` 绝不凭前缀推断放宽审批。
 */
function matchPathRule(
  rule: PermissionRule,
  pattern: string,
  rawPath: string,
  workspace: string | undefined,
  toolName: string,
): boolean {
  const candidates = pathCandidates(rawPath, workspace);
  if (candidates.some((candidate) => matchPathGlob(pattern, candidate))) return true;
  if (rule.decision === 'allow') return false;
  if (!SUBTREE_SCOPE_TOOLS.has(toolName)) return false;
  const prefix = globLiteralPrefix(pattern);
  // 形如 `**/.env`：任何位置都可能命中，保守视为落在搜索范围内
  if (!prefix || prefix === '.') return true;
  return candidates.some(
    (candidate) => candidate === '.' || prefix === candidate || prefix.startsWith(`${candidate}/`),
  );
}

/** 路径 glob → 正则：`*` 匹配单段、`**` 跨目录、`?` 匹配单字符 */
export function matchPathGlob(pattern: string, target: string): boolean {
  const pat = normalizeRelativePath(pattern);
  const path = normalizeRelativePath(target);
  if (!pat || !path) return false;
  let source = '';
  for (let i = 0; i < pat.length; i++) {
    const ch = pat[i];
    if (ch === '*') {
      if (pat[i + 1] === '*') {
        i++;
        if (pat[i + 1] === '/') {
          i++;
          // `**/` 允许零层目录：`**/.env` 同时命中 `.env` 与 `src/.env`
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (ch === '?') {
      source += '[^/]';
    } else {
      source += escapeRegExpChar(ch);
    }
  }
  return new RegExp(`^${source}$`).test(path);
}

/** 工具输入中的候选路径：规范化后的相对路径 + 若为工作区内绝对路径则折算出的相对路径 */
function pathCandidates(rawPath: string, workspace?: string): string[] {
  const out: string[] = [];
  const push = (value: string | null | undefined): void => {
    if (value && !out.includes(value)) out.push(value);
  };
  // 关键：先做词法规范化（解析 `.` 与 `..`），否则 `src/tmp/../private/x`
  // 无法命中 `src/private/**` 这类规则（真实绕过）
  const norm = normalizePathSegments(rawPath);
  push(norm);
  if (!norm) return out;
  const root = workspace ? normalizePathSegments(workspace) : null;
  if (root && root !== '.') {
    const lowerRoot = root.toLowerCase();
    const lowerNorm = norm.toLowerCase();
    if (lowerNorm === lowerRoot) push('.');
    else if (lowerNorm.startsWith(`${lowerRoot}/`)) {
      push(normalizePathSegments(norm.slice(root.length + 1)));
    }
  }
  return out;
}

/**
 * 裁决一次工具调用：
 * - 无规则或规则为空 → `null`（由审批模式语义兜底）；
 * - 任一命中规则为 deny 即拒绝；否则任一 ask 即强制审批；否则任一 allow 即免审批。
 */
export function evaluatePermission(
  rules: PermissionRule[] | undefined,
  toolName: string,
  input: unknown,
  workspace?: string,
): PermissionEvaluation | null {
  if (!rules || rules.length === 0) return null;
  const args =
    typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  let winner: PermissionEvaluation | null = null;
  for (const rule of rules) {
    if (!rule || typeof rule.tool !== 'string') continue;
    if (rule.decision !== 'allow' && rule.decision !== 'ask' && rule.decision !== 'deny') continue;
    if (rule.tool !== '*' && rule.tool !== toolName) continue;
    const pattern = typeof rule.pattern === 'string' ? rule.pattern.trim() : '';
    if (pattern) {
      if (toolName === 'run_command') {
        const command = typeof args.command === 'string' ? args.command : '';
        if (!command || !matchCommandPattern(pattern, command)) continue;
      } else if (PATH_PATTERN_TOOLS.has(toolName)) {
        const rawPath = toolPathArg(toolName, args);
        // 缺省路径按工具真实默认值求值（list_dir / search_files 默认工作区根），
        // 不能因为参数省略就跳过路径规则
        if (!rawPath) continue;
        if (!matchPathRule(rule, pattern, rawPath, workspace, toolName)) continue;
      } else {
        // 非命令/路径类工具无法可靠映射 pattern，一律视为不命中（不制造假限制）
        continue;
      }
    }
    if (!winner || DECISION_RANK[rule.decision] > DECISION_RANK[winner.decision]) {
      winner = { decision: rule.decision, rule };
    }
  }
  return winner;
}

/** 人类可读的规则描述（审批卡片 / 拒绝文案用） */
export function describePermissionRule(rule: PermissionRule): string {
  const scope =
    rule.source === 'project' ? '项目规则' : rule.source === 'global' ? '全局规则' : '权限规则';
  const target = rule.pattern ? `${rule.tool} ~ "${rule.pattern}"` : `${rule.tool}（全部调用）`;
  const note = rule.note?.trim();
  return `${scope}: ${target}${note ? ` · ${note}` : ''}`;
}

/** 一次调用的审批要求（把权限裁决翻译成审批链路的入参） */
export interface ApprovalRequirement {
  needApproval: boolean;
  /** 强制审批：命中 `ask` 规则时即使在 yolo 模式下也必须弹窗 */
  force: boolean;
  /** 触发原因说明（命中规则时用于审批卡片） */
  reason?: string;
}

/**
 * 统一的审批裁决入口：常规工具调用（`executeTool`）与引擎内置动作
 * （如测试自愈循环的 `test_loop`）必须走同一套语义，避免两条链路各写一遍而漂移。
 *
 * - 命中 `allow` → 免审批（即使在 ask 模式下）
 * - 命中 `ask`   → 强制审批（即使在 yolo 模式下）
 * - 无命中       → 按会话模式处理敏感能力；只读能力直接放行
 *
 * `deny` 不在此处理：调用方必须先短路并给出明确的拒绝说明（不得执行）。
 */
export function resolveApprovalRequirement(
  evaluation: PermissionEvaluation | null,
  sensitive: boolean,
): ApprovalRequirement {
  if (evaluation?.decision === 'allow') return { needApproval: false, force: false };
  if (evaluation?.decision === 'ask') {
    return { needApproval: true, force: true, reason: describePermissionRule(evaluation.rule) };
  }
  return { needApproval: sensitive && evaluation?.decision !== 'deny', force: false };
}
