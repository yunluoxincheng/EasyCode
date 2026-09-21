import { useStore } from '../useStore.js';

/** composer 的项目切换器（图一）：搜索 / 项目列表 / 打开文件夹 / 不在项目中工作 */
export function ProjectSwitcher() {
  const store = useStore();
  const session = store.activeSession;
  if (!session) return null;

  const projects = store.settings?.projects ?? [];
  const current = projects.find((p) => p.folder === session.workspaceRoot);
  const folderName = session.workspaceRoot
    ? session.workspaceRoot.split(/[\\/]/).filter(Boolean).pop() || session.workspaceRoot
    : '';
  const displayLabel = current ? current.name : (folderName || '不在项目中工作');

  return (
    <div className="proj-switch" onClick={(e) => e.stopPropagation()}>
      <button
        className={`chip proj-chip ${session.workspaceRoot ? '' : 'unbound'}`}
        title={session.workspaceRoot ? `${displayLabel} (${session.workspaceRoot})` : '未绑定工作区'}
        onClick={() => store.toggleProjectSwitcher()}
      >
        {displayLabel}
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
            {session.workspaceRoot && !current && (
              <button
                className="proj-foot-item"
                onClick={() => {
                  store.toggleProjectSwitcher();
                  void store
                    .createProject(folderName, session.workspaceRoot)
                    .then(() => store.showToast(`已将「${folderName}」添加到项目列表`))
                    .catch((err) => store.showToast(err instanceof Error ? err.message : String(err)));
                }}
              >
                ＋ 将当前目录存为项目
              </button>
            )}
            {session.workspaceRoot && (
              <button
                className="proj-foot-item"
                title={session.workspaceRoot}
                onClick={() => {
                  store.toggleProjectSwitcher();
                  store.openWorkspace(session.workspaceRoot);
                }}
              >
                {(store.settings?.openWorkspaceWith ?? 'explorer') === 'vscode'
                  ? '⌨ 在 VS Code 中打开'
                  : '⧉ 在文件管理器中打开'}
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
