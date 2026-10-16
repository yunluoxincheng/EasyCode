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
  /** 回合修改对比 Diff（beforeContent -> afterContent） */
  diff: DiffLine[];
}

/** 呼出 <TurnUndoModal> 时的完整预览与冲突分析数据 */
export interface TurnUndoPreview {
  turnId: string;
  sessionId: string;
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

function toSummary(rec: TurnCheckpointRecord): TurnCheckpointSummary {
  return {
    turnId: rec.turnId,
    sessionId: rec.sessionId,
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

  private async loadSessionRecords(sessionId: string): Promise<TurnCheckpointRecord[]> {
    const cached = this.cache.get(sessionId);
    if (cached) return cached;
    try {
      const raw = await this.host.fs.readFile(this.sessionCheckpointFile(sessionId));
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? (parsed as TurnCheckpointRecord[]) : [];
      this.cache.set(sessionId, list);
      return list;
    } catch {
      const empty: TurnCheckpointRecord[] = [];
      this.cache.set(sessionId, empty);
      return empty;
    }
  }

  private async persistSessionRecords(sessionId: string): Promise<void> {
    const prev = this.writeQueues.get(sessionId) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(async () => {
        const list = this.cache.get(sessionId) ?? [];
        await this.host.fs.mkdir(this.checkpointsDir(), { recursive: true });
        await this.host.fs.writeFile(
          this.sessionCheckpointFile(sessionId),
          JSON.stringify(list, null, 2),
        );
      });
    this.writeQueues.set(sessionId, next);
    await next;
  }

  /** 检查单个快照文件在当前磁盘上的状态（是否已恢复、是否与本回合结束快照偏离） */
  private async inspectFileDiskState(
    workspaceRoot: string,
    file: TurnFileSnapshot,
  ): Promise<{
    currentExists: boolean;
    currentContent: string | null;
    alreadyReverted: boolean;
    diskDiverged: boolean;
  }> {
    let currentExists = false;
    let currentContent: string | null = null;
    try {
      const abs = resolveWorkspacePath(workspaceRoot, file.path, this.host);
      const stat = await this.host.fs.stat(abs);
      if (stat && !stat.isDirectory) {
        currentExists = true;
        currentContent = await this.host.fs.readFile(abs);
      }
    } catch {
      currentExists = false;
      currentContent = null;
    }

    const alreadyReverted = !file.existedBefore
      ? !currentExists
      : currentExists && currentContent === file.beforeContent;

    const diskDiverged =
      !alreadyReverted && (!currentExists || currentContent !== file.afterContent);

    return {
      currentExists,
      currentContent,
      alreadyReverted,
      diskDiverged,
    };
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
          return;
        }

        const records = await this.loadSessionRecords(ctx.sessionId);
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
          // 控制单会话快照数量上限
          while (records.length > MAX_CHECKPOINTS_PER_SESSION) {
            records.shift();
          }
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
        }

        await this.persistSessionRecords(ctx.sessionId);
      },
    };
  }

  /** 列出会话内所有包含代码改动的回合快照摘要 */
  async listCheckpoints(sessionId: string): Promise<TurnCheckpointSummary[]> {
    const records = await this.loadSessionRecords(sessionId);
    return records.filter((r) => r.files.length > 0).map(toSummary);
  }

  /**
   * 当用户编辑最后一条提问并截断后续历史时，清理被截断回合残留的旧快照（P2 #6）
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
   * 生成回合撤销预览与冲突检测报告（供 <TurnUndoModal> 展示）
   */
  async previewUndo(sessionId: string, turnId?: string): Promise<TurnUndoPreview> {
    const records = await this.loadSessionRecords(sessionId);
    const { record, index } = this.resolveTargetRecord(records, turnId);
    const valid = records.filter((r) => r.files.length > 0);
    const laterRecords = valid.slice(index + 1).filter((r) => !r.revertedAt);

    const filePreviews: TurnUndoFilePreview[] = [];
    for (const file of record.files) {
      const key = this.pathKey(file.path);
      const laterTurnNumbers = laterRecords
        .filter((r) => r.files.some((f) => this.pathKey(f.path) === key))
        .map((r) => r.turnNumber);
      const modifiedInLaterTurns = laterTurnNumbers.length > 0;

      const { alreadyReverted, diskDiverged } = await this.inspectFileDiskState(
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
        diff,
      });
    }

    const hasConflicts = filePreviews.some((f) => f.modifiedInLaterTurns || f.diskDiverged);
    return {
      turnId: record.turnId,
      sessionId: record.sessionId,
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
   * 1. 执行前进行 CAS 乐观并发校验（若目标文件磁盘内容已偏离 afterContent 且未传 force=true，拒绝覆盖）；
   * 2. 新建文件通过 unlink 删除并经 stat 后置探活验证，删除失败如实抛错（绝不吞错谎报成功）；
   * 3. 逐文件记录 revertedAt，并基于整回合所有文件的实际恢复状态更新 record.revertedAt。
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

    // P1 #3：执行前 CAS 乐观并发校验——防止打开预览弹窗后用户在外部编辑器修改了文件却被静默覆盖
    if (!opts.force) {
      const divergedPaths: string[] = [];
      for (const file of targetFiles) {
        const { diskDiverged } = await this.inspectFileDiskState(record.workspaceRoot, file);
        if (diskDiverged) {
          divergedPaths.push(file.path);
        }
      }
      if (divergedPaths.length > 0) {
        throw new Error(
          `[CONFLICT] 检测到文件在回退前已被修改（${divergedPaths.join(', ')}），为防止覆盖最新改动已中止。请刷新预览并确认强制覆盖后再试。`,
        );
      }
    }

    const now = new Date().toISOString();
    const revertedPaths: string[] = [];
    for (const file of targetFiles) {
      const abs = resolveWorkspacePath(record.workspaceRoot, file.path, this.host);
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
        const dir = this.host.paths.dirname(abs);
        if (dir && dir !== abs) {
          await this.host.fs.mkdir(dir, { recursive: true });
        }
        await this.host.fs.writeFile(abs, file.beforeContent ?? '');
      }
      file.revertedAt = now;
      revertedPaths.push(file.path);
    }

    // P2 #4：检查该回合全部文件是否均已处于恢复状态（支持分多次部分回退后正确标记整回合完成）
    let allFilesReverted = true;
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

    await this.persistSessionRecords(sessionId);
    return { record, revertedPaths };
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
