import { useCallback, useEffect, useState } from 'react';
import { TerminalSelect } from './TerminalSelect.js';
import { SettingsHelp } from './SettingsHelp.js';
import { useStore } from '../useStore.js';
import type { PermissionRule } from '@easycode/core';
import type { Settings } from '@easycode/engine';

/** 可配置规则的工具清单（与内置工具注册表保持一致） */
const TOOL_OPTIONS = [
  { value: '*', label: '* （任意工具）' },
  { value: 'run_command', label: 'run_command （执行命令）' },
  { value: 'read_file', label: 'read_file （读取文件）' },
  { value: 'write_file', label: 'write_file （写入文件）' },
  { value: 'edit_file', label: 'edit_file （编辑文件）' },
  { value: 'list_dir', label: 'list_dir （列出目录）' },
  { value: 'search_files', label: 'search_files （搜索文件）' },
  { value: 'web_search', label: 'web_search （联网搜索）' },
];

const DECISION_LABELS: Record<PermissionRule['decision'], string> = {
  allow: '放行（免审批）',
  ask: '询问（强制确认）',
  deny: '拒绝（禁止执行）',
};

/** 需要路径 glob 的工具（pattern 语义提示用） */
const PATH_TOOLS = new Set(['read_file', 'write_file', 'edit_file', 'list_dir', 'search_files']);

function patternHint(tool: string): string {
  if (tool === 'run_command') return '命令前缀，支持 * 通配（如 git status、pnpm *）';
  if (PATH_TOOLS.has(tool)) return '路径 glob，* 单段 / ** 跨目录（如 .env、src/**）';
  return '该工具不支持匹配模式，留空即作用于全部调用';
}

/**
 * 权限规则配置面板（TODOS #47）：可视化维护 allow / ask / deny 规则。
 * 规则语义：deny > ask > allow；与项目级 `.easycode/permissions.json` 取并集裁决。
 */
export function PermissionRulesPanel({
  draft,
  patch,
}: {
  draft: Settings;
  patch: (p: Partial<Settings>) => void;
}) {
  const store = useStore();
  const workspaceRoot = store.activeSession?.workspaceRoot ?? '';
  const enabled = draft.permissions?.enabled !== false;
  const trustedWorkspaces = draft.permissions?.trustedWorkspaces ?? [];
  const rules = draft.permissions?.rules ?? [];

  // 信任状态与忽略条数一律向引擎查询：路径规范化（分隔符 / Windows 大小写）只有
  // 引擎一份实现，UI 不再自行比对字符串——否则会出现「显示已信任但撤销无效」
  // 这类授权撤销失败（PR #9 第三轮复审 P1）
  const [trusted, setTrusted] = useState(false);
  const [ignoredAllow, setIgnoredAllow] = useState(0);
  const [trustBusy, setTrustBusy] = useState(false);

  const refreshTrust = useCallback(async () => {
    const client = store.client;
    if (!workspaceRoot || !client.isProjectTrusted) {
      setTrusted(false);
      setIgnoredAllow(0);
      return;
    }
    try {
      setTrusted(await client.isProjectTrusted(workspaceRoot));
      setIgnoredAllow(
        client.countIgnoredProjectAllowRules
          ? await client.countIgnoredProjectAllowRules(workspaceRoot)
          : 0,
      );
    } catch {
      // 查询失败时保守展示为未信任，绝不误报「已授权」
      setTrusted(false);
      setIgnoredAllow(0);
    }
  }, [store, workspaceRoot]);

  useEffect(() => {
    void refreshTrust();
  }, [refreshTrust]);

  const toggleTrust = async () => {
    const client = store.client;
    if (!workspaceRoot || !client.setProjectTrust || trustBusy) return;
    setTrustBusy(true);
    try {
      const next = !trusted;
      const updated = await client.setProjectTrust(workspaceRoot, next);
      // 引擎是授权的唯一事实来源：写回后再回读一次，避免 UI 与引擎判断不一致
      store.applySettings(updated);
      // 必须同步设置页草稿（PR #9 第六轮复审 P1）：
      // 草稿只在为 null 时初始化，之后不会跟随 store.settings 变化。若不同步，
      // 用户撤销信任后只要再点「保存设置」，旧草稿就会把刚删掉的授权原样写回，
      // 造成「撤销了但没真正撤销」。这里只覆盖 trustedWorkspaces，
      // 保留草稿中其它未保存的编辑（enabled / rules）。
      patch({
        permissions: {
          enabled: draft.permissions?.enabled !== false,
          rules: draft.permissions?.rules ?? [],
          trustedWorkspaces: updated.permissions?.trustedWorkspaces ?? [],
        },
      });
      await refreshTrust();
      store.showToast(next ? '已信任此项目的 allow 规则' : '已撤销该项目信任');
    } catch (err) {
      store.showToast(err instanceof Error ? err.message : '信任设置失败', 'err');
      await refreshTrust();
    } finally {
      setTrustBusy(false);
    }
  };

  const update = (next: PermissionRule[]): void => {
    patch({ permissions: { enabled, trustedWorkspaces, rules: next } });
  };

  const setRule = (index: number, changes: Partial<PermissionRule>): void => {
    update(rules.map((rule, i) => (i === index ? { ...rule, ...changes } : rule)));
  };

  const removeRule = (index: number): void => {
    update(rules.filter((_, i) => i !== index));
  };

  const addRule = (): void => {
    update([...rules, { tool: 'run_command', pattern: '', decision: 'deny' }]);
  };

  return (
    <div className="general-panel permission-panel">
      <div className="field">
        <span>启用权限规则</span>
        <div className="auto-scroll-row">
          <button
            className={`switch ${enabled ? 'on' : ''}`}
            title={enabled ? '已开启（点击关闭，回到纯 ask / yolo 语义）' : '已关闭（点击开启）'}
            onClick={() =>
              patch({ permissions: { enabled: !enabled, trustedWorkspaces, rules } })
            }
          >
            <span className="knob" />
          </button>
          <span className="auto-scroll-text">
            {enabled ? '开启（规则优先于审批模式）' : '关闭（仅按审批模式放行）'}
          </span>
        </div>
      </div>

      <div className="field">
        <span>项目级 allow 信任</span>
        <div className="perm-trust">
          {!workspaceRoot ? (
            <span className="auto-scroll-text">未绑定工作区（先绑定项目再设置信任）</span>
          ) : (
            <>
              <code className="perm-trust-path" title={workspaceRoot}>
                {workspaceRoot}
              </code>
              <button
                className={`btn ${trusted ? 'primary' : ''}`}
                disabled={trustBusy}
                title={
                  trusted
                    ? '该项目自带的 allow 规则当前生效（点击撤销）'
                    : '该项目自带的 allow 规则被忽略（点击信任以启用）'
                }
                onClick={() => void toggleTrust()}
              >
                {trustBusy ? '[ WAIT ] 处理中' : trusted ? '[ OK ] 已信任此项目' : '信任此项目'}
              </button>
            </>
          )}
        </div>
        <span className="auto-scroll-text">
          {trusted
            ? '已信任：该项目自带 allow 规则会生效，请确认仓库来源可信'
            : '未信任（推荐）：项目级 deny / ask 生效，allow 被忽略'}
        </span>
        {ignoredAllow > 0 && (
          <span className="auto-scroll-text perm-ignored">
            [ DENY ] {ignoredAllow} 条项目级 allow 规则已被忽略
          </span>
        )}
      </div>

      <div className="perm-list">
        {rules.length === 0 && (
          <div className="perm-empty">
            尚未配置任何规则。示例：对 <code>run_command</code> + <code>rm</code> 设为「拒绝」，
            对 <code>pnpm test</code> 设为「放行」，即可在 YOLO 模式下依然守住破坏性命令。
          </div>
        )}
        {rules.map((rule, index) => (
          <div className="perm-row" key={index}>
            <div className="perm-row-main">
              <TerminalSelect
                value={rule.tool}
                options={TOOL_OPTIONS}
                onChange={(v) => setRule(index, { tool: v })}
              />
              <input
                className="input perm-pattern"
                value={rule.pattern ?? ''}
                placeholder={patternHint(rule.tool)}
                title={patternHint(rule.tool)}
                onChange={(e) => setRule(index, { pattern: e.target.value })}
              />
              <TerminalSelect
                value={rule.decision}
                options={(['deny', 'ask', 'allow'] as const).map((d) => ({
                  value: d,
                  label: DECISION_LABELS[d],
                }))}
                onChange={(v) =>
                  setRule(index, { decision: v as PermissionRule['decision'] })
                }
              />
              <button
                className="btn perm-remove"
                title="删除该规则"
                onClick={() => removeRule(index)}
              >
                [ DEL ]
              </button>
            </div>
            <input
              className="input perm-note"
              value={rule.note ?? ''}
              placeholder="备注（可选，显示在审批卡片与拒绝提示中）"
              onChange={(e) => setRule(index, { note: e.target.value })}
            />
          </div>
        ))}
      </div>

      <div className="perm-actions">
        <button className="btn" onClick={addRule}>
          [ ADD ] 添加规则
        </button>
      </div>

      <p className="hint">拒绝优先于询问，询问优先于放行；YOLO 也必须遵守拒绝和强制询问规则。</p>
      <p className="hint">命令审批不提供进程沙箱，不能逐条限制脚本或间接执行的命令。仅信任来源可靠的项目与脚本。</p>
      <SettingsHelp title="规则匹配与项目配置">
        <p className="hint">
          裁决语义：任一命中规则为「拒绝」即拒绝；否则任一「询问」即在 YOLO 模式下也强制弹窗；
          否则任一「放行」即跳过审批。命令匹配会先剥离 <code>FOO=1</code> /{' '}
          <code>FOO="a b"</code> 环境变量前缀并解包 <code>powershell -c</code> /{' '}
          <code>cmd /c</code> 包装，无法用前缀绕过拒绝规则。路径匹配<strong>复用文件工具的真实解析入口</strong>
          （先按宿主语义把参数解析为绝对路径、校验是否在工作区内，再折算相对路径做 glob），
          因此 <code>src/tmp/../private</code>、<code>../ws/private</code> 这类写法都会命中同一条规则。
        </p>
        <p className="hint">
          项目级规则可放在工作区根的 <code>.easycode/permissions.json</code>
          （<code>{'{ "rules": [ ... ] }'}</code>），与全局规则取并集裁决；非法条目会被跳过而不会让整份配置失效。
          出于信任边界考虑，项目级 <code>deny</code> / <code>ask</code> 默认生效（只会收紧权限），
          项目级 <code>allow</code> 默认<strong>被忽略</strong>——克隆来的仓库不得自行取消你的审批保护。
          信任是<strong>按工作区授予</strong>的（上方「项目级 allow 信任」），信任项目 A 不会连带放宽项目 B、C。
        </p>
        <p className="hint">
          <strong>边界说明：</strong>这里配置的是<strong>命令级审批策略</strong>，不是进程级安全沙箱。
          它按命令前缀做匹配，无法阻止间接执行——例如 <code>package.json</code> 的{' '}
          <code>scripts.test</code> 内部可以跑任意命令，此时被检查的是 <code>pnpm test</code> 而不是
          展开后的每条语句；<code>a &amp;&amp; b</code>、管道与脚本同样不在匹配范围内。
          需要强隔离请依赖操作系统级沙箱。
        </p>
      </SettingsHelp>
    </div>
  );
}
