/**
 * 基于 FIFO 队列与 AbortSignal 感知的轻量异步互斥锁。
 * 保障敏感工具（写文件、执行命令）互斥执行，先到先得，杜绝写入冲突。
 */
export class Mutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }

    return new Promise<() => void>((resolve, reject) => {
      const onAbort = () => {
        const idx = this.queue.indexOf(entry);
        if (idx !== -1) {
          this.queue.splice(idx, 1);
        }
        reject(new DOMException('Aborted', 'AbortError'));
      };

      const entry = () => {
        signal?.removeEventListener('abort', onAbort);
        this.locked = true;
        resolve(() => this.release());
      };

      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(entry);
    });
  }

  private release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else {
      this.locked = false;
    }
  }

  async withLock<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      return await fn();
    } finally {
      release();
    }
  }
}

function isWindowsPlatform(): boolean {
  if (typeof process !== 'undefined' && process?.platform) {
    return process.platform === 'win32';
  }
  if (typeof navigator !== 'undefined') {
    return /win/i.test(navigator.userAgent || navigator.platform || '');
  }
  return false;
}

/**
 * 工作区锁管理器：按标准化工作区根路径分槽管理 Mutex。
 * 同一工作区共享一把锁，不同工作区完全并发互不干扰。
 */
export class WorkspaceLockManager {
  private locks = new Map<string, Mutex>();
  /**
   * 物理路径别名映射（标准化词法路径 → 规范化真实路径）。
   *
   * `/tmp/project` 与指向它的 `/tmp/project-link` 是同一物理目录，但字符串不同。
   * 若不做别名归并，会话 A 绑真实路径、会话 B 绑别名路径就会拿到两把锁，
   * 工作区互斥形同虚设（PR #9 第五轮复审 P2）。
   * 由持有 Host 能力的调用方在绑定工作区时登记（见 AgentServer.resolveWorkspaceIdentity）。
   */
  private aliases = new Map<string, string>();

  /** 标准化工作区路径（消除末尾斜杠及 Windows 大小写差异） */
  normalize(dir: string): string {
    if (!dir) return '';
    let normalized = dir.replace(/[\\/]+$/, '').replace(/\\/g, '/');
    if (isWindowsPlatform()) {
      normalized = normalized.toLowerCase();
    }
    return normalized;
  }

  /** 登记「词法路径 ↔ 真实路径」的等价关系，使两者共享同一把锁 */
  registerAlias(lexical: string, real: string): void {
    const key = this.normalize(lexical);
    const canonical = this.normalize(real);
    if (!key || !canonical) return;
    this.aliases.set(key, canonical);
    // 真实路径自身也映射到自己，保证任意一侧查询都收敛到同一键
    this.aliases.set(canonical, canonical);
  }

  /** 解析锁键：优先使用已登记的真实路径，否则退回词法标准化 */
  lockKey(workspaceRoot: string): string {
    const normalized = this.normalize(workspaceRoot);
    if (!normalized) return '';
    return this.aliases.get(normalized) ?? normalized;
  }

  getLock(workspaceRoot: string): Mutex {
    const key = this.lockKey(workspaceRoot);
    let lock = this.locks.get(key);
    if (!lock) {
      lock = new Mutex();
      this.locks.set(key, lock);
    }
    return lock;
  }

  async withLock<T>(workspaceRoot: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!workspaceRoot) return fn();
    const lock = this.getLock(workspaceRoot);
    return lock.withLock(fn, signal);
  }
}
