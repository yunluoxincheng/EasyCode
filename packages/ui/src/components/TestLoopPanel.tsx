import type { Settings } from '@easycode/engine';
import { SettingsHelp } from './SettingsHelp.js';

/**
 * 测试自愈循环配置面板（TODOS #39）：自定义测试命令、最大自愈轮次与单次执行超时。
 * 命令留空时按项目类型自动探测（package.json scripts.test / Cargo.toml / go.mod / pyproject.toml 等）。
 */
export function TestLoopPanel({
  draft,
  patch,
}: {
  draft: Settings;
  patch: (p: Partial<Settings>) => void;
}) {
  const cfg = draft.testLoop ?? {};
  const setCfg = (changes: Partial<NonNullable<Settings['testLoop']>>): void => {
    patch({ testLoop: { ...cfg, ...changes } });
  };

  return (
    <div className="general-panel">
      <label className="field">
        <span>自定义测试命令</span>
        <input
          className="input"
          value={cfg.command ?? ''}
          placeholder="留空自动探测，如：pnpm test:unit"
          onChange={(e) => setCfg({ command: e.target.value })}
        />
      </label>
      <label className="field">
        <span>最大自愈轮次（1~5）</span>
        <input
          className="input"
          type="number"
          min={1}
          max={5}
          value={cfg.maxRounds ?? 3}
          onChange={(e) => setCfg({ maxRounds: Number(e.target.value) })}
        />
      </label>
      <label className="field">
        <span>单次测试超时（秒，10~1800）</span>
        <input
          className="input"
          type="number"
          min={10}
          max={1800}
          value={Math.round((cfg.timeoutMs ?? 600_000) / 1000)}
          onChange={(e) => setCfg({ timeoutMs: Number(e.target.value) * 1000 })}
        />
      </label>
      <p className="hint">测试命令整体审批一次；模型修复时的文件改动和命令仍遵守审批与权限规则。</p>
      <p className="hint">使用 <code>/test-loop [聚焦范围]</code> 或 Git 面板中的「运行测试并自愈」启动。</p>
      <SettingsHelp title="自动探测与自愈流程">
        <p className="hint">
          自动探测顺序：<code>package.json</code> 的 <code>scripts.test</code>（按锁文件推断
          pnpm / yarn / bun / npm）→ <code>Cargo.toml</code>（cargo test）→ <code>go.mod</code>
          （go test ./...）→ <code>pyproject.toml</code> 等 Python 标记（python -m pytest）。
          项目级可在工作区根目录放 <code>.easycode/test.json</code>
          （<code>{'{ "command": "...", "maxRounds": 3 }'}</code>）覆盖。
        </p>
        <p className="hint">
          每轮循环会先运行测试；失败则把「失败用例 + 日志摘录 + 当前 git diff」作为反馈交给模型修复，
          修完自动重跑，直至全绿或轮次耗尽。
        </p>
      </SettingsHelp>
    </div>
  );
}
