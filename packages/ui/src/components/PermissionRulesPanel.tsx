import { TerminalSelect } from './TerminalSelect.js';
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
  const enabled = draft.permissions?.enabled !== false;
  const rules = draft.permissions?.rules ?? [];

  const update = (next: PermissionRule[]): void => {
    patch({ permissions: { enabled, rules: next } });
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
              patch({ permissions: { enabled: !enabled, rules } })
            }
          >
            <span className="knob" />
          </button>
          <span className="auto-scroll-text">
            {enabled ? '开启（规则优先于审批模式）' : '关闭（仅按审批模式放行）'}
          </span>
        </div>
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
                ✕
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
          ＋ 添加规则
        </button>
      </div>

      <p className="hint">
        裁决语义：任一命中规则为「拒绝」即拒绝；否则任一「询问」即在 YOLO 模式下也强制弹窗；
        否则任一「放行」即跳过审批。命令匹配会先剥离 <code>FOO=1</code> 环境变量前缀并解包
        <code> powershell -c</code> / <code>cmd /c</code> 包装，无法用前缀绕过拒绝规则。
      </p>
      <p className="hint">
        项目级规则可放在工作区根的 <code>.easycode/permissions.json</code>
        （<code>{'{ "rules": [ ... ] }'}</code>），与全局规则取并集裁决；非法条目会被跳过而不会让整份配置失效。
      </p>
    </div>
  );
}
