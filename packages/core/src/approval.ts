import type { AgentEvent } from './events.js';
import type { ApprovalMode } from './types.js';

/**
 * 审批管理器：ask 模式下对敏感工具发出 approval_request 并挂起等待用户；
 * yolo 模式直接放行。中止时对未决请求一律拒绝。
 */
export class ApprovalManager {
  private pending = new Map<string, (approved: boolean) => void>();
  private seq = 0;

  constructor(
    private readonly emitEvent: (event: AgentEvent) => void,
    private mode: ApprovalMode,
  ) {}

  get modeValue(): ApprovalMode {
    return this.mode;
  }

  setMode(mode: ApprovalMode): void {
    this.mode = mode;
  }

  /** 返回 pending 数量，供 UI/服务端判断会话是否卡在审批 */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * 请求用户批准。
   * `force: true` 时即使在 yolo 模式下也强制弹窗（权限规则 ask，TODOS #47）；
   * `reason` 为触发原因说明（如命中的权限规则），供审批卡片展示。
   */
  async request(
    toolName: string,
    input: unknown,
    options?: { force?: boolean; reason?: string },
  ): Promise<boolean> {
    if (this.mode === 'yolo' && !options?.force) return true;
    const requestId = `ap_${Date.now().toString(36)}_${this.seq++}`;
    return new Promise<boolean>((resolve) => {
      // 必须先登记 resolver 再派发事件：同进程宿主（CLI / 演示模式 / 单测）会在事件回调里
      // 同步调用 resolve()，若事件先发，应答会因为 pending 中尚无该 requestId 被静默丢弃，
      // 审批 promise 将永久挂起（对外表现为「任务跑到审批就不动了、不会自动停止」）。
      this.pending.set(requestId, resolve);
      try {
        this.emitEvent({
          type: 'approval_request',
          requestId,
          toolName,
          input,
          ...(options?.reason ? { reason: options.reason } : {}),
        });
      } catch {
        // 订阅者抛错同样不能让审批悬挂（否则整个回合会静默卡死）：
        // 清理未决态并保守按拒绝收尾；异常本身不向执行链抛出，避免把宿主派发故障
        // 升级成工具执行异常。
        this.pending.delete(requestId);
        resolve(false);
      }
    });
  }

  /** 用户答复；若请求不存在（已被中止）则忽略 */
  resolve(requestId: string, approved: boolean): void {
    const resolver = this.pending.get(requestId);
    if (!resolver) return;
    this.pending.delete(requestId);
    resolver(approved);
    this.emitEvent({ type: 'approval_resolved', requestId, approved });
  }

  /** 中止：拒绝所有未决请求 */
  denyAll(): void {
    for (const [requestId, resolver] of [...this.pending]) {
      this.pending.delete(requestId);
      resolver(false);
      this.emitEvent({ type: 'approval_resolved', requestId, approved: false });
    }
  }
}
