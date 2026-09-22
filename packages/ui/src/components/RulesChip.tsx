import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../useStore.js';
import type { ProjectRuleInfo } from '@easycode/engine';

interface RulesChipProps {
  compact?: boolean;
}

export const RulesChip: React.FC<RulesChipProps> = ({ compact }) => {
  const store = useStore();
  const session = store.activeSession;
  const [ruleInfo, setRuleInfo] = useState<ProjectRuleInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [popOpen, setPopOpen] = useState(false);
  const [initing, setIniting] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);

  // 刷新当前会话工作区的项目规范
  const loadRules = async () => {
    if (!session?.id || !session.workspaceRoot) {
      setRuleInfo(null);
      return;
    }
    try {
      setLoading(true);
      const res = await store.client.getProjectRules(session.id);
      setRuleInfo(res);
    } catch {
      setRuleInfo(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadRules();
  }, [session?.id, session?.workspaceRoot]);

  // 点击外部收起预览浮层
  useEffect(() => {
    if (!popOpen) return;
    const handleDown = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) {
        setPopOpen(false);
      }
    };
    document.addEventListener('mousedown', handleDown);
    return () => document.removeEventListener('mousedown', handleDown);
  }, [popOpen]);

  // 未绑定工作区时不显示规则胶囊
  if (!session?.workspaceRoot) {
    return null;
  }

  const hasProjectRule = !!(ruleInfo && ruleInfo.exists && ruleInfo.content.trim());
  const hasGlobalRule = !!store.settings?.globalRules?.trim();

  const handleInit = async () => {
    if (!session?.id) return;
    try {
      setIniting(true);
      const created = await store.client.initProjectRules(session.id);
      setRuleInfo(created);
      store.showToast('已在工作区生成 .easycoderules 规则模板');
    } catch (e) {
      store.showToast(e instanceof Error ? e.message : '初始化规则失败', 'err');
    } finally {
      setIniting(false);
    }
  };

  const handleOpenInEditor = async () => {
    if (!session?.workspaceRoot || !ruleInfo?.path) return;
    try {
      // 优先在 VS Code 中打开，失败则退回系统文件管理器
      await store.client.openInVscode(session.workspaceRoot);
    } catch {
      await store.client.openPath(session.workspaceRoot);
    }
  };

  return (
    <div className="rules-chip-wrap" ref={popRef}>
      <button
        className={`rules-chip ${hasProjectRule ? 'active' : hasGlobalRule ? 'global-active' : 'empty'} ${compact ? 'compact' : ''}`}
        onClick={() => setPopOpen(!popOpen)}
        title={
          hasProjectRule
            ? `项目规范生效中 (${ruleInfo?.path})，点击查看`
            : hasGlobalRule
              ? '全局偏好规范生效中，点击查看'
              : '当前工作区未检测到规范文件，点击初始化'
        }
      >
        <span className="rules-chip-icon">📋</span>
        {!compact && (
          <span className="rules-chip-label">
            {hasProjectRule
              ? `规则: ${ruleInfo?.path}`
              : hasGlobalRule
                ? '规则: 全局'
                : '＋ 规则'}
          </span>
        )}
      </button>

      {popOpen && (
        <div className="rules-pop">
          <div className="rules-pop-head">
            <span className="rules-pop-title">[ 📋 项目与行为规范 ]</span>
            <button className="rules-pop-close" onClick={() => setPopOpen(false)}>
              ✕
            </button>
          </div>

          <div className="rules-pop-body">
            {loading ? (
              <div className="rules-pop-empty">检测规范文件中...</div>
            ) : hasProjectRule && ruleInfo ? (
              <>
                <div className="rules-pop-meta">
                  <span className="rules-pop-path">生效文件: {ruleInfo.path}</span>
                  <span className="rules-pop-count">{ruleInfo.content.length} 字符</span>
                </div>
                <div className="rules-pop-preview">
                  <pre>{ruleInfo.content}</pre>
                </div>
                <div className="rules-pop-foot">
                  <span className="rules-pop-badge">已注入系统提示词 · 抗上下文压缩</span>
                  <button className="rules-pop-btn" onClick={handleOpenInEditor}>
                    ✎ 打开所在目录
                  </button>
                </div>
              </>
            ) : (
              <div className="rules-pop-unconfigured">
                <p className="rules-pop-desc">
                  当前工作区未检测到专属规范文件。支持自动识别根目录下的：
                  <code>.easycoderules</code>、<code>AGENTS.md</code>、<code>CLAUDE.md</code>、
                  <code>.cursorrules</code> 或 <code>.easycode/rules.md</code>。
                </p>
                <div className="rules-pop-actions">
                  <button
                    className="rules-pop-init-btn"
                    onClick={handleInit}
                    disabled={initing}
                  >
                    {initing ? '生成中...' : '＋ 初始化 .easycoderules 标准模板'}
                  </button>
                </div>
              </div>
            )}

            {/* 全局偏好提示 */}
            <div className="rules-pop-global-hint">
              {hasGlobalRule ? (
                <span>
                  ✓ 全局偏好已启用（{store.settings?.globalRules?.length ?? 0} 字符）
                </span>
              ) : (
                <span>可在设置中配置跨项目的全局开发偏好</span>
              )}
              <button
                className="rules-pop-link-btn"
                onClick={() => {
                  setPopOpen(false);
                  store.openSettings('general');
                }}
              >
                前往设置 »
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
