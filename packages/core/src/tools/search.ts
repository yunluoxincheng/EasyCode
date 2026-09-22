import type { Tool } from './index.js';
import { resolveWorkspacePath } from './index.js';
import type { Host } from '../host.js';

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'out',
  'build',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  'target',
  'vendor',
]);
const MAX_FILE_SIZE = 1024 * 1024;
const MAX_MATCHES = 200;

async function walk(
  host: Host,
  dir: string,
  visit: (filePath: string) => Promise<boolean>, // 返回 false 表示停止
): Promise<boolean> {
  let dirents;
  try {
    dirents = await host.fs.readdir(dir);
  } catch {
    return true;
  }
  for (const entry of dirents) {
    const full = host.paths.join(dir, entry.name);
    if (entry.isDirectory) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (!(await walk(host, full, visit))) return false;
    } else {
      const stat = await host.fs.stat(full);
      if (!stat || stat.size > MAX_FILE_SIZE) continue;
      if (!(await visit(full))) return false;
    }
  }
  return true;
}

/**
 * 递归收集工作区中的相对路径列表（统一正斜杠 / 风格）
 * 专为 @文件 引用设计：跳过构建目录，不做冗余的 stat 检查，毫秒级返回
 */
export async function listFilesRecursively(
  host: Host,
  root: string,
  opts?: { limit?: number; signal?: AbortSignal },
): Promise<string[]> {
  const limit = opts?.limit ?? 1000;
  const results: string[] = [];

  async function step(dir: string, relPrefix: string): Promise<boolean> {
    if (opts?.signal?.aborted || results.length >= limit) return false;
    let dirents;
    try {
      dirents = await host.fs.readdir(dir);
    } catch {
      return true;
    }
    for (const entry of dirents) {
      if (results.length >= limit) return false;
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const full = host.paths.join(dir, entry.name);
        const cont = await step(full, relPath);
        if (!cont) return false;
      } else {
        results.push(relPath);
      }
    }
    return true;
  }

  await step(root, '');
  return results;
}

export const searchFilesTool: Tool = {
  spec: {
    name: 'search_files',
    description:
      '在工作区内按正则表达式搜索文本文件（自动跳过 .git/node_modules 等），返回 "文件:行号: 内容" 列表。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式' },
        path: { type: 'string', description: '搜索起始目录，默认工作区根' },
        glob: { type: 'string', description: '文件名过滤，如 *.ts（简单的后缀/包含匹配）' },
        max_results: { type: 'number', description: '最多返回条数，默认 50，上限 200' },
      },
      required: ['pattern'],
    },
  },
  async execute(input, { host, workspace, signal }) {
    const { pattern, path: rel = '.', glob, max_results = 50 } = input as {
      pattern: string;
      path?: string;
      glob?: string;
      max_results?: number;
    };
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch (err) {
      throw new Error(`正则表达式非法: ${err instanceof Error ? err.message : pattern}`);
    }
    const limit = Math.min(Math.max(1, max_results), MAX_MATCHES);
    const base = resolveWorkspacePath(workspace, rel, host);
    const results: string[] = [];
    let truncated = false;

    const matchGlob = (name: string): boolean => {
      if (!glob) return true;
      if (glob.startsWith('*.')) return name.endsWith(glob.slice(1));
      return name.includes(glob);
    };

    await walk(host, base, async (filePath) => {
      if (signal.aborted) return false;
      if (!matchGlob(host.paths.basename(filePath))) return true;
      let content: string;
      try {
        content = await host.fs.readFile(filePath);
      } catch {
        return true;
      }
      if (content.includes('\u0000')) return true;
      const root = host.paths.resolve(workspace);
      const displayPath = filePath.startsWith(root)
        ? '.' + host.paths.sep + filePath.slice(root.length).replace(/^[/\\]/, '')
        : filePath;
      const lines = content.split('\n');
      for (const [i, line] of lines.entries()) {
        if (regex.test(line)) {
          results.push(`${displayPath}:${i + 1}: ${line.trim().slice(0, 200)}`);
          if (results.length >= limit) {
            truncated = true;
            return false;
          }
        }
      }
      return true;
    });

    if (results.length === 0) return '无匹配结果';
    const header = `共 ${results.length}${truncated ? '+（已截断）' : ''} 条匹配：`;
    return `${header}\n${results.join('\n')}`;
  },
};
