import { useEffect, useState } from 'react';
import { validateMcpServers, type McpServerConfig, type McpServerStatus, type Settings } from '@easycode/engine';
import { useStore } from '../useStore.js';
import { SettingsHelp } from './SettingsHelp.js';

interface Props {
  draft: Settings;
  patch(value: Partial<Settings>): void;
  save(): Promise<void>;
  discard(): void;
  dirty: boolean;
  saving: boolean;
}

export function McpSettingsPanel({ draft, patch, save, discard, dirty, saving }: Props) {
  const store = useStore();
  const servers = draft.mcpServers ?? {};
  const [statuses, setStatuses] = useState<McpServerStatus[]>([]);
  const [newId, setNewId] = useState('');
  const [json, setJson] = useState<string | null>(null);
  const [argsDraft, setArgsDraft] = useState<Record<string, string>>({});
  const [invalidArgs, setInvalidArgs] = useState<Record<string, boolean>>({});
  const [envInput, setEnvInput] = useState<Record<string, { name: string; value: string }>>({});
  const [retrying, setRetrying] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let pending = false;
    const refresh = async () => {
      if (pending || !store.client.getMcpServers) return;
      pending = true;
      try { const list = await store.client.getMcpServers(); if (active) setStatuses(list); }
      catch { /* 设置页保存/重连有独立错误提示；轮询不反复弹 Toast。 */ }
      finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => { active = false; clearInterval(timer); };
  }, [store.client]);

  const update = (id: string, value: Partial<McpServerConfig>) => patch({
    mcpServers: { ...servers, [id]: { ...servers[id], ...value } },
  });
  const fail = (error: unknown) => store.showToast(error instanceof Error ? error.message : 'MCP 配置无效', 'err');
  const retry = async (id: string) => {
    setRetrying(id);
    try { await store.client.retryMcpServer?.(id); }
    catch (error) { fail(error); }
    finally { setRetrying(null); }
  };
  const applyJson = () => {
    try {
      const parsed = JSON.parse(json ?? '{}');
      const configs = parsed.mcpServers ?? parsed;
      validateMcpServers(configs);
      patch({ mcpServers: configs });
      setArgsDraft({}); setInvalidArgs({}); setEnvInput({}); setJson(null);
    } catch (error) { fail(error); }
  };
  const add = () => {
    try {
      if (!newId || Object.hasOwn(servers, newId)) throw new Error('请填写未占用的服务名');
      const next = { ...servers, [newId]: { command: 'npx', args: [], enabled: false } };
      validateMcpServers(next);
      patch({ mcpServers: next }); setNewId('');
    } catch (error) { fail(error); }
  };
  const stageEnv = (id: string) => {
    const input = envInput[id];
    try {
      if (!input?.name) throw new Error('请填写环境变量名');
      const next = { ...servers[id], env: { ...servers[id].env, [input.name]: input.value },
        clearEnv: servers[id].clearEnv?.filter((name) => name !== input.name) };
      validateMcpServers({ [id]: next });
      update(id, next); setEnvInput((all) => ({ ...all, [id]: { name: '', value: '' } }));
    } catch (error) { fail(error); }
  };

  return <>
    <h1 className="page-title">MCP 扩展</h1>
    <div className="page-head">
      <p className="page-desc">连接本机 Stdio MCP 服务，发现外部工具和 Prompt。</p>
      <div className="page-actions">
        <button className="btn" onClick={() => setJson(JSON.stringify({ mcpServers: servers }, null, 2))}>JSON 配置</button>
        <button className="btn" disabled={!dirty && !Object.keys(argsDraft).length && !Object.keys(envInput).length} onClick={() => { discard(); setArgsDraft({}); setInvalidArgs({}); setEnvInput({}); setJson(null); }}>放弃更改</button>
        <button className="btn primary" disabled={!dirty || saving || Object.values(invalidArgs).some(Boolean) || json !== null} onClick={() => void save()}>
          {saving ? '保存中…' : '保存并应用'}
        </button>
      </div>
    </div>
    <p className="hint">保存会启动本机进程，仅运行可信服务。进程拥有当前用户权限，工具审批不提供文件沙箱，外部改动不进入回合快照。</p>
    <p className="hint">环境值按「常规」中的密钥存储方式保存，已保存值不回显；勿将密钥写入命令参数。</p>
    <SettingsHelp title="MCP 配置与容量说明">
      <p className="hint">仅支持 Stdio，工具继承当前审批模式。参数使用 JSON 字符串数组，工作目录填写绝对路径。</p>
      <p className="hint">每回合含内置工具最多 128 个，外部工具规格总量最多 512 KiB；超出时请停用不需要的服务。</p>
    </SettingsHelp>
    {json !== null && <div className="mcp-config-box">
      <label className="field"><span>mcpServers JSON（应用到草稿后仍需保存）</span>
        <textarea rows={12} value={json} spellCheck={false} onChange={(e) => setJson(e.target.value)} />
      </label>
      <div className="row"><button className="btn" onClick={applyJson}>应用到草稿</button><button className="btn" onClick={() => setJson(null)}>关闭 JSON</button></div>
    </div>}
    <div className="mcp-add row">
      <input aria-label="新 MCP 服务名" value={newId} maxLength={20} placeholder="服务名，例如 filesystem" onChange={(e) => setNewId(e.target.value)} />
      <button className="btn" onClick={add}>添加服务</button>
    </div>
    {Object.entries(servers).map(([id, config]) => {
      const status = statuses.find((s) => s.id === id);
      const names = [...new Set([...(config.envConfigured ?? []), ...Object.keys(config.env ?? {})])];
      return <section className="mcp-config-box" key={id} aria-label={`MCP ${id}`}>
        <div className="mcp-card-head">
          <strong>{id}</strong>
          <span className={`mcp-state ${status?.state ?? 'disabled'}`}>{status?.state === 'ready' ? `[ OK ] ${status.toolCount} 工具 / ${status.promptCount} Prompt`
            : status?.state === 'connecting' ? '[ WAIT ] 连接中' : status?.state === 'error' ? '[ ERR ] 连接失败' : '[ WAIT ] 未连接'}</span>
          <button className={`switch ${config.enabled !== false ? 'on' : ''}`} role="switch" aria-checked={config.enabled !== false} aria-label={`启用 ${id}`}
            onClick={() => update(id, { enabled: config.enabled === false })}><span className="knob" /></button>
          <button className="btn" disabled={retrying !== null || dirty || config.enabled === false} onClick={() => void retry(id)}>{retrying === id ? '重连中…' : '重连'}</button>
          <button className="btn danger" onClick={() => {
            const next = { ...servers }; delete next[id]; patch({ mcpServers: next });
            setInvalidArgs((all) => { const remaining = { ...all }; delete remaining[id]; return remaining; });
            setArgsDraft((all) => { const remaining = { ...all }; delete remaining[id]; return remaining; });
            setEnvInput((all) => { const remaining = { ...all }; delete remaining[id]; return remaining; });
          }}>移除</button>
        </div>
        {status?.error && <p className="hint">{status.error}</p>}
        <div className="mcp-fields">
          <label className="field"><span>命令</span><input value={config.command} placeholder="npx / node / 可执行文件路径" onChange={(e) => update(id, { command: e.target.value })} /></label>
          <label className="field"><span>工作目录（可选）</span><input value={config.cwd ?? ''} placeholder="绝对路径；留空使用应用数据目录" onChange={(e) => update(id, { cwd: e.target.value || undefined })} /></label>
          <label className="field mcp-wide"><span>参数数组</span><textarea rows={2} spellCheck={false}
            value={argsDraft[id] ?? JSON.stringify(config.args ?? [])}
            onChange={(e) => {
              const value = e.target.value;
              setArgsDraft((all) => ({ ...all, [id]: value }));
              try {
                const args = JSON.parse(value); validateMcpServers({ [id]: { ...config, args } });
                update(id, { args }); setInvalidArgs((all) => ({ ...all, [id]: false }));
              } catch { setInvalidArgs((all) => ({ ...all, [id]: true })); }
            }} /></label>
        </div>
        {invalidArgs[id] && <p className="hint">[ ERR ] 参数必须是有效的 JSON 字符串数组；修正后才能保存。</p>}
        <div className="mcp-env">
          <span>环境变量</span>
          {names.map((name) => <div className="row" key={name}>
            <code>{name}</code><span className="hint">{config.clearEnv?.includes(name) ? '待清除' : Object.hasOwn(config.env ?? {}, name) ? '新值待保存' : '已保存，值隐藏'}</span>
            <button className="btn" onClick={() => {
              const env = { ...config.env }; delete env[name];
              update(id, { env, clearEnv: [...new Set([...(config.clearEnv ?? []), name])] });
            }}>清除</button>
          </div>)}
          <div className="row">
            <input aria-label={`${id} 环境变量名`} value={envInput[id]?.name ?? ''} placeholder="变量名" onChange={(e) => setEnvInput((all) => ({ ...all, [id]: { value: all[id]?.value ?? '', name: e.target.value } }))} />
            <input aria-label={`${id} 环境变量值`} type="password" autoComplete="new-password" value={envInput[id]?.value ?? ''} placeholder="新值（不会回显已保存值）" onChange={(e) => setEnvInput((all) => ({ ...all, [id]: { name: all[id]?.name ?? '', value: e.target.value } }))} />
            <button className="btn" onClick={() => stageEnv(id)}>设置变量</button>
          </div>
        </div>
      </section>;
    })}
    {statuses.filter((s) => !Object.hasOwn(servers, s.id) && s.state === 'error').map((s) =>
      <p className="hint" key={s.id}>[ ERR ] {s.id} 的旧进程清理失败 <button className="btn" onClick={() => void retry(s.id)}>重试清理</button></p>)}
    {!Object.keys(servers).length && <p className="hint">尚未配置 MCP 服务。可以添加服务或导入 mcpServers JSON。</p>}
  </>;
}
