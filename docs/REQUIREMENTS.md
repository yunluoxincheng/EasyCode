# EasyCode 需求文档（MVP）

一个**轻量、高度模块化**的桌面端 Coding Agent，对标 Codex / Claude Code / ZCode Desktop。

## 1. 产品目标
- **轻量**：运行时依赖极少（3 个），主进程零业务逻辑；为 v0.2 换 Tauri 壳（安装包 ~10MB）做好架构准备。
- **高度模块化**：核心引擎不依赖任何 UI/桌面框架，同一套 core 可跑在桌面端、CLI、甚至浏览器内存模式。
- **可用**：MVP 覆盖"连模型 → 干活（读写文件/跑命令）→ 审批 → Diff 审查"完整闭环。

## 2. 目标用户
希望在本地用自然语言驱动编码任务的开发者；需要接入多家模型服务（GLM/DeepSeek/OpenAI/Ollama/LM Studio/Anthropic…）。

## 3. 功能需求（MVP 范围）

| # | 需求 | 说明 |
|---|---|---|
| FR-1 | 多会话管理 | 新建/切换/删除会话，会话持久化到磁盘，重启恢复 |
| FR-2 | 工作区绑定 | 每个会话绑定一个本地文件夹，所有文件/命令操作限制在该目录内 |
| FR-3 | Agent 循环 | 流式输出；模型可多轮调用工具直到任务完成；可随时中止 |
| FR-4 | 内置工具集 | `read_file` / `write_file` / `edit_file` / `list_dir` / `search_files` / `run_command`，工具即插件（注册制） |
| FR-5 | 审批模式 | `ask`（写文件/执行命令需用户批准）/ `yolo`（自动放行）；拒绝时把拒绝原因回传给模型 |
| FR-6 | 多 Provider | OpenAI 兼容适配器（覆盖 GLM、DeepSeek、Moonshot、OpenAI、Ollama、LM Studio 等）+ Anthropic 适配器；可配置 baseURL/API Key/模型 |
| FR-7 | 会话 UI | Markdown 渲染、思考过程折叠、工具调用卡片（输入/结果/Diff）、审批按钮内联 |
| FR-8 | 设置 | Provider 预设 + 自定义；API Key 本地存储；默认审批模式 |
| FR-9 | 演示模式 | 无 API Key 时可用 Mock Provider + 内存文件系统完整体验全流程 |
| FR-10 | CLI 形态 | 同一 core 提供 `easycode "任务"` 命令行入口，验证模块化 |

## 4. 非功能需求
- **NFR-1 模块边界**：`core` 零运行时依赖、零 Node API 依赖（可跑在浏览器）；Node 能力全部经 `Host` 接口注入。
- **NFR-2 依赖预算**：运行时依赖 ≤ 5 个。
- **NFR-3 安全**：工作区路径逃逸防护；Electron `contextIsolation` 开启、`nodeIntegration` 关闭；Shell 命令超时与输出截断。
- **NFR-4 可测试**：核心循环有单元测试（Mock Provider），不依赖网络。

## 5. 非目标（后续版本）
- Git worktree 并行会话、沙箱（sandbox-exec/容器）、Routines 定时任务、子 agent
- MCP 协议接入（v0.2）、插件市场、集成终端/编辑器 pane、浏览器预览
- Tauri 壳（v0.2）、系统钥匙串存储 API Key、自动更新

## 6. 验收标准（MVP）
1. `pnpm build` 全部通过；`pnpm test` 核心循环测试通过。
2. `pnpm start` 启动桌面应用：新建会话 → 选工作区 → 用 Demo Provider 完成一轮"读文件→改文件→审批→Diff 展示"流程。
3. 有真实 API Key 时，切换 Provider 可完成真实编码任务。
4. `easycode "任务" --yolo` 在 CLI 中复用同一引擎跑通。
