import type { Host } from '../host.js';
import type { Tool } from './index.js';
import { resolveWorkspacePath } from './index.js';
import { resolveRealPathInWorkspace } from '../path-guard.js';

const MAX_READ_BYTES = 64 * 1024;
const MAX_RANGE_LINES = 500;
/** 行范围引用前置文件体积上限（2MB），防止超大 JSON/日志/Bundle 整文件读入内存 */
const MAX_RANGE_FILE_BYTES = 2 * 1024 * 1024;
/** 单个行范围切片注入的最大字符数（24KB）与单行最大字符数（2000） */
const MAX_RANGE_CHARS = 24 * 1024;
const MAX_RANGE_LINE_CHARS = 2000;

/**
 * 格式化文件 @引用 Token（TODOS #38）：当路径包含空格或双引号时自动用双引号包裹，
 * 确保 @file 与 @file:start-end 均能被解析器无损识别。
 */
export function formatFileMention(relPath: string, rangeSpec?: string | null): string {
  const clean = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  const needsQuotes = /[\s"]/.test(clean);
  const pathToken = needsQuotes ? `"${clean.replace(/"/g, '')}"` : clean;
  return rangeSpec ? `@${pathToken}:${rangeSpec}` : `@${pathToken}`;
}

function withLineNumbers(content: string, offset: number, limit: number): string {
  const lines = content.split('\n');
  const start = Math.max(0, offset);
  const end = Math.min(lines.length, start + limit);
  const out: string[] = [];
  for (let i = start; i < end; i++) {
    out.push(`${String(i + 1).padStart(5, ' ')}| ${lines[i]}`);
  }
  if (end < lines.length) {
    out.push(`...（共 ${lines.length} 行，已截断。可用 offset=${end} 继续读取）`);
  }
  return out.join('\n');
}

/** 代码行号范围引用结构（TODOS #38）：@path/to/file.ts:50-100 或 @path/to/file.ts:35 */
export interface CodeRangeMention {
  /** 原始匹配字符串（如 @src/main.ts:10-20） */
  raw: string;
  /** 工作区相对路径（如 src/main.ts） */
  path: string;
  /** 起始行号（1-based，含） */
  startLine: number;
  /** 结束行号（1-based，含） */
  endLine: number;
}

/** 解析并切片后的代码片段信息（TODOS #38） */
export interface CodeRangeSnippet {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
  formatted: string;
}

/**
 * 从用户输入文本中解析全部 @path/to/file:start-end 或 @path/to/file:line 行范围引用（TODOS #38）。
 * 严格要求 @ 前为行首、空白或左标点，避免误匹配邮箱或 URL 端口。
 */
export function parseCodeRangeMentions(text: string): CodeRangeMention[] {
  if (!text || !text.includes('@') || !text.includes(':')) return [];
  const pattern =
    /(?:^|(?<=[\s([{"'`<:;，。！？、]))@(?:"([^"\r\n:]+)"|([^\s:"'`<>]+)):(\d+)(?:-(\d+))?(?=$|[\s)\]}"'`,.;:!?，。；：！？、])/g;
  const mentions: CodeRangeMention[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const rawPath = (match[1] ?? match[2] ?? '').trim();
    if (!rawPath) continue;
    const n1 = parseInt(match[3], 10);
    const n2 = match[4] !== undefined ? parseInt(match[4], 10) : n1;
    if (!Number.isFinite(n1) || !Number.isFinite(n2) || n1 < 1 || n2 < 1) continue;
    const startLine = Math.min(n1, n2);
    const endLine = Math.max(n1, n2);
    const cleanPath = rawPath.replace(/\\/g, '/').replace(/^\.\//, '');
    const key = `${cleanPath}:${startLine}-${endLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    mentions.push({
      raw: match[0],
      path: cleanPath,
      startLine,
      endLine,
    });
  }
  return mentions;
}

/**
 * 解析文本中的 @file:start-end 行范围引用，从工作区安全读取对应行切片并注入上下文（TODOS #38）。
 * 附带行号标尺与“用户截取了文件第 X-Y 行片段”上下文说明。
 */
export async function resolveCodeRangeMentions(
  host: Host,
  workspace: string,
  text: string,
): Promise<{ enrichedText: string; snippets: CodeRangeSnippet[] }> {
  if (!workspace?.trim()) return { enrichedText: text, snippets: [] };
  const mentions = parseCodeRangeMentions(text);
  if (mentions.length === 0) return { enrichedText: text, snippets: [] };

  const snippets: CodeRangeSnippet[] = [];
  for (const m of mentions) {
    try {
      // 旁路读取入口同样受工作区边界约束（PR #9 第五轮复审 P1）：
      // @file 引用会把片段注入模型上下文，若跟随工作区内指向外部文件的符号链接，
      // 就等于把工作区外内容发给模型。因此先取真实目标，再读取真实路径。
      const guard = await resolveRealPathInWorkspace(host, workspace, m.path, host.paths);
      if (!guard.ok) continue;
      const abs = guard.value.realPath;
      const stat = await host.fs.stat(abs);
      if (!stat || stat.isDirectory || stat.size > MAX_RANGE_FILE_BYTES) continue;
      const rawContent = await host.fs.readFile(abs);
      if (rawContent.includes('\u0000')) continue;
      const normalized = rawContent.replace(/\r\n/g, '\n');
      const lines = normalized.split('\n');
      const totalLines = lines.length;
      if (totalLines === 0 || m.startLine > totalLines) continue;

      const startLine = Math.max(1, m.startLine);
      const endLine = Math.max(
        startLine,
        Math.min(m.endLine, totalLines, startLine + MAX_RANGE_LINES - 1),
      );
      const numberedLines: string[] = [];
      let totalChars = 0;
      let charTruncated = false;
      for (let i = startLine; i <= endLine; i++) {
        const rawLine = lines[i - 1] ?? '';
        const clippedLine =
          rawLine.length > MAX_RANGE_LINE_CHARS
            ? `${rawLine.slice(0, MAX_RANGE_LINE_CHARS)} ... [单行超长已截断]`
            : rawLine;
        const formattedLine = `${String(i).padStart(5, ' ')}| ${clippedLine}`;
        if (totalChars + formattedLine.length > MAX_RANGE_CHARS && numberedLines.length > 0) {
          charTruncated = true;
          break;
        }
        numberedLines.push(formattedLine);
        totalChars += formattedLine.length + 1;
      }
      if (charTruncated) {
        numberedLines.push(`...（片段已达 ${MAX_RANGE_CHARS} 字符上限，余下内容已截断）`);
      }
      const sliceBody = numberedLines.join('\n');
      const rangeSpec = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
      const rangeDesc = startLine === endLine ? `第 ${startLine} 行` : `第 ${startLine}-${endLine} 行`;
      const formatted = [
        `### ${formatFileMention(m.path, rangeSpec)}`,
        `> *用户截取了文件 \`${m.path}\` ${rangeDesc}片段（文件共 ${totalLines} 行）：*`,
        '```',
        sliceBody,
        '```',
      ].join('\n');

      snippets.push({
        path: m.path,
        startLine,
        endLine,
        totalLines,
        content: sliceBody,
        formatted,
      });
    } catch {
      // 忽略越界或不存在的单个文件引用，不阻断正常提问
    }
  }

  if (snippets.length === 0) return { enrichedText: text, snippets: [] };
  const injectedBlock = [
    '',
    '---',
    '# 引用代码行范围切片 (Code Range Mentions)',
    ...snippets.map((s) => s.formatted),
  ].join('\n\n');

  return {
    enrichedText: `${text}${injectedBlock}`,
    snippets,
  };
}

export const readFileTool: Tool = {
  spec: {
    name: 'read_file',
    description:
      '读取工作区内文本文件内容（带行号）。对大文件可用 offset/limit 分页读取。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区的文件路径' },
        offset: { type: 'number', description: '起始行号（0 开始），默认 0' },
        limit: { type: 'number', description: '最多读取行数，默认 2000' },
      },
      required: ['path'],
    },
  },
  async execute(input, { host, workspace, readFiles }) {
    const { path: rel, offset = 0, limit = 2000 } = input as {
      path: string;
      offset?: number;
      limit?: number;
    };
    const abs = resolveWorkspacePath(workspace, rel, host);
    const stat = await host.fs.stat(abs);
    if (!stat) throw new Error(`文件不存在: ${rel}`);
    if (stat.isDirectory) throw new Error(`目标是目录，请用 list_dir: ${rel}`);
    let content = await host.fs.readFile(abs);
    if (content.includes('\u0000')) throw new Error(`疑似二进制文件，无法以文本读取: ${rel}`);
    if (content.length > MAX_READ_BYTES) content = content.slice(0, MAX_READ_BYTES);
    readFiles?.add(abs);
    return withLineNumbers(content, offset, limit);
  },
};

async function rollbackWorkspaceFileOnSnapshotFailure(
  host: Host,
  abs: string,
  rel: string,
  existedBefore: boolean,
  beforeContent: string | null,
  snapErr: unknown,
): Promise<never> {
  const snapMsg = snapErr instanceof Error ? snapErr.message : String(snapErr);
  try {
    if (!existedBefore) {
      if (!host.fs.unlink) {
        throw new Error('当前宿主不支持 unlink 删除文件');
      }
      await host.fs.unlink(abs);
      const st = await host.fs.stat(abs);
      if (st !== null) {
        throw new Error('回滚删除后目标文件仍存在');
      }
    } else {
      if (beforeContent === null) {
        throw new Error('缺少写前原始内容基准');
      }
      await host.fs.writeFile(abs, beforeContent);
      const verify = await host.fs.readFile(abs);
      if (verify !== beforeContent) {
        throw new Error('回滚写回后文件内容校验不一致');
      }
    }
  } catch (rbErr) {
    const rbMsg = rbErr instanceof Error ? rbErr.message : String(rbErr);
    throw new Error(
      `文件快照记录或持久化失败，且自动回滚工作区文件失败（警告：文件可能已发生未受快照保护的修改: ${rel}）: ${snapMsg}（回滚失败原因: ${rbMsg}）`,
    );
  }
  throw new Error(
    `文件快照记录或持久化失败，已自动回滚工作区文件 (${rel}) 至修改前状态: ${snapMsg}`,
  );
}

export const writeFileTool: Tool = {
  spec: {
    name: 'write_file',
    description:
      '创建新文件或整体覆盖工作区内的文件。覆盖已有文件前必须先 read_file 该文件；修改局部内容优先使用 edit_file。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区的文件路径' },
        content: { type: 'string', description: '完整文件内容' },
      },
      required: ['path', 'content'],
    },
  },
  sensitive: true,
  async execute(input, { host, workspace, readFiles, callId, onFileChange }) {
    const { path: rel, content } = input as { path: string; content: string };
    const abs = resolveWorkspacePath(workspace, rel, host);
    const stat = await host.fs.stat(abs);
    if (stat?.isDirectory) {
      throw new Error(`目标是目录，无法作为文件写入: ${rel}`);
    }
    if (stat && readFiles && !readFiles.has(abs)) {
      throw new Error(`覆盖已有文件前请先 read_file: ${rel}（防盲改保护）`);
    }
    const existedBefore = Boolean(stat && !stat.isDirectory);
    let beforeContent: string | null = null;
    if (existedBefore && onFileChange) {
      try {
        beforeContent = await host.fs.readFile(abs);
      } catch (err) {
        throw new Error(
          `读取原文件快照失败，已中止覆盖写入以保护原文件 (${rel}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const dir = host.paths.dirname(abs);
    if (dir && dir !== abs) await host.fs.mkdir(dir, { recursive: true });
    await host.fs.writeFile(abs, content);
    if (onFileChange) {
      try {
        await onFileChange({
          callId,
          relPath: rel,
          absPath: abs,
          existedBefore,
          beforeContent,
          afterContent: content,
        });
      } catch (snapErr) {
        await rollbackWorkspaceFileOnSnapshotFailure(
          host,
          abs,
          rel,
          existedBefore,
          beforeContent,
          snapErr,
        );
      }
    }
    readFiles?.add(abs);
    return `已写入 ${rel}（${content.split('\n').length} 行, ${content.length} 字符）`;
  },
};

export const editFileTool: Tool = {
  spec: {
    name: 'edit_file',
    description:
      '对文件做精确字符串替换。仅可编辑本会话已 read_file 过的文件。old_string 必须在文件中唯一（除非 replace_all=true），否则报错。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区的文件路径' },
        old_string: { type: 'string', description: '要被替换的原文（保持足够上下文以唯一定位）' },
        new_string: { type: 'string', description: '替换后的文本' },
        replace_all: { type: 'boolean', description: '替换全部匹配，默认 false' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  sensitive: true,
  async execute(input, { host, workspace, readFiles, callId, onFileChange }) {
    const { path: rel, old_string: oldStr, new_string: newStr, replace_all = false } =
      input as {
        path: string;
        old_string: string;
        new_string: string;
        replace_all?: boolean;
      };
    if (oldStr === newStr) throw new Error('old_string 与 new_string 相同，无需修改');
    const abs = resolveWorkspacePath(workspace, rel, host);
    if (readFiles && !readFiles.has(abs)) {
      throw new Error(`尚未读取该文件，请先 read_file 后再编辑: ${rel}（防盲改保护）`);
    }
    const content = await host.fs.readFile(abs);
    const count = content.split(oldStr).length - 1;
    if (count === 0) throw new Error(`old_string 在文件中不存在: ${rel}`);
    if (count > 1 && !replace_all) {
      throw new Error(`old_string 出现 ${count} 次，请提供更多上下文或设置 replace_all=true`);
    }
    const next = replace_all ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr);
    await host.fs.writeFile(abs, next);
    if (onFileChange) {
      try {
        await onFileChange({
          callId,
          relPath: rel,
          absPath: abs,
          existedBefore: true,
          beforeContent: content,
          afterContent: next,
        });
      } catch (snapErr) {
        await rollbackWorkspaceFileOnSnapshotFailure(
          host,
          abs,
          rel,
          true,
          content,
          snapErr,
        );
      }
    }
    readFiles?.add(abs);
    return `已修改 ${rel}（替换 ${replace_all ? count : 1} 处）`;
  },
};

export const listDirTool: Tool = {
  spec: {
    name: 'list_dir',
    description: '列出工作区内目录的子项（名称、类型、大小）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区的目录路径，默认工作区根' },
      },
    },
  },
  async execute(input, { host, workspace }) {
    const { path: rel = '.' } = (input ?? {}) as { path?: string };
    const abs = resolveWorkspacePath(workspace, rel, host);
    const stat = await host.fs.stat(abs);
    if (!stat) throw new Error(`目录不存在: ${rel}`);
    if (!stat.isDirectory) throw new Error(`目标不是目录: ${rel}`);
    const dirents = await host.fs.readdir(abs);
    const lines: string[] = [];
    for (const entry of dirents.slice(0, 500)) {
      if (entry.isDirectory) {
        lines.push(`[目录] ${entry.name}/`);
      } else {
        const childStat = await host.fs.stat(host.paths.join(abs, entry.name)).catch(() => null);
        lines.push(`[文件] ${entry.name}  ${childStat ? `${childStat.size}B` : ''}`);
      }
    }
    if (dirents.length > 500) lines.push(`...（共 ${dirents.length} 项，已截断）`);
    return lines.length > 0 ? lines.join('\n') : '（空目录）';
  },
};
