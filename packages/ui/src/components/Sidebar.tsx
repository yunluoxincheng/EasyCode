import { useStore } from '../useStore.js';

/** 左侧栏（Codex 桌面端布局）：项目分区 + 会话列表；支持收起为图标栏 */
export function Sidebar({ onNewSession }: { onNewSession: () => void }) {
  const store = useStore();
  const collapsed = store.sidebarCollapsed;

  if (collapsed) {
    return (
      <aside className="sidebar collapsed">
        <div className="sidebar-top">
          <button className="btn primary block" title="新建会话" onClick={onNewSession}>＋</button>
        </div>
        <div className="sidebar-rail" />
        <div className="sidebar-bottom">
          <button className="btn ghost block" title="展开侧栏" onClick={() => store.toggleSidebar()}>»</button>
          <button className="btn ghost block" title="设置" onClick={() => store.openSettings('models')}>≡</button>
        </div>
      </aside>
    );
  }

  // 汇总会话中出现过的工作区（项目）
  const projects: string[] = [];
  for (const s of store.sessions) {
    if (s.workspaceRoot && !projects.includes(s.workspaceRoot)) projects.push(s.workspaceRoot);
  }
  const base = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <div className="sidebar-top-row">
          <button className="btn primary block" onClick={onNewSession}>＋ 新建会话</button>
          <button className="icon-btn" title="收起侧栏" onClick={() => store.toggleSidebar()}>«</button>
        </div>
      </div>

      <nav className="session-list">
        {projects.length > 0 && (
          <>
            <div className="nav-mini-label">项目</div>
            {projects.map((p) => (
              <button
                key={p}
                className="project-item"
                title={`${p} —— 点击在该项目中新建会话`}
                onClick={() => void store.newSession(p)}
              >
                <span className="project-item-name">{base(p)}</span>
                <span className="project-add">＋</span>
              </button>
            ))}
            <button
              className="project-item add"
              onClick={async () => {
                const dir = await store.client.pickWorkspace();
                if (dir) await store.newSession(dir);
              }}
            >
              ＋ 添加项目
            </button>
          </>
        )}
        <div className="nav-mini-label">会话</div>
        {store.sessions.length === 0 && (
          <p className="empty-hint">还没有会话。点击「新建会话」开始。</p>
        )}
        {store.sessions.map((session) => (
          <div
            key={session.id}
            className={`session-item ${session.id === store.activeId ? 'active' : ''}`}
            onClick={() => store.selectSession(session.id)}
          >
            <span className="session-title">{session.title}</span>
            <span className="session-meta">
              {store.providerLabelOf(session.providerId)} · {session.model}
            </span>
            <button
              className="session-delete"
              title="删除会话"
              onClick={(e) => {
                e.stopPropagation();
                if (!store.running) store.deleteSession(session.id);
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </nav>

      <div className="sidebar-bottom">
        <button className="btn ghost block" onClick={() => store.openSettings('models')}>
          设置
        </button>
      </div>
    </aside>
  );
}
