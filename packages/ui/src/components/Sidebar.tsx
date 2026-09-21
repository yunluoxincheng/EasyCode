import { useState, useRef, useEffect } from 'react';
import { useStore } from '../useStore.js';
import { UpdateBadge } from './UpdateBadge.js';

type SessionMetaLite = {
  id: string;
  title: string;
  workspaceRoot: string;
  providerId: string;
  model: string;
  updatedAt: string;
};

type ProjectGroupItem = {
  key: string;
  id: string | null;
  name: string;
  folder: string | null;
  isRegistered: boolean;
  sessions: SessionMetaLite[];
};

/** 单个会话条目，紧凑单行展示，支持悬停操作、双击改名与行内编辑 */
function SessionItemRow({
  session,
  active,
  running,
  onSelect,
  onDelete,
  onRename,
}: {
  session: SessionMetaLite;
  active: boolean;
  running: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onRename: (newTitle: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(session.title);
  }, [session.title]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = async () => {
    const trimmed = draft.trim();
    setEditing(false);
    if (trimmed && trimmed !== session.title) {
      await onRename(trimmed);
    } else {
      setDraft(session.title);
    }
  };

  const cancel = () => {
    setEditing(false);
    setDraft(session.title);
  };

  return (
    <div
      className={`session-item ${active ? 'active' : ''}`}
      onClick={onSelect}
    >
      {editing ? (
        <input
          ref={inputRef}
          className="session-rename-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void commit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancel();
            }
          }}
          onBlur={() => void commit()}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <>
          <span
            className="session-title"
            title={`${session.title} (双击重命名)`}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setEditing(true);
            }}
          >
            {session.title}
          </span>
          <div className="session-actions" onClick={(e) => e.stopPropagation()}>
            <button
              className="session-action-btn session-rename"
              title="重命名会话"
              onClick={() => setEditing(true)}
            >
              ✎
            </button>
            <button
              className="session-action-btn session-delete"
              title="删除会话"
              onClick={() => {
                if (!running) onDelete();
              }}
            >
              ✕
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** 项目组头条目，支持折叠切换、项目管理下拉菜单与重命名 */
function ProjectTreeHeader({
  project,
  active,
  folded,
  onToggleFold,
  onSelectProject,
  onOpenWorkspace,
  onRenameProject,
  onDeleteProject,
  onRegisterProject,
}: {
  project: ProjectGroupItem;
  active: boolean;
  folded: boolean;
  onToggleFold: () => void;
  onSelectProject: () => void;
  onOpenWorkspace: (tool: 'explorer' | 'vscode') => void;
  onRenameProject: (newName: string) => Promise<void>;
  onDeleteProject: () => Promise<void>;
  onRegisterProject?: () => Promise<void>;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(project.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setDraftName(project.name);
  }, [project.name]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  useEffect(() => {
    if (!menuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [menuOpen]);

  const commitRename = async () => {
    const trimmed = draftName.trim();
    setEditing(false);
    if (trimmed && trimmed !== project.name) {
      await onRenameProject(trimmed);
    } else {
      setDraftName(project.name);
    }
  };

  return (
    <div
      className={`session-group-header ${active ? 'active-header' : ''}`}
      onClick={() => {
        onToggleFold();
        onSelectProject();
      }}
    >
      <button
        className="group-fold-btn"
        title={folded ? '展开项目' : '折叠项目'}
        onClick={(e) => {
          e.stopPropagation();
          onToggleFold();
        }}
      >
        {folded ? '▸' : '▾'}
      </button>

      {editing ? (
        <input
          ref={inputRef}
          className="group-rename-input"
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void commitRename();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setEditing(false);
              setDraftName(project.name);
            }
          }}
          onBlur={() => void commitRename()}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <div
          className={`session-group-label ${active ? 'active' : ''}`}
          title={`${project.folder ?? project.name} —— 点击切换折叠`}
        >
          <span className="group-name">{project.name}</span>
        </div>
      )}

      <div className="group-menu-wrap" ref={menuRef} onClick={(e) => e.stopPropagation()}>
        <button
          className="group-menu-btn"
          title="项目操作"
          onClick={() => setMenuOpen(!menuOpen)}
        >
          ···
        </button>
        {menuOpen && (
          <div className="group-menu-pop">
            {project.folder && (
              <>
                <button
                  className="group-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenWorkspace('explorer');
                  }}
                >
                  ⧉ 在文件管理器中打开
                </button>
                <button
                  className="group-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenWorkspace('vscode');
                  }}
                >
                  ⌨ 在 VS Code 中打开
                </button>
                <div className="group-menu-divider" />
              </>
            )}
            {project.isRegistered ? (
              <>
                <button
                  className="group-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    setEditing(true);
                  }}
                >
                  ✎ 重命名项目别名
                </button>
                <button
                  className="group-menu-item danger"
                  onClick={() => {
                    setMenuOpen(false);
                    void onDeleteProject();
                  }}
                >
                  ✕ 移除项目
                </button>
              </>
            ) : (
              onRegisterProject && (
                <button
                  className="group-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    void onRegisterProject();
                  }}
                >
                  ＋ 存为已命名项目
                </button>
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** 左侧栏（Codex 桌面端布局）：项目树分组（含属于该项目的会话）+ 独立自由会话 */
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

  // 会话按文件夹分组
  const byFolder = new Map<string, SessionMetaLite[]>();
  const freeSessions: SessionMetaLite[] = [];
  for (const s of store.sessions) {
    if (s.workspaceRoot) {
      const arr = byFolder.get(s.workspaceRoot) ?? [];
      arr.push(s);
      byFolder.set(s.workspaceRoot, arr);
    } else {
      freeSessions.push(s);
    }
  }

  // 项目列表：以 settings.projects 为主体，每个项目下直接挂载其会话
  const seenFolders = new Set<string>();
  const projectsList: ProjectGroupItem[] = (store.settings?.projects ?? []).map((p) => {
    seenFolders.add(p.folder);
    return {
      key: p.id,
      id: p.id,
      name: p.name,
      folder: p.folder,
      isRegistered: true,
      sessions: byFolder.get(p.folder) ?? [],
    };
  });

  // 如果会话带 workspaceRoot 但未在 settings.projects 登记，也作为一个项目组展示
  for (const [folder, ss] of byFolder) {
    if (!seenFolders.has(folder)) {
      projectsList.push({
        key: folder,
        id: null,
        name: folder.split(/[\\/]/).filter(Boolean).pop() ?? folder,
        folder,
        isRegistered: false,
        sessions: ss,
      });
    }
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <div className="sidebar-top-row">
          <button className="btn primary block" onClick={newSession}>＋ 新建会话</button>
          <button className="icon-btn" title="收起侧栏" onClick={() => store.toggleSidebar()}>«</button>
        </div>
      </div>

      <nav className="session-list">
        {/* 项目分区：每个项目是可折叠的树，会话归属于其所在项目 */}
        <div className="nav-mini-label">项目</div>
        <div className="projects-container">
          {projectsList.map((project) => {
            const isFolded = store.isProjectFolded(project.key);
            const isActiveProject = Boolean(project.id && project.id === store.activeProjectId);
            return (
              <div key={project.key} className={`project-tree-group ${isActiveProject ? 'active' : ''}`}>
                <ProjectTreeHeader
                  project={project}
                  active={isActiveProject}
                  folded={isFolded}
                  onToggleFold={() => void store.toggleProjectFold(project.key)}
                  onSelectProject={() => {
                    if (project.id !== null) store.setActiveProject(project.id);
                  }}
                  onOpenWorkspace={(tool) => {
                    if (!project.folder) return;
                    if (tool === 'vscode') void store.openInVscode(project.folder);
                    else store.openPath(project.folder);
                  }}
                  onRenameProject={(newName) => {
                    if (!project.id) return Promise.resolve();
                    return store.renameProject(project.id, newName);
                  }}
                  onDeleteProject={() => {
                    if (!project.id) return Promise.resolve();
                    return store.deleteProject(project.id);
                  }}
                  onRegisterProject={
                    !project.isRegistered && project.folder
                      ? () =>
                          store
                            .createProject(project.name, project.folder!)
                            .then(() => store.showToast(`已将「${project.name}」添加为项目`))
                      : undefined
                  }
                />
                {!isFolded && (
                  <div className="project-tree-sessions">
                    {project.sessions.length === 0 ? (
                      <div className="group-empty">暂无会话</div>
                    ) : (
                      project.sessions.map((session) => (
                        <SessionItemRow
                          key={session.id}
                          session={session}
                          active={session.id === store.activeId}
                          running={store.running}
                          onSelect={() => void store.selectSession(session.id)}
                          onDelete={() => void store.deleteSession(session.id)}
                          onRename={(title) => store.renameSession(session.id, title)}
                        />
                      ))
                    )}
                  </div>
                )}
              </div>
            );
          })}
          <button
            className="project-item add"
            onClick={() => store.openCreateProject()}
          >
            ＋ 添加项目
          </button>
        </div>

        {/* 独立会话分区：仅展示没有绑定任何项目的独立会话 */}
        {freeSessions.length > 0 && (
          <div className="free-sessions-container">
            <div className="nav-mini-label" style={{ marginTop: '12px' }}>会话 (无项目)</div>
            <div className="session-free-list">
              {freeSessions.map((session) => (
                <SessionItemRow
                  key={session.id}
                  session={session}
                  active={session.id === store.activeId}
                  running={store.running}
                  onSelect={() => void store.selectSession(session.id)}
                  onDelete={() => void store.deleteSession(session.id)}
                  onRename={(title) => store.renameSession(session.id, title)}
                />
              ))}
            </div>
          </div>
        )}
      </nav>

      <div className="sidebar-bottom">
        <div className="sidebar-bottom-row">
          <button className="btn ghost block" onClick={() => store.openSettings('models')}>
            设置
          </button>
          <UpdateBadge />
        </div>
      </div>
    </aside>
  );
}
