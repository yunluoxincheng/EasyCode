import { useStore } from '../useStore.js';

/** 左侧栏（Codex 桌面端布局）：项目分组 + 会话；支持收起为图标栏 */
export function Sidebar() {
  const store = useStore();
  const collapsed = store.sidebarCollapsed;
  const newSession = (): void => void store.newSession().catch((err) => store.showToast(err instanceof Error ? err.message : String(err)));

  if (collapsed) {
    return (
      <aside className="sidebar collapsed">
        <div className="sidebar-top">
          <button className="btn primary block" title="新建会话" onClick={newSession}>＋</button>
        </div>
        <div className="sidebar-rail" />
        <div className="sidebar-bottom">
          <button className="btn ghost block" title="展开侧栏" onClick={() => store.toggleSidebar()}>»</button>
          <button className="btn ghost block" title="设置" onClick={() => store.openSettings('models')}>≡</button>
        </div>
      </aside>
    );
  }

  // 会话按文件夹分组；项目（settings.projects）优先作为组标题，其余文件夹派生
  const byFolder = new Map<string, SessionMetaLite[]>();
  const free: SessionMetaLite[] = [];
  for (const s of store.sessions) {
    if (s.workspaceRoot) {
      const arr = byFolder.get(s.workspaceRoot) ?? [];
      arr.push(s);
      byFolder.set(s.workspaceRoot, arr);
    } else {
      free.push(s);
    }
  }
  const groups: Array<{ key: string; label: string; folder: string | null; projectId: string | null; sessions: SessionMetaLite[] }> = [];
  const seenFolders = new Set<string>();
  for (const p of store.settings?.projects ?? []) {
    seenFolders.add(p.folder);
    groups.push({ key: p.id, label: p.name, folder: p.folder, projectId: p.id, sessions: byFolder.get(p.folder) ?? [] });
  }
  for (const [folder, ss] of byFolder) {
    if (!seenFolders.has(folder)) {
      groups.push({
        key: folder,
        label: folder.split(/[\\/]/).filter(Boolean).pop() ?? folder,
        folder,
        projectId: null,
        sessions: ss,
      });
    }
  }
  if (free.length > 0) {
    groups.push({ key: '__free', label: '不在项目中', folder: null, projectId: null, sessions: free });
  }

  const base = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <div className="sidebar-top-row">
          <button className="btn primary block" onClick={newSession}>＋ 新建会话</button>
          <button className="icon-btn" title="收起侧栏" onClick={() => store.toggleSidebar()}>«</button>
        </div>
      </div>

      <nav className="session-list">
        <div className="nav-mini-label">项目</div>
        <button
          className={`project-item ${store.activeProjectId === null ? 'active' : ''}`}
          title="新会话将直接对话（可在输入区绑定项目）"
          onClick={() => store.setActiveProject(null)}
        >
          <span className="project-item-name">不在项目中</span>
        </button>
        {(store.settings?.projects ?? []).map((p) => (
          <button
            key={p.id}
            className={`project-item ${store.activeProjectId === p.id ? 'active' : ''}`}
            title={`${p.folder} —— 新会话将建在此项目`}
            onClick={() => store.setActiveProject(p.id)}
          >
            <span className="project-item-name">{p.name}</span>
          </button>
        ))}
        <button
          className="project-item add"
          onClick={() => store.openCreateProject()}
        >
          ＋ 添加项目
        </button>

        <div className="nav-mini-label">会话</div>
        {groups.map((g) => (
          <div key={g.key} className="session-group">
            <div
              className={`session-group-label ${g.projectId && g.projectId === store.activeProjectId ? 'active' : ''}`}
              title={g.folder ?? undefined}
              onClick={() => g.projectId !== null && store.setActiveProject(g.projectId)}
            >
              {g.label}
            </div>
            {g.sessions.length === 0 && <div className="group-empty">暂无会话</div>}
            {g.sessions.map((session) => (
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

type SessionMetaLite = {
  id: string;
  title: string;
  workspaceRoot: string;
  providerId: string;
  model: string;
  updatedAt: string;
};
