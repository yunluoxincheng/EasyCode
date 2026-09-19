import type { Tool } from './index.js';
import { resolveWorkspacePath } from './index.js';

const MAX_READ_BYTES = 64 * 1024;

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
  async execute(input, { host, workspace }) {
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
    return withLineNumbers(content, offset, limit);
  },
};

export const writeFileTool: Tool = {
  spec: {
    name: 'write_file',
    description: '创建或整体覆盖工作区内的文件。修改已有文件优先使用 edit_file。',
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
  async execute(input, { host, workspace }) {
    const { path: rel, content } = input as { path: string; content: string };
    const abs = resolveWorkspacePath(workspace, rel, host);
    const dir = host.paths.dirname(abs);
    if (dir && dir !== abs) await host.fs.mkdir(dir, { recursive: true });
    await host.fs.writeFile(abs, content);
    return `已写入 ${rel}（${content.split('\n').length} 行, ${content.length} 字符）`;
  },
};

export const editFileTool: Tool = {
  spec: {
    name: 'edit_file',
    description:
      '对文件做精确字符串替换。old_string 必须在文件中唯一（除非 replace_all=true），否则报错。',
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
  async execute(input, { host, workspace }) {
    const { path: rel, old_string: oldStr, new_string: newStr, replace_all = false } =
      input as {
        path: string;
        old_string: string;
        new_string: string;
        replace_all?: boolean;
      };
    if (oldStr === newStr) throw new Error('old_string 与 new_string 相同，无需修改');
    const abs = resolveWorkspacePath(workspace, rel, host);
    const content = await host.fs.readFile(abs);
    const count = content.split(oldStr).length - 1;
    if (count === 0) throw new Error(`old_string 在文件中不存在: ${rel}`);
    if (count > 1 && !replace_all) {
      throw new Error(`old_string 出现 ${count} 次，请提供更多上下文或设置 replace_all=true`);
    }
    const next = replace_all ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr);
    await host.fs.writeFile(abs, next);
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
        const childStat = await host.fs.stat(host.paths.join(abs, entry.name));
        lines.push(`[文件] ${entry.name}  ${childStat ? `${childStat.size}B` : ''}`);
      }
    }
    if (dirents.length > 500) lines.push(`...（共 ${dirents.length} 项，已截断）`);
    return lines.length > 0 ? lines.join('\n') : '（空目录）';
  },
};
