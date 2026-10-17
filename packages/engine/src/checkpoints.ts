import {
  diffLines,
  resolveWorkspacePath,
  type DiffLine,
  type FileChangeEvent,
  type Host,
} from '@easycode/core';

/** 单文件快照体积上限（2MB），防止超大生成物撑爆快照存储 */
const MAX_SNAPSHOT_FILE_BYTES = 2 * 1024 * 1024;
/** 单会话最多保留的回合快照数量上限 */
const MAX_CHECKPOINTS_PER_SESSION = 30;
/** 单会话快照总正文容量上限（8MB），超出时按 FIFO 淘汰最早回合快照 */
const MAX_SESSION_CHECKPOINT_BYTES = 8 * 1024 * 1024;

/** 单个文件在某回合内的改动快照（以该回合首次触碰前的状态为基准，TODOS #36） */
export interface TurnFileSnapshot {
  /** 规范化后的工作区相对路径（统一正斜杠 /） */
  path: string;
  /** 该回合首次修改前，文件是否已存在 */
  existedBefore: boolean;
  /** 该回合首次修改前的完整原始内容；若 existedBefore=false 则为 null */
  beforeContent: string | null;
  /** 该回合结束时写入的最终内容 */
  afterContent: string;
  /** 相较于 beforeContent 的新增行数 */
  insertions: number;
  /** 相较于 beforeContent 的删除行数 */
  deletions: number;
  /** 该文件最近一次执行快照回退的时间 ISO */
  revertedAt?: string;
}

/** 单个回合的完整持久化快照记录（TODOS #36） */
export interface TurnCheckpointRecord {
  /** 回合快照唯一 ID */
  turnId: string;
  /** 所属会话 ID */
  sessionId: string;
  /** 该回合对应的工作区根目录 */
  workspaceRoot: string;
  /** 会话内的回合序号（1-based，第 N 回合） */
  turnNumber: number;
  /** 触发该回合的用户消息 ID */
  userMessageId: string;
  /** 该回合内产生文件写操作的 tool_call ID 列表（用于与 UI TurnItem 精确关联） */
  toolCallIds: string[];
  /** 创建时间 ISO */
  createdAt: string;
  /** 若整回合所有文件均已恢复至回合前状态，记录完成时间 ISO */
  revertedAt?: string;
  /** 该回合修改过的文件快照集合 */
  files: TurnFileSnapshot[];
}

/** 轻量级回合快照摘要（用于列表传输与 TurnView 头部展示，不含大体积文件正文） */
export interface TurnCheckpointSummary {
  turnId: string;
  sessionId: string;
  workspaceRoot: string;
  turnNumber: number;
  userMessageId: string;
  toolCallIds: string[];
  createdAt: string;
  revertedAt?: string;
  files: Array<{
    path: string;
    existedBefore: boolean;
    insertions: number;
    deletions: number;
    revertedAt?: string;
  }>;
}

/** 撤销预览中单个文件的状态与冲突检测结果 */
export interface TurnUndoFilePreview {
  path: string;
  existedBefore: boolean;
  insertions: number;
  deletions: number;
  /** 是否在后续回合（> turnNumber）中又被修改过 */
  modifiedInLaterTurns: boolean;
  /** 后续修改过该文件的回合序号列表 */
  laterTurnNumbers: number[];
  /** 当前磁盘内容是否与本回合结束时的 afterContent 不一致（可能被后续回合或外部编辑器修改） */
  diskDiverged: boolean;
  /** 当前磁盘状态是否已经与回退目标（beforeContent / 不存在）一致 */
  alreadyReverted: boolean;
  /** 预览生成时刻该文件的磁盘内容指纹（供执行回退时做 CAS 乐观并发比对，P1 #3） */
  diskFingerprint: string;
  /** 回合修改对比 Diff（beforeContent -> afterContent） */
  diff: DiffLine[];
}

/** 呼出 <TurnUndoModal> 时的完整预览与冲突分析数据 */
export interface TurnUndoPreview {
  turnId: string;
  sessionId: string;
  workspaceRoot: string;
  turnNumber: number;
  userMessageId: string;
  createdAt: string;
  revertedAt?: string;
  hasConflicts: boolean;
  files: TurnUndoFilePreview[];
}

export interface RevertTurnOptions {
  /** 仅回退指定相对路径子集；不传或空数组表示回退该回合全部文件 */
  paths?: string[];
  /** 是否允许覆盖自本回合结束后已被修改（后续回合或外部编辑器修改）的文件（CAS 强制覆盖） */
  force?: boolean;
  /** 预览时刻捕获的各文件磁盘指纹（path -> diskFingerprint）；若执行时磁盘指纹偏离此预期，即使 force=true 亦拦截并要求重新确认 */
  expectedFingerprints?: Record<string, string>;
}

export interface BeginTurnContext {
  sessionId: string;
  workspaceRoot: string;
  turnNumber: number;
  userMessageId: string;
}

export interface TurnCheckpointTracker {
  readonly turnId: string;
  recordFileChange(change: FileChangeEvent): Promise<void>;
}

function countDiffStats(before: string, after: string): { insertions: number; deletions: number } {
  const lines = diffLines(before, after, 2000);
  let insertions = 0;
  let deletions = 0;
  for (const d of lines) {
    if (d.type === 'add') insertions++;
    else if (d.type === 'del') deletions++;
  }
  return { insertions, deletions };
}

/** 计算文本确定性指纹（FNV-1a 双通道 + 长度），用于 CAS 乐观并发校验 */
function computeContentFingerprint(exists: boolean, content: string | null, tag = ''): string {
  if (tag) return `tag:${tag}`;
  if (!exists || content === null) return 'absent';
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < content.length; i++) {
    const c = content.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c + (i & 0xff);
    h2 = Math.imul(h2, 0x811c9dc5) >>> 0;
  }
  return `present:${content.length}:${h1.toString(16)}:${h2.toString(16)}`;
}

function recordStorageBytes(rec: TurnCheckpointRecord): number {
  let bytes = 0;
  for (const f of rec.files) {
    bytes += (f.beforeContent?.length ?? 0) + f.afterContent.length;
  }
  return bytes;
}

function toSummary(rec: TurnCheckpointRecord): TurnCheckpointSummary {
  return {
    turnId: rec.turnId,
    sessionId: rec.sessionId,
    workspaceRoot: rec.workspaceRoot,
    turnNumber: rec.turnNumber,
    userMessageId: rec.userMessageId,
    toolCallIds: [...rec.toolCallIds],
    createdAt: rec.createdAt,
    revertedAt: rec.revertedAt,
    files: rec.files.map((f) => ({
      path: f.path,
      existedBefore: f.existedBefore,
      insertions: f.insertions,
      deletions: f.deletions,
      revertedAt: f.revertedAt,
    })),
  };
}

/**
 * 会话级回合代码改动快照管理器（TODOS #36）：
 * - 在 write_file / edit_file 修改文件时记录回合级 Pre-edit 原始快照；
 * - 同一回合内多次修改同一文件，始终以该回合首次触碰前的原始版本为基准；
 * - 存储在 ${dataDir}/checkpoints/${sessionId}.json，绝不污染用户项目工作区与 Git 状态；
 * - 支持冲突检测（后续回合二次修改 / 外部编辑器手动修改）、CAS 乐观并发校验与按回合/按文件安全回退。
 */
export class CheckpointManager {
  private cache = new Map<string, TurnCheckpointRecord[]>();
  private writeQueues = new Map<string, Promise<void>>();

  constructor(private readonly host: Host) {}

  private checkpointsDir(): string {
    return this.host.paths.join(this.host.env.dataDir(), 'checkpoints');
  }

  private sessionCheckpointFile(sessionId: string): string {
    return this.host.paths.join(this.checkpointsDir(), `${sessionId}.json`);
  }

  private normalizeRelPath(workspaceRoot: string, relPath: string, absPath: string): string {
    const root = this.host.paths.resolve(workspaceRoot);
    const abs = this.host.paths.resolve(absPath);
    if (abs.startsWith(root)) {
      const sliced = abs.slice(root.length).replace(/^[/\\]+/, '');
      if (sliced) return sliced.replace(/\\/g, '/');
    }
    return relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  }

  private pathKey(relPath: string): string {
    const clean = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
    return this.host.paths.sep === '\\' ? clean.toLowerCase() : clean;
  }

  private parseCheckpointJson(raw: string, label: string): TurnCheckpointRecord[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `会话快照文件已损坏，JSON 解析失败 (${label}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`会话快照文件已损坏，根节点不是数组 (${label})`);
    }
    return parsed as TurnCheckpointRecord[];
  }

  private async tryRecoverFromTmpFile(
    sessionId: string,
    tmpFile: string,
    targetFile: string,
  ): Promise<TurnCheckpointRecord[] | null> {
    let tmpStat: { isDirectory: boolean; size: number; mtimeMs: number } | null;
    try {
      tmpStat = await this.host.fs.stat(tmpFile);
    } catch (err) {
      throw new Error(
        `读取会话快照临时文件状态失败 (${sessionId}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!tmpStat || tmpStat.isDirectory) return null;
    let tmpRaw: string;
    try {
      tmpRaw = await this.host.fs.readFile(tmpFile);
    } catch (err) {
      throw new Error(
        `读取会话快照临时文件失败 (${sessionId}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const list = this.parseCheckpointJson(tmpRaw, `${sessionId}.tmp`);
    try {
      if (this.host.fs.rename) {
        await this.host.fs.rename(tmpFile, targetFile);
      } else {
        await this.host.fs.writeFile(targetFile, tmpRaw);
        await this.host.fs.unlink?.(tmpFile);
      }
    } catch {
      // 恢复晋升写回失败不阻断内存恢复结果
    }
    return list;
  }

  /**
   * 加载会话快照记录（P1 修复）：
   * 严格区分「文件不存在」「读取失败」「JSON 已损坏」：
   * - 仅当正式文件与 .tmp 临时文件均明确不存在（stat === null）时，才初始化为空数组；
   * - 若正式文件缺失或损坏但同目录存在完好的 .tmp 文件，自动从 .tmp 恢复并原子晋升；
   * - 若发生读取权限/I/O 错误或 JSON 损坏，直接向上抛错且绝不缓存空数组，防止覆盖或静默清空历史快照。
   */
  private async loadSessionRecords(sessionId: string): Promise<TurnCheckpointRecord[]> {
    const cached = this.cache.get(sessionId);
    if (cached) return cached;

    const targetFile = this.sessionCheckpointFile(sessionId);
    const tmpFile = `${targetFile}.tmp`;

    let targetStat: { isDirectory: boolean; size: number; mtimeMs: number } | null;
    try {
      targetStat = await this.host.fs.stat(targetFile);
    } catch (err) {
      throw new Error(
        `读取会话快照文件状态失败 (${sessionId}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (targetStat) {
      if (targetStat.isDirectory) {
        throw new Error(`会话快照路径异常：目标为目录 (${sessionId})`);
      }
      let raw: string;
      try {
        raw = await this.host.fs.readFile(targetFile);
      } catch (err) {
        throw new Error(
          `读取会话快照文件失败 (${sessionId}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      try {
        const list = this.parseCheckpointJson(raw, sessionId);
        this.cache.set(sessionId, list);
        return list;
      } catch (parseErr) {
        const recovered = await this.tryRecoverFromTmpFile(sessionId, tmpFile, targetFile);
        if (recovered) {
          this.cache.set(sessionId, recovered);
          return recovered;
        }
        throw parseErr;
      }
    }

    const recovered = await this.tryRecoverFromTmpFile(sessionId, tmpFile, targetFile);
    if (recovered) {
      this.cache.set(sessionId, recovered);
      return recovered;
    }

    const empty: TurnCheckpointRecord[] = [];
    this.cache.set(sessionId, empty);
    return empty;
  }

  private async persistSessionRecords(sessionId: string): Promise<void> {
    const prev = this.writeQueues.get(sessionId) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(async () => {
        const list = this.cache.get(sessionId) ?? [];
        const payload = JSON.stringify(list, null, 2);
        await this.host.fs.mkdir(this.checkpointsDir(), { recursive: true });
        const targetFile = this.sessionCheckpointFile(sessionId);
        const tmpFile = `${targetFile}.tmp`;
        // P1 修复：先完整写入同目录临时文件 .tmp，再通过宿主 rename 执行原子文件替换提交
        await this.host.fs.writeFile(tmpFile, payload);
        if (this.host.fs.rename) {
          await this.host.fs.rename(tmpFile, targetFile);
        } else {
          await this.host.fs.writeFile(targetFile, payload);
          try {
            await this.host.fs.unlink?.(tmpFile);
          } catch {
            // 忽略临时文件清理异常
          }
        }
      });
    this.writeQueues.set(sessionId, next);
    await next;
  }

  /**
   * 检查单个快照文件在当前磁盘上的状态（分离 stat 与 readFile，杜绝读取失败被误判为文件不存在/已回退）
   */
  private async inspectFileDiskState(
    workspaceRoot: string,
    file: TurnFileSnapshot,
  ): Promise<{
    currentExists: boolean;
    currentContent: string | null;
    alreadyReverted: boolean;
    diskDiverged: boolean;
    inaccessible: boolean;
    accessError?: string;
    diskFingerprint: string;
  }> {
    let abs: string;
    try {
      abs = resolveWorkspacePath(workspaceRoot, file.path, this.host);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        currentExists: false,
        currentContent: null,
        alreadyReverted: false,
        diskDiverged: true,
        inaccessible: true,
        accessError: msg,
        diskFingerprint: computeContentFingerprint(false, null, 'invalid_path'),
      };
    }

    let stat: { isDirectory: boolean; size: number; mtimeMs: number } | null = null;
    try {
      stat = await this.host.fs.stat(abs);
    } catch (err) {
      // P1 修复：stat 权限异常（EACCES/EPERM 等）绝不能映射为 null 当作文件不存在处理
      const msg = err instanceof Error ? err.message : String(err);
      return {
        currentExists: false,
        currentContent: null,
        alreadyReverted: false,
        diskDiverged: true,
        inaccessible: true,
        accessError: `无法访问文件状态 (stat): ${msg}`,
        diskFingerprint: computeContentFingerprint(false, null, `stat_error:${msg}`),
      };
    }

    if (!stat) {
      const alreadyReverted = !file.existedBefore;
      return {
        currentExists: false,
        currentContent: null,
        alreadyReverted,
        diskDiverged: !alreadyReverted,
        inaccessible: false,
        diskFingerprint: computeContentFingerprint(false, null),
      };
    }

    if (stat.isDirectory) {
      return {
        currentExists: false,
        currentContent: null,
        alreadyReverted: false,
        diskDiverged: true,
        inaccessible: true,
        accessError: '目标路径已变为目录',
        diskFingerprint: computeContentFingerprint(false, null, 'is_directory'),
      };
    }

    // 文件存在：读取其当前内容；若读取抛错（如权限拒绝），标记 inaccessible，严禁在回退或回滚中清空
    let currentContent: string;
    try {
      currentContent = await this.host.fs.readFile(abs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        currentExists: true,
        currentContent: null,
        alreadyReverted: false,
        diskDiverged: true,
        inaccessible: true,
        accessError: `文件内容不可读 (readFile): ${msg}`,
        diskFingerprint: computeContentFingerprint(true, null, `unreadable:${stat.size}:${stat.mtimeMs}`),
      };
    }

    const alreadyReverted = file.existedBefore && currentContent === file.beforeContent;
    const diskDiverged = !alreadyReverted && currentContent !== file.afterContent;
    return {
      currentExists: true,
      currentContent,
      alreadyReverted,
      diskDiverged,
      inaccessible: false,
      diskFingerprint: computeContentFingerprint(true, currentContent),
    };
  }

  /** 动态刷新单个回合记录的 revertedAt 状态（防止文件恢复后又被修改却永久停留于已回退态，P2 #4） */
  private async refreshRecordRevertedState(record: TurnCheckpointRecord): Promise<boolean> {
    if (record.files.length === 0) return false;
    let mutated = false;
    let allReverted = true;
    for (const f of record.files) {
      const { alreadyReverted } = await this.inspectFileDiskState(record.workspaceRoot, f);
      if (!alreadyReverted) {
        allReverted = false;
        if (f.revertedAt !== undefined) {
          f.revertedAt = undefined;
          mutated = true;
        }
      }
    }
    if (!allReverted && record.revertedAt !== undefined) {
      record.revertedAt = undefined;
      mutated = true;
    }
    return mutated;
  }

  private enforceStorageQuota(records: TurnCheckpointRecord[], activeRecord: TurnCheckpointRecord | null): void {
    while (records.length > MAX_CHECKPOINTS_PER_SESSION) {
      if (records[0] === activeRecord) break;
      records.shift();
    }
    let totalBytes = records.reduce((sum, r) => sum + recordStorageBytes(r), 0);
    while (totalBytes > MAX_SESSION_CHECKPOINT_BYTES && records.length > 1) {
      if (records[0] === activeRecord) break;
      const evicted = records.shift();
      if (evicted) totalBytes -= recordStorageBytes(evicted);
    }
  }

  /**
   * 分配会话内单调递增的回合序号（不受 /compact 上下文压缩减少消息数组长度的影响）
   */
  async allocateTurnNumber(
    sessionId: string,
    currentTurnSeq: number | undefined,
    fallbackCount: number,
  ): Promise<number> {
    let maxInRecords = 0;
    try {
      const records = await this.loadSessionRecords(sessionId);
      for (const r of records) {
        if (r.turnNumber > maxInRecords) maxInRecords = r.turnNumber;
      }
    } catch {
      // 快照文件损坏或不可读时不静默清空缓存，仅用 meta.turnSeq 推进序号；实际写文件时由 recordFileChange 严格阻断
    }
    const base = Math.max(currentTurnSeq ?? 0, maxInRecords);
    return Math.max(base + 1, fallbackCount);
  }

  /**
   * 开启一个回合的快照追踪器：仅当回合内实际发生文件写入时才落盘生成快照记录
   */
  beginTurn(ctx: BeginTurnContext): TurnCheckpointTracker {
    const turnId = `chk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    let record: TurnCheckpointRecord | null = null;

    return {
      turnId,
      recordFileChange: async (change: FileChangeEvent) => {
        if (!ctx.workspaceRoot) return;
        const beforeLen = change.beforeContent?.length ?? 0;
        const afterLen = change.afterContent.length;
        if (beforeLen > MAX_SNAPSHOT_FILE_BYTES || afterLen > MAX_SNAPSHOT_FILE_BYTES) {
          throw new Error(
            `文件体积超过回合快照上限 (${Math.round(MAX_SNAPSHOT_FILE_BYTES / 1024 / 1024)}MB)，拒绝执行未受快照保护的文件修改`,
          );
        }

        const records = await this.loadSessionRecords(ctx.sessionId);
        const prevRecordsSnapshot: TurnCheckpointRecord[] = JSON.parse(JSON.stringify(records));
        const hadRecordBefore = record !== null;
        const relPath = this.normalizeRelPath(ctx.workspaceRoot, change.relPath, change.absPath);
        const key = this.pathKey(relPath);

        if (!record) {
          // 首次触碰且内容完全未变则无需创建快照
          if (change.existedBefore && change.beforeContent === change.afterContent) {
            return;
          }
          record = {
            turnId,
            sessionId: ctx.sessionId,
            workspaceRoot: ctx.workspaceRoot,
            turnNumber: ctx.turnNumber,
            userMessageId: ctx.userMessageId,
            toolCallIds: [],
            createdAt: new Date().toISOString(),
            files: [],
          };
          records.push(record);
        }

        if (change.callId && !record.toolCallIds.includes(change.callId)) {
          record.toolCallIds.push(change.callId);
        }

        const existingIdx = record.files.findIndex((f) => this.pathKey(f.path) === key);
        if (existingIdx === -1) {
          if (change.existedBefore && change.beforeContent === change.afterContent) {
            return;
          }
          const stats = countDiffStats(
            change.existedBefore ? (change.beforeContent ?? '') : '',
            change.afterContent,
          );
          record.files.push({
            path: relPath,
            existedBefore: change.existedBefore,
            beforeContent: change.existedBefore ? (change.beforeContent ?? '') : null,
            afterContent: change.afterContent,
            insertions: stats.insertions,
            deletions: stats.deletions,
          });
        } else {
          // 同一回合内再次修改同一文件：严格保留回合首次修改前的 existedBefore 与 beforeContent
          const existing = record.files[existingIdx];
          if (existing.existedBefore && existing.beforeContent === change.afterContent) {
            // 回合内改回原样：移除净零变更项
            record.files.splice(existingIdx, 1);
          } else {
            const stats = countDiffStats(
              existing.existedBefore ? (existing.beforeContent ?? '') : '',
              change.afterContent,
            );
            existing.afterContent = change.afterContent;
            existing.insertions = stats.insertions;
            existing.deletions = stats.deletions;
            existing.revertedAt = undefined;
          }
        }

        if (record.files.length === 0) {
          const idx = records.indexOf(record);
          if (idx !== -1) records.splice(idx, 1);
          record = null;
        } else {
          this.enforceStorageQuota(records, record);
        }

        try {
          await this.persistSessionRecords(ctx.sessionId);
        } catch (persistErr) {
          // 落盘失败时回滚内存缓存与当前回合追踪器状态，杜绝内存态与磁盘态分裂
          this.cache.set(ctx.sessionId, prevRecordsSnapshot);
          record = hadRecordBefore
            ? (prevRecordsSnapshot.find((r) => r.turnId === turnId) ?? null)
            : null;
          throw persistErr;
        }
      },
    };
  }

  /** 列出会话内所有包含代码改动的回合快照摘要（动态核对已标记回退的记录是否仍处于恢复态，P2 #4） */
  async listCheckpoints(sessionId: string): Promise<TurnCheckpointSummary[]> {
    const records = await this.loadSessionRecords(sessionId);
    let anyMutated = false;
    for (const r of records) {
      if (r.revertedAt || r.files.some((f) => f.revertedAt)) {
        if (await this.refreshRecordRevertedState(r)) {
          anyMutated = true;
        }
      }
    }
    if (anyMutated) {
      await this.persistSessionRecords(sessionId);
    }
    return records.filter((r) => r.files.length > 0).map(toSummary);
  }

  /**
   * 按被截断的用户消息 ID 与工具调用 ID 精确清理残留快照（不受历史上下文压缩影响，P2 #6）
   */
  async pruneCheckpointsByIds(
    sessionId: string,
    removedUserMessageIds: string[],
    removedToolCallIds: string[],
  ): Promise<void> {
    const records = await this.loadSessionRecords(sessionId);
    const userSet = new Set(removedUserMessageIds);
    const callSet = new Set(removedToolCallIds);
    if (userSet.size === 0 && callSet.size === 0) return;
    const filtered = records.filter(
      (r) =>
        !userSet.has(r.userMessageId) &&
        !r.toolCallIds.some((cid) => callSet.has(cid)),
    );
    if (filtered.length !== records.length) {
      this.cache.set(sessionId, filtered);
      await this.persistSessionRecords(sessionId);
    }
  }

  /**
   * 当用户编辑最后一条提问并截断后续历史时，清理被截断回合残留的旧快照（兼容辅助方法）
   */
  async pruneCheckpointsFromTurn(
    sessionId: string,
    fromTurnNumber: number,
    removedUserMessageIds?: string[],
  ): Promise<void> {
    const records = await this.loadSessionRecords(sessionId);
    const removedSet = new Set(removedUserMessageIds ?? []);
    const filtered = records.filter(
      (r) => r.turnNumber < fromTurnNumber && !removedSet.has(r.userMessageId),
    );
    if (filtered.length !== records.length) {
      this.cache.set(sessionId, filtered);
      await this.persistSessionRecords(sessionId);
    }
  }

  /** 解析目标回合快照（turnId 缺省或为 'latest' 时默认取最近一个未撤销的改动回合） */
  private resolveTargetRecord(
    records: TurnCheckpointRecord[],
    turnId?: string,
  ): { record: TurnCheckpointRecord; index: number } {
    const valid = records.filter((r) => r.files.length > 0);
    if (valid.length === 0) {
      throw new Error('当前会话暂无可撤销的代码改动快照');
    }
    if (!turnId || turnId === 'latest') {
      for (let i = valid.length - 1; i >= 0; i--) {
        if (!valid[i].revertedAt) {
          return { record: valid[i], index: i };
        }
      }
      return { record: valid[valid.length - 1], index: valid.length - 1 };
    }
    const idx = valid.findIndex(
      (r) =>
        r.turnId === turnId ||
        r.userMessageId === turnId ||
        r.toolCallIds.includes(turnId),
    );
    if (idx === -1) {
      throw new Error(`未找到对应的回合改动快照: ${turnId}`);
    }
    return { record: valid[idx], index: idx };
  }

  /** 获取目标回合快照记录（供上层在加工作区锁前先行解析快照绑定的 workspaceRoot，P1 #1） */
  async getTargetRecord(sessionId: string, turnId?: string): Promise<TurnCheckpointRecord> {
    const records = await this.loadSessionRecords(sessionId);
    return this.resolveTargetRecord(records, turnId).record;
  }

  /**
   * 生成回合撤销预览与冲突检测报告（供 <TurnUndoModal> 展示，附带各文件当前磁盘 CAS 指纹）
   */
  async previewUndo(sessionId: string, turnId?: string): Promise<TurnUndoPreview> {
    const records = await this.loadSessionRecords(sessionId);
    const { record, index } = this.resolveTargetRecord(records, turnId);
    await this.refreshRecordRevertedState(record);
    const valid = records.filter((r) => r.files.length > 0);
    const targetWsKey = this.pathKey(record.workspaceRoot);
    // 仅比较绑定在同一个工作区下的后续回合，避免会话切换工作区后因同名相对路径产生错误冲突告警
    const laterRecords = valid
      .slice(index + 1)
      .filter((r) => !r.revertedAt && this.pathKey(r.workspaceRoot) === targetWsKey);

    const filePreviews: TurnUndoFilePreview[] = [];
    for (const file of record.files) {
      const key = this.pathKey(file.path);
      const laterTurnNumbers = laterRecords
        .filter((r) => r.files.some((f) => this.pathKey(f.path) === key))
        .map((r) => r.turnNumber);
      const modifiedInLaterTurns = laterTurnNumbers.length > 0;

      const { alreadyReverted, diskDiverged, diskFingerprint } = await this.inspectFileDiskState(
        record.workspaceRoot,
        file,
      );

      const diff = diffLines(
        file.existedBefore ? (file.beforeContent ?? '') : '',
        file.afterContent,
        400,
      ).slice(0, 400);

      filePreviews.push({
        path: file.path,
        existedBefore: file.existedBefore,
        insertions: file.insertions,
        deletions: file.deletions,
        modifiedInLaterTurns,
        laterTurnNumbers,
        diskDiverged,
        alreadyReverted,
        diskFingerprint,
        diff,
      });
    }

    const hasConflicts = filePreviews.some((f) => f.modifiedInLaterTurns || f.diskDiverged);
    return {
      turnId: record.turnId,
      sessionId: record.sessionId,
      workspaceRoot: record.workspaceRoot,
      turnNumber: record.turnNumber,
      userMessageId: record.userMessageId,
      createdAt: record.createdAt,
      revertedAt: record.revertedAt,
      hasConflicts,
      files: filePreviews,
    };
  }

  /**
   * 执行回合代码改动撤销：
   * 1. 执行前进行双层 CAS 乐观并发校验：
   *    - 若传入 expectedFingerprints（预览时刻磁盘指纹），当前磁盘指纹与预期不符时无条件拦截（即使 force=true）；
   *    - 若当前磁盘偏离本回合结束快照 afterContent 且未传 force=true，拒绝覆盖；
   * 2. 新建文件通过 unlink 删除并经 stat 后置探活验证，删除失败如实抛错；
   * 3. 多文件回退中途发生异常时，逆序自动回滚已修改的前序文件；若回滚也失败则按真实磁盘状态持久化记录。
   */
  async revertTurn(
    sessionId: string,
    turnId?: string,
    optionsOrPaths?: RevertTurnOptions | string[],
  ): Promise<{ record: TurnCheckpointRecord; revertedPaths: string[] }> {
    const opts: RevertTurnOptions = Array.isArray(optionsOrPaths)
      ? { paths: optionsOrPaths }
      : (optionsOrPaths ?? {});

    const records = await this.loadSessionRecords(sessionId);
    const { record } = this.resolveTargetRecord(records, turnId);
    if (!record.workspaceRoot) {
      throw new Error('该快照未关联有效工作区路径');
    }

    const filterKeys =
      opts.paths && opts.paths.length > 0
        ? new Set(opts.paths.map((p) => this.pathKey(p)))
        : null;
    const targetFiles = filterKeys
      ? record.files.filter((f) => filterKeys.has(this.pathKey(f.path)))
      : record.files;

    if (targetFiles.length === 0) {
      throw new Error('未选择任何需要回退的文件');
    }

    // P1 修复：预检阶段无条件拦截不可访问（stat 权限错误）或不可读（currentExists && currentContent === null）的文件，
    // 即使传入 force: true 也绝不允许执行，杜绝将 null 伪造成空字符串清空用户原文件
    const inaccessibleDetails: string[] = [];
    const changedSincePreview: string[] = [];
    const divergedPaths: string[] = [];
    const preRevertStates = new Map<
      TurnFileSnapshot,
      { currentExists: boolean; currentContent: string | null }
    >();

    for (const file of targetFiles) {
      if (file.existedBefore && file.beforeContent === null) {
        inaccessibleDetails.push(`${file.path}（快照缺失原始基准内容）`);
        continue;
      }
      const state = await this.inspectFileDiskState(record.workspaceRoot, file);
      if (state.inaccessible || (state.currentExists && state.currentContent === null)) {
        inaccessibleDetails.push(`${file.path}（${state.accessError ?? '当前文件内容不可读'}）`);
        continue;
      }
      preRevertStates.set(file, {
        currentExists: state.currentExists,
        currentContent: state.currentContent,
      });
      const expectedFp = opts.expectedFingerprints?.[file.path];
      if (expectedFp !== undefined && state.diskFingerprint !== expectedFp) {
        changedSincePreview.push(file.path);
      } else if (state.diskDiverged && !opts.force) {
        divergedPaths.push(file.path);
      }
    }

    if (inaccessibleDetails.length > 0) {
      throw new Error(
        `回退已中止：无法安全访问或读取以下文件的当前状态，拒绝执行可能破坏数据的回退操作：${inaccessibleDetails.join('；')}`,
      );
    }
    if (changedSincePreview.length > 0) {
      throw new Error(
        `[CONFLICT] 检测到文件在打开预览后又被修改（${changedSincePreview.join(', ')}），已中止回退以防覆盖最新改动。请重新核对刷新后的预览并再次确认。`,
      );
    }
    if (divergedPaths.length > 0) {
      throw new Error(
        `[CONFLICT] 检测到文件在回退前已被修改（${divergedPaths.join(', ')}），为防止覆盖最新改动已中止。请刷新预览并确认强制覆盖后再试。`,
      );
    }

    const now = new Date().toISOString();
    const revertedPaths: string[] = [];
    type RevertBatchItem = {
      file: TurnFileSnapshot;
      abs: string;
      existedBeforeRevert: boolean;
      contentBeforeRevert: string | null;
    };
    const appliedFiles: RevertBatchItem[] = [];
    let inFlight: RevertBatchItem | null = null;

    try {
      for (const file of targetFiles) {
        const abs = resolveWorkspacePath(record.workspaceRoot, file.path, this.host);
        const pre = preRevertStates.get(file)!;
        inFlight = {
          file,
          abs,
          existedBeforeRevert: pre.currentExists,
          contentBeforeRevert: pre.currentContent,
        };
        if (!file.existedBefore) {
          // P1 #2：仅当文件确实不存在时才幂等跳过；unlink 缺失或删除后文件仍存在必须抛错
          const statBefore = await this.host.fs.stat(abs);
          if (statBefore) {
            if (statBefore.isDirectory) {
              throw new Error(`回退失败: 目标路径已变为目录，无法按文件删除 (${file.path})`);
            }
            if (!this.host.fs.unlink) {
              throw new Error(`当前宿主不支持文件删除 (unlink)，无法回退新建文件 (${file.path})`);
            }
            let unlinkErr: unknown;
            try {
              await this.host.fs.unlink(abs);
            } catch (err) {
              unlinkErr = err;
            }
            const statAfter = await this.host.fs.stat(abs);
            if (statAfter !== null) {
              throw new Error(
                `删除新建文件失败 (${file.path}): ${unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr ?? '目标文件仍存在')}`,
              );
            }
          }
        } else {
          if (file.beforeContent === null) {
            throw new Error(`回退失败: 快照缺少原始文件内容 (${file.path})`);
          }
          const dir = this.host.paths.dirname(abs);
          if (dir && dir !== abs) {
            await this.host.fs.mkdir(dir, { recursive: true });
          }
          await this.host.fs.writeFile(abs, file.beforeContent);
        }
        appliedFiles.push(inFlight);
        inFlight = null;
        file.revertedAt = now;
        revertedPaths.push(file.path);
      }
    } catch (batchErr) {
      const baseMsg = batchErr instanceof Error ? batchErr.message : String(batchErr);
      const rolledBackPaths: string[] = [];
      const stillRevertedPaths: string[] = [];
      const damagedPaths: string[] = [];
      const rollbackErrors: string[] = [];

      // P2 修复：若当前正在操作的文件（inFlight）在写入/删除中途抛错且磁盘内容已发生部分变动，
      // 必须一并纳入逆序恢复队列尝试还原回退前内容；若无法恢复则明确报告受损状态
      const rollbackQueue: RevertBatchItem[] = [...appliedFiles].reverse();
      if (inFlight) {
        const postFail = await this.inspectFileDiskState(record.workspaceRoot, inFlight.file);
        const unchanged =
          !postFail.inaccessible &&
          postFail.currentExists === inFlight.existedBeforeRevert &&
          (!inFlight.existedBeforeRevert || postFail.currentContent === inFlight.contentBeforeRevert);
        if (!unchanged) {
          rollbackQueue.unshift(inFlight);
        }
      }

      for (const item of rollbackQueue) {
        try {
          if (!item.existedBeforeRevert) {
            const st = await this.host.fs.stat(item.abs);
            if (st && !st.isDirectory) {
              if (!this.host.fs.unlink) {
                throw new Error('宿主不支持 unlink');
              }
              await this.host.fs.unlink(item.abs);
            }
          } else {
            if (item.contentBeforeRevert === null) {
              throw new Error(`缺少回退前原始内容 (${item.file.path})，拒绝写入空文件`);
            }
            const dir = this.host.paths.dirname(item.abs);
            if (dir && dir !== item.abs) {
              await this.host.fs.mkdir(dir, { recursive: true });
            }
            await this.host.fs.writeFile(item.abs, item.contentBeforeRevert);
          }
          item.file.revertedAt = undefined;
          rolledBackPaths.push(item.file.path);
        } catch (rbErr) {
          rollbackErrors.push(rbErr instanceof Error ? rbErr.message : String(rbErr));
          const checkAfterRb = await this.inspectFileDiskState(record.workspaceRoot, item.file);
          if (checkAfterRb.alreadyReverted) {
            item.file.revertedAt = now;
            stillRevertedPaths.push(item.file.path);
          } else {
            item.file.revertedAt = undefined;
            damagedPaths.push(item.file.path);
          }
        }
      }

      // 同步真实磁盘状态并落盘
      await this.syncAllFilesRevertedState(record, now);
      await this.persistSessionRecords(sessionId);

      if (damagedPaths.length > 0) {
        throw new Error(
          `${baseMsg}（警告：文件写入异常后自动恢复失败，以下文件可能处于部分写入或受损状态：${damagedPaths.join(', ')}${stillRevertedPaths.length > 0 ? `；注意：同批次部分文件已恢复并落盘记录：${stillRevertedPaths.join(', ')}` : ''}；原因：${rollbackErrors.join('; ')}）`,
        );
      }
      if (stillRevertedPaths.length > 0) {
        throw new Error(
          `${baseMsg}（注意：同批次部分文件已恢复并落盘记录：${stillRevertedPaths.join(', ')}；回滚失败：${rollbackErrors.join('; ')}）`,
        );
      }
      if (rolledBackPaths.length > 0) {
        throw new Error(`${baseMsg}（已自动回滚本批次前序修改的文件：${rolledBackPaths.join(', ')}）`);
      }
      throw batchErr;
    }

    await this.syncAllFilesRevertedState(record, now);
    await this.persistSessionRecords(sessionId);
    return { record, revertedPaths };
  }

  private async syncAllFilesRevertedState(record: TurnCheckpointRecord, now: string): Promise<void> {
    let allFilesReverted = record.files.length > 0;
    for (const f of record.files) {
      const { alreadyReverted } = await this.inspectFileDiskState(record.workspaceRoot, f);
      if (!alreadyReverted) {
        allFilesReverted = false;
        f.revertedAt = undefined;
      } else if (!f.revertedAt) {
        f.revertedAt = now;
      }
    }
    record.revertedAt = allFilesReverted ? now : undefined;
  }

  /** 删除会话时同步清理其快照文件 */
  async deleteSessionCheckpoints(sessionId: string): Promise<void> {
    this.cache.delete(sessionId);
    this.writeQueues.delete(sessionId);
    try {
      await this.host.fs.unlink?.(this.sessionCheckpointFile(sessionId));
    } catch {
      // 忽略不存在的文件
    }
  }
}
