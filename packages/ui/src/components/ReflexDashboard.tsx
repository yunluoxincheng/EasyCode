import { useState, useEffect, useMemo } from 'react';
import { useStore } from '../useStore.js';
import type { DecisionStats, ProjectDecisionTree, DecisionRecord } from '@easycode/core';
import { downloadDecisionDataset } from '../utils/exportDecision.js';

const TASK_FAMILY_NAMES: Record<string, { label: string; color: string }> = {
  reasoning_effort: { label: '推理深度 (Reasoning)', color: '#4ade80' },
  recovery: { label: '错误自愈 (Recovery)', color: '#38bdf8' },
  safety: { label: '安全风控 (Safety)', color: '#fbbf24' },
  context_management: { label: '上下文压缩 (Context)', color: '#c084fc' },
  information_sufficiency: { label: '信息充分性 (Sufficiency)', color: '#34d399' },
  verification: { label: '验证决策 (Verification)', color: '#f472b6' },
  tool_routing: { label: '工具路由 (Tool Routing)', color: '#a78bfa' },
  other: { label: '其他决策', color: '#94a3b8' },
};

export function ReflexDashboard() {
  const store = useStore();
  const [stats, setStats] = useState<DecisionStats | null>(null);
  const [tree, setTree] = useState<ProjectDecisionTree[]>([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  // 展开状态追踪
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
  const [expandedSessions, setExpandedSessions] = useState<Record<string, boolean>>({});
  const [expandedRecords, setExpandedRecords] = useState<Record<string, boolean>>({});

  const loadData = async () => {
    setLoading(true);
    try {
      if (store.client.getDecisionStats) {
        const s = await store.client.getDecisionStats();
        setStats(s);
      }
      if (store.client.getDecisionTree) {
        const t = await store.client.getDecisionTree();
        setTree(t);
        // 默认展开第一个项目
        if (t.length > 0 && Object.keys(expandedProjects).length === 0) {
          setExpandedProjects({ [t[0].workspaceRoot]: true });
          if (t[0].sessions.length > 0) {
            setExpandedSessions({ [t[0].sessions[0].sessionId]: true });
          }
        }
      }
    } catch (err) {
      store.showToast(`加载决策监控失败: ${err instanceof Error ? err.message : String(err)}`, 'err');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const toggleProject = (ws: string) => {
    setExpandedProjects((prev) => ({ ...prev, [ws]: !prev[ws] }));
  };

  const toggleSession = (sid: string) => {
    setExpandedSessions((prev) => ({ ...prev, [sid]: !prev[sid] }));
  };

  const toggleRecord = (rid: string) => {
    setExpandedRecords((prev) => ({ ...prev, [rid]: !prev[rid] }));
  };

  const handleExport = async (
    filter?: { workspaceRoot?: string; sessionId?: string },
    title?: string,
  ) => {
    setExporting(true);
    try {
      const res = await downloadDecisionDataset(store.client, filter, title);
      if (res.ok) {
        store.showToast(`已成功导出 ${res.count} 条合格微调训练样本 (.jsonl)`, 'ok');
      } else {
        store.showToast(res.error || '导出失败', 'err');
      }
    } finally {
      setExporting(false);
    }
  };

  const isEnabled = store.settings?.reflexShadowMode === true;
  const toggleShadowMode = async () => {
    try {
      await store.saveSettings({ reflexShadowMode: !isEnabled });
      store.showToast(
        !isEnabled ? '已开启 Reflex 影子模式旁路观测' : '已关闭 Reflex 影子模式（零旁路开销）',
        'ok',
      );
    } catch {
      store.showToast('切换影子模式失败', 'err');
    }
  };

  return (
    <div className="reflex-dashboard">
      <div className="page-head" style={{ marginBottom: 16 }}>
        <div>
          <div className="page-desc">
            Reflex 端侧旁路观测：系统依据客观执行证据链自动筛选合格微调集，无需人工审核，绝无伪标签
          </div>
        </div>
        <div className="page-actions" style={{ display: 'flex', gap: 10 }}>
          <button
            className="btn ghost mini-btn"
            onClick={loadData}
            disabled={loading}
            title="刷新统计数据"
          >
            ↻ 刷新
          </button>
          <button
            className="btn primary mini-btn"
            onClick={() => handleExport(undefined, 'Global')}
            disabled={exporting || !stats || (stats.qualifiedSamples ?? 0) === 0}
            title={
              (stats?.qualifiedSamples ?? 0) > 0
                ? `导出经过证据链严格筛选的 ${stats?.qualifiedSamples} 条合格微调样本`
                : '当前暂无符合客观证据链的合格样本（失败或不可靠判定已自动排除）'
            }
          >
            ⤓ 导出微调集 ({(stats?.qualifiedSamples ?? 0)} 条)
          </button>
        </div>
      </div>

      {/* 影子模式主控开关卡片 */}
      <div
        className="general-panel"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '14px 18px',
          marginBottom: 16,
          borderColor: isEnabled ? 'var(--green-dim)' : 'var(--border)',
        }}
      >
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-bright)' }}>
            Reflex 影子模式 (Shadow Mode) 旁路观测开关
          </div>
          <div style={{ fontSize: 11, color: 'var(--dim)', marginTop: 4, lineHeight: 1.5 }}>
            {isEnabled
              ? '【运行中】Agent 运行时关键决策点在后台毫秒级运行 22M INT8 决策小脑；系统依据执行证据自动筛选合格样本，绝无伪标签。'
              : '【已关闭】完全停止端侧小模型推理与日志记录，主循环零额外 CPU 消耗、零文件写入。'}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 12, color: isEnabled ? 'var(--green)' : 'var(--dim)', fontWeight: 500 }}>
            {isEnabled ? '● 运行中 (Active)' : '○ 已关闭 (Disabled)'}
          </span>
          <button
            className={`switch ${isEnabled ? 'on' : ''}`}
            type="button"
            role="switch"
            aria-checked={isEnabled}
            onClick={toggleShadowMode}
            title={isEnabled ? '点击关闭影子模式' : '点击开启影子模式'}
          >
            <span className="knob" />
          </button>
        </div>
      </div>

      {loading && !stats ? (
        <div className="general-panel" style={{ textAlign: 'center', padding: '40px 0', color: 'var(--dim)' }}>
          正在加载 Reflex 统计指标与决策记录...
        </div>
      ) : !stats || stats.totalDecisions === 0 ? (
        <div className="general-panel" style={{ textAlign: 'center', padding: '50px 20px', color: 'var(--dim)' }}>
          <div style={{ fontSize: 15, color: 'var(--text-bright)', marginBottom: 8 }}>暂无旁路微决策记录</div>
          <div style={{ fontSize: 13, lineHeight: 1.6, maxWidth: 600, margin: '0 auto' }}>
            在 Agent 任务执行过程中，推理档位分配、前置工具路由、工具报错恢复自愈和上下文压缩时，Reflex 将在端侧以毫秒级旁路自动记录评估轨迹。
          </div>
        </div>
      ) : (
        <>
          {/* 1. 顶层 KPI 统计大屏 */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: 12,
              marginBottom: 16,
            }}
          >
            <div className="general-panel" style={{ padding: '14px 16px' }}>
              <div style={{ fontSize: 11, color: 'var(--dim)', textTransform: 'uppercase' }}>累计微决策次数</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--green)', marginTop: 4 }}>
                {stats.totalDecisions}
              </div>
              <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 2 }}>在线 Shadow 旁路捕获</div>
            </div>

            <div className="general-panel" style={{ padding: '14px 16px' }}>
              <div style={{ fontSize: 11, color: 'var(--dim)', textTransform: 'uppercase' }}>端侧平均决策耗时</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-bright)', marginTop: 4 }}>
                {stats.avgLatencyMs} <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--dim)' }}>ms</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 2 }}>CPU 单实例极速推理</div>
            </div>

            <div className="general-panel" style={{ padding: '14px 16px' }}>
              <div style={{ fontSize: 11, color: 'var(--dim)', textTransform: 'uppercase' }}>与实际动作一致率</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: stats.agreementRate >= 0.8 ? 'var(--green)' : 'var(--amber)', marginTop: 4 }}>
                {(stats.comparableDecisions ?? 0) > 0 ? `${(stats.agreementRate * 100).toFixed(1)}%` : '暂无数据'}
              </div>
              <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 2 }}>有效对照 {stats.comparableDecisions ?? 0} 条；一致不代表正确</div>
            </div>

            <div className="general-panel" style={{ padding: '14px 16px' }}>
              <div style={{ fontSize: 11, color: 'var(--dim)', textTransform: 'uppercase' }}>合格微调样本数</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: (stats.qualifiedSamples ?? 0) > 0 ? 'var(--green)' : 'var(--amber)', marginTop: 4 }}>
                {stats.qualifiedSamples ?? 0}
              </div>
              <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 2 }}>经因果证据链严格筛选</div>
            </div>
          </div>

          <div style={{ fontSize: 12, color: 'var(--dim)', marginBottom: 14 }}>
            已自动筛选合格微调样本 {stats.qualifiedSamples ?? 0} 条 · 实际动作待映射 {stats.unresolvedDecisions ?? 0} 条 · 失败与证据不足样本自动排除
          </div>

          {/* 任务族比例分布条 */}
          <div className="general-panel" style={{ padding: '14px 16px', marginBottom: 20 }}>
            <div style={{ fontSize: 12, color: 'var(--dim)', marginBottom: 8, display: 'flex', justifyContent: 'space-between' }}>
              <span>决策任务族分布</span>
              <span>共 {stats.totalDecisions} 次</span>
            </div>
            <div style={{ display: 'flex', height: 8, borderRadius: 2, overflow: 'hidden', background: 'var(--border2)' }}>
              {Object.entries(stats.taskFamilyDistribution).map(([fam, count]) => {
                const pct = (count / stats.totalDecisions) * 100;
                const info = TASK_FAMILY_NAMES[fam] || TASK_FAMILY_NAMES.other;
                return (
                  <div
                    key={fam}
                    title={`${info.label}: ${count} 次 (${pct.toFixed(1)}%)`}
                    style={{ width: `${pct}%`, background: info.color }}
                  />
                );
              })}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 10, fontSize: 11, color: 'var(--dim)' }}>
              {Object.entries(stats.taskFamilyDistribution).map(([fam, count]) => {
                const info = TASK_FAMILY_NAMES[fam] || TASK_FAMILY_NAMES.other;
                return (
                  <div key={fam} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: info.color }} />
                    <span>{info.label}: {count}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 2. 项目 -> 会话两级折叠树 */}
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-bright)', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>// 决策历史分级索引 (项目 → 会话 → 决策事件)</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {tree.map((p) => {
              const isProjectOpen = !!expandedProjects[p.workspaceRoot];
              return (
                <div key={p.workspaceRoot} className="general-panel" style={{ padding: 0, overflow: 'hidden' }}>
                  {/* 项目卡片头部 */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '12px 16px',
                      background: 'var(--panel2)',
                      cursor: 'pointer',
                      borderBottom: isProjectOpen ? '1px solid var(--border)' : 'none',
                    }}
                    onClick={() => toggleProject(p.workspaceRoot)}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ color: 'var(--dim)', fontSize: 12, transform: isProjectOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>
                        ▶
                      </span>
                      <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--green)' }}>
                        📂 {p.projectName}
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--dim)', marginLeft: 6 }}>
                        {p.workspaceRoot}
                      </span>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }} onClick={(e) => e.stopPropagation()}>
                      <span style={{ fontSize: 12, color: 'var(--dim)' }}>
                        {p.sessions.length} 个会话 · {p.totalDecisions} 次决策
                      </span>
                      <button
                        className="btn ghost mini-btn"
                        style={{ fontSize: 11, padding: '2px 8px' }}
                        onClick={() => handleExport({ workspaceRoot: p.workspaceRoot }, p.projectName)}
                        disabled={exporting || p.totalDecisions === 0}
                        title="导出该项目下所有合格的微调样本"
                      >
                        ⤓ 导出微调集
                      </button>
                    </div>
                  </div>

                  {/* 展开的会话列表 */}
                  {isProjectOpen && (
                    <div style={{ padding: '8px 16px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {p.sessions.map((s) => {
                        const isSessionOpen = !!expandedSessions[s.sessionId];
                        const qualCount = s.qualifiedSamples ?? 0;
                        return (
                          <div
                            key={s.sessionId}
                            style={{
                              border: '1px solid var(--border)',
                              borderRadius: 2,
                              background: 'var(--bg)',
                              overflow: 'hidden',
                            }}
                          >
                            {/* 会话头部 */}
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                padding: '10px 14px',
                                cursor: 'pointer',
                                background: isSessionOpen ? 'var(--panel)' : 'transparent',
                              }}
                              onClick={() => toggleSession(s.sessionId)}
                            >
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <span style={{ color: 'var(--dim)', fontSize: 11, transform: isSessionOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>
                                  ▶
                                </span>
                                <span style={{ fontSize: 13, color: 'var(--text-bright)', fontWeight: 500 }}>
                                  💬 {s.sessionTitle}
                                </span>
                                <span style={{ fontSize: 11, color: 'var(--faint)' }}>
                                  ({s.sessionId.slice(0, 8)})
                                </span>
                              </div>

                              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }} onClick={(e) => e.stopPropagation()}>
                                <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 2, background: 'var(--border2)', color: qualCount > 0 ? 'var(--green)' : 'var(--dim)' }}>
                                  合格样本 {qualCount} 条
                                </span>
                                <span style={{ fontSize: 12, color: 'var(--dim)' }}>
                                  {s.totalDecisions} 次决策
                                </span>
                                <button
                                  className="btn ghost mini-btn"
                                  style={{ fontSize: 11, padding: '2px 6px' }}
                                  onClick={() => handleExport({ sessionId: s.sessionId }, s.sessionTitle)}
                                  disabled={exporting || qualCount === 0}
                                  title={qualCount > 0 ? '导出本会话的合格微调样本' : '本会话暂无合格微调样本'}
                                >
                                  ⤓ 导出微调集
                                </button>
                              </div>
                            </div>

                            {/* 展开的决策明细记录 */}
                            {isSessionOpen && (
                              <div style={{ padding: '8px 12px', borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 8 }}>
                                {s.records.map((r) => {
                                  const isRecordOpen = !!expandedRecords[r.id];
                                  const famInfo = TASK_FAMILY_NAMES[r.taskFamily] || TASK_FAMILY_NAMES.other;
                                  const scores = r.prediction?.scores || {};
                                  const cands = r.candidates || [];
                                  const isRouting = r.taskFamily === 'tool_routing';
                                  const isRecov = r.taskFamily === 'recovery';
                                  const isContext = r.taskFamily === 'context_management';
                                  const isReasoning = r.taskFamily === 'reasoning_effort';
                                  let isQualified = false;
                                  let evidenceNote = '排除: 证据不足不作为训练样本';

                                  if (r.review?.basis === 'human') {
                                    isQualified = true;
                                    evidenceNote = `人工审核确认: ${r.review.defer ? 'DEFER' : r.review.selectedId}`;
                                  } else if (isRouting) {
                                    if (r.actualAction?.selectedId === 'stop_respond' && r.outcome?.status !== 'failure') {
                                      isQualified = true;
                                      evidenceNote = '自动证据合格: 正常完成未调用工具 (stop_respond)';
                                    } else if (r.actualAction?.selectedId && r.outcome?.status === 'success') {
                                      isQualified = true;
                                      evidenceNote = `自动证据合格: 工具成功执行推进任务 [${r.actualAction.selectedId}]`;
                                    } else if (r.outcome?.status === 'failure') {
                                      evidenceNote = '自动排除: 工具执行失败（退出码非 0 或报错，绝不作为正例）';
                                    }
                                  } else if (isRecov) {
                                    if (r.actualAction?.selectedId && r.outcome?.status === 'success') {
                                      isQualified = true;
                                      evidenceNote = `自动证据合格: 自愈策略执行成功 [${r.actualAction.selectedId}]`;
                                    } else {
                                      evidenceNote = '自动排除: 恢复动作未成功执行';
                                    }
                                  } else if (isContext) {
                                    if (r.actualAction?.selectedId === 'keep' || r.actualAction?.selectedId === 'compact_all') {
                                      isQualified = true;
                                      evidenceNote = `自动证据合格: 上下文策略有效执行 [${r.actualAction.selectedId}]`;
                                    }
                                  } else if (isReasoning) {
                                    if (r.outcome?.status === 'success' && r.outcome?.evidence) {
                                      isQualified = true;
                                      evidenceNote = '自动证据合格: 依据整轮实际执行客观复杂度标定';
                                    } else {
                                      evidenceNote = '自动排除: 回合未正常完成或缺少完整执行证据';
                                    }
                                  } else if (r.taskFamily === 'safety') {
                                    evidenceNote = '自动排除: 审批模式不充当安全真值（严防伪标签）';
                                  }

                                  return (
                                    <div
                                      key={r.id}
                                      style={{
                                        border: '1px solid var(--border)',
                                        padding: '10px 12px',
                                        background: 'var(--panel)',
                                        borderRadius: 2,
                                      }}
                                    >
                                      {/* 记录主标头 */}
                                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                          <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 2, background: famInfo.color + '22', color: famInfo.color, fontWeight: 600 }}>
                                            {famInfo.label.split(' ')[0]}
                                          </span>
                                          <span style={{ fontSize: 12, color: 'var(--text-bright)', fontWeight: 500 }}>
                                            {r.instruction}
                                          </span>
                                        </div>

                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
                                          <span style={{ color: 'var(--dim)' }}>
                                             {r.predictionStatus === 'ready' ? `⚡ ${r.prediction?.latencyMs} ms` : '预测未就绪'}
                                          </span>
                                          <span style={{ color: (r.prediction?.confidence ?? 0) >= 0.7 ? 'var(--green)' : 'var(--amber)', fontWeight: 600 }}>
                                            置信度: {((r.prediction?.confidence ?? 0) * 100).toFixed(1)}%
                                          </span>
                                          {r.prediction?.defer && (
                                            <span style={{ color: 'var(--amber)', background: '#fbbf2422', padding: '1px 5px', borderRadius: 2 }}>
                                              DEFER
                                            </span>
                                          )}
                                        </div>
                                      </div>

                                      {/* 预测结果与实际执行对比 */}
                                      <div
                                        style={{
                                          fontSize: 12,
                                          padding: '6px 10px',
                                          background: 'var(--panel2)',
                                          border: '1px solid var(--border2)',
                                          marginBottom: 8,
                                          display: 'flex',
                                          alignItems: 'center',
                                          justifyContent: 'space-between',
                                        }}
                                      >
                                        <div>
                                          <span style={{ color: 'var(--dim)', marginRight: 6 }}>Reflex 预测:</span>
                                          <span style={{ color: 'var(--green)', fontWeight: 600 }}>
                                            {r.predictionStatus === 'ready'
                                              ? `${r.prediction?.selectedId} (${r.prediction?.selectedText})`
                                              : '不可用'}
                                          </span>
                                        </div>
                                        {r.actualAction && (
                                          <div>
                                            <span style={{ color: 'var(--dim)', marginRight: 6 }}>实际动作:</span>
                                            <span style={{ color: r.agreement ? 'var(--green)' : 'var(--amber)' }}>
                                              {r.actualAction.description}{r.actualAction.selectedId ? ` [${r.actualAction.selectedId}]` : ' [未映射]'}
                                            </span>
                                          </div>
                                        )}
                                      </div>

                                      {/* 自动证据判定状态行 */}
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 11 }}>
                                        <span style={{ color: isQualified ? 'var(--green)' : 'var(--dim)' }}>
                                          {isQualified ? '● ' : '○ '}{evidenceNote}
                                        </span>
                                      </div>

                                      {/* 候选概率分布横向柱状图 */}
                                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 6 }}>
                                        {cands.map((c) => {
                                          const p = scores[c.id] ?? 0;
                                          const isSelected = c.id === r.prediction?.selectedId;
                                          return (
                                            <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
                                              <div style={{ width: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: isSelected ? 'var(--green)' : 'var(--dim)' }}>
                                                {c.text}
                                              </div>
                                              <div style={{ flex: 1, height: 6, background: 'var(--border2)', borderRadius: 2, overflow: 'hidden' }}>
                                                <div
                                                  style={{
                                                    width: `${Math.round(p * 100)}%`,
                                                    height: '100%',
                                                    background: isSelected ? 'var(--green)' : 'var(--faint)',
                                                  }}
                                                />
                                              </div>
                                              <div style={{ width: 45, textAlign: 'right', color: isSelected ? 'var(--green)' : 'var(--dim)' }}>
                                                {(p * 100).toFixed(1)}%
                                              </div>
                                            </div>
                                          );
                                        })}
                                      </div>

                                      {/* 上下文抽屉展开按钮 */}
                                      <div style={{ textAlign: 'right', marginTop: 4 }}>
                                        <button
                                          className="btn ghost mini-btn"
                                          style={{ fontSize: 10, padding: '2px 6px', color: 'var(--dim)' }}
                                          onClick={() => toggleRecord(r.id)}
                                        >
                                          {isRecordOpen ? '收起状态详情 ▲' : '展开 Prompt 上下文 ▼'}
                                        </button>
                                      </div>

                                      {isRecordOpen && (
                                        <div style={{ marginTop: 8, padding: 8, background: '#070a08', border: '1px solid var(--border)', fontSize: 11, color: 'var(--dim)', whiteSpace: 'pre-wrap', fontFamily: 'var(--font)' }}>
                                          <div><strong>[State Summary]:</strong> {r.state?.summary}</div>
                                          {r.state?.goal && <div style={{ marginTop: 4 }}><strong>[Task Goal]:</strong> {r.state.goal}</div>}
                                          {r.state?.history && r.state.history.length > 0 && (
                                            <div style={{ marginTop: 4 }}><strong>[History]:</strong> {r.state.history.join(' -> ')}</div>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
