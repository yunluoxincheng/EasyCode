# EasyCode 技术方案与 MVP 计划

## 1. 总体架构

```
┌────────────────────────── packages/desktop (Electron 薄壳) ──────────────────────────┐
│  main: 装配 Engine + NodeHost + IPC 桥 / preload: window.easycode 类型化 API          │
└──────────────────────────────┬───────────────────────────────────────────────────────┘
                               │ AgentClient 接口 (IPC 实现 / 内存实现)
┌──────────────────────────────▼───────────────┐   ┌─────────────────────────────────┐
│  packages/ui (React, 无 UI 框架)              │   │  packages/engine (@easycode/    │
│  会话侧栏 / 时间线 / 工具卡片 / 审批 / 设置     │───▶│  engine) AgentServer: 会话管理、 │
└──────────────────────────────────────────────┘   │  设置、持久化、事件流             │
                                                   └──────────────┬──────────────────┘
                                                                  │ 纯 TS，零运行时依赖
                                                   ┌──────────────▼──────────────────┐
                                                   │  packages/core (@easycode/core) │
                                                   │  agent 循环 · Tool 注册制        │
                                                   │  Provider 适配器注册制           │
                                                   │  审批策略 · 事件协议 · diff/Mock  │
                                                   └──────────────┬──────────────────┘
                                                                  │ Host 能力接口（唯一 IO 出口）
                                                   ┌──────────────▼──────────────────┐
                                                   │  fs / process / paths / dataDir │
                                                   │  实现: NodeHost(桌面/CLI)        │
                                                   │        MemoryHost(浏览器/测试)   │
                                                   │        [未来] TauriHost(v0.2)   │
                                                   └─────────────────────────────────┘
```

**模块化三原则**
1. **依赖单向**：`ui → engine → core ← host`；core 不知道 Electron/Node/React 的存在。
2. **注册制扩展点**：工具（`ToolRegistry.register`）、Provider（`createProvider(id, config)`）都是注册式插件，加新工具/新模型服务不动核心代码。
3. **能力注入**：一切 IO（文件、进程、路径、数据目录）经 `Host` 接口注入，core 可在浏览器/测试中以 `MemoryHost` 运行。

## 2. 关键设计

### 2.1 事件协议（core 定义，UI 直接消费）
```
AgentEvent: session_snapshot? | text_delta | reasoning_delta | tool_call_start |
            tool_result | approval_request | step_end(usage) | error | done
ClientMessage: user_message | approval_response | abort
```
传输层可替换：Electron 用 IPC 推送；CLI 直接监听 emitter；浏览器演示模式为进程内直连。

### 2.2 Agent 循环（core/loop.ts）
```
while (steps < MAX) {
  turn = provider.stream(messages, tools)        // 流式，边发事件
  if (turn 无 tool_call) break
  for call in turn.tool_calls:
    approval = policy.check(call)                // ask → 发 approval_request 并等待
    result  = approved ? tool.execute(input, {host, workspace, signal})
                       : "用户拒绝了此操作"
    messages.push(tool_result)                   // 回传模型继续
}
```
中止经 `AbortController` 贯穿到 fetch 与子进程。

### 2.3 Provider 适配器（零 SDK，自研 SSE 解析）
- `openai-compatible`：`POST {baseURL}/chat/completions`（stream），支持 `reasoning_content`（GLM/DeepSeek）与并行 tool_calls；兼容 Ollama/LM Studio 的 `/v1`。
- `anthropic`：`/v1/messages`（stream，content_block_delta）。
- 内部消息格式统一为 `{role, blocks[]}`，各适配器负责映射，新增协议只加一个文件。

### 2.4 安全
- 路径含闭校验：`resolve(workspace, rel)` 必须落在工作区内。
- Shell：`cmd /c`（win）执行、默认 120s 超时、输出 100KB 截断。
- Electron：`contextIsolation: true`、`nodeIntegration: false`，preload 只暴露白名单 API。

## 3. 里程碑

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M1 调研+需求+方案 | docs/RESEARCH・REQUIREMENTS・PLAN | ✅ |
| M2 core | 类型/循环/工具×6/Provider×2/审批/Mock/单测 | ✅ |
| M3 engine+CLI | AgentServer、设置、JSONL 持久化、CLI | ✅ |
| M4 ui+desktop | React 界面、Electron 壳、IPC | ✅ |
| M5 验证 | build/test 通过、Electron 端到端走查 | ✅ |
| **v0.2 Tauri 壳** | host-tauri（TS Host）+ desktop-tauri（Rust fs/proc/HTTP 流代理/文件夹选择）+ ▚ 图标，端到端验证通过（WebView 内存 ~30MB） | ✅ |
| v0.2 剩余 | NSIS 安装包（tauri:bundle）、正式签名、API Key 钥匙串 | 规划 |
| v0.3 | MCP、worktree 并行、沙箱 | 规划 |

## v0.2 Tauri 实现备注（2026-09-19）

- 架构：WebView 内运行完整引擎（core+engine+TauriHost），Rust 侧只提供宿主能力命令
  （`host_info/fs_*/proc_run/proc_kill/pick_folder/http_stream`），业务逻辑零 Rust 化。
- HTTP 代理：LLM 请求经 Rust reqwest 流式转发（base64 分块 + Channel），绕过 WebView CORS
  且保留 SSE 流式输出；fetch 代理**必须排除 `*.localhost/localhost/127.0.0.1`**，
  否则会拦截 Tauri IPC 自身造成 invoke 无限递归（已踩坑）。
- Rust 资源嵌入缓存在 bin crate 里：改 UI 后需 touch main.rs 强制 `generate_context!` 重新嵌入。
- 工具链：RUSTUP_HOME/CARGO_HOME 在 D:\DevCache\Rust\*，crates 走 rsproxy 镜像。

## 4. 风险与对策
- **Electron 体积与"轻量"诉求冲突** → 壳已隔离，v0.2 换 Tauri；MVP 阶段主进程零依赖、渲染层按需加载。
- **各模型 tool-calling 行为差异** → 统一内部 blocks 格式 + 适配器各自归一化；Mock/单测锁住循环行为。
- **无 API Key 无法联调** → Mock Provider + MemoryHost 保证全链路可演示、可测试；Ollama/LM Studio 可作免费真实后端。
