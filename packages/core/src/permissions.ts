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
export const PATH_PATTERN_TOOLS = new Set([
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
/**
 * 消费一段 `$( ... )` 命令替换：返回结束位置（右括号之后），无法闭合返回 -1。
 *
 * 命令替换内部是完整的 Shell 上下文：可再嵌套 `$( )`、反引号与引号，且**允许空格**。
 * 按空格截断会把 `FOO=$(printf x) rm -rf build` 归一化成 `x) rm -rf build`，
 * 从而绕过针对 `rm` 的 deny 规则（PR #9 第九轮复审 P1）。
 */
function consumeCommandSubstitution(input: string, start: number): number {
  // start 指向 `$`，其后必为 `(`
  let i = start + 2;
  let depth = 1;
  while (i < input.length) {
    const ch = input[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === "'") {
      const end = input.indexOf("'", i + 1);
      if (end < 0) return -1;
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      i += 1;
      let closed = false;
      while (i < input.length) {
        if (input[i] === '\\' && i + 1 < input.length) {
          i += 2;
          continue;
        }
        if (input[i] === '$' && input[i + 1] === '(') {
          const nested = consumeCommandSubstitution(input, i);
          if (nested < 0) return -1;
          i = nested;
          continue;
        }
        if (input[i] === '`') {
          const nested = consumeBacktick(input, i);
          if (nested < 0) return -1;
          i = nested;
          continue;
        }
        if (input[i] === '"') {
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) return -1;
      continue;
    }
    if (ch === '`') {
      const end = consumeBacktick(input, i);
      if (end < 0) return -1;
      i = end;
      continue;
    }
    if (ch === '$' && input[i + 1] === '(') {
      const nested = consumeCommandSubstitution(input, i);
      if (nested < 0) return -1;
      i = nested;
      continue;
    }
    if (ch === '(') {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === ')') {
      depth -= 1;
      i += 1;
      if (depth === 0) return i;
      continue;
    }
    i += 1;
  }
  return -1;
}

/** 消费一段反引号命令替换：返回结束位置（闭合反引号之后），无法闭合返回 -1 */
function consumeBacktick(input: string, start: number): number {
  let i = start + 1;
  while (i < input.length) {
    if (input[i] === '\\' && i + 1 < input.length) {
      i += 2;
      continue;
    }
    if (input[i] === '`') return i + 1;
    i += 1;
  }
  return -1;
}

/**
 * 从 `start` 开始消费一个完整的 Shell word，返回结束位置（指向分隔空白或字符串结尾）。
 *
 * Shell 中同一个 word 可以由引号片段、命令替换与裸文本**拼接**而成：`FOO="a"b`、
 * `FOO=$(printf x)`、`FOO=x"a b"` 都是一个赋值单词，赋值之后紧跟的才是命令。
 * 只识别「整段引号」或「整段裸值」会让这类写法漏过归一化（PR #9 第七/九轮复审）。
 *
 * 返回 -1 表示不可解析（引号或命令替换未闭合）：调用方应原样返回而不声称已清洗。
 */
function consumeShellWord(input: string, start: number): number {
  let i = start;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') return i;
    if (ch === '\\') {
      // 裸文本或双引号内的反斜杠转义：连转义字符一起吞掉
      i += 2;
      continue;
    }
    if (ch === '$' && input[i + 1] === '(') {
      const end = consumeCommandSubstitution(input, i);
      if (end < 0) return -1;
      i = end;
      continue;
    }
    if (ch === '`') {
      const end = consumeBacktick(input, i);
      if (end < 0) return -1;
      i = end;
      continue;
    }
    if (ch === "'") {
      // 单引号内全部是字面量，只可能被下一个 ' 收尾
      i += 1;
      while (i < input.length && input[i] !== "'") i += 1;
      if (i >= input.length) return -1;
      i += 1;
      continue;
    }
    if (ch === '"') {
      i += 1;
      let closed = false;
      while (i < input.length) {
        if (input[i] === '\\' && i + 1 < input.length) {
          i += 2;
          continue;
        }
        // 双引号内可以嵌套命令替换（内部允许空格）
        if (input[i] === '$' && input[i + 1] === '(') {
          const end = consumeCommandSubstitution(input, i);
          if (end < 0) return -1;
          i = end;
          continue;
        }
        if (input[i] === '`') {
          const end = consumeBacktick(input, i);
          if (end < 0) return -1;
          i = end;
          continue;
        }
        if (input[i] === '"') {
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) return -1;
      continue;
    }
    i += 1;
  }
  return i;
}

function stripEnvAssignments(input: string): string {
  let rest = input;
  for (;;) {
    rest = rest.replace(/^\s+/, '');
    const head = ENV_ASSIGN_HEAD_RE.exec(rest);
    if (!head) return rest;
    // 消费完整的赋值单词（可含多段引号/裸文本拼接），而不是只认一种写法
    const end = consumeShellWord(rest, head[0].length);
    if (end < 0) return rest;
    rest = rest.slice(end);
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

/**
 * 扫描整条命令的引号 / 命令替换配平情况，返回人类可读的问题描述（无问题返回 null）。
 *
 * 归一化只处理「前缀可解析」的命令。一旦命令本身存在无法闭合的引号或 `$( )` /
 * 反引号，任何归一化结果都不可信；把不可信的归一化当成「未命中规则」，
 * 等于把危险命令当作安全放行（PR #9 第九轮复审 P1）。
 */
function scanShellBalance(input: string): string | null {
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === "'") {
      const end = input.indexOf("'", i + 1);
      if (end < 0) return '单引号未闭合';
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      i += 1;
      let closed = false;
      while (i < input.length) {
        if (input[i] === '\\' && i + 1 < input.length) {
          i += 2;
          continue;
        }
        if (input[i] === '$' && input[i + 1] === '(') {
          const end = consumeCommandSubstitution(input, i);
          if (end < 0) return '命令替换 $( ) 未闭合';
          i = end;
          continue;
        }
        if (input[i] === '`') {
          const end = consumeBacktick(input, i);
          if (end < 0) return '反引号命令替换未闭合';
          i = end;
          continue;
        }
        if (input[i] === '"') {
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) return '双引号未闭合';
      continue;
    }
    if (ch === '$' && input[i + 1] === '(') {
      const end = consumeCommandSubstitution(input, i);
      if (end < 0) return '命令替换 $( ) 未闭合';
      i = end;
      continue;
    }
    if (ch === '`') {
      const end = consumeBacktick(input, i);
      if (end < 0) return '反引号命令替换未闭合';
      i = end;
      continue;
    }
    i += 1;
  }
  return null;
}

/**
 * 命令是否无法被可靠归一化；无法解析时返回原因，可解析返回 null。
 *
 * 调用方必须对返回非 null 的命令走**保守审批**：不能因为归一化没命中规则就放行。
 */
export function describeCommandParseRisk(raw: unknown): string | null {
  const cmd = typeof raw === 'string' ? raw.trim() : '';
  if (!cmd) return null;
  return scanShellBalance(cmd);
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

/** 归一化路径：统一正斜杠、去掉 `./` 前缀与重复分隔符（不做 `..` 解析） */
export function normalizeRelativePath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/{2,}/g, '/');
}

/**
 * 路径语义接口：由调用方注入宿主真实的 `paths` 实现（`Host.paths`）。
 * 权限层**不得**自行猜测路径是否合法——必须与实际文件工具使用同一套解析入口，
 * 否则两套语义必然会漂移出新的绕过方式。
 */
export interface PathApi {
  resolve(...parts: string[]): string;
  isAbsolute(p: string): boolean;
  /** 取父目录（真实路径解析回溯最近存在祖先时需要） */
  dirname(p: string): string;
  /** 取末段文件名 */
  basename(p: string): string;
  sep: string;
}

/** POSIX 风格的兜底实现（仅用于无 Host 的纯函数调用与单测） */
export const defaultPathApi: PathApi = {
  resolve: (...parts: string[]): string => {
    let absolute = false;
    const out: string[] = [];
    for (const part of parts) {
      if (!part) continue;
      const normalized = part.replace(/\\/g, '/');
      if (normalized.startsWith('/')) {
        absolute = true;
        out.length = 0;
      }
      for (const seg of normalized.split('/')) {
        if (!seg || seg === '.') continue;
        if (seg === '..') {
          if (out.length > 0) out.pop();
          else if (!absolute) out.push('..');
          continue;
        }
        out.push(seg);
      }
    }
    const joined = out.join('/');
    if (absolute) return `/${joined}`;
    return joined || '.';
  },
  isAbsolute: (p: string): boolean => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p),
  dirname: (p: string): string => {
    const norm = p.replace(/\\/g, '/').replace(/\/+$/, '');
    const idx = norm.lastIndexOf('/');
    if (idx < 0) return '.';
    if (idx === 0) return '/';
    const head = norm.slice(0, idx);
    return /^[A-Za-z]:$/.test(head) ? `${head}/` : head;
  },
  basename: (p: string): string => {
    const norm = p.replace(/\\/g, '/').replace(/\/+$/, '');
    const idx = norm.lastIndexOf('/');
    return idx < 0 ? norm : norm.slice(idx + 1);
  },
  sep: '/',
};

/**
 * 按宿主真实路径语义把工具参数解析为「工作区相对路径」。
 *
 * 与 `resolveWorkspacePath()` 使用完全相同的入口（`paths.resolve(workspace, input)` +
 * 工作区包含性校验），因此：
 * - `src/tmp/../private/key.json` → `src/private/key.json`（命中 `src/private/**`）
 * - `../ws/private/key.json`（工作区 `/ws`）→ 解析回 `/ws/private/key.json` → `private/key.json`
 *   （**这是本轮复审指出的绕过：词法层遇到开头 `..` 就放弃匹配，而文件层却能访问**）
 *
 * 返回 `null` 表示无法映射到工作区内（真正越界）：此时文件工具会直接报「路径越界」，
 * 权限规则不命中并回落审批模式语义（安全默认）。
 */
export function resolveWorkspaceRelative(
  workspace: string,
  input: string,
  paths: PathApi = defaultPathApi,
): string | null {
  const raw = typeof input === 'string' ? input.trim() : '';
  const root = typeof workspace === 'string' ? workspace.trim() : '';
  if (!raw || !root) return null;
  let abs: string;
  let base: string;
  try {
    abs = paths.isAbsolute(raw) ? paths.resolve(raw) : paths.resolve(root, raw);
    base = paths.resolve(root);
  } catch {
    return null;
  }
  const sep = paths.sep || '/';
  const withSep = base.endsWith(sep) ? base : base + sep;
  // Windows 路径大小写不敏感：包含性判断必须同语义，否则 C:\WS 与 C:\ws 会被判为越界
  const caseInsensitive = sep === '\\';
  const cmpAbs = caseInsensitive ? abs.toLowerCase() : abs;
  const cmpBase = caseInsensitive ? base.toLowerCase() : base;
  const cmpWithSep = caseInsensitive ? withSep.toLowerCase() : withSep;
  if (cmpAbs !== cmpBase && !cmpAbs.startsWith(cmpWithSep)) return null;
  if (cmpAbs === cmpBase) return '.';
  const rel = abs.slice(base.length + (base.endsWith(sep) ? 0 : 1));
  return normalizeRelativePath(rel) || '.';
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
  paths: PathApi,
): boolean {
  const candidates = pathCandidates(rawPath, workspace, paths);
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
function pathCandidates(rawPath: string, workspace: string | undefined, paths: PathApi): string[] {
  const out: string[] = [];
  const push = (value: string | null | undefined): void => {
    if (value && !out.includes(value)) out.push(value);
  };
  if (!workspace) {
    // 未绑定工作区：无宿主语义可依，退回词法规范化（仅作相对路径匹配）
    const lexical = defaultPathApi.resolve('.', rawPath);
    push(normalizeRelativePath(lexical));
    return out;
  }
  // 关键：完全复用文件工具的解析入口（resolve(工作区, 输入) + 包含性校验），
  // 先得到真实绝对路径再折算相对路径。绝不能自行猜测 `..` 是否合法——
  // `../ws/private/key.json` 在 `/ws` 下会解析回工作区内，词法层却会误判为越界。
  const rel = resolveWorkspaceRelative(workspace, rawPath, paths);
  push(rel);
  return out;
}

/**
 * 裁决一次工具调用：
 * - 无规则或规则为空 → `null`（由审批模式语义兜底）；
 * - 任一命中规则为 deny 即拒绝；否则任一 ask 即强制审批；否则任一 allow 即免审批。
 *
 * `paths` 必须传入宿主真实路径能力（`Host.paths`），否则路径类规则会退化到
 * POSIX 兜底语义，与文件工具的实际行为不一致。
 */
export function evaluatePermission(
  rules: PermissionRule[] | undefined,
  toolName: string,
  input: unknown,
  workspace?: string,
  paths: PathApi = defaultPathApi,
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
        if (!matchPathRule(rule, pattern, rawPath, workspace, toolName, paths)) continue;
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
  options?: { parseRisk?: string | null },
): ApprovalRequirement {
  // 命令含无法可靠解析的结构（未闭合引号 / 命令替换）时，归一化结果不可信：
  // 此时「没命中 allow 规则」不代表安全，必须按保守策略强制审批。
  // 优先级高于 allow——基于不可信归一化得出的免审批结论不能被采信。
  const parseRisk = options?.parseRisk?.trim();
  if (parseRisk && evaluation?.decision !== 'deny') {
    return {
      needApproval: true,
      force: true,
      reason: `命令含无法可靠解析的结构（${parseRisk}），已按保守策略要求审批`,
    };
  }
  if (evaluation?.decision === 'allow') return { needApproval: false, force: false };
  if (evaluation?.decision === 'ask') {
    return { needApproval: true, force: true, reason: describePermissionRule(evaluation.rule) };
  }
  return { needApproval: sensitive && evaluation?.decision !== 'deny', force: false };
}
