import React, { useEffect, useState, useCallback } from 'react';
import { useStore } from '../useStore.js';
import type { GitStatusSummary } from '@easycode/engine';

interface GitCapsuleProps {
  compact?: boolean;
}

export const GitCapsule: React.FC<GitCapsuleProps> = ({ compact }) => {
  const store = useStore();
  const session = store.activeSession;
  const [gitStatus, setGitStatus] = useState<GitStatusSummary | null>(null);

  const fetchStatus = useCallback(async () => {
    if (!session?.id || !session.workspaceRoot || !store.client.getGitStatus) {
      setGitStatus(null);
      return;
    }
    try {
      const res = await store.client.getGitStatus(session.id);
      setGitStatus(res);
    } catch {
      setGitStatus(null);
    }
  }, [session?.id, session?.workspaceRoot, store.client]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus, store.activeId, store.structureVersion]);

  // 窗口聚焦时自动检测最新 Git 状态
  useEffect(() => {
    const handleFocus = () => void fetchStatus();
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [fetchStatus]);

  if (!session?.workspaceRoot || !gitStatus || !gitStatus.isGit) {
    return null;
  }

  const isClean = gitStatus.clean;
  const branchLabel = gitStatus.branch || 'HEAD';
  const changeCount = gitStatus.totalChanges;
  const insertions = gitStatus.insertions;
  const deletions = gitStatus.deletions;

  return (
    <button
      className={`git-capsule ${isClean ? 'clean' : 'dirty'} ${compact ? 'compact' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        store.openGitModal();
      }}
      title={`当前分支: ${branchLabel} · ${isClean ? '工作区干净' : `${changeCount} 个文件变动 (+${insertions} -${deletions})`} · 点击审查代码改动`}
    >
      <span className="git-capsule-icon">⑂</span>
      <span className="git-capsule-branch">{branchLabel}{!isClean ? '*' : ''}</span>
      {!compact && (
        <span className="git-capsule-stat">
          {isClean ? (
            'clean'
          ) : (
            <>
              {changeCount} 改动
              {(insertions > 0 || deletions > 0) && (
                <span className="git-capsule-diff-stat">
                  {insertions > 0 && <span className="stat-add">+{insertions}</span>}
                  {deletions > 0 && <span className="stat-del">-{deletions}</span>}
                </span>
              )}
            </>
          )}
        </span>
      )}
    </button>
  );
};
