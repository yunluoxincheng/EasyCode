import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { TerminalSnapshot } from '@easycode/engine';
import { useStoreApi } from '../useStore.js';
import '@xterm/xterm/css/xterm.css';
import './terminal-panel.css';

export default function TerminalPanel({ sessionId }: { sessionId: string }) {
  const store = useStoreApi();
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal>();
  const current = useRef<TerminalSnapshot | null>(null);
  const lifecycle = useRef(0);
  const [snapshot, setSnapshot] = useState<TerminalSnapshot | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const revision = ++lifecycle.current;
    let active = true;
    let polling = false;
    let cursor = 0;
    let pendingInput = '';
    let writing = false;
    let inputPaused = false;
    current.current = null;
    setSnapshot(null);
    setBusy(true);
    const term = new Terminal({ cursorBlink: true, scrollback: 2000, fontSize: 13,
      fontFamily: 'Consolas, "Cascadia Mono", monospace', theme: { background: '#0b1012', foreground: '#d0ddd4', cursor: '#4cdb8c' },
      allowProposedApi: false });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container.current!);
    terminal.current = term;
    const fail = (reason: unknown) => { if (active && revision === lifecycle.current) setError(reason instanceof Error ? reason.message : String(reason)); };
    const resize = () => {
      if (!active || revision !== lifecycle.current || !container.current?.clientWidth) return;
      fit.fit();
      const s = current.current;
      if (s?.running) void store.client.resizeTerminal!(sessionId, s.id, Math.max(2, Math.min(500, term.cols)), Math.max(2, Math.min(500, term.rows))).catch(fail);
    };
    const append = (s: TerminalSnapshot) => {
      if (!active || revision !== lifecycle.current) return;
      if (s.start > cursor) term.write('\r\n[ 较早输出已超出保留范围 ]\r\n');
      if (s.output) term.write(s.output);
      cursor = s.end;
      current.current = s;
      setSnapshot((previous) => previous?.id === s.id && previous.running === s.running && previous.exitCode === s.exitCode && previous.error === s.error ? previous : s);
    };
    const flushInput = async () => {
      if (!active || revision !== lifecycle.current || inputPaused || writing || !pendingInput) return;
      const id = current.current?.id;
      if (!id || !current.current?.running) return;
      writing = true;
      const data = pendingInput;
      pendingInput = '';
      try { await store.client.writeTerminal!(sessionId, id, data); }
      catch (reason) {
        inputPaused = true;
        pendingInput = '';
        if (active) term.options.disableStdin = true;
        fail(reason);
      } finally {
        writing = false;
        if (active && pendingInput && !inputPaused) void flushInput();
      }
    };
    const input = term.onData((data) => {
      if (!active || revision !== lifecycle.current || inputPaused || !current.current?.running) return;
      if (pendingInput.length + data.length > 65536) {
        inputPaused = true;
        pendingInput = '';
        term.options.disableStdin = true;
        fail('输入超过容量，已暂停接收；请结束并重新打开终端');
        return;
      }
      pendingInput += data;
      void flushInput();
    });
    const observer = new ResizeObserver(resize);
    observer.observe(container.current!);
    void store.client.openTerminal!(sessionId).then(async (s) => {
      if (!active || revision !== lifecycle.current) return;
      append(s);
      resize();
      term.focus();
    }).catch(fail).finally(() => { if (active && revision === lifecycle.current) setBusy(false); });
    const timer = setInterval(() => {
      if (!active || revision !== lifecycle.current || polling || !current.current) return;
      polling = true;
      void store.client.readTerminal!(sessionId, cursor).then((s) => {
        if (!active || revision !== lifecycle.current) return;
        if (s) append(s);
        else if (active) { current.current = null; setSnapshot(null); }
      }).catch(fail).finally(() => { polling = false; });
    }, 100);
    return () => {
      active = false;
      clearInterval(timer);
      observer.disconnect();
      input.dispose();
      term.dispose();
      terminal.current = undefined;
    };
  }, [store, sessionId, generation]);

  const close = async () => {
    if (!snapshot || busy) return;
    setBusy(true);
    setError('');
    lifecycle.current++;
    if (terminal.current) terminal.current.options.disableStdin = true;
    try {
      await store.client.closeTerminal!(sessionId, snapshot.id);
      current.current = null;
      setSnapshot(null);
      terminal.current?.write('\r\n[ 终端已结束 ]\r\n');
    } catch (reason) {
      if (terminal.current) terminal.current.options.disableStdin = false;
      setError(reason instanceof Error ? reason.message : String(reason));
      setGeneration((value) => value + 1);
    }
    finally { setBusy(false); }
  };

  return <section className="interactive-terminal" aria-label="会话终端" onContextMenu={(event) => event.stopPropagation()}>
    <div className="interactive-terminal-head">
      <span title={snapshot?.shell}>{busy ? '[ WAIT ] 正在处理' : snapshot?.running ? '[ OK ] 终端运行中'
        : snapshot?.exitCode != null && snapshot.exitCode !== 0 ? `[ ERR ] Shell 已退出 (${snapshot.exitCode})`
        : snapshot ? '[ WAIT ] Shell 已退出，待清理终端' : '[ OK ] 终端已结束'}</span>
      <span className="interactive-terminal-cwd" title={snapshot?.cwd}>{snapshot?.cwd}</span>
      <button className="btn" disabled={busy || !snapshot?.running} onClick={() => {
        void store.client.writeTerminal!(sessionId, snapshot!.id, '\x03').catch((reason) => setError(String(reason)));
      }}>中断 Ctrl+C</button>
      <button className="btn" onClick={() => {
        const text = terminal.current?.getSelection();
        if (text && navigator.clipboard) void navigator.clipboard.writeText(text).catch(() => setError('复制失败，请使用系统复制快捷键'));
        else if (text) setError('当前环境不支持自动复制，请使用系统复制快捷键');
      }}>复制选中</button>
      {snapshot ? <button className="btn" disabled={busy} onClick={() => void close()}>结束终端</button>
        : <button className="btn" disabled={busy} onClick={() => { setError(''); setGeneration((n) => n + 1); }}>启动终端</button>}
      <button className="btn" onClick={() => store.toggleTerminal()} title="隐藏面板，终端继续运行">隐藏</button>
    </div>
    {(error || snapshot?.error) && <div className="interactive-terminal-error" role="alert">[ ERR ] {error || snapshot?.error}</div>}
    <div className="interactive-terminal-screen" ref={container} />
  </section>;
}
