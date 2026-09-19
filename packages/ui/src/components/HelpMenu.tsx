import { useEffect, useRef, useState } from 'react';
import { useStore } from '../useStore.js';
import { updater } from '../updater.js';

const DOCS_URL = 'https://github.com/yunluoxincheng/EasyCode#readme';
const ISSUES_URL = 'https://github.com/yunluoxincheng/EasyCode/issues';

/** 标题栏帮助菜单：产品文档 / 问题上报 / 检查更新 / 关于 */
export function HelpButton() {
  const store = useStore();
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const openExternal = async (url: string): Promise<void> => {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(url);
      setOpen(false);
    } catch (err) {
      store.showToast(`打开链接失败: ${err instanceof Error ? err.message : String(err)}`, 'err');
    }
  };

  const checkUpdate = async (): Promise<void> => {
    if (!updater.isSupported) {
      store.showToast('当前环境不支持应用内更新');
      return;
    }
    setChecking(true);
    try {
      await updater.check(false);
      const k = updater.phase.kind;
      if (k === 'available') {
        store.showToast(`发现新版本 v${updater.phase.version}，侧栏 ⤓ 可下载安装`);
        setOpen(false);
      } else if (k === 'latest') {
        store.showToast('已是最新版本');
      } else if (k === 'error') {
        store.showToast(`检查更新失败：${updater.phase.message}`, 'err');
      }
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="help-tb" ref={ref}>
      <button
        type="button"
        className="tbtn"
        title="帮助"
        onClick={() => setOpen(!open)}
      >
        ?
      </button>
      {open && (
        <div className="help-menu" role="menu">
          <button className="help-item" onClick={() => void openExternal(DOCS_URL)}>
            产品文档
          </button>
          <button className="help-item" onClick={() => void openExternal(ISSUES_URL)}>
            问题上报
          </button>
          <div className="help-sep" />
          <button
            className="help-item"
            disabled={checking}
            onClick={() => void checkUpdate()}
          >
            {checking ? '正在检查更新…' : '检查更新'}
          </button>
          <button
            className="help-item"
            onClick={() => {
              setOpen(false);
              store.openSettings('about');
            }}
          >
            关于 EasyCode
          </button>
        </div>
      )}
    </div>
  );
}
