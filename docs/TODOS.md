# TODOS — 需求记录

> 这里只记录需求与方案，**先记录、排期后再做**。路线图级的长期规划见 [PLAN.md](PLAN.md)。

## 待办需求

### 35. MCP (Model Context Protocol) 协议客户端接入（Stdio / SSE）

**状态**：⏳ 待办（规划中）

**背景**：
EasyCode 作为开放、可扩展的桌面 Coding Agent，目前仅提供内置的基础文件与命令操作工具（`read_file`, `write_file`, `edit_file`, `list_dir`, `search_files`, `run_command`, `todo_write`, `git_status`, `git_diff`）。
随着 Anthropic 主导的 Model Context Protocol（MCP）成为大模型工具生态的事实标准，成百上千的高质量开源 MCP Server（如官方提供的 SQLite/PostgreSQL 数据库直连、Puppeteer/Fetch 网页抓取、GitHub Issue/PR 管理、GitLab、Google Drive、Sentry 异常监控等）为 Agent 提供了近乎无限的能力边界。
目前 EasyCode 在架构设计之初就确立了“注册制扩展点”（Tool 注册制），但缺少一个通用协议桥梁来动态接入外部工具进程。

**设计方案**：
1. **MCP Client 协议适配层（Core / Engine）**：
   - 遵循标准 MCP 协议（JSON-RPC 2.0），优先支持 Stdio 进程管道传输（Command + Args + Env），未来可选扩展 SSE；
   - 握手协议周期：进程启动 → `initialize` 握手协商协议版本与能力 → `tools/list` 枚举外部工具清单（提取工具名、描述、JSON Schema 参数规范）→ 转换为 EasyCode 内置 `ToolDefinition`；
   - 动态注册进入 `ToolRegistry`：工具命名空间隔离（如 `mcp__postgres__query`），并在 Agent 执行工具时调用 `tools/call` 进行 RPC 派发与结果接收；
   - 遵循 EasyCode 安全审批机制：外部 MCP 工具默认继承审批策略（`ask` 模式下执行敏感 MCP 工具时触发 `ApprovalCard`，展示工具来源服务器与参数，经用户确认后执行）。
2. **设置页「MCP 扩展」配置看板**：
   - 设置页新增「MCP 扩展（MCP Servers）」独立面板；
   - 支持两种配置方式：
     - ① 极客友好 JSON 配置编辑器（兼容主流 `mcpServers` 配置格式，如 `{"mcpServers": { "postgres": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-postgres", "..."] } } }`）；
     - ② 可视化卡片表单：服务器名称、可执行命令、参数列表、环境变量、启用/停用开关；
   - 实时探活与诊断状态灯：各 MCP 服务卡片实时展示连接状态（绿色已就绪、琥珀色连接中、红色故障）、获取到的工具数量及一键「↻ 重试连接」；
3. **UI 与 Composer 联动**：
   - Composer `/` 斜杠快捷指令面板自动合流 MCP 暴露的工具和 Prompt（标注 `[MCP:名称]` 徽标）；
   - 回合内 `ToolCard` 清晰标注 MCP 来源与返回数据渲染。

**涉及改动**：
- `packages/core/src/mcp/`：新建 MCP 客户端协议实现（JSON-RPC 2.0 编解码、工具定义映射、结果解包）；
- `packages/engine/src/mcp/`：MCP Server 进程生命周期管理器（启动、重启、心跳检测、stdio 管道托管）；
- `packages/engine/src/settings.ts`：Settings 扩展 `mcpServers?: Record<string, McpServerConfig>`；
- `packages/ui/src/components/SettingsPage.tsx`：新增 MCP 设置管理面板；
- `packages/ui/src/styles.css`：MCP 服务器状态卡片与徽标样式。

---

### 36. 回合级代码改动快照与一键回退（Turn Checkpoint & Safe Undo）

**状态**：⏳ 待办（规划中）

**背景**：
在多轮复杂编码任务中，Agent 经常跨多个文件进行大规模修改（`edit_file` / `write_file`）或执行命令。然而，当大模型的实现方向偏离预期、误删逻辑或引入回归缺陷时，用户面临极大的挽救成本：
1. **手动撤销繁琐**：需要跨多个历史回合的卡片，人工比对并手动改回原有代码；
2. **Git 粗暴回滚丢失未提交工作**：如果使用 Git 检视面板的 `git checkout`，会连带把用户自己在此之前手工编写的、未暂存/未提交的代码一并销毁；
3. **限制了 `yolo` 模式的普及**：用户因缺乏安全保障而不敢完全放手让 Agent 自主执行。

**设计方案**：
1. **轻量原子改动快照（Turn Pre-edit Snapshot）**：
   - 当某个会话回合（Turn）准备对某个文件发起写操作（`write_file` 覆盖已有文件、`edit_file`）前，Engine/Core 自动记录该文件的 Pre-edit 原始内容快照；
   - 快照文件存放在项目临时目录 `.easycode/checkpoints/{turnId}/`（自动被 `.gitignore` 忽略）或会话数据持久层中；
   - 严格记录每个回合所影响的文件变更集合与修改前 SHA/内容，同一回合内多次修改同一文件只以回合开始前的原始版本为基准。
2. **回合头部「↶ 撤销此回合改动」入口与交互**：
   - 在已产生代码改动的历史回合头部（`TurnView`）以及右键菜单中，增设「`↶ 撤销此回合改动`」按钮；
   - 点击后呼出极客风撤销确认弹窗 `<TurnUndoModal>`：
     - 列出该回合修改过的所有文件路径、当时增删行数；
     - 提示若文件在后续回合又被修改过的冲突告警；
     - 提供对比 Diff 预览；
   - 用户确认后，Engine 安全地将文件恢复至该回合开始前的状态，并自动向当前会话追加一条系统消息“已撤销第 N 回合的文件变更”；
3. **与 Composer `/undo` 指令闭环**：
   - 在 Composer 输入 `/undo` 即可默认回滚最近一个包含代码变更的回合，提供丝滑的键盘流回退体验。

**涉及改动**：
- `packages/engine/src/checkpoints.ts`：新建会话快照管理器（快照捕获、存储、还原、冲突检测）；
- `packages/engine/src/server.ts`：在工具执行前后挂载快照钩子，暴露 `revertTurnCheckpoints` API；
- `packages/ui/src/components/Transcript.tsx` / `TurnView`：回合头部添加撤销操作按钮；
- `packages/ui/src/components/TurnUndoModal.tsx`：新建撤销改动确认与 Diff 弹窗；
- `packages/ui/src/commands/`：新增 `/undo` 快捷指令。

---

### 37. 长期运行后台进程管理与端口探测（Background Tasks & Port Watcher）

**状态**：⏳ 待办（规划中）

**背景**：
目前的 `run_command` 工具是面向短命令（如 `git status`, `pnpm build`, `pnpm test` 等能在数秒到两分钟内退出且带有 exit code 的命令）设计的，默认带 120s 超时强制中断。
但在真实的开发闭环中，用户经常需要让 Agent“启动本地 dev server（如 `pnpm dev`, `vite`, `cargo run`）并进行测试”、“启动后台常驻容器”、“或者开启 watch 监听测试进程”。当前机制下，启动长命令会一直处于运行转圈状态，直到 120s 超时被判定为 Failure 强行杀掉进程，无法维持服务正常运行，且容易造成孤儿端口占用。

**设计方案**：
1. **后台任务管理核心（Background Process Pool）**：
   - 扩展 `run_command` 参数：`background?: boolean`（或支持模型自主声明）；
   - 后台进程启动后即刻返回进程元数据（PID、启动命令、起始时间），不阻塞 Agent 循环的后续步骤；
   - Host 层维护会话绑定的常驻进程池，在应用关闭、会话重置或用户显式停止时优雅发送 `SIGTERM` / `SIGKILL` 终止，杜绝僵尸进程与端口残留。
2. **本地网络端口动态探测与捕获（Port Watcher）**：
   - 监听后台进程的 stdout 输出，通过正则智能捕获本地服务监听的 URL 与端口（如 `http://localhost:3000`、`http://127.0.0.1:5173/`）；
   - 执行跨平台端口占用探活确认服务已就绪。
3. **UI 底部常驻任务条与终端日志抽屉**：
   - 当会话拥有正在运行的后台服务时，在应用底部状态栏以极客暗黑风展示常驻指示条：`[● pnpm dev · localhost:5173 · 运行中 2m15s] [↗ 浏览器打开] [■ 停止]`；
   - 点击常驻条可滑出半屏终端实时滚动日志抽屉（`.task-drawer`），实时流式查阅最新输出；
   - Agent 后续步骤亦可随时调用 `read_task_logs(pid)` 检查服务启动日志与报错。

**涉及改动**：
- `packages/core/src/tools/command.ts`：扩展 `run_command` 工具规范支持 `background` 参数；
- `packages/engine/src/tasks.ts`：新建后台任务进程管理器与端口探测器；
- `packages/ui/src/components/StatusBar.tsx` 或新建 `BackgroundTasksBar.tsx`：常驻任务指示器与控制条；
- `packages/ui/src/components/TaskLogsDrawer.tsx`：拟终端实时日志抽屉与 ANSI 解码；
- `packages/ui/src/styles.css`：常驻任务指示器与抽屉样式。

---

### 38. 工作区轻量文件树与代码行范围引用（Workspace Tree & Range Mention）

**状态**：⏳ 待办（规划中）

**背景**：
1. **工作区结构黑盒**：用户打开一个复杂项目后，除非去系统文件管理器或 VS Code 查看，在 EasyCode 界面内无法一览当前工程的目录结构与文件组织；
2. **整文件引用浪费 Token 且分散注意力**：目前 Composer 的 `@文件` 补全（#25）只能引用完整文件。当一个文件有上千行（如复杂的配置、大型单体组件、数据字典），而用户只想让 Agent 优化其中第 100~150 行时，整文件喂入既浪费了宝贵的上下文窗口，又容易导致大模型注意力漂移。

**设计方案**：
1. **工作区目录树微型侧栏（Workspace File Explorer）**：
   - 在会话侧栏底部或以可折叠面板形式增设「📂 工作区文件树」；
   - 自动递归渲染当前工作区目录结构，智能忽略 `.git`、`node_modules`、`dist`、`target` 等目录；
   - 极客暗黑风文件图标与展开折叠动效；
   - 文件右键上下文菜单支持：「⧉ 复制相对路径」、「⌨ 插入到 Composer 输入框」、「✎ 在外部编辑器中打开」；
2. **代码行号范围引用语法（Code Range Mention）**：
   - Composer 支持输入 `@path/to/file.ts:50-100` 或 `@path/to/file.ts:35`；
   - 在 `@` 补全后按 `:` 自动提示行号区间输入帮助；
   - Engine 注入上下文时自动执行切片截取，附带行号标尺，并对上下文说明：“*用户截取了文件第 50-100 行片段*”，大幅节省 Token 消耗；
3. **快速轻量预览弹窗**：
   - 在文件树中单击文件，支持在轻量暗黑代码弹窗中查看内容与行号，直接拖选代码行一键「引用所选行至 Composer」。

**涉及改动**：
- `packages/ui/src/components/WorkspaceFileTree.tsx`：新建工作区目录树组件与右键菜单；
- `packages/ui/src/components/Composer.tsx`：支持 `@file:start-end` 语法解析与光标补全提示；
- `packages/core/src/prompts.ts`：解析并格式化行范围切片代码片段；
- `packages/ui/src/styles.css`：文件树极客折叠面板与行号高亮样式。

---

### 39. 自主测试运行与排错自愈循环（Auto Test-and-Fix Loop）

**状态**：⏳ 待办（规划中）

**背景**：
编写代码只是开发的第一步，确保代码正确无误才是工程交付的根本。目前用户在让 Agent 完成代码修改后，通常需要手动打字让模型运行测试、等待模型报出测试错误、再人工提示模型“根据报错继续修改”，多次反复交互，沟通成本高且容易遗漏测试用例。
如果赋予 Agent“修改完代码 → 自动运行相关测试 → 失败则捕获堆栈自动发起自愈微调 → 直至全绿”的自主循环能力，将极大提升代码生成的可靠度与交付质量。

**设计方案**：
1. **测试框架与命令自动探知（Test Discovery）**：
   - Engine 根据工作区特征自动探测测试运行命令：
     - Node/TS 项目：扫描 `package.json` 中的 `scripts.test`（如 `pnpm test` / `vitest` / `jest`）；
     - Rust 项目：`cargo test`；
     - Python 项目：`pytest`；
     - Go 项目：`go test ./...`；
   - 支持在 `.easycoderules` 或设置中指定自定义测试命令（如 `testCommand: "pnpm test:unit"`）；
2. **专属闭环指令 `/test-loop` 与 Git Inspector 一键入口**：
   - 在 Composer 支持 `/test-loop [目标模块/文件]` 指令；
   - 在 Git 检视面板（#34）底部增加「`🧪 运行测试并自愈`」操作按钮；
3. **Agent 自愈循环执行协议（In-Loop Self-Healing）**：
   - Step 1：执行测试命令并捕获退出码与终端输出；
   - Step 2：若 exit code === 0，判定成功，输出通过报告；
   - Step 3：若 exit code !== 0，提取 failure 报错日志、失败测试用例名以及异常堆栈（Stack Trace）；
   - Step 4：将错误堆栈与该任务所修改的代码 Diff 联合打包作为反馈提示词，模型自动分析根本原因并执行修复（`edit_file`）；
   - Step 5：自动重新运行测试；
   - 设置最大自愈轮次保护（如上限 3 次），避免死循环消耗 Token；
4. **测试进展可视化面板**：
   - 回合内渲染专门的 `TestRunCard`，直观呈现测试运行用时、通过率（通过 N / 失败 M）、失败用例列表及当前的自愈轮数（Round 1/3）。

**涉及改动**：
- `packages/core/src/testRunner.ts`：测试环境探知与失败堆栈抽取模块；
- `packages/engine/src/testLoop.ts`：自愈循环状态机与轮次管理；
- `packages/ui/src/commands/`：新增 `/test-loop` 指令；
- `packages/ui/src/components/GitInspectorModal.tsx`：增加运行测试与自愈入口；
- `packages/ui/src/components/Transcript.tsx` / `TestRunCard.tsx`：极客风测试卡片与自愈轮次动画。

---

### 40. AgentRuntime 决策与路由挂载接口（Reflex 决策小模型 / DecisionPolicy 挂载与 Shadow Mode 旁路）

**状态**：✅ 已完成（2026-09-23）——Core 零依赖契约 + 四大决策点旁路注入 + DecisionStatsManager 统计引擎 + 设置页 Reflex 决策监控看板（项目→会话两级折叠树与概率柱状图）+ Reflex V1 标准微调数据集导出

**背景**：
在现有的 Agent 核心循环中，意图识别、推理档位分配（Reasoning Effort）、敏感操作审批、工具报错恢复以及上下文压缩时机等所有控制流决策，要么完全依赖主会话的大模型（LLM）进行全量高延迟生成，要么依赖硬编码的朴素阈值（如敏感布尔值、0.85 上下文压缩硬触发、报错直接回传模型自行思考）。这种模式增加了单次回合的延迟与 Token 消耗，且缺乏端侧自适应调控能力。
目前专为 Agent 高频离散决策设计的端侧微型决策模型 **Reflex**（基于 `microsoft/deberta-v3-xsmall` ~22M 骨干，已完成 Phase 1~4 研发与 INT8 动态量化）已经就绪：
- **模型体量**：单个独立 ONNX 文件 `model_int8.onnx` 仅 **79.20 MB**，配合 8MB Fast Tokenizer（`tokenizer.json`）；
- **推理开销**：普通 CPU 单次推理延迟 **~31ms**，全链路端到端决策（分词 + 特征组装 + ONNX 推理 + 温度缩放）仅 **22~29ms**，完全可作为毫秒级反射层；
- **决策可靠度**：测试集整体准确率 85.19%，310 对对抗反事实成对通过率 72.90%，且**前 20% 高置信区间准确率达 100.00%**，自带温度缩放（$T=78.2$）与动态降级机制（`defer_to_system2`）。

为了在 EasyCode 中无侵入接入 Reflex，需要遵循 EasyCode 的**模块化三原则（单向依赖、注册制扩展、接口能力注入，保持 `@easycode/core` 零运行时依赖）**，设计标准的 `DecisionPolicy` 契约并在关键决策点注入旁路。

**设计方案**：

1. **核心抽象接口（`@easycode/core` 纯类型，零运行时依赖）**：
   在 `packages/core/src/policy.ts` 中定义统一的 Schema-Conditioned 候选决策契约（与 Reflex 导出品严格对齐）：
   ```ts
   export interface DecisionCandidate {
     id: string;
     text: string;
   }

   export interface DecisionRequest {
     instruction: string;                  // 决策任务描述
     state: {
       summary: string;                    // 当前状态摘要
       goal?: string;                      // 总体任务目标
       history?: string[];                 // 近期操作历史
     };
     candidates: DecisionCandidate[];      // 离散动态候选集
     metadata?: Record<string, unknown>;
   }

   export interface DecisionResult {
     selectedId: string;                   // 最优候选 ID
     selectedText: string;
     confidence: number;                   // 校准后 Softmax 置信度 (0~1)
     defer: boolean;                       // 是否建议转交主大模型处理 (不确定性高或置信度低于门限)
     scores: Record<string, number>;       // 各候选概率分布
     latencyMs: number;
   }

   export interface DecisionPolicy {
     decide(req: DecisionRequest): Promise<DecisionResult>;
   }
   ```

2. **预留首批落地关键决策介入点**：
   - **决策点 1：推理深度动态分配 (`reasoning_effort`)**：根据用户输入意图与工作区复杂度，决策 `fast` / `medium` / `high`；
   - **决策点 2：工具执行错误恢复 (`recovery`)**：工具报错时，快速决策是 `retry_same` / `modify_input` / `search_dir` / `ask_user` / `stop`；
   - **决策点 3：上下文修剪决策 (`context_management`)**：根据当前历史密度，决策是否提前做工具输出修剪或消息合并，而非仅靠 0.85 静态阈值；
   - **决策点 4：敏感命令审批建议 (`safety`)**：为 `ApprovalManager` 注入语义风险评分，辅助区分安全只读、常规修改与破坏性高危操作。

3. **四阶段渐进式接管与安全网（Stage-gated Rollout）**：
   - **Stage A: Shadow Mode（当前集成第一目标）**：
     - 完全不改变 EasyCode 现有的任何主逻辑与执行动作；
     - 关键决策点异步旁路触发 `policy.decide()`，主循环零阻塞；
     - 落盘记录影子决策日志（`State`、`Candidates`、`Reflex 预测与置信度`、`主模型实际动作`、`最终 Outcome 结果`），用于在真实开发场景中验证模型准确率并持续收集 Trajectory 数据；
   - **Stage B: Advisory Mode（建议模式）**：
     - 在开发者日志或 UI 旁路轻量展示微模型建议（如“Reflex 建议当前任务可使用 fast 推理档位”）；
   - **Stage C: Low-risk Control（低风险接管）**：
     - 仅在前 20% 高置信区间（置信度高且 `defer === false`）自动接管推理档位与压缩时机；
   - **Stage D: Selective Control（关键决策接管）**：
     - 经过充分在线影子数据验证后，受控接管错误自愈策略与命令审批建议。

4. **运行时与工程架构分层**：
   - `packages/core`：只包含接口定义与默认 `NoopDecisionPolicy`，保持零外部依赖；
   - `packages/engine`：提供 `ShadowLoggerPolicy`，在 `server.ts` `runTurn` 组装时按需注入；
   - 端侧 ONNX 运行时实现：
     - **Electron / CLI**：由主进程/NodeHost 侧使用 `onnxruntime-node` 加载 80MB 权重；
     - **Tauri / 浏览器**：由 WebView 使用 `onnxruntime-web` 或经 Rust Tauri 命令代理；
   - 降级保护：任何 ONNX 加载失败、超时或内部异常，一律自动降级为 Noop，主流程绝不报错。

5. **内置统计分析引擎 (`DecisionStatsManager`)**：
   - **持久化路径**：在用户数据目录集中追加存储 `${this.host.env.dataDir()}/reflex_decisions/${sessionId}.jsonl`，会话级隔离、写入无锁追加、会话删除同步清理，绝不污染代码库；
   - **核心指标聚合计算**：
     - `totalDecisions`：累计微决策次数；
     - `avgLatencyMs`：端侧决策平均耗时（ms）；
     - `deferRate`：模型主动降级/转交主大模型的比例；
     - `agreementRate`：与主会话大模型实际决策的吻合率；
     - `taskFamilyDistribution`：四大任务族的触发频度占比；
     - `confidenceBuckets`：置信度区间分布统计（健康度阶梯）。

6. **设置界面可视化决策历史：项目 $\to$ 会话分级展开 (`SettingsPage`)**：
   - 设置页导航新增导航项：`{ id: 'reflex', label: 'Reflex 决策监控', group: '模型与分析' }`；
   - **顶层：全局指标看板 (KPI Cards)**：总决策量、平均端侧耗时（~26ms）、一致率（%）、安全降级率（%）及任务族色彩占比条；
   - **主体：项目 $\to$ 会话两级折叠树 (Hierarchical Accordion)**：
     - **Level 1（项目卡片）**：以 `workspaceRoot` 聚合，展示项目路径、关联会话数、累计决策数、操作栏【⤓ 导出该项目微调数据】；
     - **Level 2（会话条目）**：展开项目后列出该项目下的所有会话，展示标题、时间戳、决策数、一致率胶囊标签、操作栏【⤓ 导出本会话】；
     - **Level 3（决策明细卡片）**：展开会话后按时间轴展示决策记录：
       - 标头徽章：任务族类型（`[RECOVERY]` 等）、端侧耗时（`⚡ 28ms`）、校准置信度（`82.5%`）；
       - 决策对比：Reflex 预测选择 vs 大模型实际选择（一致为绿，分歧为黄）；
       - 候选概率条形图：动态横向柱状图渲染候选分布（Softmax 分布）；
       - 上下文抽屉：点击展开查看完整 `instruction`、`state.summary`、`state.goal` 与上下文历史。

7. **一键导出微调数据集（数据飞轮闭环）**：
   - 基于 UI 现有成熟的 `downloadFile` 工具，提供多维度导出能力：
     - 单会话导出：`EasyCode-Reflex-[SessionTitle]-[Timestamp].jsonl`
     - 单项目导出：`EasyCode-Reflex-Project-[ProjectName]-[Timestamp].jsonl`
     - 全局一键打包导出：导出所有项目沉淀的高价值样本；
   - **格式完全兼容**：导出格式严格遵循 Reflex 训练集规范（`data/v1/prototype.jsonl`），导出的文件可直接放入 Reflex 项目的 `data/` 目录中，无需任何清洗二次加工，直接用于增量微调（Fine-tuning），实现真实 Trajectory 驱动的模型进化闭环。

**涉及改动**：
- `packages/core/src/policy.ts`：新增 `DecisionPolicy` / `DecisionRequest` / `DecisionResult` / `DecisionRecord` 接口与 `NoopPolicy`；
- `packages/core/src/loop.ts` & `approval.ts`：`LoopOptions` 与 `ToolContext` 增加可选 `policy?: DecisionPolicy`；
- `packages/engine/src/shadow.ts`：实现 Shadow Mode 旁路事件捕获与 JSONL 日志归档；
- `packages/engine/src/stats.ts`：实现 `DecisionStatsManager` 统计引擎与索引聚合；
- `packages/engine/src/server.ts`：装配层注入决策策略与影子观察器，提供 stats / export IPC API；
- `packages/ui/src/components/SettingsPage.tsx`：新增 `ReflexDashboard` 监控面板、KPI 卡片与两级折叠树；
- `packages/ui/src/utils/exportDecision.ts`：微调数据集导出器。

---

### 41. API Key 系统钥匙串安全存储（Keychain / Credential Manager）

**状态**：⏳ 待办（规划中）

**背景**：
目前各模型服务的 API Key 以明文形式直接存储在设置 JSON 文件中（`Settings.providers[].apiKey`），任何能读取用户配置目录的进程或恶意脚本均可直接窃取明文密钥。随着应用走向正式发布（NSIS 安装包、签名分发），密钥安全将成为不可回避的底线问题。操作系统原生提供了受保护的凭据存储能力（Windows Credential Manager、macOS Keychain、Linux libsecret），应当优先利用而非自造轮子。

**设计方案**：
1. **Host 凭据存取能力注入**：
   - `Host` 能力接口新增 `secretGet` / `secretSet` / `secretDelete` 三个方法，core 与 engine 仅面向接口编程，保持零平台依赖；
   - **Tauri 宿主**：Rust 侧引入 `keyring` crate，新增 `secret_set` / `secret_get` / `secret_delete` 命令；
   - **Electron 宿主**：主进程采用 `safeStorage` API 加密后落盘；
   - **演示模式 / CLI**：内存实现或明文文件兜底，保证接口可用。
2. **设置层平滑迁移**：
   - Settings 中 `apiKey` 字段替换为 `apiKeyRef`（钥匙串条目标识），首次启动检测到旧明文 Key 时自动迁移至系统钥匙串并从配置文件中抹除，迁移成功 Toast 告知；
   - 保留「不使用钥匙串」设置开关（部分 Linux 环境无 libsecret 服务），此时回退明文存储并在设置页显著标注安全提示。
3. **设置页感知**：
   - 模型服务表单中 Key 输入框仅显示掩码（`sk-****`），支持「更新密钥」与「清除密钥」操作，不再回显完整明文。

**涉及改动**：
- `packages/core/src/host.ts`：Host 接口扩展 secret 三方法与 MemoryHost 空实现；
- `packages/desktop-tauri/src-tauri/src/main.rs`：keyring 凭据命令；
- `packages/desktop/src/main.ts`：Electron safeStorage 实现与 preload 白名单；
- `packages/engine/src/settings.ts`：`apiKeyRef` 引用模型与启动迁移逻辑；
- `packages/ui/src/components/SettingsPage.tsx`：密钥掩码展示与迁移提示。

---

### 42. 子 Agent 任务委派（Sub-Agent Delegation）

**状态**：⏳ 待办（规划中）

**背景**：
当前所有工作都在主会话的单一 Agent 循环内完成。执行「大范围检索代码定位实现」「阅读多份文档汇总调研结论」这类探索型子任务时，大量的中间读取输出（大文件内容、搜索命中列表）会持续挤占主会话上下文窗口，加速触发上下文压缩（#31），压缩过程的摘要损耗又会伤害主任务的关键记忆。业界主流 Coding Agent（Claude Code 的 Task/subagent、Codex）均采用「子 Agent 独立上下文探索、仅回传结论摘要」的架构来解决这一矛盾。

**设计方案**：
1. **`task` 委派工具（注册制内置工具）**：
   - 主循环可调用 `task` 工具发起委派，参数：`description`（子任务目标）、`hints`（建议探查方向/文件）、`return_format`（期望回传格式）；
   - 子 Agent 拥有完全独立的 `messages` 数组与独立上下文窗口，复用同一 `runAgentLoop`、同一工具集与审批策略（继承主会话审批模式与工作区绑定），可自主多步读文件、搜索、跑只读命令；
   - 子循环结束后仅将最终结论文本作为 `task` 工具结果回传主循环，中间过程不进入主会话上下文。
2. **资源与安全约束**：
   - 子 Agent 默认禁用写操作与 `run_command`（只读探索），可通过参数显式申请写权限（仍走审批）；
   - 嵌套深度上限 1 层（子 Agent 不可再委派），并发子任务数上限（默认 2），总步数独立受限；
   - 主循环可中止（AbortSignal 贯穿），主回合被打断时子任务一并终止。
3. **UI 过程可见**：
   - 回合内渲染 `TaskCard`：展示子任务目标、实时状态（运行中/已完成/已中止）、耗时与可展开的子过程只读回放（不占主上下文但过程留档可查）。

**涉及改动**：
- `packages/core/src/tools/task.ts`：新建 `task` 委派工具定义；
- `packages/core/src/loop.ts`：抽象循环入口支持子循环复用（独立 messages、受限工具集、嵌套深度控制）；
- `packages/engine/src/server.ts`：子 Agent 生命周期管理与并发配额；
- `packages/ui/src/components/Transcript.tsx` / `TaskCard.tsx`：委派卡片与子过程回放。

---

### 43. Git Worktree 并行会话（Worktree Parallel Sessions）

**状态**：⏳ 待办（规划中）

**背景**：
#29 已实现多会话并发执行与运行态无感切换，但对绑定同一工作区的多个会话，敏感写操作只能经 `WorkspaceLockManager` 排队串行——两个会话在「同一份代码」上并行改动依然会互相踩踏，无法真正做到物理隔离的并行开发。Git worktree 提供了官方正解：同一仓库可检出多个独立工作目录，各自拥有独立分支与未提交改动，互不干扰。

**设计方案**：
1. **并行会话创建入口**：
   - 项目切换器与会话侧栏新增「⑂ 并行分支会话」入口：选择或输入分支名（基于当前 HEAD 创建新分支 + worktree，目录位于 `<repo>/.easycode/worktrees/<branch>/` 并自动 gitignore）；
   - 新会话自动绑定该 worktree 目录，Agent 的全部读写与命令都在隔离目录内进行，与主工作区物理隔离。
2. **会话与 worktree 生命周期绑定**：
   - 侧栏并行会话显示分支徽标（`⑂ feat/xxx`）与所属主仓库路径；
   - 会话删除时询问是否同步清理 worktree（`git worktree remove`，有未提交改动时强提示）；
   - 应用启动时自动探测孤儿 worktree（会话已删但目录残留）并提供清理入口。
3. **成果回流闭环**：
   - 并行会话内完成开发后，通过 `/commit`（#32）提交到该分支；Git 检视面板（#34）提供「⇅ 合并回当前分支」快捷操作（`git merge`，冲突时引导用户在终端或外部工具处理）；
   - 与 #40 决策路由天然衔接：worktree 会话可作为「试验田」，失败即弃、成功即并，无风险试错。

**涉及改动**：
- `packages/engine/src/worktrees.ts`：新建 worktree 创建/清理/探测管理器；
- `packages/core/src/tools/git.ts`：worktree 相关只读探测支持；
- `packages/engine/src/server.ts`：会话创建接口扩展 worktree 绑定参数；
- `packages/ui/src/components/Sidebar.tsx` / `ProjectSwitcher.tsx`：并行会话入口与分支徽标；
- `packages/ui/src/components/GitInspectorModal.tsx`：合并回流操作。

---

### 44. 内嵌 Web 预览面板（Embedded Preview）

**状态**：⏳ 待办（规划中）

**背景**：
前端开发的高频循环是「改代码 → 看 effect → 再改」。当前 #37 落地后，Agent 启动 dev server 并捕获 `localhost:5173` 地址，用户仍需点击「↗ 浏览器打开」切换到外部浏览器查看——窗口来回切换打断了心流。若能把运行中的本地服务直接内嵌到应用侧边实时预览，配合 Agent 的多会话并发（#29），即可形成「左侧 Agent 改码、右侧页面实时刷新」的沉浸闭环。

**设计方案**：
1. **侧边预览面板**：
   - 可从右侧滑出/收起的预览分区（与主会话区左右分栏，可调宽度），内部以 WebView/iframe 加载目标地址；
   - 面板顶部极客风地址栏：当前 URL、⟳ 刷新、外部浏览器打开兜底、设备视口宽度快捷切换（桌面/平板/手机）。
2. **与 #37 后台任务条联动**：
   - 端口探测捕获到服务地址后，任务条上的「↗ 浏览器打开」旁增加「⧉ 内嵌预览」按钮，一键在侧边打开该地址；
   - 服务被停止或端口失活时，预览面板自动展示失联占位态（`● 服务已停止 [▶ 重新启动]`，可一键重新拉起后台任务）。
3. **开发刷新体验**：
   - 支持「跟随刷新」模式：检测到后台任务产生新的输出行（dev server 热更新日志）时自动轻刷新预览；
   - HMR（vite/webpack dev server 自带热更新）天然生效，无需额外处理；仅作为 HMR 失效场景的兜底。

**涉及改动**：
- `packages/ui/src/components/PreviewPanel.tsx`：新建预览面板组件（地址栏、视口切换、失联占位）；
- `packages/ui/src/components/BackgroundTasksBar.tsx`：任务条增加内嵌预览入口；
- `packages/ui/src/App.tsx`：主区左右分栏布局与面板开合状态管理；
- `packages/ui/src/styles.css`：预览面板与地址栏样式。

---

### 45. 流式输出卡顿滞后治理与打字机自适应追赶机制（Streaming Render Pipeline & Catch-up）

**状态**：⏳ 待办（规划中）

**背景**：
用户反馈流式输出时文字输出极其缓慢，像打字机一样卡顿，严重滞后于模型的实际推理生成速度。经排查，根本原因存在于三层瓶颈：
1. **未闭合代码块与动态文本的高频全量分词打满 CPU（核心瓶颈）**：每次收到 `text_delta` 时，UI 触发 RAF 重新渲染；由于文本在流式期间每帧都在累积变化，`renderMarkdown` 的 AST 缓存（`mdCache`）与代码高亮缓存（`hljsCache`）命中率恒为 0%。每一帧都在对不断变长的几百上千行文本执行昂贵的正则语法分词（`hljs.highlight`），把 JS 主线程 CPU 占满，导致 IPC/网络数据接收与 UI 事件循环阻塞堆积；
2. **缺乏流式自适应追赶（Catch-up Buffer）**：没有根据当前排队 token 堆积深度自适应增大单帧推进步长，导致高速模型（如 DeepSeek/本地 Ollama）在后端早已输出完成，前端主线程却仍在慢速排队重绘；
3. **MockProvider 演示模式的人工延时**：内置的演示模型存在固定 `emitSlow`（每 6 字符 sleep 12ms）硬编码打字机节流，在无 API Key 体验时呈现极低吞吐。

**设计方案**：
1. **流式渲染降级与代码块轻量化（Stream-time Throttling & Deferral）**：
   - 在回合处于活跃运行态（`live`）流式输出期间，对未闭合的代码块或高频流式段落跳过昂贵的 `hljs.highlight` 正则多层匹配，仅作纯文本呈现或轻量转义；
   - 待该代码块闭合或回合结束（`done`）后，再进行一次全局全量语法高亮并持久化写入缓存，消除流式期间 90% 以上的无谓 CPU 消耗；
2. **自适应动态追赶算法（Adaptive Catch-up Engine）**：
   - 引入流式字符缓冲队列与动态吞吐调节器：若检测到待渲染缓冲区堆积字符超过阈值（如 > 80 字符），自动成倍加大单帧刷新并出的 chunk 步长，瞬间同步至最新模型进度，杜绝“慢速打字机式滞后”；
3. **优化演示模式流速**：调整 `mock.ts` 的流式模拟步长与延时，既保证视觉动画流畅度，又贴近真实模型响应。

**涉及改动**：
- `packages/ui/src/markdown.ts`：增加流式轻量渲染模式（流式期间对活跃未闭合代码块跳过全量 hljs 正则分词）；
- `packages/ui/src/store.ts`：优化流式文本缓冲与 RAF 合并策略，增加动态追赶自适应阈值；
- `packages/core/src/providers/mock.ts`：优化演示模式步长与流速参数。

---

### 46. 智能贴底跟随与双层视口滚动体验修复（Smart Auto-Scroll & Viewport Sync）

**状态**：⏳ 待办（规划中）

**背景**：
用户反馈当前“滚动到底部”功能出现问题并失效，新生成的回答往往被推到视窗下方看不到。排查发现由于前期性能优化与视口改造引入了双重状态错位：
1. **外层视口单次触发后永久脱节**：外层滚动容器 `transcript-scroll` 的滚动监听在 #3 和 #18 中被过度精简为仅依赖 `[store.scrollTick, store.activeId]`（仅在用户发送的瞬间滚动一次）。随后当模型新生成 `TurnItem` 时，外层容器的高度剧增，而外层 `scrollTop` 纹丝不动，导致所有新输出的过程卡片、思考与回答被全部挤在可视窗口下方，必须用户手动滚轮翻找；
2. **`atBottom` 状态被意外置假关闭**：随着新回合在下方撑高，`onScroll` 中的 `el.scrollTop >= max - 80` 瞬间被算为 `false`，系统误判用户“向上翻看脱离跟随”，直接退出了自动跟随；
3. **双层滚动视窗操作割裂**：外层主容器与内部过程视窗 `.turn-body` 各有一套滚动逻辑，底部的 `jump-bottom`（↓ 回到底部）悬浮按钮只操作外层容器，无法同步重置内部视窗的跟随状态，导致用户点击后依然无法舒适浏览最新输出。

**设计方案**：
1. **基于 Mutation/Resize 尺寸感知的智能贴底跟随器（Smart Stick-to-Bottom）**：
   - 外层主容器引入精确的贴底锁定机制（`isPinnedToBottom`）：当用户处于底部（未主动向上滚动翻看）时，只要内容因新回合创建、工具卡片加入、文本增量增长或回合折叠而发生高度膨胀（通过 `ResizeObserver` 捕获），外层视口自动无感平滑跟进贴底；
   - 用户主动向上滑动鼠标滚轮时，立即解除贴底锁定，进入自由阅读模式；
2. **内外视口联动的一键回到底部（Dual-view Jump-to-Bottom）**：
   - 优化 `jump-bottom` 悬浮按钮点击行为：不仅将外层主视口滚动至最底，同时同步将当前活动回合内部的 `.turn-body` 恢复至贴底状态，并重新激活全局 `isPinnedToBottom` 跟随锁定；
3. **回合完结（done）自动对齐保障**：
   - 当回合执行完成、由展开态变为折叠态（或展示最终文本）时，触发一次精准的视口校准，保证最终文本与最新状态完整呈现在可视区域中。

**涉及改动**：
- `packages/ui/src/components/Transcript.tsx`：重构外层容器滚动跟随与 ResizeObserver 贴底感知，优化 `jump-bottom` 联动逻辑；
- `packages/ui/src/store.ts`：完善 `atBottom` 与贴底跟随状态机。

---

### 32. Composer `/` 斜杠快捷指令系统（Slash Commands & Custom Prompts）

**状态**：✅ 已完成（2026-09-22）——Composer `/` 触发监听与光标探测 + 极客风 `.command-pop` 指令面板 + 动作类执行（`/compact` 压缩上下文、`/fork` 分叉会话、`/export` 导出会话、`/clear` 清空草稿）与模板类补全（`/commit` 规范提交、`/review` 深度审查、`/test` 单元测试、`/fix` 缺陷修复）+ 工作区 `.easycode/prompts/*.md` 自定义指令自动合流 + 纯键盘驱动（↑↓ 导航、Tab/Enter 补全执行、Esc 退出、输入法合成防误触）

**背景**：
在日常高频开发场景中，用户向 Coding Agent 下发意图往往包含大量模式化操作，例如：
1. **代码与安全审查**：针对当前变动或指定文件进行质量、边界与安全漏洞审查（`/review`）；
2. **生成规范提交**：分析工作区当前改动并生成符合 Conventional Commits 规范的 Git 提交信息（`/commit`）；
3. **编写与验证测试**：为当前变更或指定代码模块编写/补充单元测试并执行验证（`/test`）；
4. **会话与上下文管理**：主动触发阶段记忆归档与早期输出折叠（`/compact`，复用 #31 核心）、从当前节点分叉新会话对比方案（`/fork`，复用 #27 核心）、一键导出离线报告（`/export`，复用 #26 核心）。

目前用户只能每次手打大段重复的自然语言 Prompt，不仅耗时繁琐，且每次表述不一致容易遗漏关键约束。
此外，当前 Composer 已经成功实现了成熟的 `@文件` 快捷引用补全体系（#25），具备纯键盘驱动（↑↓ 选条目、Tab/Enter 补全、Esc 退出、输入法合成防误触）与暗黑终端风格弹窗。斜杠指令可深度复用这一套交互模式，形成统一的键盘流操作体验。

**设计方案**：
1. **输入触发与极客风指令面板 (`.command-pop`)**：
   - 当用户在 Composer 输入框处于空输入、行首或空格后键入 `/` 字符时自动触发；
   - 在输入框上方呼出终端极客风格弹窗，面板标题为 `[ / 快捷指令 ]`；
   - 条目布局：指令标识（绿色高亮，如 `/commit`）、功能说明（浅色辅助文本）、右侧类型徽标（如 `[Git]` / `[Action]` / `[Prompt]`）；
   - 智能模糊搜索打分：输入 `/com` 自动优先匹配高亮 `/commit`；
   - 键盘纯驱动交互：`↑` / `↓` 移动光标并自动将条目滚动入可视区，`Tab` / `Enter` 选中确认，`Esc` 随时退出，输入法合成中（`isComposing`）防误触。
2. **指令类型与执行语义**：
   - **立即执行类动作（Immediate Action，零 Token 消耗）**：
     - `/compact`：就地触发当前会话的阶梯式上下文压缩归档；
     - `/fork`：呼出会话分叉能力，自动从当前节点派生新会话；
     - `/export`：快捷打开导出会话菜单（Markdown / 离线 HTML）；
     - `/clear`：快速清空任务清单或重置输入草稿；
   - **参数化提示词模板（Prompt Template）**：
     - 指令选中后自动在输入框填入预设的高密度结构化提示词前缀，并允许用户在其后追加个性化参数或使用 `@文件` 结合：
       - `/commit [补充说明]`：自动调用 `git status` 与 `git diff`，按标准约定输出优雅的提交信息建议；
       - `/review [@文件]`：引导模型聚焦于架构合理性、边界条件、异常处理与代码规范进行分级审查；
       - `/test [@文件]`：自动分析被测代码，编写覆盖边界场景的测试套件并自动运行；
       - `/fix [报错日志]`：结构化排查异常与堆栈信息并给出修复方案；
3. **可扩展自定义指令（Custom Prompts）**：
   - 支持项目级自定义指令：自动扫描工作区根目录 `.easycode/prompts/*.md`，文件名即指令名（如 `deploy.md` 对应 `/deploy`），文件正文即 Prompt 模板；
   - 支持全局设置级自定义指令：设置页新增快捷指令管理面板；
   - 自定义指令以高优先级合流展示，并标注 `[自定义]` 徽标。

**涉及改动**：
- `packages/ui/src/components/Composer.tsx`：指令前缀感知、光标定位与 `.command-pop` 面板渲染；
- `packages/ui/src/commands/`：新建开箱即用内置指令集合与解析器；
- `packages/engine/src/prompts.ts`：标准化各指令的提示词模板；
- `packages/ui/src/styles.css`：极客暗黑风 `.command-pop` 样式与键盘选中高亮。

---

### 33. 项目级上下文与行为规范系统（Rules System: `.easycoderules` / `AGENTS.md`）

**状态**：✅ 已完成（2026-09-22）——Engine 规则多层级探测（`.easycoderules` > `AGENTS.md` > `CLAUDE.md` > `.cursorrules` > `.easycode/rules.md`）+ 系统提示词 `## 项目规范` 挂载与天然抗上下文压缩 + Composer `<RulesChip>` 状态感知胶囊与预览/快捷打开/一键初始化模板 + 设置页全局开发偏好（Global Rules）配置

**背景**：
在真实的工程实践中，每个项目都有独特的架构约束与工程纪律，例如：
- 技术栈选型：“本项目强制使用 pnpm，严禁使用 npm/yarn；状态管理采用 Zustand，禁止引入 Redux”；
- 架构分层约定：“UI 组件必须零外部 UI 框架、样式全部内联于 styles.css；Core 严禁依赖任何 Node.js 原生 API”；
- 质量与提交规范：“修改核心逻辑后必须运行 pnpm test 确保单测全绿；提交前必须更新 CHANGELOG.md”。

目前用户每次开启新会话都必须手动重复输入这些规矩，或者在多轮对话后模型因上下文推移而“遗忘”隐式规则，导致生成破坏规范的代码，极大地增加了人工审查与返工成本。

**设计方案**：
1. **规范文件自动探测与层级加载**：
   - **项目级规则（优先）**：会话绑定工作区后，Core/Engine 自动扫描工作区根目录，支持主流约定规范：
     - 首选专有规则文件：`.easycoderules`
     - 兼容通用规范文件：`AGENTS.md`、`CLAUDE.md`、`.cursorrules`
     - 目录型规范：`.easycode/rules.md`
   - **全局用户偏好（兜底）**：在设置页「常规」新增「全局开发偏好（Global Rules）」配置，适用于跨所有项目的通用偏好（如“代码注释与回复一律使用中文”、“优先使用纯函数与不可变数据”等）；
   - 内存引入带 mtime 的短时缓存，文件发生变化时即时自动重载。
2. **系统提示词智能挂载与抗压缩根基保障**：
   - 在 `prompts.ts` 的 `buildSystemPrompt` 中增设独立的高优先级章节：`## Project Specific Rules`；
   - 规则注入权重约束明确：`系统安全与工作纪律 > 项目专用规范 (.easycoderules) > 全局用户偏好 > 当前回合指令`；
   - 深度配合 #31 上下文压缩机制：项目规范和系统提示词属于不可裁剪的“根基上下文”，在会话进行历史归档与多轮交互时永远完整保全，杜绝长会话规则漂移。
3. **UI 状态感知与一键模板初始化**：
   - **规则感知胶囊（Rules Chip）**：在 Composer 顶部工具栏展示当前规则生效状态：
     - 检测到项目规则：`[ 📋 规则: .easycoderules ]`（亮绿激活高亮）；
     - 未配置项目规则但有全局偏好：`[ 📋 规则: 全局 ]`；
     - 未检测到任何规则：`[ ＋ 规则 ]`（弱化提示）；
   - **快捷交互卡片**：
     - 点击胶囊浮出规则预览卡片，显示规则摘要行数与字数；
     - 提供「✎ 在编辑器中打开」直接调用 `openPath` 快速编辑；
     - 若当前项目尚未配置，提供「＋ 初始化项目规则」按钮，一键在工作区生成涵盖技术栈、编码准则、测试流程的标准 `.easycoderules` 骨架文件。

**涉及改动**：
- `packages/core/src/prompts.ts`：扩展 `buildSystemPrompt` 接收 `projectRules` / `globalRules` 并格式化注入；
- `packages/engine/src/server.ts`：在会话加载与任务执行前检测并读取工作区规则文件；
- `packages/engine/src/settings.ts`：Settings 扩展 `globalRules?: string`；
- `packages/ui/src/components/Composer.tsx` / `RulesChip.tsx`：规则状态徽标与预览浮层；
- `packages/ui/src/components/SettingsPage.tsx`：全局规则编辑配置项。

---

### 34. 工作区 Git 状态感知与改动检视面板（Git Status & Diff Inspector）

**状态**：✅ 已完成（2026-09-22）——Core 底层 Git 状态/差异解析与只读免审批工具（`git_status` / `git_diff`）+ TitleBar & Composer `<GitCapsule>` 实时分支与增删行数胶囊 + 全尺寸 `<GitInspectorModal>` 两栏审查弹窗（分栏文件列表、红绿双侧行号 Diff、一键复制 Patch）+ 底部操作条（暂存全部 `git add .`、放弃修改、一键填入 `/commit` 闭环）+ 右键菜单审查入口

**背景**：
Coding Agent 在执行较复杂任务时，经常跨越多个文件进行批量编辑（`edit_file`）、新建（`write_file`）或命令执行。目前用户在审查全局改动时存在明显痛点：
1. **信息离散**：改动分散在时间线里各个回合的不同工具卡片中，难以一眼纵览当前工作区总共变动了哪些文件；
2. **缺乏全貌**：无法直观获知当前工作区是否干净、处于哪个分支、各文件增删行数总览（`-N +M`）、是否有意外修改或未跟踪文件；
3. **验证成本高**：用户为了看 `git status` 常常需要手动敲命令让模型执行 `run_command("git status")`，不仅白白消耗 Token，还会触发终端审批弹窗。

EasyCode 现已具备非常成熟的红绿行号 `ToolDiff` 视窗（#19）与行级差异算法，完全可以将此能力升维为全局工作区级的 Git 检视中心。

**设计方案**：
1. **标题栏 / Composer 顶部 Git 状态胶囊**：
   - 绑定工作区且为 Git 仓库时，实时显示 Git 状态胶囊：
     `[ ⑂ master* · 3 改动 (+58 -12) ]`（工作区干净时显示 `[ ⑂ master · clean ]`）；
   - 在关键生命周期（文件工具执行完成、命令执行完成、窗口恢复聚焦）触发增量刷新；
2. **极客暗黑风 Git 改动检视面板 (`<GitInspectorModal>`)**：
   - 点击 Git 胶囊或通过右键菜单「📂 审查工作区改动」一键唤出；
   - **左侧改动文件导航**：
     - 分组呈现：暂存区改动（Staged）、工作区修改（Unstaged）、新创建未跟踪文件（Untracked）；
     - 每个文件显示状态徽标（`M` 修改、`A` 新增、`D` 删除、`?` 未跟踪）以及增删行数（`-N +M`）；
     - 提供文件快速筛选框；
   - **右侧全尺寸结构化 Diff 视窗**：
     - 复用 `ToolDiff` 视觉规范：双侧行号、精准红底删除与绿底新增着色、变更统计；
     - 支持一键复制整个文件的 Diff Patch；
   - **底部快捷操作栏**：
     - `[ ⧉ 暂存全部 (git add .) ]`；
     - `[ ↶ 放弃修改 (git checkout) ]`（带防误触安全确认）；
     - `[ ⌨ 填入 Composer /commit ]`：一键将当前审查改动作为意图填入输入框，与 #32 斜杠指令无缝闭环！
3. **Core 扩展只读无审批 Git 工具支持**：
   - 在 Core 工具注册表新增只读工具 `git_status` 与 `git_diff`（零审批、免 `run_command` 弹窗与噪音）；
   - 模型需要分析整体代码改动或准备提交信息时可自主调用，输出规范整洁。

**涉及改动**：
- `packages/core/src/tools/git.ts`：实现只读 Git 状态与差异检测工具；
- `packages/engine/src/server.ts`：向 Client 暴露 `getGitStatus` 与 `getGitDiff` API；
- `packages/ui/src/components/GitInspectorModal.tsx`：全局 Git 检视弹窗；
- `packages/ui/src/components/TitleBar.tsx` / `Composer.tsx`：Git 状态胶囊挂载与点击事件；
- `packages/ui/src/styles.css`：Git 检视面板与分支指示器样式。

---

### 25. Composer `@文件` 快捷引用与模糊补全（Context Mention）

**状态**：✅ 已完成（2026-09-22）——Core 导出快速遍历器 `listFilesRecursively` + Engine 短时缓存与文件名/路径多段模糊匹配 + Composer 纯键盘驱动（↑↓ 选项目、Tab/Enter 补全、Esc 退出、输入法合成防误触）+ 终端极客风文件建议面板 + 未绑定友好提示

**背景**：
向 Coding Agent 投喂上下文是最高频的开发操作。目前向 EasyCode 输入框注入目标文件只有两种方式：纯手动敲打绝对/相对路径、或通过鼠标从外部文件管理器拖拽进输入区。
当开发者专注于键盘编码时，频繁切换鼠标拖拽会打断心流；而手动敲写深层路径既费时又容易拼写错误。

**已实现**：
1. **输入触发与位置感知**：
   - 监听 Composer 光标输入，检测光标前的 `@` 字符与查询串；
   - 在输入框上方即时唤出终端极客风格文件悬浮建议面板（`.mention-pop`）；
2. **工作区毫秒级检索与智能打分匹配**：
   - Core 提取轻量路径递归遍历器 `listFilesRecursively`，自动跳过 `.git`, `node_modules`, `dist`, `target` 等构建与环境目录；
   - Engine 层提供 3 秒 TTL 内存缓存，避免连续按键时频繁扫描磁盘；
   - 智能评分排序：优先文件名开头匹配（100分），其次文件名包含（80分），再次全路径包含（50分），短路径优先；
3. **纯键盘操作导航**：
   - 键盘 `↑` / `↓` 平滑移动选项目，并自动将选中条目滚动至列表可视区域；
   - `Enter` 或 `Tab` 键一键补全为 `@relative/path ` 并自动后置空格，光标后移就绪；`Esc` 键随时关闭浮层；
   - 完整支持输入法中（`isComposing`）防误触；
4. **终端风视觉与未绑定容错**：
   - 极客暗黑风弹窗面板，展示 `[ @ 文件引用 ]`、文件名高亮、父目录浅色呈现与绿色 `❯` 动态光标；
   - 当前会话未绑定工作区时友好提示“当前会话未绑定项目工作区，点击上方「＋ 绑定项目」即可引用代码文件”。

---

### 26. 会话一键导出：支持导出为完整 Markdown 文档与离线 HTML 报告

**状态**：✅ 已完成（2026-09-22）——导出模块 `exportSession.ts`（Markdown 与单文件自包含 HTML 生成器）+ 极客暗黑主题与 highlight.js 语法高亮内联 + 交互式 `<details>` 折叠与结构化 Diff 视窗 + TitleBar `<ExportButton>` 标题栏下拉菜单与跨端一键下载

**背景**：
在经过多轮深度的需求分析、代码重构、测试排错后，会话中沉淀了极其详尽的任务清单、思考脉络、代码改动 Diff 与终端执行日志。
目前用户如果想将这些过程归档到项目 Wiki、沉淀为技术文档、或者同步给团队成员，只能逐段手动复制，耗时繁琐且丢失了格式层级。

**已实现**：
1. **结构化 Markdown 导出**：
   - 自动生成导出元数据头部（导出时间、会话标题、工作区路径、模型/服务、Token 消耗统计）；
   - 包含完整的 GitHub 风格任务清单（Todos）；
   - 结构化渲染思考过程（`<details>` 折叠）、文件修改 Diff 代码块、终端命令执行卡片与最终回复。
2. **自包含离线 HTML 报告**：
   - 单文件离线自包含，零外部 CDN 或网络依赖，任何浏览器双击即开即审；
   - 完整内嵌 EasyCode 极客暗黑终端调色板（`--bg`, `--green`, `--cyan`, `--amber`, `--red` 等）与排版规则；
   - 内联 highlight.js 代码高亮样式，原生 `<details><summary>` 交互式折叠，红绿行号 Diff 视窗。
3. **UI 入口与跨端下载**：
   - 标题栏 `TitleBar` 增加极客风 `⤓` 导出会话下拉按钮；
   - 跨端通用 `downloadFile` 驱动 Blob 文件保存，自动以规范命名（`EasyCode-${title}-${timestamp}.${ext}`）并弹出 Toast 通知。

---

### 27. 会话分支/分叉（Fork Session）：从指定回合分叉出新会话

**状态**：✅ 已完成（2026-09-22）——Engine 核心 `forkSession`（继承工作区与模型配置、消息历史无损克隆、最新待办清单同步）+ Client 跨宿主接口打通 + 回合头部 `TurnView` 与用户消息 `UserView` 双入口一键分叉 + 自动高亮切换新分支会话

**背景**：
在复杂的开发决策过程中，往往存在多种技术实现路线（例如：“方案 A：使用 Redux Toolkit 重构状态” vs “方案 B：使用轻量 Zustand 重构状态”）。
目前会话只支持“从最后一条用户消息编辑重发”，但这会强行截断并永久销毁该消息之后的所有轮次。如果用户想对比两条路线，只能手动新建会话并重复喂入前面的大量背景信息。

**已实现**：
1. **多入口分叉支持**：
   - **在回合头部（`TurnView`）分叉**：每个历史回合头部提供「`⑂ 分叉`」按钮，保留截至该回合（包含生成的代码与回答）的全部历史，无缝开启后续分支决策；
   - **在用户提问（`UserView`）分叉**：用户消息悬停条增加「`⑂`」分叉按钮，克隆该提问之前的全部背景上下文，直接在该节点提出新的指令；
   - Agent 运行状态下自动禁用分叉按钮，防止并发修改脏数据；
2. **无损克隆与上下文继承**：
   - 完整继承原会话的工作区绑定（`workspaceRoot`）、模型服务（`providerId`）、模型覆盖（`model`）与思考档位（`reasoningEffort`）；
   - 消息历史采用 `structuredClone` 深度解耦复制，原会话与新分支互不干扰；
   - 继承该时间点对应的任务清单（Todos）快照，重置单会话 Token 消耗统计；
   - 新会话标题自动继承原标题并追加「`（分支）`」后缀；
3. **即时无缝切换**：
   - 创建成功后，自动置顶插入侧栏并无缝激活切换，呈现最新历史与「已成功分叉出新会话」轻量提示；
   - 原会话完整保留在侧栏项目树中，开发者可随时在两侧自由切换方案进行比对。

---

### 28. 渲染性能与高频流式性能专项治理（消除 CPU 占满与主线程卡顿）

**状态**：✅ 已完成（2026-09-21）——Store 流式事件 RAF 批处理（50ms 兜底 + 结构事件同步 Flush）+ `structureVersion` 细粒度版本解耦 + `ContextChip` 静态 Prompt/Spec 缓存与已定型条目 `WeakMap` 分词缓存 + `Transcript` 刻度测量解耦与滚动监听节流（零 Layout Thrashing）+ `markdown.ts` 与代码高亮 LRU 多级缓存与 `React.memo`

**背景**：
应用内存占用虽小（几十兆左右），但在 Agent 流式输出以及较长会话浏览时出现明显的不流畅、掉帧、输入滞后甚至界面短暂假死。
经底层性能与源码排查，根本原因在于**主线程 CPU 被密集的重复计算与频繁重排打满**：
1. **主线程高频 BPE 分词**：`ContextChip.tsx` 在每次组件渲染时，无缓存地调用纯 JS 分词器（`gpt-tokenizer` 的 `encode()`）对全量会话历史中所有消息、工具输入与长文本输出全量重新编码，长会话单次耗时可达几十至上百毫秒；
2. **强制同步布局抖动（Layout Thrashing）**：`Transcript.tsx` 在每次 `version` 变化时执行 `measure()` 触发二次渲染，并紧随在 `useEffect` 中调用所有历史节点的 `getBoundingClientRect()`；更严重的是鼠标滚动事件无防抖节流，滚动每一像素都在遍历调用 `getBoundingClientRect()`，导致空闲浏览时也严重掉帧；
3. **零节流全局 Re-render 瀑布**：`AppStore` 的单一全局 `version++` 在流式输出期间每秒触发几十次，没有任何 RAF 或时间窗口批处理（Batching），根组件 `App` 与全树子组件深度连带重渲；
4. **Markdown 与代码高亮逐帧重算**：`Md` 组件流式追加文字时，未定型的整个代码块反复全量执行 `marked.parse` 与 `hljs.highlight` 正则匹配，加剧主线程拥塞；
5. **缺少虚拟滚动**：所有历史消息的真实 DOM 节点全量堆积在文档树上，卡片与行号元素膨胀导致浏览器重绘开销陡增。

**已实现**：
1. **Store 级流式事件 RAF 批量合并（Batching & Coalescing）**：
   - 在 `store.ts` 引入 `scheduleNotify()` 批处理机制，对高频纯文本增量（`text_delta`、`reasoning_delta`）原地追加文本缓冲，通过 `requestAnimationFrame`（50ms 定时器兜底）合并派发，将每秒几十次全树重绘收敛到流畅帧率（~60fps），彻底消灭输入滞后；
   - 结构性与状态性事件（`assistant_start`, `tool_call_start`, `tool_result`, `approval_request`, `error`, `done` 等）同步清空 pending 调度并立即同步通知，确保卡片生命周期与审批严格保序；
   - 拆分 `structureVersion`：仅在增删消息、创建/切换会话、折叠展开等结构性变更时递增；
   - `appendToBlock` 与 `flushAssistant` 引入 `WeakSet` O(1) 判定，彻底消除回合条目数组的线性扫描。
2. **Token 估算多级缓存与轻量化**：
   - 静态系统提示词与工具规格缓存：避免每次组件渲染都重复序列化与分词数万 Token，仅在模型或设置变更时计算一次；
   - 历史定型条目与完结回合全量采用 `WeakMap` 多级缓存，历史长文本 O(1) 秒取，消除长会话重复 BPE 编码。
3. **彻底消除滚动中的 Layout Thrashing**：
   - 解耦 `Transcript.tsx` 的 `measure()` 刻度计算，从依赖全局 `version` 改为仅依赖 `structureVersion`，流式追加期间零次触发刻度重算与监听器重建；
   - 滚动监听采用 `requestAnimationFrame` 节流；静态 Y 坐标偏移仅在 `ResizeObserver` / 结构变更时计算一次，滚动事件中实现纯数字数学比对，杜绝滚动中密集调用 `getBoundingClientRect()`；
   - 时间线轨道鼠标悬停波浪动效增加 RAF 节流，消除指针滑动时的重绘堆积。
4. **Markdown 与语法高亮多级缓存**：
   - `markdown.ts` 增加容量为 200 的 Markdown 编译结果 LRU 缓存与容量为 300 的代码高亮 LRU 缓存，避免对相同代码块重复执行耗时的语言正则着色；
   - `Md` 组件使用 `React.memo` 浅比对优化，非活动消息与折叠内容直接跳过 Virtual DOM 协调。

---

### 29. 多会话并发执行与运行态会话无感切换

**状态**：✅ 已完成（2026-09-22）——解除全局锁定与非阻塞会话切换 + Store 视图状态隔离池化（`SessionViewState`）+ 全局事件路由分流与后台静默推进 + 侧栏实时状态指示徽标（运行绿点脉冲、等待审批橙色呼吸、错误红点）+ 独立删除保护 + 引擎端工作区互斥锁（`WorkspaceLockManager`）与敏感工具排队写入

**背景**：
目前只要某个会话内的 Agent 开始执行任务，应用即进入全局锁定状态：用户在侧栏点击其他会话被直接拦截（`if (this.running) return;`），无法切换查看历史代码或提出新问题；同时前端状态为单例平铺设计，不支持多个会话在后台并发执行。

**已实现**：
1. **解除运行中切换限制与 0ms 瞬切**：
   - 彻底移除 `selectSession` 中的全局 `running` 阻断；支持用户在任一会话执行耗时任务时，自由在侧栏切换到其他历史会话查阅代码、复盘，或在空闲会话中并发启动新任务；
   - 增加切换序列号 `selectSeq` 防异步乱序竞争；对已加载或正在后台执行的会话实现 0ms 零白屏瞬间切换，切回时即时呈现当前实时进度与 LiveTicker；
2. **按会话隔离 ViewState 与事件路由分流**：
   - Store 引入会话视图状态池 `sessionStates = Map<sessionId, SessionViewState>`，将 `items`、`currentTurn`、`activeTodos`、`sessionUsage`、`lastUsage`、`running`、`status` 全面按会话隔离维护；
   - 重构 `client.onEvent` 事件路由：所有会话事件按 `sessionId` 分发并累积到各自的状态池中；当前活动会话进行高频 RAF 合并渲染，后台会话静默推进状态并在产生关键状态跃迁（开始运行、遇到审批等待、执行完成、发生错误）时更新指示器；
3. **侧栏多会话状态实时指示灯**：
   - 侧栏每个会话行独立呈现状态指示：
     - `● running`：绿色呼吸脉冲点（正在后台执行任务）；
     - `○ waiting`：琥珀色呼吸徽标（后台任务等待用户审批，点击直达审批卡片现场）；
     - `✕ error`：红色错误标识；
   - 独立删除安全保护：仅禁用正在运行中的会话删除按钮，后台有任务时不影响删除其他空闲会话；
4. **工作区写入互斥与并发安全（Workspace Lock）**：
   - 引擎端引入基于 FIFO 队列与 AbortSignal 感知的轻量异步互斥锁 `Mutex` 与 `WorkspaceLockManager`（路径标准化处理消除 Windows 大小写差异）；
   - 绑定不同工作区的会话完全独立并发；
   - 绑定同一工作区根目录的多个会话，在执行敏感写操作（`write_file`, `edit_file`, `run_command`）时由工作区锁保护并按序排队执行，杜绝文件改动覆盖冲突；只读操作（`read_file`, `list_dir`, `search_files`）与审批等待期不占锁，保障并发吞吐。

---

### 30. 模型热切换安全边界守护与上下文继承策略

**状态**：✅ 已完成（2026-09-22）——上下文 80% 安全阈值检测与统一 Token 估算器 `estimateSessionTokens` + `<ModelSwitchGuardModal>` 容量安全预警与三大继承策略（⑂ 分叉为新分支、✄ 当前会话裁剪历史、⚠ 忽略直接切换）+ Engine `trimSessionHistory` 历史裁剪与持久化 + 跨厂商 Wire Format 兼容清洗（Anthropic 过滤未签名 thinking 块、OpenAI 剔除孤儿 tool_result 与自动补齐断尾 tool_calls）

**背景**：
当前在会话中切换模型时，底层会话消息数组 `messages` 完整保留并透传给新模型。但存在以下风险：
1. **小窗口溢出崩溃**：若从大上下文模型（如 1M/200k）积累了数万 Token 上下文后切换到小上下文模型（如 32k/8k），新模型发起请求会直接遭遇 HTTP 400（Context Length Exceeded）而异常中断；
2. **厂商私有格式兼容**：不同模型对 thinking 块签名、tool_call_id 格式等要求不一致，直接透传易引发校验报错；
3. **缺乏用户感知**：用户切换模型时对上下文是否继承、继承后的风险缺乏透明度和选择权。

**已实现**：
1. **上下文容量校验与 80% 阈值预警**：
   - 提取全局复用的 Token 估算器 `estimateSessionTokens`（复用 WeakMap 多级缓存）；
   - 在 `ModelEffortPicker` 切换模型或供应商时，动态比对当前会话用量与目标模型窗口大小；
   - 超过 80% 时自动拦截切换并弹出极客暗黑风预警弹窗 `<ModelSwitchGuardModal>`；
2. **三大灵活处理策略**：
   - **「⑂ 分叉为新分支并精简历史（推荐）」**：保留原会话与原配置不受损，自动分叉出新分支会话并继承最新任务清单，精简早期历史并应用新模型；
   - **「✄ 在当前会话裁剪早期历史」**：调用 Engine 端的 `trimSessionHistory` 接口，归档早期冗长内容，保留最新 2 轮完整交互和任务清单；
   - **「⚠ 忽略风险，直接切换」**：保留全量历史直接切换；
3. **跨厂商 Wire Format 兼容清洗**：
   - **Anthropic 适配器**：清洗过滤未带服务端有效签名的 thinking 块，杜绝跨模型切换后 Anthropic 抛出 400 校验错误；
   - **OpenAI 兼容适配器**：严格校验 `role: 'tool'` 消息的前序 `tool_call_id` 匹配性，过滤孤儿 tool；若遇到未闭合的断尾 `tool_calls`，自动补齐中断占位响应，保障消息序列合规。

---

### 31. 上下文超限保护与智能自动压缩（Context Compaction）

**状态**：✅ 已完成（2026-09-22）——Core 压缩核心 `compaction.ts`（`pruneHistoricalToolResults` 第一级工具长输出折叠 + `compactHistoryMessages` 第二级阶段记忆归档与涉及文件/命令/Todo提取）+ Agent 循环步间超限检测与自动压缩（`contextWindow` 与 `autoCompactThreshold`）+ `context_compacted` 单向事件通知 + `ContextChip` 80%/95% 多级警戒变色与呼吸光圈 + 浮层预警与主动「✄ 压缩上下文」按钮 + 设置页常规区自动压缩开关与阈值调节全链路打通

**背景**：
当前引擎没有任何上下文压缩与修剪逻辑，随着交互回合增多、多轮读取大文件与长命令输出，Token 消耗单调递增，最终必然撞上模型上下文上限而失败。需要对标顶尖 Coding Agent 建立稳健的上下文压缩体系。

**已实现**：
1. **阶梯式渐进压缩核心（Core Compactor）**：
   - **第一级（工具长输出折叠裁切 `pruneHistoricalToolResults`）**：对早于保留轮次的大型工具输出（如大文件读取、冗长构建日志），若超 1000 字符或 25 行执行首尾行保留（各 10 行）与结构化折叠，保留行数与字符统计；严格保留 `toolCallId` 完备配对，杜绝模型适配器孤儿报错；
   - **第二级（历史轮次阶段记忆归档 `compactHistoryMessages`）**：保留最近 N 轮（默认 2 轮）完整交互，从早期轮次中自动扫描提炼涉及的文件路径集合（`read_file`, `write_file`, `edit_file`）、执行的关键命令（`run_command`）与最新的任务清单（`todo_write`）进度快照，聚合成高密度阶段记忆说明消息，替换旧历史；
2. **Agent 循环内步间自动超限保护（In-Loop Auto-Compaction）**：
   - `runAgentLoop` 支持感知模型 `contextWindow` 与可配置阈值（`autoCompactThreshold`，默认 85%）；
   - 在多步交互循环中，当上一轮输入 Token 超过设定阈值且仍需继续执行工具时，就地原子触发阶梯压缩，无损更新 `messages`，发射 `context_compacted` 事件，保证长任务平滑执行不中断；
3. **前端多级预警看板与主动瘦身入口**：
   - `ContextChip` 根据容量占比 `pct` 动态切换样式：80%~95% 呈现琥珀色警戒态（`.ctx-warn`，文字/边框/SVG环变黄），超过 95% 呈现红色高危呼吸态（`.ctx-danger`）；
   - 浮层内部根据状态呈现黄色预警或红色紧急超限横条（`.ctx-pop-alert`）；
   - 浮层脚部提供极客暗黑风「`✄ 压缩上下文（归档早期历史）`」操作按钮，支持开发者一键主动瘦身；单轮对话时智能禁用；
4. **设置页全链路配置化**：
   - 设置页「常规」面板新增「上下文超限自动压缩」开关（默认开启）与「自动压缩触发阈值 (%)」输入控件（默认 85%），并在 `Settings` 中持久化存储。

---

### 24. 折叠容器吸顶体验：工具卡片与思考过程头部 Sticky 常驻，免除长滚动后的回滑折叠

**状态**：✅ 已完成（2026-09-21）——`.tool-head` / `.term-head` / `.thinking-head` / `.turn-head` 全部吸顶（`position: sticky; z-index: 5` + 实色背景 + 层次阴影），钉位按 Chromium「滚动容器 padding box」基准做了负值补偿贴平视窗顶缘，并配 `:has()` 避让规则

**背景**：
当用户点击展开长内容的**工具调用卡片**（如长 Diff、大段命令输出、长搜索列表）或**思考过程**（长篇推理）时，随着用户用鼠标滚轮向下阅读，**卡片顶部用于折叠/展开的头部栏会被一路推到视口上方之外**。
当用户在底部读完后想要收起卡片时，由于折叠按钮已经不可见，必须费力地在滚轮上向上滑回几百甚至上千像素找到头部才能点击折叠，操作链路断裂且体验繁琐。

**已实现**：
1. **折叠头部 Sticky 吸顶**：
   - 工具卡片头部（`.tool-head`）、拟终端卡片头部（`.term-head`）、思考过程卡片头部（`.thinking-head`）在 `.turn-body` 局部滚动视窗内吸顶；回合头部（`.turn-head`）在外层会话滚动容器内吸顶；
   - 解除 `.tool-card` / `.term-card` 的 `overflow: hidden`（会禁用内部 sticky），思考块重构为 `.thinking-card` 终端风格卡片并带开闭态圆角；
   - 实测钉位遵循 Chromium「sticky 以滚动容器 padding box 为基准」的行为，`.turn-head` 以 `top: -22px` 补偿 `.transcript-scroll` 的 `padding-top`、卡片头部以 `top: -4px` 补偿 `.turn-body` 的 `padding-top`，实现真正贴平视窗顶缘（含 `LiveTicker` 统一为 `top: -4px`）；
2. **防穿模与层级视觉保障**：
   - 吸顶头部全部实色背景（`var(--panel)` / `var(--panel2)` / `var(--bg)`）+ `0 8px 12px -10px` 轻层次阴影，下方滚动的文字与代码平滑滑入头部下方不透出；
3. **吸顶避让（`:has()` 规则）**：
   - 回合运行态 `LiveTicker` 在场时，卡片/思考头部钉位于其正下缘（`top: 29px`）；任务清单吸顶栏（`sticky-todo`）在场时，回合头部钉位于其正下缘（`top: 17px`），多层吸顶互不遮挡。

---

### 23. 文件工具卡片视觉降噪：去除 write_file / edit_file 冗余的 Raw JSON 代码输入块

**状态**：✅ 已完成（2026-09-21）——`ToolCard` 展开态对 `write_file` / `edit_file` 不再渲染 raw JSON 输入块，聚焦「结构化 Diff 视窗 + 执行结果」；其他工具保留参数输入显示

**背景**：
虽然目前 `write_file` 和 `edit_file` 工具卡片已经有了专门的可视化 Diff 审查视窗（红绿对比与新文件内容预览），但 `ToolCard` 在展开状态下依然无差别执行了：
```tsx
<div className="kv">
  <span className="k">输入</span>
  <pre>{JSON.stringify(item.input, null, 2)}</pre>
</div>
```
对于写入（`write_file`）或修改（`edit_file`）文件的操作，这意味着整份被写入或替换的大段代码字符（`content` / `old_string` / `new_string`）会被全量以原始 JSON 字符串形式 dump 在 Diff 视窗下方。
- **100% 信息重复**：上方已有结构化且带行号的 Diff 视窗，下方再展示一遍代码纯属累赘；
- **视觉噪音大且打乱视线**：大段 raw JSON 动辄占屏上千像素，充斥着大量的换行转义符（`\n`），且把最下方的关键信息（工具执行结果、OK/Error 状态、耗时）挤到了最底部，严重干扰用户视线。

**期望行为**：
1. **针对文件修改类工具剔除 raw JSON 输入块**：
   - 当工具为 `write_file` 或 `edit_file` 时，卡片展开后**不再渲染 raw JSON 代码输入块**；
   - 卡片展开内容聚焦于两部分：**① 结构化可视化 Diff 视窗** 与 **② 执行结果/状态（若有输出或报错）**；
2. **只保留关键上下文**：
   - 文件的目标路径在卡片头部摘要与 Diff 头部已有清晰展示（如 `packages/ui/src/App.tsx · 新文件 · 50 行`），无需大段重复字符；
   - 非代码修改类工具（如 `search_files`, `run_command`, `list_dir` 等）保留正常的参数输入显示。

**涉及改动**：
- `packages/ui/src/components/Transcript.tsx`：在 `ToolCard` 中添加条件判断（如 `name !== 'write_file' && name !== 'edit_file'` 时才渲染 raw input pre 块）。

---

### 19. 代码与差异审查增强：代码块语法高亮 + 独立复制 + edit_file 可视化 Diff 视图

**状态**：✅ 已完成（2026-09-21）——代码块语法高亮（highlight.js/common 30+ 常用语言）+ 顶部语言标识条与一键复制 + `edit_file` 红绿行号 Diff 视窗与增删统计 + `ApprovalCard` 审批实时预览

**已实现**：
1. **代码块语法高亮与操作条**：
   - 引入 `highlight.js/lib/common`（零体积膨胀，支持 TS/JS/Rust/Python/Bash/Go 等高频语言），在 `markdown.ts` 中实现自定义代码块渲染；
   - 代码块顶部增加小窄条：左侧声明语言（如 `// typescript`），右侧提供 `[ ⧉ 复制 ]` 按钮；
   - 基于事件委托实现一键复制与纯文本提取，点击后即时反馈 `✓ 已复制`（1.5 秒后自动复原）；
   - 在 `styles.css` 中打造符合 EasyCode 的极客暗黑终端高亮调色板（冷绿/青色/琥珀/品红等经典色系）。
2. **可视化 Diff 审查（补齐 `edit_file`）**：
   - 重构 `ToolDiff`：当工具为 `edit_file` 时，调用 `@easycode/core` 的 `diffLines` 计算行级差异；
   - 直观渲染结构化红绿视窗：红色删除行 `-`、绿色新增行 `+`、双侧旧/新行号精确递增，支持全局替换徽标、增删行数实时统计（`-N +M`）与超长差异折叠保护；
   - `write_file` 同步升级为统一行号视窗；`ApprovalCard` 审批卡片同步嵌入 Diff 预览，批准前即可直观审查改动。

---

### 20. 输入控制体验打磨：Composer 自适应高度 + 顶部栏响应式收敛 + 文件拖拽填充

**状态**：✅ 已完成（2026-09-21）——输入框 2~8 行自适应撑高（超 8 行出滚动条、发送后收缩）+ 顶部栏窄宽度时用量/容量 chip 收敛为微型图标与进度环（悬停浮出明细）+ 文件拖拽填充路径至光标处（Tauri 窗口级拖放事件 / Electron webUtils / 浏览器演示兜底文件名）

**已实现**：
1. **输入框自适应撑高（Auto-grow Textarea）**：
   - 按内容即时量高（`scrollHeight`），CSS `min-height: 60px`（2 行）~ `max-height: 181px`（8 行）钳制，超出出纵向滚动条；发送清空后自动收缩回初始高度；窗口宽度变化时重算折行高度；高度变化带 120ms 平滑过渡（`prefers-reduced-motion` 下关闭）。
2. **顶部工具栏响应式收敛**：
   - Composer 以 `ResizeObserver`（+window resize 兜底 + 初始测量）监测顶部栏可用宽度，低于 640px 时进入紧凑态；
   - Token 用量 chip 收敛为 `⇅` 微型图标、上下文容量 chip 收敛为 SVG 进度环（按实际占用比例描边），`title` Tooltip 携带完整数值，悬停即浮出原有明细看板（`onMouseEnter/Leave`），点击展开行为保留；优先保障审批模式与模型选择控件完整可见。
3. **文件拖拽填充（Drag & Drop）**：
   - **Tauri 宿主**：`dragDrop` 由窗口级接管（DOM drop 不触发），监听 `onDragDropEvent` 拿真实绝对路径，物理像素坐标换算后与输入区包围盒求交，命中才插入；
   - **Electron 宿主**：preload 暴露 `webUtils.getPathForFile`（兼容旧版 `File.path`），HTML5 drop 事件提取路径；
   - **浏览器演示**：无路径可取时兜底插入文件名；
   - 插入语义：路径插入当前光标位置（替换选区），多文件换行拼接，含空格/引号的路径自动加引号包裹，插入后光标落在末尾并聚焦；拖拽悬停时输入框绿色高亮 + 「⊘ 松开插入文件路径」行内提示。

---

### 21. 运行态与终端拟态强化：Agent 实时动作指示器（Live Ticker）+ run_command 拟终端卡片

**状态**：✅ 已完成（2026-09-21）——`store.ts` 活跃工具追踪（startedAt 与 activeTool）+ `LiveTicker` 实时平滑计时状态行（秒级计时+光标闪烁+等待审批态）+ `run_command` 拟终端卡片（带 `$ 命令` 标题栏、退出码徽标、执行中光标）+ 零依赖 ANSI 16 色与 `\r` 转码高亮

**已实现**：
1. **运行态数据流与实时动作指示器（Live Ticker）**：
   - `ToolItem` 增加 `startedAt` 启动时间戳，`store.ts` 提供 `activeTool` 与 `pendingApproval` 响应式状态；
   - 在活动回合内新增 `LiveTicker`：动态展示 `❯ [{tool_name}] 正在执行: {summary} (已耗时 {seconds}s) █`，支持毫秒/秒级平滑计时；若触发审批则提示 `❯ [{tool_name}] 等待用户审批操作... █`；
2. **run_command 拟终端控制台卡片**：
   - 定制 `TerminalCard`：顶部终端风格标题栏，显示 `$ {command}`、执行状态码徽标（`exit: 0` 绿标 / `exit: 1` 红标，从结果提取）与耗时；
   - 运行中展示拟终端命令行动态光标 `█`；
   - 新建 `packages/ui/src/ansi.ts` 零依赖轻量解码器，解析 ANSI SGR 标准 16 色、高亮色、粗体、暗淡等样式，并处理 `\r` 回车覆盖（平滑兼容动态进度条与加载旋转器）。

---

### 22. 界面舒适度与微动效：CRT 扫描线可配置开关 + 弹窗轻量平滑过渡

**状态**：✅ 已完成（2026-09-21）——设置页「常规」新增 CRT 扫描线开关（默认开，关时平滑淡出切换纯黑终端风）+ 弹窗与全浮层微缩放淡入动效 + prefers-reduced-motion 无障碍支持

**已实现**：
1. **CRT 扫描线配置开关**：
   - 引擎层 `Settings` 接口与 `DEFAULT_SETTINGS` 扩展 `crtScanline?: boolean`（默认开）；
   - 设置页「常规」新增开关控件（已开启/已关闭），提示“切换为纯黑极简现代终端风”；
   - `App.tsx` 响应设置动态切换 `html.crt-off`；`styles.css` 中为 `body::after` 添加 `opacity` 平滑过渡，关闭时淡出隐藏，把视觉风格选择权交还给用户。
2. **弹窗与全屏覆盖层平滑微动效**：
   - 为 `.modal-mask` 添加 180ms 柔和淡入，为 `.modal` 添加 200ms `translateY(8px) scale(0.985)` 平滑展开；
   - 为项目切换器（`.proj-pop`）、模型选择器（`.me-pop`）、思考滑杆（`.effort-pop`）、更新说明（`.update-pop`）、帮助菜单（`.help-menu`）、终端下拉（`.tsel-menu`）、容量/用量面板及 Toast 浮层加入 140ms~160ms 平滑轻量微动效，消灭生硬瞬切感；
   - 文件尾部统一支持 `@media (prefers-reduced-motion: reduce)` 无障碍动效关闭。

---

### 18. 会话视口重构：模型过程独立滚动视窗 + 任务清单常驻吸顶

**状态**：✅ 已完成（2026-09-21）——`.turn-body` 独立局部视窗（max-height 55vh + 局部自动贴底跟随 + 内部滚轮隔离）+ 外层滚动解耦（仅发送与切会话时定位，提示词永不被冲走）+ 任务清单顶部常驻吸顶（StickyTodoBar 单行紧凑进度 + 展开详情面板）

**已实现**：
1. **模型过程独立滚动视窗**：
   - 回合展开态（`TurnView`）的过程体（`turn-body`）设为局部独立滚动视窗（`max-height: 55vh; overflow-y: auto; overscroll-behavior: contain;`）；
   - 在回合活动（`live`）期间，流式更新仅触发 `.turn-body` 自身贴底；用户向上滚轮翻看时自动暂停跟随；
   - 内部滚轮事件隔离：阻止向外冒泡，防止局部滚轮翻看误触发外层的脱离贴底状态；
   - 解耦外层主视口滚动：移除外层随 `store.version`（每个 token delta）强制滚底的逻辑，仅在用户发消息（`scrollTick`）或切换会话时平滑贴底，保障用户提问（`UserView`）始终舒适停留在可视区上方。
2. **任务清单顶部常驻吸顶（Sticky Header）**：
   - 新增 `StickyTodoBar` 组件，响应式订阅 `store.activeTodos`，无待办事项时自动隐藏不占空间；
   - **紧凑态（默认）**：以毛玻璃半透吸顶单行状态栏呈现（`[◍ 进度 N/M · P%] 正在进行: xxx ▾`），全部完成显示 `[✓ 全部任务已完成]`；
   - **展开态**：点击顺畅展开完整任务列表，显示每项的状态图标（○ / ◍ / ✓）、步骤描述与优先级标签；再次点击收起。

---

### 1. Windows Shell 增强：探测式自动选择 + 设置可覆盖

**状态**：✅ 已完成（2026-09-21）——探测式自动选择（pwsh 7 → Git Bash → PowerShell 5.1 → cmd）+ 设置页可覆盖 + Windows 原生 CP_ACP 智能转码杜绝 GBK 乱码

**已实现**：
- **探测式自动选择**：Rust 宿主启动探测（`proc_detect_shells`），优先级 `pwsh 7 → Git Bash → PowerShell 5.1 → cmd`，自动选择最高可用 Shell；
- **设置页可覆盖**：设置页「常规」新增「命令行终端 (Shell)」下拉单选，默认自动，且动态展示系统检测到的终端状态，支持用户自由切换；
- **智能转码杜绝乱码**：Rust 侧 `decode_output` 自适应解码，优先合规 UTF-8，若包含非法字节则调用 Windows 原生 API `MultiByteToWideChar(CP_ACP)` 转为 UTF-8，彻底解决 cmd / powershell 5.1 中文乱码问题；
- **全链路贯通**：Core（`ProcessRunOptions` / `ToolContext`）→ Engine（`Settings.shell` / `AgentServer`）→ Host（Tauri & Node）→ UI 完整透传。

---

### 17. 更新详情弹窗被窗口左缘截断

**状态**：✅ 已实现（2026-09-20，随 v0.1.7）——`.update-pop` 改为 `left: 0` 向右展开，宽度 320px

**背景**：侧栏更新角标的详情面板（发现新版本/更新说明/下载并安装）定位为 `right: 0`（相对角标向左展开），角标又在侧栏左下角——面板直接超出窗口左缘，内容被截断（截图已复现）。

**方案**：`.update-pop` 改为 `left: 0`（向右展开进会话区），宽度可加大到 ~320px 提升可读性；z-index 保持最高层。

**涉及改动**：仅 styles.css 定位调整。

---

### 16. 应用内右键菜单：自定义极客终端风上下文菜单

**状态**：✅ 已完成（2026-09-22）——自定义全局自绘终端风右键菜单 `<ContextMenu>` + 上下文感知（选区复制/代码块提取/提问与回答复制/回合一键分叉/新建会话/导出会话/工作区直达/停止任务）+ 视口边缘防溢出贴靠 + 输入控件原生粘贴保护

**背景**：应用内右键原本弹出的是操作系统或 WebView2 原生菜单（返回/刷新/另存为/打印/更多工具），与应用无关且严重破坏极客暗黑终端沉浸感。

**已实现**：
1. **全局自绘终端风浮层 (`<ContextMenu>`)**：
   - 彻底消除白色浏览器原生菜单，全局采用暗黑微质感调色板（`--panel` / `--border2` / `popIn` 动效）；
   - 输入控件（`input`, `textarea`, `contentEditable`）保留原生右键菜单，保障原生输入法与粘贴操作习惯；
2. **丰富的上下文语义识别 (Context-Aware)**：
   - **选区感知**：检测用户划选文字，提供「⧉ 复制选中文本」；
   - **代码块感知**：悬停于代码块（`.code-block`）内部时，提供「⧉ 复制代码块」纯文本提取；
   - **用户提问消息感知**：右键用户消息气泡，提供「⧉ 复制用户提问」与「⑂ 从此处分叉会话」；
   - **模型回答回合感知**：右键回合回答区域，提供「⧉ 复制回答 Markdown」与「⑂ 从此回合分叉会话」；
   - **全局常用快捷操作**：提供「＋ 新建会话」、「⤓ 导出会话 (Markdown)」、「📂 打开工作区目录」、「■ 停止当前任务」以及「⚙ 打开应用设置」；
3. **视口边界防溢出微调**：
   - 采用 `useLayoutEffect` 实时比对点击坐标与菜单宽高，在贴近屏幕底缘或右缘时自动向内吸附贴合，避免菜单项被截断；
   - 支持键盘 `Escape` 键随时关闭、全局点击空白处即刻收起。

---

### 15. 单次任务步数上限：提升或改为可配置

**状态**：✅ 已完成（2026-09-21）——`Settings.maxSteps` 全链路配置化（缺省 200，支持 10~500 步）+ 设置页「常规」新增数字步数调节控件 + `AgentServer.runTurn` 动态透传至 Agent 循环

**已实现**：
- `packages/engine/src/settings.ts`：`Settings` 增加 `maxSteps?: number;`（`DEFAULT_SETTINGS` 默认 200）；
- `packages/engine/src/server.ts`：`runTurn()` 调用 `runAgentLoop` 时传参 `maxSteps: this.settings.maxSteps ?? 200`；
- `packages/core/src/test/loop.test.ts`：补充 `maxSteps` 步数上限耗尽返回 error 的单元测试并全部通过；
- `packages/ui/src/components/SettingsPage.tsx`：设置页「常规」面板新增单次任务最大步数调节输入框与提示文案，支持实时保存。

---

### 14. 「打开工作区」按钮：资源管理器 / VS Code

**状态**：✅ 已完成（2026-09-20 随 v0.1.8 实现文件管理器；2026-09-21 随 v0.1.9 补齐 VS Code 与默认方式记忆）

**已实现**：
- Rust 命令 `open_path`（`tauri-plugin-opener`），经 AgentClient 暴露为 `openPath`：Tauri 用系统文件管理器打开，Electron 走 `shell.openPath`，演示模式空实现
- Rust 命令 `open_in_vscode`：Windows `where code` / Unix `which code` 探测，找到后隐藏窗口 spawn（Windows 经 `cmd /C code`）；未找到返回错误，UI toast 提示安装。Electron 主进程同语义实现
- 设置页「常规」→「打开工作区方式」下拉（`settings.openWorkspaceWith`：explorer / vscode，默认 explorer）；项目切换器按钮文案与行为跟随默认方式（「⧉ 在文件管理器中打开」/「⌨ 在 VS Code 中打开」）
- 未绑定工作区的会话不显示该入口（等效满足"按钮禁用"）

---

### 13. 任务完成桌面通知（右下角，应用风格）

**状态**：✅ 已完成（2026-09-20 随 v0.1.8 实现；2026-09-21 随 v0.1.9 补齐子项）

**已实现**：
- 走系统原生通知（Rust 命令 `send_notification`），经 AgentClient 抽象：Tauri 用系统通知、Electron 用主进程 `Notification`、演示模式退回浏览器 Web Notification
- 触发时机：store 的 `done` 事件（Agent 回合结束），且 `document.hasFocus()` 为假（窗口在后台）才发；前台时沿用应用内 toast，不重复打扰
- 文案区分：回合内出现过错误条目（loop 保证 error 后必发 done，不会双发）→「EasyCode — 任务出错」，否则「EasyCode — Agent 完成」，正文为会话标题
- **点击唤起**（Windows）：winrt toast 挂 `on_activated` 回调，点击通知 → 主窗口 unminimize + show + set_focus；非 Windows 走插件无点击回调
- **设置开关**：设置页「常规」→「任务完成桌面通知」（`settings.desktopNotify`，默认开）

**已知行为：dev 构建的通知会署名为「Windows PowerShell」**（图标也是 PowerShell 的），这是插件的刻意设计而非缺陷：`tauri-plugin-notification` 的 Windows 分支检测到 exe 位于 `…/target/debug` 或 `…/target/release` 时**不设置 `System.AppUserModel.ID`**（源码注释：*set the notification's System.AppUserModel.ID only when running the installed app*），于是 `tauri-winrt-notification` 落到它文档化的兜底方案 `Toast::POWERSHELL_APP_ID`（该常量注释原文：*the toast will erroneously report its origin as powershell*）。v0.1.9 起 Windows 直连 winrt toast，沿用同一策略（dev 回退 PowerShell AUMID，否则 toast 拒发）。

**安装版（NSIS）署名正常**：包外路径运行时会传 `app_id = com.easycode.desktop`，且该 AUMID 已由安装器的开始菜单快捷方式注册（`EasyCode.lnk` 的 `System.AppUserModel.ID` 属性即此值）。实测对比：debug 路径运行 → 通知库里 `powershell.exe` 计数 +1；把 exe 复制到非 `target` 路径运行 → `com.easycode.desktop` 计数 +1。**因此验收通知署名需用安装版，不要在 dev 构建下按此判缺陷。**

**设计取舍**：自绘终端风小窗（原方案 b）不做——系统通知已覆盖提醒诉求，且与「点击唤起」天然配合；若未来要与应用风格完全一致再评估。

---

### 12. 任务清单：Agent 可维护进度面板（会话内渲染）

**状态**：✅ 已完成（2026-09-21）——内置 `todo_write` 工具 + 极客风 TodoCard 面板 + 状态实时更新（待办/进行中/完成）+ 回合折叠态进度条 + 会话持久化（参照 Claude Code TodoWrite / ZCode 进度面板）

**已实现**：
- **核心工具 `todo_write`**：注册为内置工具（零审批要求、全场景可用），参数为 `todos` 数组，整体替换式更新；强制约束至多只能有 1 项处于 `in_progress`；执行后返回纯文本进度摘要供模型继续。
- **系统提示词主动引导**：在工作纪律中引导模型“处理多步骤、较复杂或跨文件的开发任务时，积极使用 todo_write 规划任务清单并在执行中持续更新状态”。
- **极客风进度面板渲染**：Transcript 中为 `todo_write` 提供专门优化的 `TodoCard`，清晰渲染每项步骤的状态（○ 待办 / ◍ 亮绿呼吸动效进行中 / ✓ 绿色完成）与优先级徽标；支持面板折叠/展开与进度百分比统计。
- **折叠态进度指示**：回合折叠后（`TurnView`），在最终回答上方保留该回合最新的任务清单进度条（`[◍] 任务进度 N/M` 与当前进行中任务），折叠后依然对进度一目了然。
- **数据流与持久化**：`SessionData.todos` 随会话文件自动持久化，重载或切换会话后准确恢复。

---

### 11. 助手最终输出加复制按钮

**状态**：✅ 已实现（2026-09-20，随 v0.1.6）——实现为回合头部「复制」按钮（复制最终文本的 Markdown 原文），参照 ZCode

**期望行为**：助手消息（最终输出）悬停时右上角出现复制图标按钮，tooltip「复制」，点击把该条回复的 Markdown 原文复制到剪贴板（复制后可短暂变为「已复制」反馈）。

**涉及改动**：Transcript.tsx assistant 消息容器（悬停操作条）；配合 #8 回合聚合时注意复制的是"最终文本"而非整个回合。

---

### 10. 会话目录/时间线轨道：左侧刻度导航，悬停预览、点击跳转

**状态**：✅ 已实现（2026-09-20，随 v0.1.6）——等距刻度（14px）+ 垂直居中滑移 + 悬停预览 + 点击跳转 + 波浪效果；等距方案下刻度密度不随内容增长，「过密抽稀」不再需要（参照 ZCode 会话左侧的时间线）

**背景**：长会话里上下文一多，想回看/定位某条消息只能慢慢滚。

**期望行为**：
- 会话区左侧渲染一条细时间线轨道，每个用户消息（或每个回合）一个刻度
- **悬停刻度**：浮出该位置消息的内容预览
- **点击刻度**：滚动定位到对应消息
- 长会话刻度过密时聚合/抽稀（按屏幕高度均匀采样）

**实现要点**：
- 刻度定位：渲染后测量各消息在滚动容器中的 offsetTop（或按消息序号比例映射）
- 与 #7 用户消息 id、#8 回合聚合天然配合：刻度按回合分组，锚点用消息 id
- 与滚动改造（#3）协调：跳转属于用户主动滚动，不应被自动滚动逻辑覆盖

**涉及改动**：Transcript.tsx（轨道渲染、消息位置测量、跳转）、store（消息/回合元数据）。

---

### 9. 输入框历史：↑ 切换上一条指令，↓ 切回

**状态**：✅ 已实现（2026-09-20，随 v0.1.6）——↑/↓ 翻历史 + 光标首行/末行判定 + 草稿保护，范围当前会话

**期望行为**：
- 输入框为空时按 ↑ → 填入上一条已发送的消息；连续按 ↑ 继续向前翻
- 按 ↓ → 向后翻，翻过最新一条后恢复原状（清空或恢复翻历史前的草稿）
- 多行输入时遵循终端惯例：↑ 只在光标位于第一行时才翻历史（否则移动光标），↓ 同理在最后一行才向后翻
- 草稿保护：翻历史前保存当前未发送的草稿，翻回来时恢复
- 历史范围：当前会话的已发送消息（已确认，不做全局历史）

**涉及改动**：Composer.tsx 的 onKeyDown（已有 Enter/Shift+Enter 处理，追加方向键分支 + 光标行判断）；store 侧记录历史游标。

---

### 8. 回合聚合：过程折叠 + 用时统计，默认只显示最终结果

**状态**：✅ 已实现（2026-09-20，随 v0.1.6）——TurnItem 回合容器（用时统计、头部折叠、默认收起过程只留最终文本，重载后保持折叠）

**背景**：当前思考、每次工具调用、中间说明文本都平铺在会话流里，一次复杂任务的输出会把会话很快占满。

**期望行为**：
- 一次发送的完整执行（思考 + 工具调用 + 中间说明 + 最终回答）聚合为**一个回合块**
- 折叠态（默认）：头部显示「用时 X 分 X 秒 ⌄」+ 最终文本结果，过程全部收起
- 展开态：可查看过程中的思考、每次工具调用（工具卡片本身仍可逐个展开看输入/输出）、中间说明文本
- 计时：从模型开始工作到 done 的耗时，显示在回合头部
- 交互：运行中实时展示过程（展开），回合结束后自动折叠只留最终结果；用户随时可再展开

**涉及改动**：
- store/items 结构：引入"回合（turn）"容器概念——当前 items 是平铺列表（user/assistant/tool/approval/error），需要按一次 send 周期分组嵌套
- 计时：send() 记录起始时间，done 事件时写入回合时长
- 会话重载：从持久化消息重建回合分组（thinking/tool_call 在 assistant 消息的 blocks 里、tool_result 是独立消息，顺序可重建），重载后保持折叠态
- Transcript 渲染与折叠交互

**依赖/范围说明**：截图中的「上下文已自动压缩」属于上下文自动压缩功能，本条不包含。

---

### 7. 用户消息：显示发送时间、可复制、可编辑重发

**状态**：✅ 已实现（2026-09-20，随 v0.1.6）——终端风气泡框 + meta 行（时间/⧉复制/✎编辑，仅最近一条可编辑）+ 编辑重发（截断重生成，engine `editLastUserMessage`）

**背景**：当前用户消息只有一个静态气泡，无时间戳、无操作入口。

**期望行为**：
- 气泡下方（或悬停时）显示发送时间（如 2:29；悬浮可看完整日期时间）
- 悬停出现操作按钮：**复制**（文本进剪贴板）、**编辑**
- 编辑 = 修改文本并**从该消息重新生成**（截断该消息之后的所有轮次，重新发送）——参照 ZCode 语义

**涉及改动**：
- engine：ChatMessage 需增加 `id` 与 `createdAt`（时间戳）字段并持久化（当前消息无 id，仅按顺序存储）
- engine：新增编辑接口——按 id 定位用户消息，替换文本，截断其后的全部消息，触发重新生成
- UI：Transcript 用户消息悬停操作条（复制/编辑）、时间显示；编辑态复用 composer 或行内输入框

---

### 6. 模型选择器支持切换供应商（含模型子菜单）

**状态**：✅ 已完成（2026-09-21，随 v0.1.9 补齐子项）——菜单分组切换 + 底部「⚙ 管理模型」入口跳转设置页模型服务分区

**已实现**：
- engine `AgentServer.setSessionProvider(id, providerId, model?)`：校验目标服务已配置，切换 providerId 并把 model 落为目标服务第一个启用模型，reasoningEffort 一并重置（换服务后旧档位未必适用）
- `ModelEffortPicker` 分组平铺：当前服务一组（含「跟随服务默认」），其余启用服务各一组；组标题带 `// ` 前缀与顶部分隔线，其他服务的模型项常态降透明度，表达「选中即切换服务」语义
- 弹窗底部「⚙ 管理模型」按钮 → `store.openSettings('models')`
- 全链路打通：AgentClient → Tauri / Electron / 演示模式三种宿主实现

**设计取舍**：二级悬停子菜单不做（分组平铺实现更简单，且一次性可见全部可选模型，无需逐级悬停）——原条目本就标注"排期时定"，分组平铺即为定稿形态。

---

### 5. 关闭最小化到系统托盘（常驻后台）

**状态**：✅ 已完成（2026-09-22）——双端（Tauri 2.0 与 Electron）系统托盘图标 + 关闭窗口（✕）拦截隐藏常驻后台 + 托盘左键激活/右键菜单（显示主窗口/退出 EasyCode）+ 设置页常规面板开关（可配置关闭直接退出）

**背景**：此前点击关闭按钮应用直接销毁退出，导致后台执行的并发任务、长程重构以及后续计划的 Routines 定时任务被迫中断。

**已实现**：
1. **双端系统托盘能力完整落地**：
   - **Tauri 2.0 桌面端**：Cargo 启用 `tray-icon`，使用 `TrayIconBuilder` 构建带应用原色图标的托盘；左键单击快速还原并激活主窗口，右键弹出「显示主窗口」与「退出 EasyCode」；在 `WindowEvent::CloseRequested` 中拦截关闭事件，平滑调用 `window.hide()` 并 `prevent_close()`；
   - **Electron 桌面端**：基于 `Tray` 与 `Menu` 实现同等托盘交互，监听 `mainWindow.on('close')` 与 `win-control` 事件实现拦截隐藏；
2. **设置项与配置联动**：
   - `Settings` 协议增加 `closeToTray?: boolean`（默认开启）；
   - 设置页「常规」面板新增「关闭窗口时最小化到系统托盘」开关，关闭后点击右上角关闭按钮将直接退出整个应用，把行为选择权完全交给用户；
   - 宿主与前端动态同步 `closeToTray` 状态，免重启即时生效。

---

### 4. 项目体验重构：可折叠分组 / 会话改名 / 切换器显示项目名与菜单

**状态**：✅ 已完成（2026-09-21）——会话支持双击/悬停行内编辑改名（全链路打通）+ 侧栏项目分组支持折叠/展开（折叠状态持久化保存在 Settings 中）+ 组头操作菜单（··· 打开工作区/重命名项目/移除项目）+ Composer 项目切换器显示项目名与一键存为项目

**已实现**：
1. **会话标题支持修改**：
   - 提取可复用的 `SessionItemRow` 组件；
   - 支持在会话条目悬停时点击 `✎` 按钮或双击标题直接进入行内编辑模式；
   - 渲染终端风格输入框，支持 `Enter` 保存、`Escape` 取消、`onBlur` 自动提交；
   - 打通 `store.renameSession` → `client.renameSession` → `engine.renameSession`，侧栏与 TitleBar 标题即时同步更新并持久化。
2. **侧栏项目分组可折叠/展开**：
   - 组头增加 `▾` / `▸` 折叠切换按钮与会话计数徽标（如 `(3)`）；
   - 折叠状态持久化存储于 `Settings.collapsedProjects`，跨进程重启不丢失；
   - 折叠后整组会话即时收起，大幅释放侧栏纵向空间。
3. **项目组头管理菜单（···）**：
   - 悬停浮出 `···` 按钮，点击展开项目操作菜单；
   - 支持「⧉ 在文件管理器中打开」与「⌨ 在 VS Code 中打开」；
   - 支持「✎ 重命名项目别名」行内修改并持久化；
   - 支持「✕ 移除项目」（从配置列表移除，安全保留本地物理文件夹）。
4. **Composer 项目切换器显示与交互优化**：
   - 优先展示已命名项目名，未命名时智能提取当前关联文件夹名（不再直接粗暴展示"不在项目中工作"）；
   - 当关联未登记的文件夹时，下拉脚部提供「＋ 将当前目录存为项目」快捷按钮，一键持久化为项目。

---

### 3. 自动滚动改造：贴底跟随 + 回到底部按钮

**状态**：✅ 已实现（2026-09-20，随 v0.1.6+）

**背景**：当前会话区滚动跟随 `store.version`（每个 AgentEvent 都触发），导致 AI 流式输出、工具调用期间会话区被持续拉回底部，用户上翻阅读会被打断。

**期望**：
- 仅**用户发送消息**时滚动到底部
- 流式输出、工具调用、其他事件不触发滚动
- 切换会话时仍自动回到底部（保持现状）

**方案**（讨论中已设计，约 10 行改动）：
- `store.send()` 推送用户消息且 `autoScrollOn` 时递增一个 `scrollTick` 信号
- `Transcript` 的滚动 effect 依赖从 `[version, autoScrollOn]` 改为 `[scrollTick, activeId, autoScrollOn]`

**涉及改动**：store.ts（新增 scrollTick 字段与发送时递增）、Transcript.tsx（effect 依赖调整）。

---

### 2. 编辑加固：edit_file 强制"先读后改"

**状态**：✅ 已实现（2026-09-20，随 v0.1.7）——回合内维护已读文件集合，edit_file / 覆盖已有文件的 write_file 未读即拒绝并引导先读；edit/write 成功后也记入集合（会话内改过的文件可直接再改）

**背景**：当前 `edit_file` 不校验该会话是否读过目标文件，唯一防线是 `old_string` 精确匹配且唯一。模型理论上可以凭猜测"盲改"（碰巧匹配到通用代码片段），造成误改。

**业界参考**：Claude Code 等 Agent 对编辑类工具有硬约束——未在当前会话中读过的文件，编辑请求直接拒绝并提示先读。

**方案**（讨论中倾向）：
- 会话运行时维护"已读文件集合"（read_file 成功执行后记录绝对路径）
- `edit_file` / `write_file`（覆盖已有文件时）执行前检查：目标不在集合中 → 拒绝执行，返回"请先 read_file 该文件"引导模型补读
- 新文件（write_file 创建）不受限制
- 代价：个别场景多一轮读取；收益：消灭盲改类误操作

**涉及改动**：core 工具层（需要跨工具调用的会话内状态，ToolContext 传递或 AgentServer 维护）。

