# rules.md — EasyCode 工程规范与开发行为守则

> 本文件详细定义 EasyCode 项目的工程架构规范、代码风格、Git 工作流、审查标准与验证铁律。所有参与研发的 Agent 与开发者必须无条件遵照执行。

---

## 1. 架构与依赖规范（Architecture & Dependency Rules）

### 1.1 模块单向依赖
- 依赖层次必须严格遵循：`ui → engine → core ← host`。
- 绝不允许反向导入或跳层耦合（例如：`core` 严禁感知任何 `ui`、`engine`、`host` 的具体实现）。

### 1.2 `@easycode/core` 极致纯洁性
- **零运行时外部依赖**：`packages/core/package.json` 中的 `dependencies` 必须始终为空（或仅限纯类型包）。
- **零 Node.js / Electron API**：严禁在 core 中直接导入 `fs`、`path`、`child_process`、`crypto`、`os` 或 Electron 模块。
- **纯能力注入**：一切与物理环境相关的交互，一律由 `Host` 接口提供（文件系统 `fs`、进程执行 `process`、环境变量 `env` 等）。必须保证 core 能脱机在纯净的 Web 浏览器沙箱中跑通全部单元测试。

### 1.3 注册制扩展点
- **工具扩展**：所有 Agent 可用工具均实现为 `ToolDefinition`，并通过 `ToolRegistry` 进行注册；执行时通过 `ToolContext` 获得注入的 `Host` 与环境，严禁在 `loop.ts` 内硬编码特定工具的特殊执行分支。
- **模型服务**：所有大模型协议适配器均实现为统一契约，支持即插即用注册。

### 1.4 Tauri 宿主极薄原则
- `packages/desktop-tauri` 中的 Rust 侧逻辑仅作为“宿主外设驱动”，负责暴露出安全的高性能原生命令（文件 IO、进程管理、HTTP 流式代理、系统托盘、系统通知）。
- 绝不把 Agent 调度、会话解析、Prompt 编排等业务逻辑沉淀到 Rust。

---

## 2. 界面与交互规范（UI & Design System Rules）

### 2.1 视觉调色板与排版风格
- **严格遵循极客暗黑终端风**：品牌调色板定义于 `packages/ui/src/styles.css`（冷绿 `--green`、青色 `--cyan`、琥珀色 `--amber`、红色 `--red`、面板色 `--panel`/`--panel2` 与纯黑背景 `--bg`）。
- **全局禁用 Emoji**：所有界面文字、状态展示、按钮文案严禁使用 Emoji。
- **状态标记规范**：系统状态与动作提示统一采用终端风格标记：
  - `[ OK ]`：执行成功 / 正常状态
  - `[ ERR ]`：发生错误 / 异常中断
  - `[ WAIT ]`：等待执行 / 调度排队
  - `[ DENY ]`：已被拒绝 / 权限拦截

### 2.2 组件与控件设计
- **禁用原生与外部三方组件**：
  - 严禁使用原生 HTML `<select>`，原生弹层无法契合暗黑风格；必须使用统一自绘的 `TerminalSelect` 组件（支持键盘 ↑↓/Enter/Esc 完整导航）。
  - 所有按钮文本统一采用 `[ 按钮文本 ]` 终端括号装饰（仅在极窄侧栏收起状态等极少数易换行场景例外）。
- **Toast 提示规范**：
  - 统一调用 `showToast(message, kind)`，`.toast::before` 会自动附加 `[ OK ]` 或 `[ ERR ]` 徽标；**绝不在传入的文案中手动手写前缀**（杜绝出现双重 `[ OK ] [ OK ]` 的事故）。所有失败或异常 toast 必须显式传 `'err'`。
- **React 开发约束**：
  - 当在 JSX 中显式使用 `<Fragment>` 时，**必须显式 `import { Fragment } from 'react'`**（`jsx: react-jsx` 不会自动注入命名 Fragment 导出）。

### 2.3 状态管理与响应式订阅
- **快照数字版本号约束**：
  - `useSyncExternalStore` 订阅 store 时，快照函数必须返回**原始数值型版本号（`store.version`）**，绝对不要直接返回 store 对象本身。对象引用不变会导致 React 判定未变化，从而发生“数据已更新但界面静默不重渲染”的恶性 Bug。
- **流式渲染性能保护**：
  - 高频文本增量（`text_delta`）必须经 `scheduleNotify` 通过 `requestAnimationFrame`（50ms 定时器兜底）进行合批派发，不可每收到一个字符就触发全树重渲染。

### 2.4 吸顶钉位（Sticky）计算补偿
- `styles.css` 中各类吸顶头部（`.tool-head`、`.term-head`、`.turn-head`）的 `top` 设为负值（如 `-4px`, `-22px`），是用于精确补偿 Chromium 内核中「滚动容器 padding-box 为基准」的视觉偏差。
- **改动任何滚动容器的 `padding` 时，必须同步重新核算其子代 sticky 元素的负值补偿！**

---

## 3. Git 与版本工作流铁律（Git Workflow Rules）

### 3.1 默认分支严格保护
- **绝对禁止向 `master` 分支直接 push 代码！**
- 无论改动多么微小（即使是修改一个错别字），都必须遵循“新分支 + PR”的完整流程：
  1. 检出分支：`git switch -b <type>/<description>`
  2. 提交更改：`git commit -m "..."`
  3. 推送远程：`git push -u origin <type>/<description>`
  4. 发起审查：`gh pr create`

### 3.2 分支命名与类型约定
- `feat/<feature-name>`：新功能实现
- `fix/<bug-name>`：缺陷修复
- `docs/<doc-name>`：文档维护与规范沉淀
- `chore/<task-name>`：版本发布准备、工程基建与依赖调整

### 3.3 并行操作防碰撞守则（重中之重）
- 用户会在本地同时进行 Git 操作与会话交互。
- **在任何分支操作（`switch`, `checkout`, `branch`, `rebase`）前，必须先执行 `git status` 与 `git reflog -n 5`**！
- 如果发现 HEAD 指向了未预料的提交，或工作区有非自己产生的变动，先通过 `git show` 确认作者和意图，切忌强行覆盖或将用户的并行提交无意打包进自己的 PR 中。
- 用户留下的临时分支或 stash 绝对不可代删，由用户自主决定。

### 3.4 PR 合并必须使用 Merge Commit（严禁 Squash）
- 用户明确规定：**PR 合并必须保留完整提交轨迹，严禁使用 Squash 压扁合并！**
- 合并命令：`gh pr merge <PR编号> --merge`。
- **原因**：EasyCode 代码审查标准高，PR 内部的多个 commit 真实记录了“初版实现 → 静态审查指出问题 → 针对性返工 → 收敛合并”的完整思考链，这是宝贵的工程资产。

### 3.5 两个绝对独立的授权闸门
1. **审查通过 ≠ 自动合并**：代码审查即使全部通过，是否将 PR 合并入 master，**必须等待用户下达明确指令**。
2. **PR 合并 ≠ 自动发布**：向 GitHub 推送版本 Tag（如 `git tag v0.1.24` 并推送）会立即触发跨平台 Release 工作流。**推 Tag 属于最高级别操作，必须获得用户显式授权，任何情况下严禁擅自推 Tag**。

---

## 4. 版本控制与 CHANGELOG 纪律（Changelog & Versioning Rules）

### 4.1 提交前必更新 CHANGELOG.md
- 根目录 `CHANGELOG.md` 是 GitHub Release 描述的单一生成源头（由 Release 工作流通过精确脚本提取）。
- 提交功能前，必须在 `CHANGELOG.md` 中对应写好更新项（新增、修复、优化、测试）。
- 纯文档或未发布的变更，写入 `## [未发布]` 段落。

### 4.2 版本号单一事实来源
- 统一且唯一的应用版本号维护在：`packages/desktop-tauri/src-tauri/tauri.conf.json` 的 `version` 字段。
- 各子包 `package.json` 中的 `version` 统一保持 `0.1.0`，不进行频繁扰动。
- 发布准备（`chore/vX.Y.Z-release`）专属工作：
  1. 将 CHANGELOG 中的版本日期对齐发布日；
  2. 递增 `tauri.conf.json` 中的版本号；
  3. 执行编译与测试核验；
  4. 发起 release PR。

### 4.3 版本批次排期纪律（先记后做）
- 用户按规划批次推进产品演进，不做一个改一个。
- 偶发的新想法、微小改进或非阻塞性重构，**一律先记录到 `docs/TODOS.md`**。只有经过方案讨论并正式排期后，才创建分支启动开发。

---

## 5. 代码审查与交付期望（Review & Delivery Rules）

用户会亲自对交付的代码进行极其严谨的**静态代码审查**，并给出精确到行号的 P1/P2/P3 分级评价。

### 5.1 审查应对准则
1. **客观推演，绝不无脑照改**：
   - 面对审查意见，先独立推演事件时序（Event loop、生命周期状态机、异步竞争）。
   - 属实的缺陷，坚决彻底修复，并附带结构性护栏；
   - 若审查指出的路径在现有机制下不可达，必须清晰说明不可达的数学与逻辑推导，不为了应付而盲目修改。
2. **区分“机制落地”与“收益已证明”**：
   - 交付说明中必须实事求是。在没有提供真实 Profile 基准测试数据前，只描述“机制已实现与生效路径”，严禁虚夸“性能提升 90%”、“彻底根除卡顿”等未经证明的话术。
3. **跨平台语义是合并阻塞项**：
   - 虽然当前开发机为 Windows，但只要接口抽象对外承诺了跨平台语义，就必须兑现。
   - 例如：进程终止机制不仅要对 Windows 树杀负责，也必须对 Unix 独立进程组的生命周期管理（SIGTERM → 宽限 → 探活 → SIGKILL）严格负责，绝不能以“本机无 Linux 无法实测”为由放水。
4. **生命周期与状态边界是高频雷区**：
   - 长驻任务与异步回调必须考虑：“谁会迟到、谁会永远不来、什么会无限膨胀”。
   - 缓冲要有界、退出要等待、清理失败要保留重试句柄。
5. **PR 评论逐条闭环**：
   - 用户审查以 PR 评论形式给出，修复后必须通过 `gh pr comment` 或逐条回复清晰报告修复 Commit 与测试验证结果。
6. **PR 描述必须与 HEAD 实时同步**：
   - 经过多轮审查返工后，必须手动刷新 PR 的 Title 和 Body，确保测试用例数、机制描述与最新 HEAD 代码 100% 一致。

---

## 6. 测试与实测验证铁律（Verification Rules）

### 6.1 坚决杜绝使用 Mock 糊弄真实功能
- **红线**：用户拥有完整的真实基础设施（自建 SearXNG 搜索、真实 API 网关、真实 Key）；凡可由真实环境验证的，交由用户验证；不得私自搭建持久 mock 服务，临时脚本必须测完彻底清理。
- 严禁为了所谓的“全绿”而写虚假的 Mock 服务并宣称功能已打通。临时验证脚本必须在验证结束后立即彻底清理，绝不残留垃圾配置。

### 6.2 UI 交互行为必须在真实桌面端实测
- `jsdom` 和 React Testing Library 没有真实布局引擎（`scrollTop` 恒为 0，缺乏真实 ResizeObserver 与像素渲染），**绝对无法用于验证贴底跟随、滚动折叠、视口同步等真实 UI 交互**。
- **标准验证姿势**：
  1. `pnpm -r run build`（必须确保 UI dist 已重建）；
  2. 启动桌面应用执行端到端走查；
  3. 采用数据目录隔离（`EASYCODE_DATA_DIR`）保护用户真实数据；
  4. 交付时附带具体、可复现的操作走查清单。
