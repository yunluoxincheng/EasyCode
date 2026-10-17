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

/** 环境变量前缀（FOO=bar BAZ=1 cmd） */
const ENV_PREFIX_RE = /^(?:[a-zA-Z_][a-zA-Z0-9_]*=\S*\s+)+/;
/** 常见 shell 包装命令（powershell -c "..." / cmd /c "..." / bash -lc "..."） */
const SHELL_WRAPPER_RE =
  /^(?:powershell(?:\.exe)?|pwsh(?:\.exe)?|cmd(?:\.exe)?|bash|sh)\s+(?:-[a-zA-Z0-9]+\s+|(?:\/c|\/k)\s+)*["']?([^"']+)["']?/i;

/**
 * 命令归一化：剥离环境变量前缀并解包常见 shell 包装，使 `FOO=1 rm -rf x` 这类
 * 写法无法绕过针对 `rm` 的 deny 规则。
 */
export function normalizeShellCommand(raw: unknown): string {
  let cmd = typeof raw === 'string' ? raw.trim() : '';
  if (!cmd) return '';
  cmd = cmd.replace(ENV_PREFIX_RE, '').trim();
  const wrapped = SHELL_WRAPPER_RE.exec(cmd);
  if (wrapped) {
    cmd = wrapped[1].trim().replace(ENV_PREFIX_RE, '').trim();
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

/** 归一化路径：统一正斜杠、去掉 `./` 前缀与重复分隔符 */
export function normalizeRelativePath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/{2,}/g, '/');
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

/** 工具输入中的候选路径：原样相对路径 + 若为工作区内绝对路径则折算出的相对路径 */
function pathCandidates(rawPath: string, workspace?: string): string[] {
  const norm = normalizeRelativePath(rawPath);
  const out = [norm];
  const root = workspace ? normalizeRelativePath(workspace) : '';
  if (root) {
    const lowerRoot = root.toLowerCase();
    const lowerNorm = norm.toLowerCase();
    if (lowerNorm === lowerRoot) out.push('.');
    else if (lowerNorm.startsWith(`${lowerRoot}/`)) out.push(norm.slice(root.length + 1));
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
        const rawPath = typeof args.path === 'string' ? args.path : '';
        if (!rawPath) continue;
        const candidates = pathCandidates(rawPath, workspace);
        if (!candidates.some((candidate) => matchPathGlob(pattern, candidate))) continue;
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
