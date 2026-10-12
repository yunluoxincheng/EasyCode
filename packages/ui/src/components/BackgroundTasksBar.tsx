import React, { useEffect, useState } from 'react';
import { useStore } from '../useStore.js';
import type { BackgroundTaskInfo } from '@easycode/core';

/** 任务运行时长（每秒本地跳动，不触发 store 重渲） */
function useElapsed(startedAt: number, active: boolean): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  const total = Math.max(0, Math.floor((now - startedAt) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}h${m % 60}m`;
  }
  return m > 0 ? `${m}m${s.toString().padStart(2, '0')}s` : `${s}s`;
}

/** 单个后台任务 chip：● 命令 · 地址 · 运行时长 + 控制 */
function TaskChip({ task }: { task: BackgroundTaskInfo }) {
  const store = useStore();
  const running = task.status === 'running';
  const elapsed = useElapsed(task.startedAt, running);
  const command = task.command.length > 36 ? `${task.command.slice(0, 36)}…` : task.command;
  const url = task.primaryUrl;

  return (
    <div className={`bg-chip ${running ? 'running' : 'stopped'}`}>
      <button
        className="bg-chip-main"
        type="button"
        title={running ? '查看实时日志' : '任务已结束，点击查看日志'}
        onClick={() => store.toggleTaskDrawer(task.id)}
      >
        <span className={`bg-dot ${running ? (task.alive === false ? 'idle' : 'live') : 'dead'}`} />
        <span className="bg-cmd">{command}</span>
        {url && <span className="bg-url">{url.replace(/^https?:\/\//, '')}</span>}
        <span className="bg-elapsed">
          {running ? `运行中 ${elapsed}` : task.status === 'killed' ? '已停止' : `已退出 (${task.exitCode ?? '-'})`}
        </span>
      </button>
      {url && running && (
        <button
          className="bg-chip-btn"
          type="button"
          title="内嵌预览（侧边打开）"
          onClick={() => store.openPreviewForTask(task.id)}
        >
          ⧉
        </button>
      )}
      {url && running && (
        <button
          className="bg-chip-btn"
          type="button"
          title="在系统浏览器打开"
          onClick={() => store.openExternalUrl(url)}
        >
          ↗
        </button>
      )}
      {running && (
        <button
          className="bg-chip-btn danger"
          type="button"
          title="停止任务（终止整棵进程树）"
          onClick={() => void store.stopTask(task.id)}
        >
          ■
        </button>
      )}
    </div>
  );
}

/**
 * 底部常驻后台任务条（TODOS #37）：
 * 会话存在后台任务时展示在 Composer 上方，点击滑出日志抽屉，支持内嵌预览 / 外部浏览器 / 停止。
 */
export function BackgroundTasksBar() {
  const store = useStore();
  const tasks = store.bgTasks;
  if (tasks.length === 0) return null;

  return (
    <div className="bg-bar" role="status">
      <span className="bg-bar-label">⚙ 后台任务 {tasks.filter((t) => t.status === 'running').length}/{tasks.length}</span>
      {tasks.map((t) => (
        <TaskChip key={t.id} task={t} />
      ))}
    </div>
  );
}
