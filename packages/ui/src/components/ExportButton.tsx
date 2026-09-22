import { useEffect, useRef, useState } from 'react';
import { useStore } from '../useStore.js';
import {
  sessionToMarkdown,
  sessionToHtml,
  downloadFile,
  getExportFilename,
} from '../utils/exportSession.js';

export function ExportButton() {
  const store = useStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const onExport = async (format: 'md' | 'html'): Promise<void> => {
    setOpen(false);
    if (!store.activeId) {
      store.showToast('请先选择要导出的会话');
      return;
    }
    if (store.running) {
      store.showToast('会话正在运行中，请等待完成后再导出');
      return;
    }
    try {
      const data = await store.client.getSession(store.activeId);
      if (format === 'md') {
        const content = sessionToMarkdown(data);
        const filename = getExportFilename(data.meta.title, 'md');
        downloadFile(filename, content, 'text/markdown;charset=utf-8');
        store.showToast(`已成功导出 Markdown: ${filename}`);
      } else {
        const content = sessionToHtml(data);
        const filename = getExportFilename(data.meta.title, 'html');
        downloadFile(filename, content, 'text/html;charset=utf-8');
        store.showToast(`已成功导出离线 HTML 报告: ${filename}`);
      }
    } catch (err) {
      store.showToast(`导出失败: ${err instanceof Error ? err.message : String(err)}`, 'err');
    }
  };

  const hasSession = !!store.activeId;

  return (
    <div className="export-tb" ref={ref}>
      <button
        type="button"
        className={`tbtn ${open ? 'open' : ''}`}
        title="导出会话（Markdown / 离线 HTML 报告）"
        disabled={!hasSession}
        onClick={() => setOpen(!open)}
      >
        ⤓
      </button>
      {open && (
        <div className="export-menu" role="menu">
          <div className="export-title">// 导出会话</div>
          <button className="export-item" onClick={() => void onExport('md')}>
            <span className="export-icon">⧉</span>
            <span>导出为 Markdown (.md)</span>
          </button>
          <button className="export-item" onClick={() => void onExport('html')}>
            <span className="export-icon">🌐</span>
            <span>导出为离线 HTML (.html)</span>
          </button>
        </div>
      )}
    </div>
  );
}
