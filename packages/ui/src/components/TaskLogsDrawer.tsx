import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../useStore.js';
import { renderAnsi } from '../ansi.js';

/**
 * 后台任务实时日志抽屉（TODOS #37）：
 * 拟终端滚动视窗，1s 轮询拉取增量输出；用户上翻阅读时暂停自动贴底。
 */
export function TaskLogsDrawer() {
  const store = useStore();
  const [logs, setLogs] = useState('');
  const [pinned, setPinned] = useState(true);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const task =
    (store.taskDrawerTaskId && store.bgTasks.find((t) => t.id === store.taskDrawerTaskId)) ||
    store.bgTasks[0] ||
    null;
  const running = task?.status === 'running';

  // 切换抽屉任务时清空旧任务日志并恢复贴底，避免新任务首帧前闪现旧内容
  useEffect(() => {
    setLogs('');
    setPinned(true);
  }, [task?.id]);

  // 日志轮询：抽屉打开期间 1s 拉一次尾部
  useEffect(() => {
    if (!task) return;
    let cancelled = false;
    const fetchLogs = (): void => {
      const id = store.activeId;
      if (!id || !store.client.getTaskLogs) return;
      void store.client
        .getTaskLogs(id, task.id, 400)
        .then((text) => {
          if (!cancelled) setLogs(text);
        })
        .catch(() => {});
    };
    fetchLogs();
    const timer = setInterval(fetchLogs, 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // store 为页面级单例引用稳定；task.id 变化（切换抽屉任务）时重建轮询
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id]);

  // 贴底跟随：日志更新时若处于贴底锁定则自动滚到底
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !pinned) return;
    el.scrollTop = el.scrollHeight;
  }, [logs, pinned]);

  const onScroll = (): void => {
    const el = bodyRef.current;
    if (!el) return;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
    setPinned(atBottom);
  };

  if (!store.taskDrawerOpen || !task) return null;

  return (
    <div className="task-drawer">
      <div className="task-drawer-head">
        <span className={`term-status-badge ${running ? 'running' : task.status === 'killed' ? 'err' : 'ok'}`}>
          {running ? 'RUN' : task.status === 'killed' ? 'STOP' : 'EXIT'}
        </span>
        <span className="task-drawer-title" title={task.command}>
          $ {task.command}
        </span>
        {task.primaryUrl && (
          <button
            className="task-drawer-btn"
            type="button"
            title="内嵌预览（侧边打开）"
            onClick={() => store.openPreviewForTask(task.id)}
          >
            ⧉ 预览
          </button>
        )}
        {task.primaryUrl && (
          <button
            className="task-drawer-btn"
            type="button"
            title="在系统浏览器打开"
            onClick={() => store.openExternalUrl(task.primaryUrl!)}
          >
            ↗ 浏览器
          </button>
        )}
        {running ? (
          <button
            className="task-drawer-btn danger"
            type="button"
            title="停止任务"
            onClick={() => void store.stopTask(task.id)}
          >
            ■ 停止
          </button>
        ) : (
          <button
            className="task-drawer-btn"
            type="button"
            title="以原命令重新启动"
            onClick={() => void store.restartTask(task.id)}
          >
            ▶ 重新启动
          </button>
        )}
        <span className="spacer" />
        <button
          className="task-drawer-btn"
          type="button"
          title="关闭抽屉"
          onClick={() => store.toggleTaskDrawer(task.id)}
        >
          ✕
        </button>
      </div>
      <div className="task-drawer-body" ref={bodyRef} onScroll={onScroll}>
        {logs.trim().length > 0 ? (
          <pre className="task-drawer-pre">{renderAnsi(logs)}</pre>
        ) : (
          <div className="task-drawer-empty">(暂无输出，等待进程打印…)</div>
        )}
        {running && pinned && (
          <div className="task-drawer-cursor">
            <span className="term-prompt">❯</span> <span className="term-cursor">█</span>
          </div>
        )}
        {!pinned && (
          <button
            className="task-drawer-jump"
            type="button"
            onClick={() => {
              setPinned(true);
              const el = bodyRef.current;
              if (el) el.scrollTop = el.scrollHeight;
            }}
          >
            ↓ 回到最新
          </button>
        )}
      </div>
    </div>
  );
}
