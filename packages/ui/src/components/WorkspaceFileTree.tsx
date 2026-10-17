import { useEffect, useMemo, useRef, useState } from 'react';
import { formatFileMention } from '@easycode/core';
import type { WorkspaceFilePreview } from '@easycode/engine';
import { useStore } from '../useStore.js';

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
}

function buildFileTree(paths: string[]): TreeNode[] {
  const root: TreeNode[] = [];
  const dirMap = new Map<string, TreeNode>();

  const ensureDir = (dirPath: string, name: string, parentList: TreeNode[]): TreeNode => {
    let node = dirMap.get(dirPath);
    if (!node) {
      node = { name, path: dirPath, isDir: true, children: [] };
      dirMap.set(dirPath, node);
      parentList.push(node);
    }
    return node;
  };

  for (const raw of paths) {
    const clean = raw.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!clean) continue;
    const parts = clean.split('/');
    let currentList = root;
    let accPath = '';
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      accPath = accPath ? `${accPath}/${part}` : part;
      const isLast = i === parts.length - 1;
      if (isLast) {
        currentList.push({
          name: part,
          path: accPath,
          isDir: false,
          children: [],
        });
      } else {
        const dirNode = ensureDir(accPath, part, currentList);
        currentList = dirNode.children;
      }
    }
  }

  const sortNodes = (nodes: TreeNode[]): void => {
    nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) {
      if (n.isDir) sortNodes(n.children);
    }
  };

  sortNodes(root);
  return root;
}

function fileExtBadge(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return 'FILE';
  const ext = fileName.slice(dot + 1).toUpperCase();
  if (ext.length <= 4) return ext;
  return ext.slice(0, 4);
}

/**
 * 工作区目录树微型侧栏（TODOS #38）：
 * 递归展示当前绑定工作区目录结构，支持筛选、右键菜单、插入 @引用 与单击轻量代码预览。
 */
export function WorkspaceFileTree() {
  const store = useStore();
  const session = store.activeSession;
  const workspaceRoot = session?.workspaceRoot ?? '';

  const [panelOpen, setPanelOpen] = useState(false);
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const loadFiles = async () => {
    if (!session?.id || !workspaceRoot) {
      setFiles([]);
      return;
    }
    setLoading(true);
    try {
      const list = await store.client.listWorkspaceFiles(session.id, '', 1500);
      setFiles(list);
    } catch {
      setFiles([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!panelOpen || !session?.id || !workspaceRoot) return;
    void loadFiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelOpen, session?.id, workspaceRoot, store.fileTreeRefreshTick]);

  useEffect(() => {
    if (!ctxMenu) return;
    const onClose = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setCtxMenu(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCtxMenu(null);
    };
    window.addEventListener('mousedown', onClose);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onClose);
      window.removeEventListener('keydown', onKey);
    };
  }, [ctxMenu]);

  const filteredPaths = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return files;
    return files.filter((p) => p.toLowerCase().includes(q));
  }, [files, filter]);

  const tree = useMemo(() => buildFileTree(filteredPaths), [filteredPaths]);

  if (!session || !workspaceRoot) return null;

  const toggleDir = (dirPath: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  };

  const joinFullPath = (relPath: string): string => {
    const sep = workspaceRoot.includes('\\') ? '\\' : '/';
    const normalizedRel = sep === '\\' ? relPath.replace(/\//g, '\\') : relPath;
    return `${workspaceRoot.replace(/[/\\]+$/, '')}${sep}${normalizedRel}`;
  };

  const handleCopyPath = (relPath: string) => {
    setCtxMenu(null);
    void navigator.clipboard.writeText(relPath).then(() => {
      store.showToast(`已复制相对路径: ${relPath}`);
    });
  };

  const handleInsertComposer = (relPath: string) => {
    setCtxMenu(null);
    store.insertIntoComposer(`${formatFileMention(relPath)} `);
  };

  const handleOpenExternal = (relPath: string) => {
    setCtxMenu(null);
    store.openWorkspace(joinFullPath(relPath));
  };

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    const isFiltering = filter.trim().length > 0;
    const isOpen = isFiltering || expandedDirs.has(node.path);
    const indentPx = 8 + depth * 12;

    if (node.isDir) {
      return (
        <div key={node.path} className="ws-tree-group">
          <div
            className="ws-tree-row dir"
            style={{ paddingLeft: `${indentPx}px` }}
            onClick={() => toggleDir(node.path)}
            title={node.path}
          >
            <span className="ws-tree-caret">{isOpen ? '▾' : '▸'}</span>
            <span className="ws-tree-badge dir">DIR</span>
            <span className="ws-tree-name">{node.name}/</span>
          </div>
          {isOpen && (
            <div className="ws-tree-children">
              {node.children.map((child) => renderNode(child, depth + 1))}
            </div>
          )}
        </div>
      );
    }

    return (
      <div
        key={node.path}
        className={`ws-tree-row file ${store.filePreviewPath === node.path ? 'active' : ''}`}
        style={{ paddingLeft: `${indentPx}px` }}
        title={`${node.path}（单击预览代码与行框选，右键更多操作）`}
        onClick={() => store.openFilePreview(node.path)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const x = Math.min(e.clientX, window.innerWidth - 210);
          const y = Math.min(e.clientY, window.innerHeight - 160);
          setCtxMenu({ x, y, path: node.path });
        }}
      >
        <span className="ws-tree-badge file">{fileExtBadge(node.name)}</span>
        <span className="ws-tree-name">{node.name}</span>
        <div className="ws-tree-actions" onClick={(e) => e.stopPropagation()}>
          <button
            className="ws-tree-act-btn"
            title="插入 @引用 到输入框"
            onClick={() => handleInsertComposer(node.path)}
          >
            @
          </button>
          <button
            className="ws-tree-act-btn"
            title="复制相对路径"
            onClick={() => handleCopyPath(node.path)}
          >
            ⧉
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className={`ws-tree-panel ${panelOpen ? 'open' : 'closed'}`}>
      <div className="ws-tree-header" onClick={() => setPanelOpen(!panelOpen)}>
        <span className="ws-tree-caret">{panelOpen ? '▾' : '▸'}</span>
        <span className="ws-tree-title">[TREE] 工作区文件树</span>
        {files.length > 0 && (
          <span className="ws-tree-count">{files.length >= 1500 ? '1500+' : files.length}</span>
        )}
        <span className="spacer" />
        {panelOpen && (
          <button
            className="ws-tree-refresh"
            type="button"
            title="刷新工作区文件树"
            onClick={(e) => {
              e.stopPropagation();
              void loadFiles();
            }}
          >
            ⟳
          </button>
        )}
      </div>

      {panelOpen && (
        <div className="ws-tree-body">
          <div className="ws-tree-toolbar">
            <input
              type="text"
              className="ws-tree-filter"
              placeholder="筛选文件名或路径..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            {filter && (
              <button
                className="ws-tree-clear"
                type="button"
                title="清空筛选"
                onClick={() => setFilter('')}
              >
                ✕
              </button>
            )}
          </div>
          {files.length >= 1500 && (
            <div className="ws-tree-trunc-hint">
              [ INFO ] 工作区文件较多，当前仅索引并展示前 1,500 项；未索引的深层文件可直接在输入框手写 @相对路径 引用
            </div>
          )}
          <div className="ws-tree-scroll">
            {loading && files.length === 0 ? (
              <div className="ws-tree-empty">[ WAIT ] 扫描工作区目录...</div>
            ) : tree.length === 0 ? (
              <div className="ws-tree-empty">无匹配文件</div>
            ) : (
              tree.map((node) => renderNode(node, 0))
            )}
          </div>
        </div>
      )}

      {ctxMenu && (
        <div
          ref={menuRef}
          className="context-menu ws-tree-ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="context-menu-title">{ctxMenu.path}</div>
          <button
            className="context-menu-item"
            onClick={() => {
              const p = ctxMenu.path;
              setCtxMenu(null);
              store.openFilePreview(p);
            }}
          >
            <span className="ctx-icon">⊞</span> 预览代码与框选行引用
          </button>
          <button
            className="context-menu-item"
            onClick={() => handleInsertComposer(ctxMenu.path)}
          >
            <span className="ctx-icon">⌨</span> 插入到 Composer 输入框
          </button>
          <button
            className="context-menu-item"
            onClick={() => handleCopyPath(ctxMenu.path)}
          >
            <span className="ctx-icon">⧉</span> 复制相对路径
          </button>
          <button
            className="context-menu-item"
            onClick={() => handleOpenExternal(ctxMenu.path)}
          >
            <span className="ctx-icon">✎</span> 在外部编辑器中打开
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * 快速轻量代码预览弹窗与行号范围框选器（TODOS #38）：
 * 支持单击/Shift+单击或鼠标拖拽行号/代码行选定区间，一键生成 @path:start-end 插入 Composer。
 */
export function FilePreviewModal() {
  const store = useStore();
  const relPath = store.filePreviewPath;
  const session = store.activeSession;

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<WorkspaceFilePreview | null>(null);
  const [anchorLine, setAnchorLine] = useState<number | null>(null);
  const [focusLine, setFocusLine] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!relPath || !session?.id || !store.client.readWorkspaceFile) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setAnchorLine(null);
    setFocusLine(null);
    store.client
      .readWorkspaceFile(session.id, relPath)
      .then((res) => {
        if (cancelled) return;
        setPreview(res);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [relPath, session?.id, store.client]);

  useEffect(() => {
    if (!relPath) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        store.closeFilePreview();
      }
    };
    const onMouseUp = () => setDragging(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [relPath, store]);

  if (!relPath || !session) return null;

  const lines = preview ? preview.content.split('\n') : [];
  const startLine =
    anchorLine !== null && focusLine !== null ? Math.min(anchorLine, focusLine) : null;
  const endLine =
    anchorLine !== null && focusLine !== null ? Math.max(anchorLine, focusLine) : null;

  const rangeSpec =
    startLine !== null && endLine !== null
      ? startLine === endLine
        ? `${startLine}`
        : `${startLine}-${endLine}`
      : null;

  const mentionToken = formatFileMention(relPath, rangeSpec);

  const handleLineMouseDown = (lineNo: number, shiftKey: boolean) => {
    if (shiftKey && anchorLine !== null) {
      setFocusLine(lineNo);
    } else {
      setAnchorLine(lineNo);
      setFocusLine(lineNo);
      setDragging(true);
    }
  };

  const handleLineMouseEnter = (lineNo: number) => {
    if (dragging && anchorLine !== null) {
      setFocusLine(lineNo);
    }
  };

  const handleCodeMouseUp = () => {
    setDragging(false);
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const findLineNo = (node: Node | null): number | null => {
      if (!node) return null;
      const el = (node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement)?.closest?.(
        '[data-line-no]',
      ) as HTMLElement | null;
      if (!el) return null;
      const n = parseInt(el.dataset.lineNo ?? '', 10);
      return Number.isFinite(n) ? n : null;
    };
    const l1 = findLineNo(sel.anchorNode);
    const l2 = findLineNo(sel.focusNode);
    if (l1 !== null && l2 !== null) {
      setAnchorLine(l1);
      setFocusLine(l2);
    }
  };

  const handleInsertRange = () => {
    store.insertIntoComposer(`${mentionToken} `);
    store.closeFilePreview();
    store.showToast(`已插入代码引用: ${mentionToken}`);
  };

  const handleCopySelectedLines = () => {
    if (!preview) return;
    const textToCopy =
      startLine !== null && endLine !== null
        ? lines.slice(startLine - 1, endLine).join('\n')
        : preview.content;
    void navigator.clipboard.writeText(textToCopy).then(() => {
      store.showToast(
        startLine !== null && endLine !== null
          ? `已复制第 ${rangeSpec} 行代码`
          : '已复制完整文件内容',
      );
    });
  };

  const handleOpenExternal = () => {
    if (!session.workspaceRoot) return;
    const sep = session.workspaceRoot.includes('\\') ? '\\' : '/';
    const normalizedRel = sep === '\\' ? relPath.replace(/\//g, '\\') : relPath;
    store.openWorkspace(`${session.workspaceRoot.replace(/[/\\]+$/, '')}${sep}${normalizedRel}`);
  };

  return (
    <div
      className="modal-backdrop file-preview-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) store.closeFilePreview();
      }}
    >
      <div className="file-preview-modal" role="dialog" aria-modal="true" aria-label="代码文件预览">
        <div className="file-preview-head">
          <div className="file-preview-title-wrap">
            <span className="file-preview-badge">[ FILE // 代码预览 ]</span>
            <span className="file-preview-path">{relPath}</span>
            {preview && (
              <span className="file-preview-meta">
                共 {preview.totalLines} 行 · {(preview.size / 1024).toFixed(1)} KB
                {preview.truncated && ' (大文件已截断预览)'}
              </span>
            )}
          </div>
          <div className="file-preview-head-actions">
            <button
              className="btn ghost sm"
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(relPath).then(() => {
                  store.showToast(`已复制相对路径: ${relPath}`);
                });
              }}
            >
              ⧉ 复制路径
            </button>
            <button className="btn ghost sm" type="button" onClick={handleOpenExternal}>
              ✎ 外部打开
            </button>
            <button
              className="icon-btn"
              type="button"
              title="关闭 (Esc)"
              onClick={() => store.closeFilePreview()}
            >
              ✕
            </button>
          </div>
        </div>

        <div className="file-preview-subbar">
          <span className="file-preview-hint">
            {startLine !== null && endLine !== null ? (
              <>
                <span className="range-active-tag">[ 已选第 {rangeSpec} 行 ]</span> 共{' '}
                {endLine - startLine + 1} 行（可按住鼠标拖拽或 Shift+点击行号调整范围）
              </>
            ) : (
              '提示：点击或拖拽左侧行号（或直接拖选代码）即可框选行号范围，精准切片注入 Composer 节省 Token'
            )}
          </span>
          {startLine !== null && (
            <button
              className="link-btn"
              type="button"
              onClick={() => {
                setAnchorLine(null);
                setFocusLine(null);
              }}
            >
              清除选区
            </button>
          )}
        </div>

        {loading ? (
          <div className="file-preview-empty">[ WAIT ] 正在读取文件内容...</div>
        ) : error ? (
          <div className="file-preview-empty err">[ ERR ] {error}</div>
        ) : (
          <div className="file-preview-scroll" onMouseUp={handleCodeMouseUp}>
            <div className="file-preview-code">
              {lines.map((lineText, idx) => {
                const lineNo = idx + 1;
                const selected =
                  startLine !== null && endLine !== null && lineNo >= startLine && lineNo <= endLine;
                return (
                  <div
                    key={lineNo}
                    data-line-no={lineNo}
                    className={`file-preview-line ${selected ? 'selected' : ''}`}
                    onMouseEnter={() => handleLineMouseEnter(lineNo)}
                  >
                    <span
                      className="file-preview-lineno"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        handleLineMouseDown(lineNo, e.shiftKey);
                      }}
                    >
                      {lineNo}
                    </span>
                    <span className="file-preview-text">{lineText || ' '}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="file-preview-foot">
          <code className="file-preview-token-preview">{mentionToken}</code>
          <div className="file-preview-foot-actions">
            <button
              className="btn ghost"
              type="button"
              disabled={!preview}
              onClick={handleCopySelectedLines}
            >
              {startLine !== null ? `⧉ 复制所选行 (${endLine! - startLine + 1})` : '⧉ 复制全文'}
            </button>
            <button
              className="btn primary"
              type="button"
              disabled={!preview}
              onClick={handleInsertRange}
            >
              {startLine !== null
                ? `⌨ 引用所选行至 Composer (${mentionToken})`
                : `⌨ 引用文件至 Composer (${mentionToken})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
