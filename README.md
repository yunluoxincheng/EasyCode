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
- **权限规则**：在 ask / YOLO 之上叠加 `allow` / `ask` / `deny` 细粒度规则——命令按前缀匹配（自带词边界，`rm` 不命中 `rmdir`），文件按工作区路径 glob；全局设置与项目级 `.easycode/permissions.json` 并集裁决且 `deny` 一律优先，YOLO 模式下也能守住破坏性命令
- **测试自愈**：`/test-loop` 自动探测测试命令（package.json / Cargo / Go / Python）→ 失败时把失败用例、日志摘录与当前 diff 交给模型修复 → 自动重跑，轮次 1~5 可配，过程以 `[ TEST n/m ]` 卡片实时呈现
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
pnpm test       # 全部 Node 测试，并检查包含 Rust 声明的 80 个总量预算
pnpm test --native # 同时核对并执行 Rust 测试（需 Rust 工具链与原生依赖，CI 使用此入口）
pnpm --filter @easycode/ui typecheck
pnpm start      # Electron 版（开发调试用）

# Tauri 版（主推，需 Rust 工具链）
pnpm --filter @easycode/desktop-tauri run tauri:build     # 调试构建
pnpm --filter @easycode/desktop-tauri run tauri:bundle    # 安装包
```

无 API Key 时可直接体验演示模式（内存文件系统 + Mock 模型，完整走通工具调用 → 审批 → 结果回传）。

Node.js 要求 >=20.14.0；测试建议使用与 CI 相同的 Node 22 / pnpm 11。PR 和 master 推送的三平台检查负责 TypeScript 构建、UI 类型、Node/Rust 测试与数量检查，原生安装包仍由独立 Release 工作流构建。

项目测试总量硬上限为 **80 个**，当前为 **74 个 Node + 4 个 Rust = 78 个**。统一入口按测试源码发现文件，按实际注册数量统计 Node（包含动态和子测试）；原生模式还核对 Cargo 实际清单。超限、跳过、取消或空测试文件会失败。后续测试优先替换、精简现有检查，不默认追加“最小回归”。

Reflex 影子模式默认关闭，首次使用时才加载本地运行时和模型。构建前可通过 `EASYCODE_REFLEX_MODEL_DIR` 指向包含 `model_int8.onnx`、`tokenizer.json`、`tokenizer_config.json`、`runtime_config.json` 的目录；默认查找相邻的 `../Reflex/models_export/deberta-v3-xsmall`。模型缺失时构建会警告，常规 Agent 可运行，Reflex 会退回无有效预测。构建仅打包当前使用的 ORT JSEP 后端；旧 `public/ort` 缓存无需删除，也不会全部进入安装产物。

桌面走查必须先重建产物并隔离数据：Electron 支持进程级 `EASYCODE_DATA_DIR`，Tauri 当前按应用 identifier 选择数据目录，需要使用 `tauri build --debug --no-bundle --config '{"identifier":"com.easycode.desktop.qa"}'` 临时构建并先核对 `host_info`。该覆盖参数不应写入正式配置或用于发布。

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

UI 的 `AppStore` 是可变事件仓库：全量订阅读取数值 `version`；局部订阅按原始值/不可变引用投影，快照仍是数值版本。仅动作回调使用 `useStoreApi()`。上下文计算在 `context-tokens.ts`，与 `ContextChip` 展示分离并按需加载；显示在流式期间按 200ms 采样，模型容量保护始终读取最新精确计数。长 Markdown 在流式期间按 80ms 采样显示，结束立即完整渲染，原始文本和复制内容始终保留最新值。

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

## MCP 扩展（Stdio）

在「设置 → MCP 扩展」添加本机服务，或导入兼容的配置，然后点击「保存并应用」：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "E:/YourWorkspace"],
      "enabled": true,
      "timeoutMs": 30000
    }
  }
}
```

仅配置可信服务，保存会以当前用户权限启动进程；参数使用字符串数组，工作目录使用绝对路径。JSON 使用本页示例中的字段，停用用 `enabled:false`；不支持的字段会拒绝导入。环境变量通过卡片设置或 JSON 的 `env` 输入，按常规设置选定的存储方式保存；已保存值不回显，未重新输入的已保存变量会保留，使用「清除」显式删除，不要把密钥写入命令参数。

服务就绪后，Agent 可通过带命名空间的工具调用外部服务，并继承现有审批/权限规则；YOLO 模式的行为保持一致。MCP 授权按工具名配置，不能把远端参数路径当作客户端文件沙箱。Composer 的 `/` 菜单列出外部工具和 Prompt，Prompt 获取后只填入草稿，不自动发送。环境、工具目录或连接变化会使旧调用失效，失败连接需手动重连。

最多配置 8 个服务；含内置工具每回合最多 128 个，外部工具规格总量最多 512 KiB。当前展示文本、结构化结果和文本资源；媒体、资源订阅、采样及远程 Streamable HTTP 尚未实现。外部进程不受工作区文件沙箱约束，外部工具的修改不进入内置回合快照/撤销。

## 安全设计

- Tauri 能力白名单；Electron `contextIsolation` + `sandbox`，渲染进程拿不到 Node 能力
- IPC 白名单分发；preload 仅暴露 `invoke` / `onEvent` 两个通道
- 工作区路径逃逸防护；命令超时与输出截断
- 模型与 Tavily API Key 默认使用系统安全存储：Tauri 通过系统凭据服务保存，Electron 使用 safeStorage 加密后存放在用户数据目录，Linux 的 basic_text 后端不视为安全存储。设置接口只返回是否已保存，输入框留空保持原密钥，输入新值替换，「清除密钥」需保存后生效
- 首次读取旧明文配置时，先保存并回读凭据，再原子提交配置引用；失败保留原文件和可用密钥，在设置页提示重试。无安全后端时可在「常规」明确选择明文模式；CLI / 浏览器演示未注入安全后端时会明示明文模式，CLI 的环境变量与命令行 Key 仅在本进程使用
- 系统保护不能防御同一用户权限下的任意恶意程序。迁移机器或降级到旧版本时可能需要重新填写密钥；Electron 密文依赖原操作系统账户与应用 profile，单独复制 settings.json 或 credentials 目录不足以保证可解密
- **权限规则的信任边界**：项目级 `.easycode/permissions.json` 只能收紧权限（`deny` / `ask` 默认生效）；其中的 `allow` 默认被忽略，需在设置页对**该工作区**显式授予信任——信任按项目逐项记录（比对的是 `realpath` 解析出的**物理工作区身份**，只写入本机设置、绝不落在项目仓库），信任项目 A 不会连带放宽后来打开的 B、C；工作区若是指向别处的符号链接，改指到另一个仓库后原授权**不会**随之转移，需要重新授予。授权只能经引擎的信任接口变更，普通「保存设置」不会覆盖授权状态，因此撤销后不会被陈旧草稿恢复。克隆来的仓库无法自行取消用户的审批保护
- **符号链接不构成路径规则的后门**：文件类工具在权限裁决与边界检查前会解析真实目标（`realpath` + `lstat`），**实际读写用的也是已验证的真实路径**（不是原始链接路径），审批返回后还会复核一次**绝对真实目标**——审批期间链接被换掉、或工作区根被改指到另一个项目，都会取消操作；工作区内的别名链接同样命中针对真实路径的规则；指向工作区外的链接一律拒绝；**悬空链接**（目标尚不存在）同样拒绝，不会被当成可新建的普通文件；`search_files` 递归遍历时对**每个候选文件**逐个校验；`@file` 引用、文件预览、**自动加载的项目规则（`AGENTS.md` 等）与自定义指令模板**等全部读取入口使用同一套边界；新建文件会校验其最近存在的父目录；同一物理工作区的不同写法共享同一把工作区锁。宿主缺少真实路径解析能力时保守拒绝，不假装安全

> **边界说明（重要）**：权限规则是**命令级审批策略，不是进程级安全沙箱**。它按命令前缀匹配，无法阻止间接执行——例如 `package.json` 的 `scripts.test` 内部可执行任意命令，被检查的是 `pnpm test` 而不是展开后的每条语句；`a && b`、管道与脚本同样不在匹配范围内。需要强隔离请依赖操作系统级沙箱（见 Roadmap v0.4）。
>
> 符号链接防护以「访问前解析真实目标 + 执行前复核」实现，能覆盖常规的别名/悬空链接/审批期替换，但**无法对抗宿主级别的极端并发替换**（两次检查之间仍有极窄窗口）。彻底消除需要宿主提供 `O_NOFOLLOW` / 文件句柄级别的约束能力，属于 v0.4 沙箱执行的范畴。

## Roadmap

- [x] **v0.1** 多协议接入 · 工具与审批 · 项目管理 · 联网搜索 · 应用内更新
- [ ] v0.2 收口：API Key 系统安全存储已实现，待审查与跨平台验证（TODOS #41）
- [ ] v0.3 Git worktree 并行会话 · 子 agent · Routines 定时任务 · MCP 工具协议
- [ ] v0.4 沙箱执行（Windows AppContainer / macOS sandbox-exec）· 插件市场

## 文档

- [docs/RESEARCH.md](docs/RESEARCH.md) — 竞品调研
- [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) — 需求
- [docs/PLAN.md](docs/PLAN.md) — 计划与里程碑
- [CHANGELOG.md](CHANGELOG.md) — 版本变更记录
