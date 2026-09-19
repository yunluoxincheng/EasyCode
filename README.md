# EasyCode

轻量、高度模块化的**桌面端 Coding Agent**（对标 Codex / Claude Code / ZCode Desktop）。

```
┌ packages/desktop-tauri  Tauri 壳（Rust 宿主命令 + ▚ 图标；当前主推，~30MB 内存） ┐
├ packages/host-tauri     Tauri 宿主：invoke 桥接 Rust（fs/进程/HTTP 流代理）      ┤
├ packages/desktop        Electron 壳（零业务逻辑；与 Tauri 壳二选一）              ┤
├ packages/ui             React 会话界面（三态启动：Tauri/Electron/浏览器演示）      ┤
├ packages/engine         会话服务、设置、持久化、CLI                              ┤
├ packages/core           Agent 循环 · 工具注册制 · Provider 适配制 · 审批策略      ┤ （零运行时依赖）
└ packages/host-node      Node 宿主能力（Electron/CLI 用）                         ┘
```

详细设计见 [docs/RESEARCH.md](docs/RESEARCH.md) · [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) · [docs/PLAN.md](docs/PLAN.md)

## 快速开始

```bash
pnpm install
pnpm build      # 全部包构建
pnpm test       # core 单元测试
pnpm start      # Electron 版（开发调试用）

# Tauri 版（主推，需 Rust 工具链）
pnpm --filter @easycode/desktop-tauri run tauri:build     # 调试构建
packages/desktop-tauri/src-tauri/target/debug/easycode-desktop.exe
pnpm --filter @easycode/desktop-tauri run tauri:bundle    # NSIS 安装包
```

**无 API Key？** 应用默认使用「演示」Provider（内存文件系统 + Mock 模型），可完整体验
工具调用 → 审批 → 结果回传全链路。真正的任务在 ⚙ 设置中填入 API Key：

| Provider | 说明 |
|---|---|
| `zhipu` | GLM 系列（OpenAI 兼容端点） |
| `deepseek` / `moonshot` / `openai` | OpenAI 兼容端点 |
| `ollama` / `lm-studio` | 本地模型（默认端口已预设，完全离线） |
| `anthropic` | Claude 系列（原生协议） |

## CLI（同一引擎的终端形态）

```bash
pnpm cli "列出工作区的所有 TODO" --workspace ./some-project --provider zhipu --model glm-4.6
pnpm cli "运行测试并修复失败" --workspace . --provider deepseek --yolo
```

## 内置工具

`read_file` · `write_file` · `edit_file` · `list_dir` · `search_files` · `run_command`

审批模式：`ask`（写文件/执行命令需批准，默认）| `yolo`（自动放行）。
所有文件操作强制限制在工作区目录内。

## 安全设计

- Electron `contextIsolation` + `sandbox` 开启，渲染进程拿不到 Node 能力
- IPC 白名单分发；preload 仅暴露 `invoke`/`onEvent` 两个通道
- 工作区路径逃逸防护；命令超时（默认 120s）与输出截断

## Roadmap

- [x] **v0.2** Tauri 壳（Rust 宿主 + ▚ 图标，已上线）· 终端风 UI
- [ ] v0.2 剩余：NSIS 安装包 · API Key 入系统钥匙串
- [ ] v0.3 Git worktree 并行会话 · 子 agent · Routines 定时任务 · MCP 工具协议
- [ ] v0.4 沙箱执行（Windows AppContainer / macOS sandbox-exec）· 插件市场
