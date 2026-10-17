# memory.md — EasyCode 项目记忆与踩坑血泪史

> 本文件完整沉淀了 EasyCode 自 2026-09-18 诞生以来的**所有核心设计决策背景、重大技术演进脉络、避坑血泪史与基础设施实战经验**。供后续所有接手 Agent 深度研读，避免在已知暗坑中重复触雷。

---

## 1. 项目前世今生与演进里程碑

### 1.1 起源与初心
- **启动时间**：2026-09-18。
- **目标**：打造一款对标 Codex、Claude Code、ZCode Desktop 的**极客终端风、轻量、高模块化桌面 Coding Agent**。
- **初版验证**：短时间内完成了基于 Electron 薄壳与 NodeHost 的全流程 MVP 端到端验证。

### 1.2 核心版本演进树
- **v0.1.0 ~ v0.1.5 (2026-09-19 ~ 09-20)**：
  - 确立终端风视觉语言（绿色 `▚` + `EASYCODE` 品牌标、纯黑背景、终端状态标签）；
  - 落地设置页（模型服务、常规偏好、关于）、自绘 `TerminalSelect`；
  - 侧栏更新角标（`⤓`）、标题栏帮助菜单、Toast 体系（`[ OK ]` / `[ ERR ]`）；
  - 落地内置 `web_search()` 联网搜索（对接用户自建 SearXNG / Tavily / Custom API）；
  - 落地模型元数据多层级目录（API / models.dev / 内置 CATALOG / 启发式），模型智能参数探测。
- **v0.1.6 ~ v0.1.9 (2026-09-20 ~ 09-21)**：
  - 用户体验打磨：回合聚合（折叠过程只留最终文本）、用时统计、左侧时间线刻度导航、用户消息复制与编辑重发、输入框历史（↑/↓）；
  - 贴底跟随与回到底部浮动按钮；
  - edit_file 强制“先读后改”安全守卫；
  - 单次任务最大步数配置（缺省 200）；
  - 桌面通知完成提醒与点击唤起、外部文件管理器 / VS Code 打开工作区；
  - 消除标题栏硬编码版本号，全面接入动态版本。
- **v0.1.16 ~ v0.1.20 (2026-09-21 ~ 09-22)**：
  - 会话导出功能（结构化 Markdown 与离线单文件 HTML 报告）；
  - 会话多入口分叉（`forkSession`）；
  - 多会话并发执行与 0ms 瞬切（`SessionViewState` 状态隔离池 + 引擎端 `WorkspaceLockManager` 工作区写入互斥锁）；
  - 模型热切换上下文安全预警（`<ModelSwitchGuardModal>` 80% 阈值保护）；
  - 阶梯式上下文自动压缩（`pruneHistoricalToolResults` 第一级工具长输出折叠 + `compactHistoryMessages` 第二级阶段记忆归档）；
  - Composer `/` 斜杠指令系统（`/commit`, `/review`, `/test`, `/fix`, `/compact`, `/fork`, `/export` 与项目级自定义指令合流）；
  - 项目行为规范系统（Rules System: `.easycoderules` > `AGENTS.md` > `CLAUDE.md` 等自动探测）；
  - 工作区 Git 状态胶囊与全尺寸 Git 审查面板（`<GitInspectorModal>`）；
  - 自绘极客终端风全局右键菜单（`<ContextMenu>`）、关闭窗口最小化至系统托盘。
- **v0.1.21 (2026-09-24)**：
  - 端侧微决策小模型（Reflex ~22M DeBERTa-v3 QInt8）影子模式接入（Shadow Mode）；
  - WebAssembly SIMD 端侧本地推理（`onnxruntime-web`），5 大关键决策点旁路观测；
  - 证据驱动的弱监督 Silver 微调集一键导出。
- **v0.1.22 (2026-09-29)**：
  - 流式渲染性能优化（活跃流式期间尾部未闭合代码块跳过全量 hljs 正则分词）；
  - 双层视口智能贴底跟随重构（基于 ResizeObserver 的智能贴底锁定器、内外视口独立贴底状态机）。
- **v0.1.23 (2026-10-12)**：
  - 长期运行后台进程管理与端口探测（#37）：`run_command` 扩展 `background` 参数、双宿主真树杀（Windows `taskkill /T /F`，Unix 完整进程组生命周期管理）、ANSI 终端日志抽屉；
  - 内嵌 Web 预览面板（#44）：右侧滑出分栏、跟随后台任务增量刷新、任务条联动一键内嵌预览；
  - 启动白屏加固：修复特殊 token 字面量引起的分词崩溃，根组件挂载 `ErrorBoundary`。
- **v0.2 核心蜕变（Tauri 壳）**：
  - 引入 `packages/host-tauri` + `packages/desktop-tauri`，WebView 内存仅 ~30MB，完整引擎平滑迁移至 WebView 内。

---

## 2. 关键架构决策与背景（Why & Trade-offs）

### 2.1 为什么坚决不使用官方商业 SDK？
- **背景**：绝大部分 Agent 开源项目普遍重度依赖 `@anthropic-ai/sdk`、`openai` 等官方 npm 包。
- **原因**：
  1. 商业 SDK 依赖体积庞大，打包后会显著拖慢启动与运行内存；
  2. 各大商业 SDK 的类型定义与流式事件协议各异，强行引入会导致适配层充斥着胶水代码；
  3. 自研原生 Fetch + SSE 解析器极其小巧灵活，能以最轻量级的代码统一归一化各大服务商的消息格式（包括 OpenAI 兼容格式、Anthropic Messages、智谱/Responses API、Ollama 本地服务），并对思考流（thinking / reasoning_content）与并行工具调用进行精确无误的统一处理。

### 2.2 为什么坚持依赖单向与 Host 接口注入？
- **背景**：`packages/core` 是系统的心脏。
- **原因**：如果让 core 直接依赖 `fs`、`child_process` 或 Electron，EasyCode 将被牢牢钉死在特定的桌面运行时上。通过 `Host` 依赖注入，系统实现了极致解耦：
  - 桌面生产环境：注入 `TauriHost`（经 Rust IPC 执行原生命令与文件操作）；
  - 桌面调试环境：注入 `NodeHost`（经 Node 原生模块执行）；
  - 单元测试与浏览器演示：注入 `MemoryHost`（内存文件系统与模拟进程）。
  - 这一设计使得核心业务层未来可以无痛移植到任何平台（包括 Web、移动端、服务器端容器）。

### 2.3 为什么 UI 坚持纯手绘极客终端风格？
- **背景**：用户早期评审了 15 种视觉原型（包括冷灰极简、紫光玻璃等），最终敲定极客暗黑终端风。
- **原因**：通用 UI 库（如 Ant Design 或 Material UI）具有强烈的 Web 管理后台风格，与沉浸式沉浸编码的心流格格不入。自绘暗黑终端风格（纯 CSS `styles.css`，自绘 TerminalSelect，按钮括号装饰）不仅视觉极具极客美感，而且实现了**零外部 UI 框架依赖**，打包产物体积极小、无样式冲突、全键盘操作丝滑。

### 2.4 为什么 PR 合并严禁 Squash？
- **背景**：常规开源项目推崇 squash 保持 master 线性清爽。
- **原因**：EasyCode 具有极其严格的代码审查文化。审查过程中往往会经历多轮“初版 → 审查指出缺陷 → 返工修复 → 边界收敛”。这些 commit 串联起了一段极为清晰的工程推演与设计决策脉络，保留完整的 merge commit 比压扁为一个粗暴的提交更有技术回溯与学习价值。

---

## 3. 技术暗坑全景剖析与避坑血泪史

### 3.1 【致命死锁】Tauri IPC fetch 代理拦截陷阱
- **现象**：Tauri 桌面端启动后，发送消息或调用命令时，进程无响应，内存以每秒数十兆速度飙升至 800MB+，最终报 `postMessage Invalid string length` 崩溃。
- **根因**：为了实现 HTTP 请求代理与绕过 WebView CORS，我们在前端全局拦截了 `window.fetch`。然而 **Tauri 2.0 自身的 WebView IPC 机制在底层正是通过请求 `http://ipc.localhost` 实现的**！拦截 fetch 导致 Tauri 自身的 IPC 请求被递归截获并发起无限重入，造成致命死锁。
- **军规**：**在任何 fetch 拦截或代理逻辑中，必须无条件放行 `*.localhost`、`localhost` 和 `127.0.0.1`**：
  ```ts
  const urlObj = new URL(url, window.location.href);
  if (urlObj.hostname === 'localhost' || urlObj.hostname.endsWith('.localhost') || urlObj.hostname === '127.0.0.1') {
    return originalFetch(input, init);
  }
  ```

### 3.2 【跨平台编译】Cargo.toml 表头位置陷阱
- **现象**：本地 Windows 上执行 `cargo check` 和 `cargo build` 畅通无阻，但推送远程触发 GitHub Actions 三平台 CI 时，Linux 和 macOS 构建全部报错，大量核心依赖（reqwest, tokio, futures-util）报 `unresolved import`。
- **根因**：往 `Cargo.toml` 中添加 Windows 专用依赖 `[target.'cfg(windows)'.dependencies]` 时，如果错误地插在了通用 `[dependencies]` 段落的**中间**，其后所有的通用依赖都会被 Cargo 静默当作 Windows 专有依赖！在 Linux/macOS 上这些依赖直接被忽略。
- **军规**：**Cargo.toml 中的所有 `[target.'...'.dependencies]` 条件依赖段落，必须无条件放在整个文件的最末尾！**

### 3.3 【构建缓存】Rust 静态资源嵌入缓存
- **现象**：修改了 UI 代码并执行了 `pnpm -r run build`，但重新启动 Tauri 调试应用后，界面没有任何变化。
- **根因**：Tauri 的 `generate_context!` 宏在编译阶段将静态资源嵌入二进制，Rust 编译器检测到 Rust 代码本身没有改动时，会命中编译缓存，跳过资源重新打包。
- **军规**：更新 UI 代码后，编译前必须执行 `touch packages/desktop-tauri/src-tauri/src/main.rs` 强制刷新 Rust 编译戳。

### 3.4 【渲染崩溃】特殊 Token 字面量引发分词器启动白屏
- **现象**：会话中一旦包含大模型特殊标记（例如 `<|im_start|>`、`<|im_end|>`），重启应用加载该会话时，整个窗口瞬间变成纯黑背景白屏，所有组件被卸载。
- **根因**：`ContextChip` 在计算 Token 用量时调用了 `gpt-tokenizer` 的 `encode()`。该分词库默认遇到特殊标记字面量时会直接抛出 `Error: Disallowed special token found` 异常。由于缺乏错误边界，渲染期未捕获异常导致整棵 React 树崩溃卸载。
- **军规**：
  1. 调用分词时必须显式设置 `disallowedSpecial: new Set()`，将其当作普通文本处理；
  2. 根组件必须包裹 `ErrorBoundary`，遇到不可预见渲染异常时展示友好诊断堆栈，杜绝全屏空白。

### 3.5 【发布陷阱】GitHub Release 孤儿 Draft 残留
- **现象**：发布新版本时删除了 tag 并重新打 tag，再次推送后发现 Release 页面存在一个无资产的草稿（Draft）与正式 Release 并存。
- **根因**：`tauri-action` 在矩阵构建时（Windows/macOS/Ubuntu），跑得快的系统会先创建 Release；若后续有系统构建失败而删 tag 重做，已创建的 Release 会被 GitHub 自动转为孤儿 Draft。
- **军规**：重新打 tag 发布前，必须通过 `gh api repos/yunluoxincheng/EasyCode/releases` 检查并用 `DELETE` 彻底清理遗留的草稿。

### 3.6 【已知设计】Dev 构建的桌面通知署名为「PowerShell」
- **现象**：在调试运行（dev 构建）时，右下角弹出的系统通知图标和标题显示为 Windows PowerShell，而非 EasyCode。
- **根因**：`tauri-plugin-notification` 检测到可执行文件位于 `target/debug` 或 `target/release` 路径时，为了防止污染系统注册表，刻意不设置 `System.AppUserModel.ID`（AUMID），而是回退到系统内置的 `Toast::POWERSHELL_APP_ID`。正式 NSIS 安装版运行时会传 `app_id = com.easycode.desktop`，开始菜单快捷方式已注册该 AUMID，显示完全正常。
- **军规**：**桌面通知署名问题属于调试构建的刻意设计，验收通知署名必须基于安装版，切勿在 dev 模式下误判为 Bug**。

### 3.7 【字符编码】Windows ACP=65001 与 GBK 乱码
- **现象**：Windows 机器若开启了系统级的“Beta版: 使用 Unicode UTF-8 提供全球语言支持”，系统的 `GetACP()` 会返回 `65001`。此时如果单测硬编码断言 GBK 字符转换，会导致测试在不同 Windows 环境下行为不一致。
- **军规**：对于 GBK 等非 Unicode 代码页的精确解码测试断言，必须通过 `GetACP() == 936` 进行前置门控。

### 3.8 【进程管理】进程组生命周期与 Early-Return 陷阱
- **现象**：在 Unix 系统下启动带 shell 的后台进程（如 `pnpm dev`），杀掉进程后，前端显示已停止，但后台实际的 node 进程依然常驻占用 5173 端口。
- **根因**：以独立进程组启动命令时，组长（shell 进程）可能先一步退出，但后代进程仍在存活。若终止逻辑在入口处单纯检查 `child.exitCode`，就会误判“进程已消亡”而提前 return，导致真正的后代工作进程成为孤儿进程残留。
- **军规**：**进程生命周期的管理单位必须贯穿为“进程组”，绝不能单纯依据组长自身状态做提前退出**。终止流程必须遵循：`组 SIGTERM → 3s 宽限等待 → 组探活 → 仍存活则组 SIGKILL → 确认消亡`。

### 3.9 【自动化测试】秒级计时动态组件击穿 AX 元素索引
- **现象**：使用 Computer Use 或无障碍（AX）树进行 GUI 自动化测试时，点击后台任务条经常报错找不到元素。
- **根因**：后台任务条包含每秒自增的运行时长文本（如 `运行中 12s`）。AX 树每秒都在重新生成，导致在 `getAXState()` 获取索引与随后的 `click(index)` 执行之间，AX 树快照必然失效。
- **军规**：对于包含秒级动态刷新的组件，自动化测试切勿依赖 AX 元素索引，应通过稳定选择器、DOM 查询或截图坐标进行精准操作。

---

## 4. 真实基础设施与实测验证工装

### 4.1 用户真实环境参数（严禁 Mock）
- **自建 SearXNG 实例**：部署于局域网 `http://192.168.50.1:8080`，供 EasyCode 真实发起联网搜索（测试时注意 SearXNG 自带请求限流器，高频测试时模型重试即可恢复）。
- **用户自建 CPA 网关**：配置了 15+ 主流商业与开源模型端点，具有真实 Key 与额度。
- **验证准则**：网络请求、模型调用、联网搜索全部依靠真实环境，切忌自作主张搭建 mock 服务。

### 4.2 隔离 GUI 实测工装（无毒无污染实测法）
在需要对桌面 UI 进行端到端全链路走查（如验证审批流、后台任务条、日志抽屉、内嵌预览）时，采用以下经过实战检验的工装方案：
1. **数据目录隔离**：启动应用时指定 `EASYCODE_DATA_DIR` 环境变量（如 `EASYCODE_DATA_DIR=E:/AllProjects/EASYCODE/.tmp-test-data`），确保完全不触碰、不污染用户的真实生产配置与会话历史。
2. **脚本化 LLM 驱动真实引擎**：在本地启动一个极简 Node 脚本，模拟 OpenAI 兼容的 `/chat/completions` SSE 流式端点，按测试剧本返回精确的 `tool_calls`。这样无需消耗真实 Token 即可驱动真实 Electron/Tauri 壳完整走通 UI 交互、组件展开与异常流。
