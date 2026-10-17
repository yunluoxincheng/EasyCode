import { useEffect, useState } from 'react';
import type { TurnUndoFilePreview, TurnUndoPreview } from '@easycode/engine';
import { useStore } from '../useStore.js';

export function TurnUndoModal() {
  const store = useStore();
  const targetTurnId = store.turnUndoModalTurnId;
  const sessionId = store.activeId;

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<TurnUndoPreview | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [checkedPaths, setCheckedPaths] = useState<Set<string>>(new Set());
  /** 当勾选文件中存在后续修改或磁盘偏离冲突时，需用户显式勾选确认强制覆盖（P1 #3） */
  const [forceConfirmed, setForceConfirmed] = useState(false);

  const loadPreview = (keepSelection = false) => {
    if (!sessionId || !targetTurnId || !store.client.previewTurnUndo) return () => {};
    let cancelled = false;
    setLoading(true);
    setError(null);
    setForceConfirmed(false);
    store.client
      .previewTurnUndo(sessionId, targetTurnId)
      .then((res) => {
        if (cancelled) return;
        setPreview(res);
        setSelectedPath((prev) => (keepSelection && prev ? prev : (res.files[0]?.path ?? null)));
        if (!keepSelection) {
          const initialChecked = new Set(
            res.files.filter((f) => !f.alreadyReverted).map((f) => f.path),
          );
          if (initialChecked.size === 0) {
            for (const f of res.files) initialChecked.add(f.path);
          }
          setCheckedPaths(initialChecked);
        }
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  };

  useEffect(() => {
    return loadPreview(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, targetTurnId, store.client]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) {
        e.preventDefault();
        store.closeTurnUndoModal();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [submitting, store]);

  if (!targetTurnId) return null;

  const toggleCheck = (path: string) => {
    setCheckedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const toggleAll = () => {
    if (!preview) return;
    if (checkedPaths.size === preview.files.length) {
      setCheckedPaths(new Set());
    } else {
      setCheckedPaths(new Set(preview.files.map((f) => f.path)));
    }
  };

  const selectedHasConflicts = Boolean(
    preview?.files.some(
      (f) => checkedPaths.has(f.path) && (f.modifiedInLaterTurns || f.diskDiverged),
    ),
  );

  const handleConfirm = async () => {
    if (!preview || checkedPaths.size === 0 || submitting) return;
    if (selectedHasConflicts && !forceConfirmed) return;
    const expectedFingerprints: Record<string, string> = {};
    for (const f of preview.files) {
      if (checkedPaths.has(f.path)) {
        expectedFingerprints[f.path] = f.diskFingerprint;
      }
    }
    setSubmitting(true);
    try {
      const res = await store.executeTurnUndo(preview.turnId, {
        paths: [...checkedPaths],
        force: selectedHasConflicts && forceConfirmed,
        expectedFingerprints,
      });
      // P1 #3：若打开弹窗期间文件被外部编辑器改动，Engine CAS 校验拦截返回 conflict，
      // 自动重新拉取最新冲突状态并要求用户二次确认强制覆盖
      if (!res.ok && res.conflict) {
        loadPreview(true);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const activeFile: TurnUndoFilePreview | undefined =
    preview?.files.find((f) => f.path === selectedPath) ?? preview?.files[0];

  const totalInsertions = preview?.files.reduce((sum, f) => sum + f.insertions, 0) ?? 0;
  const totalDeletions = preview?.files.reduce((sum, f) => sum + f.deletions, 0) ?? 0;

  let oldNo = 1;
  let newNo = 1;

  return (
    <div
      className="modal-backdrop turn-undo-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !submitting) {
          store.closeTurnUndoModal();
        }
      }}
    >
      <div className="turn-undo-modal" role="dialog" aria-modal="true" aria-label="撤销回合代码改动">
        <div className="turn-undo-head">
          <div className="turn-undo-title-wrap">
            <span className="turn-undo-badge">[ UNDO // 快照回退 ]</span>
            <span className="turn-undo-title">
              {preview ? `撤销第 ${preview.turnNumber} 回合代码改动` : '加载回合快照...'}
            </span>
            {preview && (
              <span className="turn-undo-stats">
                共 {preview.files.length} 个文件
                {totalInsertions > 0 && <span className="stat-add"> +{totalInsertions}</span>}
                {totalDeletions > 0 && <span className="stat-del"> -{totalDeletions}</span>}
              </span>
            )}
          </div>
          <button
            className="icon-btn"
            title="关闭 (Esc)"
            disabled={submitting}
            onClick={() => store.closeTurnUndoModal()}
          >
            ✕
          </button>
        </div>

        {(preview?.hasConflicts || selectedHasConflicts) && (
          <div className="turn-undo-warn-banner">
            <div className="turn-undo-warn-row">
              <span className="warn-tag">[ WARN · 冲突告警 ]</span>
              <span>
                部分文件在第 {preview?.turnNumber} 回合之后又被后续回合或外部编辑器修改过。执行回退将把所勾选文件直接恢复至第{' '}
                {preview?.turnNumber} 回合开始前的原始快照，请先核对右侧变更明细。
              </span>
            </div>
            {selectedHasConflicts && (
              <label className="turn-undo-force-confirm">
                <input
                  type="checkbox"
                  checked={forceConfirmed}
                  onChange={(e) => setForceConfirmed(e.target.checked)}
                />
                <span>我已知晓冲突风险，确认强制覆盖已勾选文件的后续修改</span>
              </label>
            )}
          </div>
        )}

        {loading ? (
          <div className="turn-undo-empty">[ WAIT ] 正在读取回合 Pre-edit 快照与冲突状态...</div>
        ) : error ? (
          <div className="turn-undo-empty err">[ ERR ] {error}</div>
        ) : !preview || preview.files.length === 0 ? (
          <div className="turn-undo-empty">该回合没有可回退的文件快照</div>
        ) : (
          <div className="turn-undo-body">
            <aside className="turn-undo-sidebar">
              <div className="turn-undo-sidebar-head">
                <span>
                  影响文件 ({checkedPaths.size}/{preview.files.length})
                </span>
                <button className="link-btn" type="button" onClick={toggleAll}>
                  {checkedPaths.size === preview.files.length ? '取消全选' : '全选'}
                </button>
              </div>
              <div className="turn-undo-file-list">
                {preview.files.map((file) => {
                  const checked = checkedPaths.has(file.path);
                  const isSelected = activeFile?.path === file.path;
                  return (
                    <div
                      key={file.path}
                      className={`turn-undo-file-row ${isSelected ? 'active' : ''}`}
                      onClick={() => setSelectedPath(file.path)}
                    >
                      <input
                        type="checkbox"
                        className="turn-undo-checkbox"
                        checked={checked}
                        onChange={() => toggleCheck(file.path)}
                        onClick={(e) => e.stopPropagation()}
                      />
                      <span className={`turn-undo-op-tag ${file.existedBefore ? 'mod' : 'new'}`}>
                        {file.existedBefore ? 'MOD' : 'NEW'}
                      </span>
                      <div className="turn-undo-file-main">
                        <div className="turn-undo-file-path" title={file.path}>
                          {file.path}
                        </div>
                        <div className="turn-undo-file-meta">
                          {file.insertions > 0 && <span className="stat-add">+{file.insertions}</span>}
                          {file.deletions > 0 && <span className="stat-del">-{file.deletions}</span>}
                          {file.alreadyReverted && (
                            <span className="turn-undo-flag reverted">[已恢复]</span>
                          )}
                          {file.modifiedInLaterTurns && (
                            <span
                              className="turn-undo-flag conflict"
                              title={`在第 ${file.laterTurnNumbers.join(', ')} 回合中又被修改过`}
                            >
                              [第 {file.laterTurnNumbers.join(',')} 回合再改]
                            </span>
                          )}
                          {!file.modifiedInLaterTurns && file.diskDiverged && (
                            <span
                              className="turn-undo-flag conflict"
                              title="当前磁盘文件内容与本回合结束快照不一致"
                            >
                              [磁盘已变更]
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </aside>

            <section className="turn-undo-diff-pane">
              {activeFile ? (
                <>
                  <div className="turn-undo-diff-head">
                    <span className="turn-undo-diff-path">{activeFile.path}</span>
                    <span className="turn-undo-action-hint">
                      {activeFile.existedBefore
                        ? `↶ 回退动作：恢复至第 ${preview.turnNumber} 回合修改前快照`
                        : '↶ 回退动作：删除本回合新建的文件'}
                    </span>
                  </div>
                  <div className="turn-undo-diff-scroll">
                    <div className="diff-lines">
                      {activeFile.diff.map((d, idx) => {
                        let oLine = '';
                        let nLine = '';
                        if (d.type === 'same') {
                          oLine = String(oldNo++);
                          nLine = String(newNo++);
                        } else if (d.type === 'del') {
                          oLine = String(oldNo++);
                        } else if (d.type === 'add') {
                          nLine = String(newNo++);
                        }
                        return (
                          <div key={idx} className={`diff-line ${d.type}`}>
                            <span className="diff-no old">{oLine}</span>
                            <span className="diff-no new">{nLine}</span>
                            <span className="diff-prefix">
                              {d.type === 'add' ? '+' : d.type === 'del' ? '-' : ' '}
                            </span>
                            <span className="diff-text">{d.text}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </>
              ) : null}
            </section>
          </div>
        )}

        <div className="turn-undo-foot">
          <span className="turn-undo-foot-hint">
            注：仅恢复本回合 write_file / edit_file 修改的勾选文件（不追踪终端命令 run_command 或外部改动）
          </span>
          <div className="turn-undo-foot-actions">
            <button
              className="btn ghost"
              type="button"
              disabled={submitting}
              onClick={() => store.closeTurnUndoModal()}
            >
              取消
            </button>
            <button
              className="btn danger"
              type="button"
              disabled={
                loading ||
                Boolean(error) ||
                checkedPaths.size === 0 ||
                submitting ||
                (selectedHasConflicts && !forceConfirmed)
              }
              onClick={() => void handleConfirm()}
            >
              {submitting
                ? '[ WAIT ] 正在恢复快照...'
                : selectedHasConflicts
                  ? `↶ 强制覆盖并撤销 (${checkedPaths.size})`
                  : `↶ 撤销此回合改动 (${checkedPaths.size})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
