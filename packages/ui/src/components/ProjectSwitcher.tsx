import { useStore } from '../useStore.js';

/** composer 的项目切换器（图一）：搜索 / 项目列表 / 打开文件夹 / 不在项目中工作 */
export function ProjectSwitcher() {
  const store = useStore();
  const session = store.activeSession;
  if (!session) return null;

  const projects = store.settings?.projects ?? [];
  const current = projects.find((p) => p.folder === session.workspaceRoot);

  return (
    <div className="proj-switch" onClick={(e) => e.stopPropagation()}>
      <button
        className={`chip proj-chip ${current ? '' : 'unbound'}`}
        title="切换项目"
        onClick={() => store.toggleProjectSwitcher()}
      >
        {current ? current.name : '不在项目中工作'}
        <span className="proj-caret">▾</span>
      </button>
      {store.projectSwitcherOpen && (
        <div className="proj-pop">
          <input
            className="proj-search"
            placeholder="搜索项目"
            value={store.projectSearch}
            onChange={(e) => store.setProjectSearch(e.target.value)}
            autoFocus
          />
          <div className="proj-list">
            {projects
              .filter((p) => !store.projectSearch || p.name.toLowerCase().includes(store.projectSearch.toLowerCase()))
              .map((p) => (
                <button
                  key={p.id}
                  className={`proj-opt ${p.folder === session.workspaceRoot ? 'on' : ''}`}
                  title={p.folder}
                  onClick={() => {
                    store.toggleProjectSwitcher();
                    if (p.folder !== session.workspaceRoot) {
                      void store
                        .bindWorkspace(session.id, p.folder)
                        .catch((err) => store.showToast(err instanceof Error ? err.message : String(err)));
                    }
                  }}
                >
                  <span className="proj-opt-mark">{p.folder === session.workspaceRoot ? '✓' : ''}</span>
                  {p.name}
                </button>
              ))}
            {projects.length === 0 && <div className="proj-empty">还没有项目</div>}
          </div>
          <div className="proj-pop-foot">
            <button
              className="proj-foot-item"
              onClick={() => {
                store.toggleProjectSwitcher();
                void store
                  .bindProjectFromPicker(session.id)
                  .catch((err) => store.showToast(err instanceof Error ? err.message : String(err)));
              }}
            >
              ⌂ 打开文件夹
            </button>
            {session.workspaceRoot && (
              <button
                className="proj-foot-item"
                title={session.workspaceRoot}
                onClick={() => {
                  store.toggleProjectSwitcher();
                  store.openPath(session.workspaceRoot);
                }}
              >
                ⧉ 在文件管理器中打开
              </button>
            )}
            <button
              className="proj-foot-item"
              onClick={() => {
                store.toggleProjectSwitcher();
                if (session.workspaceRoot) {
                  void store
                    .bindWorkspace(session.id, '')
                    .catch((err) => store.showToast(err instanceof Error ? err.message : String(err)));
                }
              }}
            >
              ○ 不在项目中工作
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
