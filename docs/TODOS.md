# TODOS — 需求记录

> 这里只记录需求与方案，**先记录、排期后再做**。路线图级的长期规划见 [PLAN.md](PLAN.md)。

## 待办需求

### 1. Windows Shell 增强：探测式自动选择 + 设置可覆盖

**状态**：已记录，未排期

**背景**：`run_command` 在 Windows 上当前固定使用 `cmd /C` 执行（Rust 侧 `proc_run`）。

**痛点**：
- 模型亲和差：模型训练数据以 bash 为主，`ls` / `rm -rf` / `export` / `/` 路径在 cmd 下均需额外翻译，失败率偏高
- 编码坑：中文 Windows 的 cmd 默认 GBK 输出，Rust 侧按 UTF-8 解码，命令输出中的中文会乱码（pwsh 7 默认 UTF-8 无此问题）
- 语法古老：引号规则、`%VAR%` 展开时机均为历史包袱

**候选对比**：

| Shell | 可用性 | 模型亲和 | 编码 | 启动速度 |
|---|---|---|---|---|
| cmd | 100% 必有 | 差 | GBK 坑 | 快 |
| PowerShell 5.1 | 随系统自带 | 中（有 ls/rm 别名） | GBK 坑 | 慢 |
| pwsh 7 | 需另装 | 好 | UTF-8 默认 | 中 |
| Git Bash | 装 Git for Windows 才有 | 最好（bash 即模型母语） | UTF-8 | 快 |

业界参考：Claude Code 在 Windows 上强制要求 Git Bash；Cline 默认 PowerShell。

**方案**（讨论中倾向）：
- 默认 `auto`：启动时探测可用性，按 `pwsh 7 → Git Bash → PowerShell 5.1 → cmd` 取最优
- 设置页「常规」新增 Shell 下拉：自动 / cmd / PowerShell / Git Bash，可覆盖
- bash / pwsh 路径顺带修复 GBK 编码问题
- 最小改法（备选）：仅改为 Git Bash 优先、探测不到回退 cmd，改动十几行

**涉及改动**：Rust `proc_run` 按所选 shell 分流调用；engine 设置项；设置页 UI。

---

### 3. 自动滚动改造：仅发送消息时滚到底部

**状态**：已记录，未排期

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

**状态**：已记录，未排期

**背景**：当前 `edit_file` 不校验该会话是否读过目标文件，唯一防线是 `old_string` 精确匹配且唯一。模型理论上可以凭猜测"盲改"（碰巧匹配到通用代码片段），造成误改。

**业界参考**：Claude Code 等 Agent 对编辑类工具有硬约束——未在当前会话中读过的文件，编辑请求直接拒绝并提示先读。

**方案**（讨论中倾向）：
- 会话运行时维护"已读文件集合"（read_file 成功执行后记录绝对路径）
- `edit_file` / `write_file`（覆盖已有文件时）执行前检查：目标不在集合中 → 拒绝执行，返回"请先 read_file 该文件"引导模型补读
- 新文件（write_file 创建）不受限制
- 代价：个别场景多一轮读取；收益：消灭盲改类误操作

**涉及改动**：core 工具层（需要跨工具调用的会话内状态，ToolContext 传递或 AgentServer 维护）。

