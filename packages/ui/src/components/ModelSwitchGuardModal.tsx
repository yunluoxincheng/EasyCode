import { useStore } from '../useStore.js';
import { fmtCtx } from '../format.js';

function fmtTk(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(1)}万` : n.toLocaleString();
}

/** 模型热切换容量超限预警与继承策略弹窗（TODOS #30） */
export function ModelSwitchGuardModal() {
  const store = useStore();
  const pending = store.pendingModelSwitch;
  if (!pending) return null;

  const ratio = Math.round((pending.currentTokens / pending.targetWindow) * 100);
  const isSevere = ratio >= 100;

  const onCancel = (): void => {
    store.closeModelSwitchGuard();
  };

  const onFork = (): void => {
    void store.forkSessionAndSwitch(pending).catch((err) => {
      store.showToast(err instanceof Error ? err.message : String(err), 'err');
    });
  };

  const onTrim = (): void => {
    void store.trimSessionAndSwitch(pending).catch((err) => {
      store.showToast(err instanceof Error ? err.message : String(err), 'err');
    });
  };

  const onDirect = (): void => {
    store.closeModelSwitchGuard();
    void store
      .setSessionProvider(pending.sessionId, pending.providerId, pending.model)
      .then(() => {
        store.showToast(`已直接切换至 ${pending.model || '默认'}`);
      })
      .catch((err) => {
        store.showToast(err instanceof Error ? err.message : String(err), 'err');
      });
  };

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal switch-guard-modal">
        <header>
          <h2 className="warning-h2">模型切换容量安全预警</h2>
          <button className="icon-btn" onClick={onCancel} aria-label="关闭">✕</button>
        </header>

        <div className="settings-body guard-body">
          <div className="guard-desc">
            检测到当前会话积累的上下文已超过目标模型的推荐安全阈值（80%）：
          </div>

          <div className="guard-stat-box">
            <div className="stat-row">
              <span className="stat-k">目标模型：</span>
              <span className="stat-v highlight">{pending.providerLabel} · {pending.model || '默认'}</span>
              <span className="stat-meta">(容量上限: {fmtCtx(pending.targetWindow)})</span>
            </div>
            <div className="stat-row">
              <span className="stat-k">当前上下文用量：</span>
              <span className="stat-v warn">约 {fmtTk(pending.currentTokens)} Tokens</span>
              <span className="stat-meta">(占用率: <strong className={isSevere ? 'danger-txt' : 'warn-txt'}>{ratio}%</strong>)</span>
            </div>

            <div className="guard-progress-bar">
              <div
                className={`guard-progress-fill ${isSevere ? 'fill-danger' : 'fill-warn'}`}
                style={{ width: `${Math.min(100, ratio)}%` }}
              />
            </div>
          </div>

          <p className="guard-warn-note">
            若直接携带全量上下文切换，后续交互极易遭遇服务商 <strong>HTTP 400 (Context Length Exceeded)</strong> 异常报错中断。请选择处理策略：
          </p>

          <div className="guard-strategies">
            <div className="strategy-card recommended" onClick={onFork}>
              <div className="strategy-head">
                <span className="strategy-icon">⑂</span>
                <span className="strategy-title">分叉为新分支并精简历史</span>
                <span className="rec-badge">推荐</span>
              </div>
              <div className="strategy-desc">
                原会话完整保留原配置与全量历史；自动克隆新分支会话，继承工作区与最新任务清单，精简早期历史并切换至目标模型。
              </div>
            </div>

            <div className="strategy-card" onClick={onTrim}>
              <div className="strategy-head">
                <span className="strategy-icon">✄</span>
                <span className="strategy-title">在当前会话裁剪早期历史</span>
              </div>
              <div className="strategy-desc">
                保留当前会话，由引擎将过往旧轮次归档，仅保留最近关键交互与最新待办清单，腾出充足空间后切换。
              </div>
            </div>

            <div className="strategy-card muted" onClick={onDirect}>
              <div className="strategy-head">
                <span className="strategy-icon">⚠</span>
                <span className="strategy-title">忽略风险，直接切换</span>
              </div>
              <div className="strategy-desc">
                保留所有历史直接切换。仅建议后续提问极短或你确信不会超限时使用。
              </div>
            </div>
          </div>
        </div>

        <footer>
          <button className="btn ghost" onClick={onCancel}>取消切换</button>
        </footer>
      </div>
    </div>
  );
}
