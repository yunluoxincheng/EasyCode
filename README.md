<div align="center">

<img src="docs/assets/logo.png" width="96" alt="EasyCode logo" />

# EasyCode

轻量、高度模块化的**桌面端 Coding Agent** —— 终端风界面，本地优先，无锁定。

[下载最新版](https://github.com/yunluoxincheng/EasyCode/releases/latest) · [更新日志](CHANGELOG.md) · [设计文档](docs/RESEARCH.md)

</div>

---

## 功能

- **多协议模型接入**：Anthropic Messages / Chat Completions / Responses 三种 API 格式，内置智谱、DeepSeek、OpenAI、Moonshot、Anthropic 预设与自定义供应商；Ollama / LM Studio 本地模型完全离线可用；无 Key 时自带演示模式
- **联网搜索**：给不支持原生搜索的模型（GLM / DeepSeek 等）提供 `web_search` 工具，后端支持 SearXNG、Tavily 与自定义 API；GPT / Claude 等有原生搜索的模型自动走原生工具
- **Agent 工具**：读写文件、精确编辑、目录浏览、正则搜索、执行命令；文件操作强制限制在工作区内，敏感操作有审批门（ask / YOLO）
- **模型管理**：一键拉取模型列表、参数自动探测（上下文窗口 / 最大输出 / 视觉 / 能力 / 推理档位，models.dev 目录 + 内置规格库 + 名称启发式）、逐模型连通性测试、模型级配置
- **上下文与用量**：o200k 分词精确计数，容量面板按分类展示占用与缓存命中率
- **会话与项目**：多会话持久化、项目分组、会话级模型与思考强度切换（自动跟随模型官方档位）、未绑定项目也能纯对话 + 联网搜索
- **应用内自动更新**：检查 / 下载进度 / 安装重启

## 下载

从 [Releases](https://github.com/yunluoxincheng/EasyCode/releases/latest) 获取：

| 平台 | 文件 |
|---|---|
| Windows | `*-setup.exe`（NSIS）或 `*.msi` |
| macOS | `*.dmg`（Intel / Apple Silicon 通用） |
| Linux | `*.AppImage` 或 `*.deb` |

已安装的版本会在有新版本时于应用内提示更新。

## 快速开始（开发）

```bash
pnpm install
pnpm build      # 全部包构建
pnpm test       # core 单元测试
pnpm start      # Electron 版（开发调试用）

# Tauri 版（主推，需 Rust 工具链）
pnpm --filter @easycode/desktop-tauri run tauri:build     # 调试构建
pnpm --filter @easycode/desktop-tauri run tauri:bundle    # 安装包
```

无 API Key 时可直接体验演示模式（内存文件系统 + Mock 模型，完整走通工具调用 → 审批 → 结果回传）。

## 架构

```
┌ packages/desktop-tauri  Tauri 壳（Rust 宿主命令 + ▚ 图标；主推）          ┐
├ packages/host-tauri     Tauri 宿主：invoke 桥接 Rust（fs/进程/HTTP 流代理）┤
├ packages/desktop        Electron 壳（零业务逻辑；与 Tauri 壳二选一）       ┤
├ packages/ui             React 会话界面（三态启动：Tauri/Electron/浏览器演示）┤
├ packages/engine         会话服务、设置、持久化、搜索后端、CLI               ┤
├ packages/core           Agent 循环 · 工具注册制 · Provider 适配制 · 审批策略 ┤ （零运行时依赖）
└ packages/host-node      Node 宿主能力（Electron/CLI 用）                   ┘
```

依赖单向：`ui → engine → core ← host`。core 零运行时依赖、零 Node API，一切 IO 经 `Host` 接口注入；工具与 Provider 均为注册制扩展点。

## 模型服务

| 预设 | 说明 |
|---|---|
| 智谱 GLM / DeepSeek / OpenAI / Moonshot | OpenAI 兼容端点 |
| Anthropic | Claude 原生协议 |
| Ollama / LM Studio | 本地模型（端口已预设，离线可用） |
| 自定义供应商 | 任意 OpenAI 兼容 / Anthropic / Responses 端点 |

模型列表支持从 API 自动获取或手动添加；每个模型可单独配置上下文窗口、最大输出、输入类型、模型能力与推理档位（默认自动探测，可切换手动）。

## 联网搜索

设置 → 联网搜索：选择后端（SearXNG / Tavily / 自定义 API）、填写地址或 Key、测试连通。开启后自动获取的模型默认启用联网搜索：

- 有原生搜索的模型（GPT / Claude）→ 走官方原生工具
- 其余模型（GLM / DeepSeek 等）→ 走内置 `web_search()` 工具

## CLI（同一引擎的终端形态）

```bash
pnpm cli "列出工作区的所有 TODO" --workspace ./some-project --provider zhipu --model glm-4.6
pnpm cli "运行测试并修复失败" --workspace . --provider deepseek --yolo
```

## 安全设计

- Tauri 能力白名单；Electron `contextIsolation` + `sandbox`，渲染进程拿不到 Node 能力
- IPC 白名单分发；preload 仅暴露 `invoke` / `onEvent` 两个通道
- 工作区路径逃逸防护；命令超时与输出截断
- API Key 与搜索密钥仅保存在本机设置文件

## Roadmap

- [x] **v0.1** 多协议接入 · 工具与审批 · 项目管理 · 联网搜索 · 应用内更新
- [ ] v0.2 剩余：API Key 入系统钥匙串
- [ ] v0.3 Git worktree 并行会话 · 子 agent · Routines 定时任务 · MCP 工具协议
- [ ] v0.4 沙箱执行（Windows AppContainer / macOS sandbox-exec）· 插件市场

## 文档

- [docs/RESEARCH.md](docs/RESEARCH.md) — 竞品调研
- [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) — 需求
- [docs/PLAN.md](docs/PLAN.md) — 计划与里程碑
- [CHANGELOG.md](CHANGELOG.md) — 版本变更记录
