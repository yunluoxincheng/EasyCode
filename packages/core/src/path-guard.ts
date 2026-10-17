/**
 * 真实路径守卫（TODOS #47 第三轮复审 P1）。
 *
 * 为什么需要独立一层：`paths.resolve()` 只做**词法**归一化，不识别文件系统里的符号链接。
 * 工作区中若存在
 * ```
 * workspace/private/key.txt          （规则 deny private/**）
 * workspace/public/key.txt -> ../private/key.txt
 * ```
 * 读取 `public/key.txt` 时词法路径是 `public/key.txt`，不会命中 `private/**` 规则，
 * 而实际读到的是 `private/key.txt` —— 针对路径的权限规则在别名路径上静默失效。
 * 指向工作区**外部**的 symlink 同样会绕过词法 containment 检查。
 *
 * 因此文件路径类工具在权限裁决与访问边界检查之前，必须取得**真实目标路径**：
 * - 目标已存在 → `host.fs.realpath()` 消解全部链接；
 * - 目标不存在（新建文件）→ 解析**最近存在的父目录**，再拼回剩余片段；
 * - 无法安全解析（宿主不支持、权限不足、循环链接）→ 保守拒绝，绝不当作无风险。
 *
 * 本模块只依赖 `Host` 接口，保持 core 可在浏览器沙箱中脱机运行。
 */

import type { Host } from './host.js';
import { resolveWorkspaceRelative, type PathApi } from './permissions.js';

/** 守卫结果：真实绝对路径 + 相对工作区路径（均已消解符号链接） */
export interface RealPathResolution {
  /** 真实绝对路径（消解 symlink 后） */
  realPath: string;
  /** 相对（真实）工作区根的路径，统一正斜杠，供权限 glob 匹配 */
  realRelative: string;
  /** 目标的最近存在祖先是否就是工作区根本身（用于区分「新建于根」与「新建于子目录」） */
  existedAtResolution: boolean;
}

export type RealPathOutcome =
  | { ok: true; value: RealPathResolution }
  /**
   * 拒绝原因：
   * - `escape` 真实目标越出工作区
   * - `dangling-symlink` 路径是悬空符号链接（无法确认最终落点）
   * - `unsupported` 宿主缺少必要能力
   * - `failed` 解析失败（权限不足、循环链接等）
   */
  | {
      ok: false;
      reason: 'escape' | 'dangling-symlink' | 'unsupported' | 'failed';
      message: string;
    };

/** 判断两个绝对路径的包含关系（Windows 大小写不敏感） */
function isInside(child: string, parent: string, paths: PathApi): boolean {
  const sep = paths.sep || '/';
  const caseInsensitive = sep === '\\';
  const c = caseInsensitive ? child.toLowerCase() : child;
  const p = caseInsensitive ? parent.toLowerCase() : parent;
  if (c === p) return true;
  return c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/** 词法拼接（不触碰文件系统） */
function joinLexical(paths: PathApi, base: string, segments: string[]): string {
  return paths.resolve(base, ...segments);
}

/**
 * 把工具传入的路径解析为「真实目标 + 真实相对路径」。
 *
 * `input` 为工具参数中的原始路径（可为相对或绝对）；`workspaceRoot` 为会话工作区。
 * 返回 `{ ok: false }` 时调用方必须拒绝执行，不得退化为「当作安全」。
 */
export async function resolveRealPathInWorkspace(
  host: Host,
  workspaceRoot: string,
  input: string,
  paths: PathApi,
): Promise<RealPathOutcome> {
  const root = typeof workspaceRoot === 'string' ? workspaceRoot.trim() : '';
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!root) {
    return { ok: false, reason: 'failed', message: '未绑定工作区，无法校验路径边界' };
  }
  if (!raw) {
    return { ok: false, reason: 'failed', message: '路径为空' };
  }

  // 宿主没有 realpath 能力时不能声称已校验——保守拒绝（文件类工具按路径保护是核心职责）
  const realpath = host.fs.realpath;
  if (typeof realpath !== 'function') {
    return {
      ok: false,
      reason: 'unsupported',
      message: '当前宿主不支持真实路径解析，无法校验符号链接边界，已保守拒绝',
    };
  }

  const lexicalRoot = paths.resolve(root);
  let realRoot: string;
  try {
    const resolvedRoot = await realpath(lexicalRoot);
    if (resolvedRoot) {
      realRoot = resolvedRoot;
    } else {
      // 极少数宿主（如内存文件系统）无法对「尚无子项的空目录」给出真实路径，
      // 但 stat 仍可确认它存在。此时退回词法根：这类宿主本身没有符号链接语义，
      // 不会削弱边界检查；真实文件系统上 realpath 对存在目录总是成功，不会走到这里。
      const st = await host.fs.stat(lexicalRoot);
      if (!st?.isDirectory) {
        return { ok: false, reason: 'failed', message: `工作区不存在或无法解析: ${root}` };
      }
      realRoot = lexicalRoot;
    }
  } catch (err) {
    return {
      ok: false,
      reason: 'failed',
      message: `工作区真实路径解析失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const lexicalTarget = paths.isAbsolute(raw) ? paths.resolve(raw) : paths.resolve(lexicalRoot, raw);

  // 已存在 → 直接消解；不存在（新建/待写）→ 回溯最近存在祖先再拼回剩余片段。
  // 后者的必要性：Agent 常写新文件，而新文件没有 realpath 可查，
  // 但它的父目录可能是指向工作区外的 symlink。
  const lstat = host.fs.lstat;
  const pending: string[] = [];
  let cursor = lexicalTarget;
  let existed = true;
  let realTarget: string | null = null;
  for (;;) {
    let resolved: string | null;
    try {
      resolved = await realpath(cursor);
    } catch (err) {
      return {
        ok: false,
        reason: 'failed',
        message: `路径真实解析失败（${raw}）: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (resolved) {
      realTarget = pending.length > 0 ? joinLexical(paths, resolved, pending) : resolved;
      break;
    }
    // realpath 返回 null 有两种含义：路径真的不存在，或它是**悬空符号链接**。
    // 后者绝不能被当作「待新建的普通文件」——否则 writeFile 会跟随该链接在
    // 工作区外创建文件（PR #9 第四轮复审 P1）。用 lstat 区分并保守拒绝。
    if (typeof lstat === 'function') {
      let linkInfo: Awaited<ReturnType<NonNullable<typeof lstat>>>;
      try {
        linkInfo = await lstat(cursor);
      } catch (err) {
        return {
          ok: false,
          reason: 'failed',
          message: `无法确认路径类型（${raw}）: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (linkInfo?.isSymbolicLink) {
        return {
          ok: false,
          reason: 'dangling-symlink',
          message:
            `路径是悬空符号链接（${raw} → 目标不存在），已拒绝：无法确认其最终落点是否在工作区内。` +
            '请改用普通路径，或先修复该链接。',
        };
      }
    } else if (pending.length === 0) {
      // 宿主既无 realpath 又无 lstat 时无法区分这两种情况，保守拒绝
      return {
        ok: false,
        reason: 'unsupported',
        message: '当前宿主无法区分「不存在」与「悬空符号链接」，已保守拒绝',
      };
    }
    existed = false;
    const parent = paths.dirname(cursor);
    // 已回溯到文件系统根仍不存在：无法确定边界，保守拒绝
    if (!parent || parent === cursor) {
      return {
        ok: false,
        reason: 'failed',
        message: `无法解析路径的真实目标: ${raw}`,
      };
    }
    pending.unshift(paths.basename(cursor));
    cursor = parent;
  }

  // 边界检查针对**真实**工作区根：既防 symlink 逃逸，也兼容工作区本身是链接的情况
  if (!isInside(realTarget, realRoot, paths)) {
    return {
      ok: false,
      reason: 'escape',
      message: `路径越界: ${raw} 的真实目标 ${realTarget} 不在工作区 ${realRoot} 内`,
    };
  }

  const realRelative = resolveWorkspaceRelative(realRoot, realTarget, paths);
  if (realRelative === null) {
    // 理论上不会发生（上面已做过包含性校验）；作为最后一道防线保守拒绝
    return {
      ok: false,
      reason: 'escape',
      message: `路径越界: 无法把 ${raw} 归一到工作区内`,
    };
  }

  return {
    ok: true,
    value: { realPath: realTarget, realRelative, existedAtResolution: existed },
  };
}
