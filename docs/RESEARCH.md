# 调研报告：桌面端 Coding Agent 产品与技术选型

> 调研日期：2026-09-18

## 1. 竞品调研

| 产品 | 定位 | 核心功能 | 对本项目的启示 |
|---|---|---|---|
| **OpenAI Codex Desktop** | 多 agent 并行编码环境（2026-07 已并入 ChatGPT Desktop） | 多 agent 并行运行/监控/审查、后台运行、桌面控制、持久记忆 | 多会话并行管理是标配；MVP 先做单会话，架构上预留多会话 |
| **Claude Code Desktop** | 重量级 agent 工作台 | 并行会话 + Git worktree 隔离、可拖拽 pane 布局（chat/diff/browser/terminal/file/plan/tasks/subagent）、集成终端与文件编辑器、Routines 定时自动化、沙箱 Bash | Diff 审查、工具调用时间线、**权限审批模式**是桌面 agent 的安全底线 |
| **ZCode Desktop（智谱）** | 轻量级 AI IDE | 文件管理、终端、Git 提交、实时浏览器预览、全上下文感知（工作区/任务/文件引用/**执行模式**）、移动端协作 | 执行模式（approval mode）、工作区感知；"轻量"定位有市场空间 |
| **OpenCode（开源）** | 开源 coding agent，TUI + Desktop + IDE | model-agnostic、75+ Provider、共享同一个 server core | **架构范本**：core 与前端形态彻底解耦 |
| **Conductor / Crystal(→Nimbalyst)** | 多会话管理器 | 并行 Claude Code 会话、git worktree 隔离 | 会话隔离是后续方向 |

### 共性结论
1. 桌面 agent = **会话管理 + Agent 循环（LLM+工具）+ 工作区文件/Shell 能力 + 审批机制 + Diff 审查**。
2. 差异化空间在"轻量 + 模块化"：现有产品要么重（Claude Code Desktop 全家桶），要么绑定单一生态（ZCode/GLM）。
3. 开源界已验证 core/host 分离架构可行（OpenCode）。

## 2. 桌面框架选型

| 维度 | Tauri 2.x | Electron | Neutralino |
|---|---|---|---|
| 安装包体积 | 3–10 MB | 120–200 MB | ~2 MB |
| 空闲内存 | ~40–80 MB | ~150–400 MB | ~30 MB |
| 工具链要求 | **Rust + MSVC** | Node.js | Node.js |
| 进程/系统能力 | Rust 后端，权限细粒度 | 完整 Node.js 主进程 | 有限 |
| 生态成熟度 | 中 | 高 | 低 |

> 来源：[Tech-Insider 对比](https://tech-insider.org)、[Rustify.rs](https://rustify.rs)、[GetHopp 基准](https://www.gethopp.app)

**本机约束**：已安装 Node 24 + pnpm 11，**未安装 Rust 工具链**。

### 决策
- **MVP：Electron 薄壳**（今天即可构建、验证；主进程只做装配，零业务逻辑）。
- **架构上把"壳"隔离**：所有业务逻辑在 `@easycode/core`（纯 TS、零运行时依赖、浏览器可运行），宿主能力（文件/进程/路径）通过 `Host` 接口注入。`packages/desktop` 只是一个 Host 实现 + IPC 桥。
- **v0.2：Tauri 壳**——实现同一个 Host 接口即可整体替换，core/UI/tools 零改动。届时安装包从 ~100MB 降到 ~10MB。

## 3. 是否复用现有开源？
- 直接复用 OpenCode 整体：太重，且深度绑定其插件体系，不符合"自研轻量"目标。
- 复用 Vercel AI SDK：引入较大依赖面，且自研 Provider/Tool 适配层仅 ~400 行，收益不成比例。
- **结论：Build（自研），但借鉴 OpenCode 的 core/server 分层与 Claude Code 的审批模型。** 依赖预算：运行时仅 `react`、`react-dom`、`marked`，其余全部零依赖自研（含 SSE 解析、JSON Schema 校验、行级 diff）。
