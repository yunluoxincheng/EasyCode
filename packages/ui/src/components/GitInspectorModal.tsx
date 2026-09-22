import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useStore } from '../useStore.js';
import { splitUnifiedDiff, type GitStatusSummary, type GitFileChange } from '@easycode/engine';

interface GitInspectorModalProps {
  onClose: () => void;
}

interface ParsedDiffLine {
  type: 'hunk' | 'header' | 'add' | 'del' | 'same';
  text: string;
  oldNo?: number;
  newNo?: number;
}

const MAX_DIFF_LINES = 600;

function parseUnifiedDiff(rawDiff: string): ParsedDiffLine[] {
  const allLines = rawDiff.split(/\r?\n/);
  const total = allLines.length;
  const isTruncated = total > MAX_DIFF_LINES;
  const lines = isTruncated ? allLines.slice(0, MAX_DIFF_LINES) : allLines;
  const result: ParsedDiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('new file mode')) {
      result.push({ type: 'header', text: line });
      continue;
    }
    if (line.startsWith('@@')) {
      // 提取行号，形如 @@ -15,8 +15,12 @@
      const m = line.match(/@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
      if (m) {
        oldLine = parseInt(m[1], 10);
        newLine = parseInt(m[2], 10);
      }
      result.push({ type: 'hunk', text: line });
      continue;
    }
    if (line.startsWith('-')) {
      result.push({
        type: 'del',
        text: line.slice(1),
        oldNo: oldLine++,
      });
      continue;
    }
    if (line.startsWith('+')) {
      result.push({
        type: 'add',
        text: line.slice(1),
        newNo: newLine++,
      });
      continue;
    }
    // 普通上下文行或空行
    result.push({
      type: 'same',
      text: line.startsWith(' ') ? line.slice(1) : line,
      oldNo: oldLine++,
      newNo: newLine++,
    });
  }

  if (isTruncated) {
    result.push({
      type: 'hunk',
      text: `... 其余 ${total - MAX_DIFF_LINES} 行代码差异已省略（防止大文件渲染卡顿） ...`,
    });
  }

  return result;
}

export const GitInspectorModal: React.FC<GitInspectorModalProps> = ({ onClose }) => {
  const store = useStore();
  const session = store.activeSession;
  const [status, setStatus] = useState<GitStatusSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedFile, setSelectedFile] = useState<GitFileChange | null>(null);
  const [diffText, setDiffText] = useState<string>('');
  const [diffLoading, setDiffLoading] = useState<boolean>(false);
  const [filter, setFilter] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const diffCacheRef = useRef<Map<string, string>>(new Map());

  // 预热全量 Diff（单次执行批量切片，点击文件 0ms 瞬间显示）
  const warmUpFullDiff = useCallback(async () => {
    if (!session?.id) return;
    try {
      const [unstagedRes, stagedRes] = await Promise.all([
        store.client.getGitDiff(session.id, { staged: false }).catch(() => ({ diff: '' })),
        store.client.getGitDiff(session.id, { staged: true }).catch(() => ({ diff: '' })),
      ]);
      if (unstagedRes.diff) {
        const m = splitUnifiedDiff(unstagedRes.diff);
        for (const [p, d] of m.entries()) {
          diffCacheRef.current.set(`unstaged:${p}`, d);
        }
      }
      if (stagedRes.diff) {
        const m = splitUnifiedDiff(stagedRes.diff);
        for (const [p, d] of m.entries()) {
          diffCacheRef.current.set(`staged:${p}`, d);
        }
      }
    } catch {
      // 容错
    }
  }, [session?.id, store.client]);

  // 加载 Git 状态
  const loadStatus = useCallback(async () => {
    if (!session?.id) return;
    try {
      setLoading(true);
      diffCacheRef.current.clear();
      const res = await store.client.getGitStatus(session.id);
      setStatus(res);

      // 并发启动全量 Diff 预热
      void warmUpFullDiff();

      // 若当前无选中或选中文件已不存在，默认选中第一项
      if (res.files.length > 0) {
        setSelectedFile((prev) => {
          if (!prev) return res.files[0];
          const found = res.files.find((f) => f.path === prev.path && f.staged === prev.staged);
          return found || res.files[0];
        });
      } else {
        setSelectedFile(null);
      }
    } catch (e) {
      store.showToast(e instanceof Error ? e.message : '获取 Git 状态失败', 'err');
    } finally {
      setLoading(false);
    }
  }, [session?.id, store.client, warmUpFullDiff]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  // 加载选中文件的 Diff（优先命中内存预热切片，0ms 瞬开）
  useEffect(() => {
    if (!session?.id || !selectedFile) {
      setDiffText('');
      return;
    }
    const cacheKey = `${selectedFile.staged ? 'staged' : 'unstaged'}:${selectedFile.path}`;
    const cached = diffCacheRef.current.get(cacheKey);
    if (cached) {
      setDiffText(cached);
      setDiffLoading(false);
      return;
    }

    let cancelled = false;
    const fetchDiff = async () => {
      setDiffLoading(true);
      try {
        const res = await store.client.getGitDiff(session.id, {
          path: selectedFile.path,
          staged: selectedFile.staged,
          untracked: selectedFile.status === '?',
        });
        if (!cancelled) {
          diffCacheRef.current.set(cacheKey, res.diff);
          setDiffText(res.diff);
        }
      } catch {
        if (!cancelled) setDiffText('获取差异失败');
      } finally {
        if (!cancelled) setDiffLoading(false);
      }
    };
    fetchDiff();
    return () => {
      cancelled = true;
    };
  }, [session?.id, selectedFile, store.client]);

  // 按状态分组并过滤
  const { stagedFiles, unstagedFiles, untrackedFiles } = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const all = status?.files || [];
    const matched = q ? all.filter((f) => f.path.toLowerCase().includes(q)) : all;

    return {
      stagedFiles: matched.filter((f) => f.staged),
      unstagedFiles: matched.filter((f) => !f.staged && f.status !== '?'),
      untrackedFiles: matched.filter((f) => !f.staged && f.status === '?'),
    };
  }, [status?.files, filter]);

  // 解析当前 Diff
  const parsedDiff = useMemo(() => {
    if (!diffText.trim()) return [];
    return parseUnifiedDiff(diffText);
  }, [diffText]);

  // 复制 Diff 内容
  const handleCopyDiff = () => {
    if (!diffText) return;
    navigator.clipboard.writeText(diffText).then(() => {
      store.showToast('已复制代码差异 Patch');
    });
  };

  // 暂存全部 (git add .)
  const handleStageAll = async () => {
    if (!session?.id) return;
    try {
      setActionLoading(true);
      const res = await store.client.stageGitFiles(session.id);
      if (res.ok) {
        store.showToast('已暂存全部改动 (git add .)');
        await loadStatus();
      } else {
        store.showToast(res.error || '暂存失败', 'err');
      }
    } finally {
      setActionLoading(false);
    }
  };

  // 放弃选中文件修改
  const handleDiscardCurrent = async () => {
    if (!session?.id || !selectedFile) return;
    try {
      setActionLoading(true);
      const res = await store.client.discardGitChanges(session.id, [selectedFile.path]);
      if (res.ok) {
        store.showToast(`已放弃对 ${selectedFile.path} 的修改`);
        setConfirmDiscard(false);
        await loadStatus();
      } else {
        store.showToast(res.error || '放弃修改失败', 'err');
      }
    } finally {
      setActionLoading(false);
    }
  };

  // 填入 Composer /commit 闭环
  const handleFillCommit = () => {
    onClose();
    // 构造带改动文件清单的高密度提示
    const fileList = (status?.files || []).map((f) => f.path).join('、');
    const prompt = `请结合当前工作区的 Git 改动（变动文件：${fileList || '所有改动'}），按照 Conventional Commits 规范生成标准提交信息并说明核心改动点。`;
    store.send(prompt);
  };

  // Esc 键关闭
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal git-inspector-modal" onClick={(e) => e.stopPropagation()}>
        {/* 头部 */}
        <div className="git-modal-head">
          <div className="git-modal-title">
            <span className="git-modal-icon">⑂</span>
            <span className="git-modal-name">GIT 改动审查</span>
            {status?.isGit && (
              <span className="git-modal-branch">[{status.branch}]</span>
            )}
            {status && (
              <span className={`git-modal-badge ${status.clean ? 'clean' : 'dirty'}`}>
                {status.clean ? '工作区干净' : `${status.totalChanges} 项改动 · +${status.insertions} -${status.deletions}`}
              </span>
            )}
          </div>
          <div className="git-modal-head-actions">
            <button
              className="git-head-btn"
              onClick={loadStatus}
              disabled={loading}
              title="重新检测 Git 状态"
            >
              ⟳ 刷新
            </button>
            <button className="git-head-close" onClick={onClose} title="关闭 (Esc)">
              ✕
            </button>
          </div>
        </div>

        {/* 主体分栏 */}
        <div className="git-modal-body">
          {/* 左栏：文件列表与搜索 */}
          <div className="git-sidebar">
            <div className="git-filter-wrap">
              <input
                type="text"
                className="git-filter-input"
                placeholder="搜索变动文件..."
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              {filter && (
                <button className="git-filter-clear" onClick={() => setFilter('')}>
                  ✕
                </button>
              )}
            </div>

            <div className="git-file-list">
              {loading ? (
                <div className="git-empty-hint">扫描工作区 Git 状态中...</div>
              ) : !status?.isGit ? (
                <div className="git-empty-hint">当前工作区不是有效的 Git 仓库</div>
              ) : status.clean ? (
                <div className="git-empty-hint">✓ 工作区完全干净，无代码修改</div>
              ) : (
                <>
                  {/* 暂存区 */}
                  {stagedFiles.length > 0 && (
                    <div className="git-group">
                      <div className="git-group-title">
                        <span>[ 已暂存 STAGED ]</span>
                        <span className="git-group-count">{stagedFiles.length}</span>
                      </div>
                      {stagedFiles.map((f) => {
                        const isSelected = selectedFile?.path === f.path && selectedFile?.staged === true;
                        return (
                          <div
                            key={`staged-${f.path}`}
                            className={`git-file-item ${isSelected ? 'selected' : ''}`}
                            onClick={() => {
                              setSelectedFile(f);
                              setConfirmDiscard(false);
                            }}
                          >
                            <span className={`git-status-badge ${f.status}`}>{f.status}</span>
                            <span className="git-file-name" title={f.path}>{f.path}</span>
                            {(f.insertions! > 0 || f.deletions! > 0) && (
                              <span className="git-file-diff">
                                {f.insertions! > 0 && <span className="stat-add">+{f.insertions}</span>}
                                {f.deletions! > 0 && <span className="stat-del">-{f.deletions}</span>}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* 未暂存区 */}
                  {unstagedFiles.length > 0 && (
                    <div className="git-group">
                      <div className="git-group-title">
                        <span>[ 未暂存 UNSTAGED ]</span>
                        <span className="git-group-count">{unstagedFiles.length}</span>
                      </div>
                      {unstagedFiles.map((f) => {
                        const isSelected = selectedFile?.path === f.path && selectedFile?.staged === false;
                        return (
                          <div
                            key={`unstaged-${f.path}`}
                            className={`git-file-item ${isSelected ? 'selected' : ''}`}
                            onClick={() => {
                              setSelectedFile(f);
                              setConfirmDiscard(false);
                            }}
                          >
                            <span className={`git-status-badge ${f.status}`}>{f.status}</span>
                            <span className="git-file-name" title={f.path}>{f.path}</span>
                            {(f.insertions! > 0 || f.deletions! > 0) && (
                              <span className="git-file-diff">
                                {f.insertions! > 0 && <span className="stat-add">+{f.insertions}</span>}
                                {f.deletions! > 0 && <span className="stat-del">-{f.deletions}</span>}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* 未跟踪文件 */}
                  {untrackedFiles.length > 0 && (
                    <div className="git-group">
                      <div className="git-group-title">
                        <span>[ 未跟踪 UNTRACKED ]</span>
                        <span className="git-group-count">{untrackedFiles.length}</span>
                      </div>
                      {untrackedFiles.map((f) => {
                        const isSelected = selectedFile?.path === f.path && selectedFile?.staged === false;
                        return (
                          <div
                            key={`untracked-${f.path}`}
                            className={`git-file-item ${isSelected ? 'selected' : ''}`}
                            onClick={() => {
                              setSelectedFile(f);
                              setConfirmDiscard(false);
                            }}
                          >
                            <span className="git-status-badge question">?</span>
                            <span className="git-file-name" title={f.path}>{f.path}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* 右栏：全尺寸 Diff 视窗 */}
          <div className="git-diff-panel">
            {selectedFile ? (
              <>
                <div className="git-diff-head">
                  <div className="git-diff-head-left">
                    <span className={`git-status-badge ${selectedFile.status}`}>
                      {selectedFile.status}
                    </span>
                    <span className="git-diff-path" title={selectedFile.path}>
                      {selectedFile.path}
                    </span>
                    <span className="git-diff-area">
                      {selectedFile.staged ? '[已暂存]' : '[工作区]'}
                    </span>
                  </div>
                  <div className="git-diff-head-right">
                    <button className="git-diff-copy-btn" onClick={handleCopyDiff}>
                      ⧉ 复制 Diff
                    </button>
                  </div>
                </div>

                <div className="git-diff-content">
                  {diffLoading ? (
                    <div className="git-empty-hint">生成代码差异中...</div>
                  ) : parsedDiff.length === 0 ? (
                    <div className="git-empty-hint">该文件无差异或为二进制文件</div>
                  ) : (
                    <div className="git-diff-rows">
                      {parsedDiff.map((d, idx) => {
                        if (d.type === 'hunk') {
                          return (
                            <div key={idx} className="git-diff-row hunk">
                              <span className="git-diff-no" />
                              <span className="git-diff-no" />
                              <span className="git-diff-text">{d.text}</span>
                            </div>
                          );
                        }
                        if (d.type === 'header') {
                          return (
                            <div key={idx} className="git-diff-row header">
                              <span className="git-diff-no" />
                              <span className="git-diff-no" />
                              <span className="git-diff-text">{d.text}</span>
                            </div>
                          );
                        }
                        return (
                          <div key={idx} className={`git-diff-row ${d.type}`}>
                            <span className="git-diff-no old">
                              {d.oldNo !== undefined ? d.oldNo : ''}
                            </span>
                            <span className="git-diff-no new">
                              {d.newNo !== undefined ? d.newNo : ''}
                            </span>
                            <span className="git-diff-prefix">
                              {d.type === 'add' ? '+' : d.type === 'del' ? '-' : ' '}
                            </span>
                            <span className="git-diff-text">{d.text}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="git-diff-placeholder">
                <span className="git-diff-ph-icon">⑂</span>
                <p>在左侧选择一个变动文件以审查行级代码差异</p>
              </div>
            )}
          </div>
        </div>

        {/* 底部操作条 */}
        <div className="git-modal-foot">
          <div className="git-foot-left">
            <button
              className="git-action-btn primary"
              onClick={handleStageAll}
              disabled={actionLoading || !status || (unstagedFiles.length === 0 && untrackedFiles.length === 0)}
              title="暂存所有未暂存和未跟踪的改动 (git add .)"
            >
              ⧉ 暂存全部 (git add .)
            </button>

            {selectedFile && !selectedFile.staged && (
              <>
                {!confirmDiscard ? (
                  <button
                    className="git-action-btn danger"
                    onClick={() => setConfirmDiscard(true)}
                    disabled={actionLoading}
                    title="放弃当前选中文件的修改"
                  >
                    ↶ 放弃当前文件修改
                  </button>
                ) : (
                  <div className="git-discard-confirm">
                    <span className="git-confirm-text">确定放弃对该文件的全部改动？</span>
                    <button
                      className="git-confirm-btn yes"
                      onClick={handleDiscardCurrent}
                      disabled={actionLoading}
                    >
                      确定放弃
                    </button>
                    <button
                      className="git-confirm-btn cancel"
                      onClick={() => setConfirmDiscard(false)}
                    >
                      取消
                    </button>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="git-foot-right">
            <button
              className="git-action-btn commit"
              onClick={handleFillCommit}
              disabled={!status || status.clean}
              title="一键将审查改动作为意图填入 Composer /commit 闭环生成提交信息"
            >
              ⌨ 填入 Composer /commit »
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
