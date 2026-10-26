import type { Tool } from './index.js';
import { resolveWorkspacePath } from './index.js';
import type { Host } from '../host.js';
import { resolveRealPathInWorkspace } from '../path-guard.js';

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
      const stat = await host.fs.stat(full).catch(() => null);
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

const createSearchFilesTool = (literalOnly: boolean): Tool => ({
  spec: {
    name: 'search_files',
    description: literalOnly
      ? '在工作区内按字面量文本搜索，不解析正则；自动跳过构建目录，返回文件、行号和内容。'
      : '在工作区内按正则表达式搜索文本文件（自动跳过 .git/node_modules 等），返回 "文件:行号: 内容" 列表。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: literalOnly ? '字面量文本，1–1024 字符，不解析正则' : '正则表达式' },
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
    let regex: RegExp | undefined;
    if (literalOnly) {
      signal.throwIfAborted();
      if (!pattern.length || pattern.length > 1024 || rel.length > 4096 || (glob?.length ?? 0) > 256) throw new Error('子任务字面量查询须为 1–1024 字符，路径/过滤条件超过上限');
    } else {
      try { regex = new RegExp(pattern); }
      catch (err) { throw new Error(`正则表达式非法: ${err instanceof Error ? err.message : pattern}`); }
    }
    // KMP 无回溯；同时按字符/行工作量让出事件循环，截止与取消不会被扫描饿死。
    const prefix = literalOnly ? new Uint16Array(pattern.length) : undefined;
    if (prefix) for (let i = 1, matched = 0; i < pattern.length; i++) {
      while (matched && pattern[i] !== pattern[matched]) matched = prefix[matched - 1];
      if (pattern[i] === pattern[matched]) matched++;
      prefix[i] = matched;
    }
    let work = 0;
    const yieldScan = async () => {
      work = 0;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      signal.throwIfAborted();
    };
    const containsLiteral = async (line: string): Promise<boolean> => {
      let matched = 0;
      for (let i = 0; i < line.length; i++) {
        if (++work >= 32768) await yieldScan();
        while (matched && line[i] !== pattern[matched]) matched = prefix![matched - 1];
        if (line[i] === pattern[matched]) matched++;
        if (matched === pattern.length) return true;
      }
      return false;
    };
    const limit = Math.min(Math.max(1, max_results), MAX_MATCHES);
    const base = resolveWorkspacePath(workspace, rel, host);
    const results: string[] = [];
    let truncated = false;
    /** 因真实目标越出工作区（或无法确认）而跳过的文件数 */
    let skipped = 0;

    const matchGlob = (name: string): boolean => {
      if (!glob) return true;
      if (glob.startsWith('*.')) return name.endsWith(glob.slice(1));
      return name.includes(glob);
    };

    await walk(host, base, async (filePath) => {
      if (signal.aborted) return false;
      if (!matchGlob(host.paths.basename(filePath))) return true;
      // 逐文件校验真实目标（PR #9 第四轮复审 P1）：遍历阶段每读一个文件之前都必须
      // 重新确认它的真实落点在工作区内。起始目录合法并不代表递归发现的每个条目合法——
      // 工作区内一个 `leak.txt -> /outside/secret.txt` 会让 stat/readFile 跟随链接
      // 读到工作区外内容。越界或无法确认的文件直接跳过并计数，绝不读取。
      if (host.fs.realpath) {
        const verdict = await resolveRealPathInWorkspace(host, workspace, filePath, host.paths);
        if (!verdict.ok) {
          skipped += 1;
          return true;
        }
      }
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
        if (literalOnly && ++work >= 32768) await yieldScan();
        if (literalOnly ? await containsLiteral(line) : regex!.test(line)) {
          results.push(`${displayPath}:${i + 1}: ${line.trim().slice(0, 200)}`);
          if (results.length >= limit) {
            truncated = true;
            return false;
          }
        }
      }
      return true;
    });
    if (literalOnly) signal.throwIfAborted();

    // 越界跳过必须向用户报告：静默跳过会让人误以为「工作区里确实没有」
    const skipNote =
      skipped > 0
        ? `\n（已跳过 ${skipped} 个真实目标在工作区外的符号链接文件）`
        : '';
    if (results.length === 0) return `无匹配结果${skipNote}`;
    const header = `共 ${results.length}${truncated ? '+（已截断）' : ''} 条匹配：`;
    return `${header}\n${results.join('\n')}${skipNote}`;
  },
});

export const searchFilesTool = createSearchFilesTool(false);
export const literalSearchFilesTool = createSearchFilesTool(true);
