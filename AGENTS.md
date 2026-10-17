# AGENTS.md — EasyCode Agent 接手与工程总纲

> 本文件是所有参与 EasyCode 项目研发、维护与协作的 AI Coding Agent（包括 EasyCode 自身、ZCode、Claude Code、Cursor 等）的**顶级工程指引与行动纲领**。
>
> 任何进入本项目的 Agent 必须首先完整阅读本文件，并严格执行其中定义的所有架构红线、工程纪律与审查标准。

---

## 1. 项目定位与核心技术栈

- **产品定位**：EasyCode 是一款面向全栈开发者的**极客终端风、轻量高模块化桌面 Coding Agent**（产品与体验对标 Codex、Claude Code、ZCode Desktop）。
- **技术栈规范**：
  - **Monorepo 管理**：`pnpm` workspace。
  - **前端视图层 (`packages/ui`)**：React 18 + 纯自绘 CSS 终端风格组件。**严禁引入通用外部 UI 组件库（如 antd/shadcn/mui）**，全局禁用 Emoji，统一采用状态标记（`[ OK ]` / `[ ERR ]` / `[ WAIT ]` / `[ DENY ]`），下拉一律采用自绘 `TerminalSelect`。
  - **核心引擎层 (`packages/core` & `packages/engine`)**：纯 TypeScript 编写，负责 Agent 执行循环、消息协议、工具注册表、审批策略、会话管理、配置持久化与调度器。
  - **双宿主外壳**：
    - **生产主力壳 (`packages/desktop-tauri` + `packages/host-tauri`)**：Tauri 2.0 (Rust) + TS Host 适配层，完整核心引擎与 UI 均运行在 WebView 内，Rust 仅提供底层宿主命令代理；
    - **辅助/备用壳 (`packages/desktop`)**：Electron 薄壳（零业务逻辑）。
  - **大模型接入**：**零第三方商业 SDK**，基于原生 Fetch 纯手写 SSE 解析器，支持 OpenAI 兼容、Anthropic Messages、Responses API 以及自建联网搜索。

---

## 2. 架构三原则与神圣红线（绝对不可侵犯）

1. **依赖单向流动**：
   - 依赖链路必须严格单向：`ui → engine → core ← host`。
   - **`packages/core` 必须保持绝对纯洁**：零运行时依赖、零 Node 原生 API、零 Electron/React 概念（必须能够在标准浏览器沙箱中脱机运行）。
2. **能力完全注入 (Host-Injected)**：
   - 一切文件读写、进程运行、网络代理、操作系统路径与数据目录，一律通过 `Host` 抽象接口注入。`core` 面向接口编程，不直接触碰物理平台。
3. **工具与适配器全注册制**：
   - 工具（`ToolRegistry`）与模型服务（Provider）均为即插即用注册制，严禁侵入核心循环 `runAgentLoop` 的主干控制流。
4. **Tauri 极薄宿主原则**：
   - Rust 侧代码（`packages/desktop-tauri/src-tauri`）**只提供宿主底层 IO 命令**（`fs_*`, `proc_*`, `http_stream`, `net_probe`, 托盘与系统通知），**核心业务逻辑坚决零 Rust 化**。

---

## 3. 核心纪律与工作流铁律（踩线即视为严重事故）

用户具备极其深厚的技术功底，会对所有提交代码执行严格的**静态代码审查**并给出 P1/P2 级结论。请谨记以下铁律：

### 3.1 Git 与分支工作流
- **禁止直接推送默认分支 `master`**：所有功能、修复与文档，一律开辟新分支（如 `feat/xxx`, `fix/xxx`, `docs/xxx`, `chore/xxx`）。
- **PR 合并必须使用 Merge Commit，严禁 Squash**：合并必须使用 `gh pr merge <PR编号> --merge`。因为审查过程中“初版 → 审查发现问题 → 返工修复 → 收敛”的提交轨迹具有极高的工程回溯价值，绝不能压扁。
- **审查通过 ≠ 自动合并**：代码审查完成后，是否执行 merge 必须由用户显式批准；
- **PR 合并 ≠ 自动发布**：向远程推送 Tag（如 `git tag v0.1.x`）会触发 GitHub Actions 编译发布跨平台安装包，**打 Tag 与推 Tag 必须由用户明确下达指令，禁止擅自触发**。
- **并行操作防碰撞**：用户经常在本地并行执行 Git 操作。在做任何分支切换、新建分支或 rebase 之前，**必须先执行 `git status` 和 `git reflog`** 确认 HEAD 状态；发现非自己创建的提交，先 `git show` 确认，切勿盲目裹进自己的 PR 中。

### 3.2 变更与版本管理
- **提交前必须更新 `CHANGELOG.md`**：正式发布说明直接截取自 CHANGELOG 对应版本段落；非功能性或未发布变更记录在 `## [未发布]` 段。
- **版本号单一事实来源**：应用版本号仅在 `packages/desktop-tauri/src-tauri/tauri.conf.json` 中维护（各 `package.json` 的 version 恒为 0.1.0）。
- **版本批次纪律**：任何新需求或即使只有一行的微小优化，**一律先记录到 `docs/TODOS.md`**，随版本排期批量推进，严禁“想到哪改到哪”。

### 3.3 验证与测试铁律
- **严禁用 Mock / 假数据糊弄功能验证**：用户拥有完整的真实基础设施（自建 SearXNG 搜索、真实 API 网关、真实 Key）；凡可由真实环境验证的，交由用户验证；不得私自搭建持久 mock 服务，临时脚本必须测完彻底清理。
- **UI 交互必须在真实桌面端实测**：jsdom / RTL 无法测真实滚动条、ResizeObserver 与布局贴底；测试前必须先 `pnpm build` 重建 UI 产物，再启动应用验证。
- **严谨客观陈述**：交付总结严格区分“机制已落地”与“收益已证明”，未做 Benchmark 的性能切勿盲目宣称指标；如实区分本地测试证据与 GitHub CI 证据。
- **跨平台语义是合并阻塞项**：开发机为 Windows 也绝不能放水 Unix 进程组生命周期等平台抽象。

---

## 4. 规范与记忆文档体系

为了便于系统化查阅与长期演进，工程详细规范与历史记忆已沉淀为以下专门文档：

- 📜 **[rules.md](rules.md)**：**工程规范与行为守则**
  - 详细的架构与编码纪律（状态管理、样式隔离、吸顶补偿、零依赖沙箱）；
  - Git 与 PR 完整作业指南、并发安全与防碰撞机制；
  - 静态代码审查应对标准与交付清单。
- 🧠 **[memory.md](memory.md)**：**项目记忆库与避坑血泪史**
  - 项目前世今生与各版本关键技术里程碑；
  - 核心架构决策背景（为什么不用商业 SDK、为什么做进程组真树杀等）；
  - 历史技术暗坑全景剖析（Tauri IPC 死锁、TOML 段落顺序、分词崩溃、编码乱码等）；
  - 真实基础设施配置与隔离实测工装。
- 📋 **[docs/TODOS.md](docs/TODOS.md)**：**需求记录簿**
  - 所有新需求、新 Feature、待办项的唯一登记中心；新灵感先入库、排期再实现。
- 🗺️ **[docs/PLAN.md](docs/PLAN.md)**：**长期技术方案与里程碑规划**。
- 📝 **[CHANGELOG.md](CHANGELOG.md)**：**全版本变更日志**。

---

## 5. 快速上手常用命令

```bash
# 1. 依赖安装与工作区完整编译
pnpm install
pnpm -r run build

# 2. 运行单测（core 核心逻辑全覆盖）
pnpm --filter @easycode/core test

# 3. 启动桌面端调试
pnpm --filter @easycode/desktop run dev         # Electron 调试壳
pnpm --filter @easycode/desktop-tauri run tauri:build --debug # Tauri 调试构建

# 4. Git 规范操作流程
git status && git reflog -n 5                   # 先确认现场
git switch -b feat/<your-feature-name>          # 检出新分支
# 开发、更新 CHANGELOG.md 并跑通测试
git add .
git commit -m "feat(...): 规范描述"
git push -u origin feat/<your-feature-name>
gh pr create                                    # 创建 PR 并贴入清晰描述
# 审查通过并获得用户授权后：
gh pr merge <PR编号> --merge
git switch master && git pull
```
