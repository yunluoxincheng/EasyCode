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

  async request(toolName: string, input: unknown): Promise<boolean> {
    if (this.mode === 'yolo') return true;
    const requestId = `ap_${Date.now().toString(36)}_${this.seq++}`;
    this.emitEvent({ type: 'approval_request', requestId, toolName, input });
    return new Promise<boolean>((resolve) => {
      this.pending.set(requestId, resolve);
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
