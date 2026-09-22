import type { Host } from '../host.js';
import type { Tool, ToolContext } from './index.js';

export interface GitFileChange {
  path: string;
  staged: boolean;
  status: 'M' | 'A' | 'D' | 'R' | '?' | 'U';
  insertions?: number;
  deletions?: number;
}

export interface GitStatusSummary {
  isGit: boolean;
  branch: string;
  clean: boolean;
  ahead: number;
  behind: number;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  totalChanges: number;
  insertions: number;
  deletions: number;
  files: GitFileChange[];
}

export interface GitDiffOptions {
  path?: string;
  staged?: boolean;
  untracked?: boolean;
}

export interface GitDiffResult {
  path?: string;
  diff: string;
}

/**
 * 高速将全局统一差异 (unified diff) 切分为每个文件的单独差异映射
 */
export function splitUnifiedDiff(rawDiff: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!rawDiff || !rawDiff.trim()) return map;

  const chunks = rawDiff.split(/^diff --git a\//m);
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const newlineIdx = chunk.indexOf('\n');
    const firstLine = newlineIdx !== -1 ? chunk.slice(0, newlineIdx) : chunk;
    const bPartIdx = firstLine.lastIndexOf(' b/');
    if (bPartIdx !== -1) {
      let path = firstLine.slice(0, bPartIdx).trim();
      if (path.startsWith('"') && path.endsWith('"')) {
        path = path.slice(1, -1);
      }
      map.set(path, `diff --git a/${chunk}`);
    }
  }
  return map;
}

/**
 * 探测并解析工作区的 Git 状态
 */
export async function getGitStatus(host: Host, workspace: string): Promise<GitStatusSummary> {
  const emptyResult: GitStatusSummary = {
    isGit: false,
    branch: '',
    clean: true,
    ahead: 0,
    behind: 0,
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    totalChanges: 0,
    insertions: 0,
    deletions: 0,
    files: [],
  };

  if (!workspace) return emptyResult;

  try {
    let statusRes = await host.process.run('git status --porcelain=v1 -b --ahead-behind', {
      cwd: workspace,
      timeoutMs: 10000,
    });

    // 若旧版 git 不支持 --ahead-behind 导致非零退出码，回退到普通 -b
    if (statusRes.code !== 0) {
      statusRes = await host.process.run('git status --porcelain=v1 -b', {
        cwd: workspace,
        timeoutMs: 10000,
      });
    }

    if (statusRes.code !== 0) {
      return emptyResult;
    }

    const lines = statusRes.stdout.split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) {
      return { ...emptyResult, isGit: true };
    }

    // 解析分支信息：首行形如 "## master...origin/master [ahead 1, behind 2]" 或 "## master"
    let branch = '';
    let ahead = 0;
    let behind = 0;

    const firstLine = lines[0];
    if (firstLine.startsWith('## ')) {
      const branchPart = firstLine.slice(3).trim();
      const matchAhead = branchPart.match(/ahead\s+(\d+)/);
      if (matchAhead) ahead = parseInt(matchAhead[1], 10);
      const matchBehind = branchPart.match(/behind\s+(\d+)/);
      if (matchBehind) behind = parseInt(matchBehind[1], 10);

      const dotIdx = branchPart.indexOf('...');
      const spaceIdx = branchPart.indexOf(' ');
      let endIdx = branchPart.length;
      if (dotIdx !== -1) endIdx = dotIdx;
      else if (spaceIdx !== -1) endIdx = spaceIdx;
      branch = branchPart.slice(0, endIdx).trim();
      if (branch.startsWith('Initial commit on ') || branch.startsWith('No commits yet on ')) {
        branch = branch.replace(/^(Initial commit on |No commits yet on )/, '');
      } else if (branch.startsWith('HEAD (no branch)')) {
        branch = 'DETACHED';
      }
    }

    // 解析增删行数统计 numstat
    const numstatMap = new Map<string, { stagedIns: number; stagedDel: number; unstagedIns: number; unstagedDel: number }>();
    const getNumEntry = (p: string) => {
      let e = numstatMap.get(p);
      if (!e) {
        e = { stagedIns: 0, stagedDel: 0, unstagedIns: 0, unstagedDel: 0 };
        numstatMap.set(p, e);
      }
      return e;
    };

    // 1. 暂存区增删
    const cachedDiff = await host.process.run('git diff --cached --numstat', {
      cwd: workspace,
      timeoutMs: 10000,
    });
    if (cachedDiff.code === 0 && cachedDiff.stdout) {
      for (const line of cachedDiff.stdout.split(/\r?\n/)) {
        const parts = line.split('\t');
        if (parts.length >= 3) {
          const ins = parseInt(parts[0], 10) || 0;
          const del = parseInt(parts[1], 10) || 0;
          const p = parts[2].trim();
          const entry = getNumEntry(p);
          entry.stagedIns = ins;
          entry.stagedDel = del;
        }
      }
    }

    // 2. 工作区未暂存增删
    const unstagedDiff = await host.process.run('git diff --numstat', {
      cwd: workspace,
      timeoutMs: 10000,
    });
    if (unstagedDiff.code === 0 && unstagedDiff.stdout) {
      for (const line of unstagedDiff.stdout.split(/\r?\n/)) {
        const parts = line.split('\t');
        if (parts.length >= 3) {
          const ins = parseInt(parts[0], 10) || 0;
          const del = parseInt(parts[1], 10) || 0;
          const p = parts[2].trim();
          const entry = getNumEntry(p);
          entry.unstagedIns = ins;
          entry.unstagedDel = del;
        }
      }
    }

    const files: GitFileChange[] = [];
    let stagedCount = 0;
    let unstagedCount = 0;
    let untrackedCount = 0;
    let totalInsertions = 0;
    let totalDeletions = 0;

    for (let i = 1; i < lines.length; i++) {
      const l = lines[i];
      if (l.length < 4) continue;
      const x = l[0];
      const y = l[1];
      let filePath = l.slice(3).trim();
      // 处理重命名 R  old -> new
      if (filePath.includes(' -> ')) {
        filePath = filePath.split(' -> ')[1].trim();
      }
      // 去除可能的外层引号
      if (filePath.startsWith('"') && filePath.endsWith('"')) {
        filePath = filePath.slice(1, -1);
      }

      const numInfo = numstatMap.get(filePath);

      // 未跟踪文件
      if (x === '?' && y === '?') {
        untrackedCount++;
        files.push({
          path: filePath,
          staged: false,
          status: '?',
        });
        continue;
      }

      // 暂存区变更
      if (x !== ' ' && x !== '?') {
        stagedCount++;
        const ins = numInfo?.stagedIns ?? 0;
        const del = numInfo?.stagedDel ?? 0;
        totalInsertions += ins;
        totalDeletions += del;
        files.push({
          path: filePath,
          staged: true,
          status: x as GitFileChange['status'],
          insertions: ins,
          deletions: del,
        });
      }

      // 未暂存区变更
      if (y !== ' ' && y !== '?') {
        unstagedCount++;
        const ins = numInfo?.unstagedIns ?? 0;
        const del = numInfo?.unstagedDel ?? 0;
        totalInsertions += ins;
        totalDeletions += del;
        files.push({
          path: filePath,
          staged: false,
          status: y as GitFileChange['status'],
          insertions: ins,
          deletions: del,
        });
      }
    }

    const totalChanges = files.length;
    return {
      isGit: true,
      branch: branch || 'HEAD',
      clean: totalChanges === 0,
      ahead,
      behind,
      stagedCount,
      unstagedCount,
      untrackedCount,
      totalChanges,
      insertions: totalInsertions,
      deletions: totalDeletions,
      files,
    };
  } catch {
    return emptyResult;
  }
}

/**
 * 获取 Git 差异内容（已消除多余的子进程状态探测）
 */
export async function getGitDiff(
  host: Host,
  workspace: string,
  options?: GitDiffOptions,
): Promise<GitDiffResult> {
  if (!workspace) return { diff: '' };

  const targetPath = options?.path?.trim();
  const isStaged = !!options?.staged;
  const isUntracked = !!options?.untracked;

  // 1. 若显式标记为未跟踪文件，直接读取文件生成新增 diff，无需调用 git 进程
  if (targetPath && !isStaged && isUntracked) {
    try {
      const fullPath = host.paths.isAbsolute(targetPath)
        ? targetPath
        : host.paths.join(workspace, targetPath);
      const stat = await host.fs.stat(fullPath);
      if (stat && !stat.isDirectory) {
        const content = await host.fs.readFile(fullPath);
        const lines = content.split(/\r?\n/);
        const header = [
          `diff --git a/${targetPath} b/${targetPath}`,
          'new file mode 100644',
          '--- /dev/null',
          `+++ b/${targetPath}`,
          `@@ -0,0 +1,${lines.length} @@`,
        ];
        const diffBody = lines.map((l) => `+${l}`).join('\n');
        return {
          path: targetPath,
          diff: `${header.join('\n')}\n${diffBody}`,
        };
      }
    } catch {
      // 容错回退到 git diff
    }
  }

  // 2. 正常单次执行 git diff
  const cmd = `git diff ${isStaged ? '--cached' : ''} ${targetPath ? `-- "${targetPath}"` : ''}`;
  try {
    const res = await host.process.run(cmd, { cwd: workspace, timeoutMs: 15000 });
    const diff = res.stdout || '';

    // 若指定了文件但 diff 输出为空，且未暂存，尝试检测是否为未跟踪文件
    if (targetPath && !diff.trim() && !isStaged) {
      try {
        const fullPath = host.paths.isAbsolute(targetPath)
          ? targetPath
          : host.paths.join(workspace, targetPath);
        const stat = await host.fs.stat(fullPath);
        if (stat && !stat.isDirectory) {
          const content = await host.fs.readFile(fullPath);
          const lines = content.split(/\r?\n/);
          const header = [
            `diff --git a/${targetPath} b/${targetPath}`,
            'new file mode 100644',
            '--- /dev/null',
            `+++ b/${targetPath}`,
            `@@ -0,0 +1,${lines.length} @@`,
          ];
          const diffBody = lines.map((l) => `+${l}`).join('\n');
          return {
            path: targetPath,
            diff: `${header.join('\n')}\n${diffBody}`,
          };
        }
      } catch {
        // 忽略
      }
    }

    return {
      path: targetPath,
      diff,
    };
  } catch (e) {
    return {
      path: targetPath,
      diff: `获取 Diff 失败: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * 暂存工作区文件（git add）
 */
export async function stageGitFiles(
  host: Host,
  workspace: string,
  paths?: string[],
): Promise<{ ok: boolean; error?: string }> {
  if (!workspace) return { ok: false, error: '未绑定工作区' };
  const target = paths && paths.length > 0 ? paths.map((p) => `"${p}"`).join(' ') : '.';
  const res = await host.process.run(`git add ${target}`, { cwd: workspace, timeoutMs: 15000 });
  if (res.code !== 0) {
    return { ok: false, error: res.stderr || 'git add 执行失败' };
  }
  return { ok: true };
}

/**
 * 放弃工作区文件修改（已跟踪走 checkout / restore，未跟踪走 clean）
 */
export async function discardGitChanges(
  host: Host,
  workspace: string,
  paths: string[],
): Promise<{ ok: boolean; error?: string }> {
  if (!workspace) return { ok: false, error: '未绑定工作区' };
  if (!paths || paths.length === 0) return { ok: true };

  for (const p of paths) {
    // 检查是否未跟踪文件
    const statusRes = await host.process.run(`git status --porcelain=v1 -- "${p}"`, {
      cwd: workspace,
      timeoutMs: 5000,
    });
    if (statusRes.stdout.startsWith('??')) {
      const cleanRes = await host.process.run(`git clean -f -- "${p}"`, {
        cwd: workspace,
        timeoutMs: 5000,
      });
      if (cleanRes.code !== 0) {
        return { ok: false, error: cleanRes.stderr || `清理未跟踪文件 ${p} 失败` };
      }
    } else {
      // 已跟踪文件：先从暂存区撤回，再检出还原
      await host.process.run(`git restore --staged -- "${p}"`, { cwd: workspace, timeoutMs: 5000 });
      const checkoutRes = await host.process.run(`git checkout -- "${p}"`, {
        cwd: workspace,
        timeoutMs: 5000,
      });
      if (checkoutRes.code !== 0) {
        return { ok: false, error: checkoutRes.stderr || `还原文件 ${p} 失败` };
      }
    }
  }

  return { ok: true };
}

/* -------------------- 只读免审批 Agent 工具注册 (TODOS #34) -------------------- */

/**
 * git_status 工具：模型可自主查询当前 Git 分支、变动文件及增删统计
 */
export const gitStatusTool: Tool = {
  spec: {
    name: 'git_status',
    description: '查看当前工作区 Git 仓库状态（分支名称、改动文件列表、暂存区/工作区状态与增删行数）。免审批只读工具。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  sensitive: false,
  requiresWorkspace: true,
  async execute(_input: unknown, ctx: ToolContext): Promise<string> {
    const status = await getGitStatus(ctx.host, ctx.workspace);
    if (!status.isGit) {
      return '当前工作区不是一个有效的 Git 仓库。';
    }
    if (status.clean) {
      return `当前分支: ${status.branch} (工作区干净，无任何改动)`;
    }
    const lines: string[] = [
      `分支: ${status.branch}${status.ahead > 0 ? ` (领先 ${status.ahead})` : ''}${status.behind > 0 ? ` (落后 ${status.behind})` : ''}`,
      `变动文件总计: ${status.totalChanges} 项 (新增 +${status.insertions} 行, 删除 -${status.deletions} 行)`,
      '',
      '文件明细:',
    ];
    for (const f of status.files) {
      const area = f.staged ? '[已暂存]' : '[未暂存]';
      const stats = f.insertions !== undefined ? ` (+${f.insertions} -${f.deletions})` : '';
      lines.push(`- ${f.status} ${area} ${f.path}${stats}`);
    }
    return lines.join('\n');
  },
};

/**
 * git_diff 工具：模型可自主查看指定文件或全局的 unified diff 代码差异
 */
export const gitDiffTool: Tool = {
  spec: {
    name: 'git_diff',
    description: '查看当前工作区代码改动的统一差异（unified diff）。支持指定单个文件或查看暂存区改动。免审批只读工具。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '可选：指定要查看差异的文件相对路径。不填则查看全局差异。',
        },
        staged: {
          type: 'boolean',
          description: '可选：是否查看暂存区差异（默认 false）。',
        },
      },
    },
  },
  sensitive: false,
  requiresWorkspace: true,
  async execute(input: unknown, ctx: ToolContext): Promise<string> {
    const raw = (input && typeof input === 'object' ? input : {}) as { path?: string; staged?: boolean };
    const res = await getGitDiff(ctx.host, ctx.workspace, raw);
    if (!res.diff.trim()) {
      return raw.path
        ? `文件 ${raw.path} 在 ${raw.staged ? '暂存区' : '工作区'} 无差异。`
        : `当前工作区在 ${raw.staged ? '暂存区' : '工作区'} 无任何代码改动。`;
    }
    // 保护输出过长
    if (res.diff.length > 50000) {
      return res.diff.slice(0, 50000) + '\n\n...[其余差异已截断]...';
    }
    return res.diff;
  },
};
