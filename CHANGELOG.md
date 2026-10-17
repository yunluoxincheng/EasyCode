# Changelog

本文件记录 EasyCode 每个版本的变更。发布时，GitHub Release 说明自动取自对应版本的段落。

## [0.1.25] - 2026-10-17

### 新增
- 工具权限规则引擎（Allow / Deny / Ask Policy Rules）：在 `ask` / `yolo` 二元审批之上叠加细粒度策略——`run_command` 按命令前缀匹配（自带词边界，`rm` 不命中 `rmdir`），文件类工具按工作区相对路径 glob（`*` 单段 / `**` 跨目录），其余工具只支持工具级规则（写了 `pattern` 一律视为不命中，不制造「看似限制实则无效」的假象）；裁决与书写顺序无关、安全优先（任一命中为 `deny` 即拒绝 → 否则任一 `ask` 强制审批 → 否则任一 `allow` 免审批），无命中时回落既有模式语义；命令归一化与 #40 结构化事实共用 `normalizeShellCommand`（剥离 `FOO=1` 前缀、解包 `powershell -c` / `cmd /c` / `bash -c`），杜绝「加个环境变量前缀就绕过 deny」（TODOS #47）
- 两级规则来源与设置页配置面板：全局 `Settings.permissions`（含总开关，关闭即彻底回到纯模式语义）+ 项目级 `.easycode/permissions.json`（3 秒 TTL 缓存、非法条目跳过而非整份配置失效），全局与项目规则取并集裁决并在审批卡片与拒绝文案中明示来源；设置页新增「权限规则」分区（工具下拉、匹配模式、裁决三态、备注与语义说明）（TODOS #47）
- **权限信任边界（PR #9 审查返工）**：工作区内的代码属低信任输入，克隆来的仓库不得自行放宽审批。项目级 `deny` / `ask` 默认生效（只会收紧权限），项目级 `allow` **默认被忽略**。信任粒度按**工作区**授予（`Settings.permissions.trustedWorkspaces`，规范化绝对路径比对）而非全局开关——信任项目 A 不会连带放宽后来打开的 B、C；授权记录只写入用户本地设置，绝不落在项目仓库内。引擎提供 `isProjectTrusted()` / `setProjectTrust()` / `countIgnoredProjectAllowRules()`，设置页在「权限规则」中按当前工作区提供「信任此项目」按钮并展示被忽略条数
- 自主测试运行与排错自愈循环（Auto Test-and-Fix Loop）：Core 新增 `detectTestCommand`（`package.json` `scripts.test` 并按锁文件推断 pnpm / yarn / bun / npm → `Cargo.toml` → `go.mod` → `pyproject.toml` 等 Python 标记）与 `parseTestOutput` / `extractFailureExcerpt`（覆盖 vitest / jest / pytest / cargo / go 以及 **Node 内置 `node --test` 的 spec reporter（`ℹ tests/pass/fail` 跨行聚合）与 TAP reporter（`# tests/pass/fail` + `not ok N - 名称`，`# TODO` / `# SKIP` 不计失败）**；用例名剥离 reporter 追加的耗时后缀并跳过 `✖ failing tests:` 这类分节标题；解析不到就保持 `undefined`，绝不用估算值冒充真实结果）（TODOS #39）
- 自愈循环状态机与入口：`runTestLoop` 执行「跑测试 → 失败则把失败用例 + 日志摘录 + 当前 git diff 组成结构化修复提示词驱动一个完整 Agent 回合 → 自动重跑」，轮次上限 1~5（默认 3）防死循环；`/test-loop [聚焦范围]` 快捷指令与 Git 改动检视面板底部「▷ 运行测试并自愈」双入口；测试命令整体只审批一次（修复回合内的文件改动与命令仍走常规审批与权限规则），测试命令本身同样受权限规则约束——`deny` 直接拒绝不执行，`ask` 在 YOLO 模式下也强制弹窗确认（TODOS #39）
- 回合内 `[ TEST n/m ]` 测试卡片：展示命令与探测来源、用时、通过 / 失败 / 总数与失败用例清单，可展开查看原始输出尾部；收敛时按 `passed` / `max_rounds` / `aborted` / `error` 四态给出明确 toast（TODOS #39）

### 修复
- **第七轮复审返工（P1 一项 + P2 两项）**：
  - **Shell 环境变量拼接前缀可绕过 `deny`（P1）**：`stripEnvAssignments()` 原来只认「整段引号」或「整段裸值」，没有处理 POSIX Shell 中引号与裸文本拼成**同一个赋值单词**的写法。`FOO="hello"world rm -rf build`（归一化后原样保留）与 `FOO=x"hello world" rm -rf build`（归一化后变成 `world" rm ...`）都能让 `deny rm` 失效，而真实 shell 确实执行 `rm`。现改用 `consumeShellWord()` 按完整 Shell word 消费（支持引号/裸文本多段拼接、反斜杠转义），再剥离前缀；引号未闭合仍原样返回、不声称已清洗。已用真实 `bash -c` 逐条确认三种写法都执行赋值后的程序
  - **自愈修复回合收尾期间停止失效（P2）**：`runTurn()` 的 `finally` 先 `rt.controller = undefined` 再 `persistSession()`，而外层循环要等 `runTurn()` 返回才恢复 controller。用户恰在落盘等待期间点停止时 `abort()` 找不到 controller，循环 signal 存活，下一轮测试照旧跑起来（实测会跑完并报「通过」）。现 `runTurn` 复用循环 controller 时**不解除注册**，且 controller 释放挪到落盘之后，只释放自己创建的那个
  - **删除正在启动的测试循环会让会话复活（P2）**：循环 `busy=true` 后还要异步探测命令/加载规则，此时 controller 尚未挂上；这期间 `deleteSession()` 中止不到任何东西，会话从内存表与磁盘删除后，未结束的循环退出时又 `persistSession()` 把它写回来。现循环**占位后立即挂 controller**（探测/审批阶段也能被停止），运行时增加 `deleted` 标记使 `persistSession` 直接放弃写入，并登记在途落盘任务 `persisting`——删除时先等在途写入落定再 `unlink`，避免「先删后写」把文件重新创建
- **第六轮复审返工（P1 三项）**：
  - **保存设置会恢复已撤销的项目信任（P1）**：`toggleTrust()` 只更新 `store.settings`，而设置页 `draft` 仅在为 `null` 时初始化、之后不跟随 store 变化。于是「撤销信任 → 改别的设置 → 保存」会把旧草稿里仍含该项目的 `trustedWorkspaces` 原样写回，撤销失效。双层修复：① 信任操作成功后把引擎返回的 `trustedWorkspaces` 同步进草稿（保留草稿中其它未保存的编辑）；② `store.saveSettings()` 作为 UI 唯一保存出口，提交前**剥离**草稿里的 `trustedWorkspaces`，一律沿用引擎当前值——授权只能经 `setProjectTrust` 变更，任何全量保存都不会覆盖
  - **自动加载的项目规则经符号链接读取工作区外内容（P1）**：`getProjectRules()` 仍直接 `stat` + `readFile`，没有走真实路径守卫。克隆仓库里 `AGENTS.md -> /home/user/private.txt` 会在拉起 Agent 时**无需用户操作**即被读取并拼进系统提示词发往模型服务。现候选文件逐个经 `resolveRealPathInWorkspace()` 取真实目标后读取，越界或无法确认则跳过该候选（`CLAUDE.md` / `.cursorrules` / `.easycode/rules.md` 同理）；`.easycode/prompts/*.md` 自定义指令模板一并接入
  - **审批后复核只比相对路径（P1）**：复核原为 `realRelative !== verifiedRelative`，漏掉「工作区根本身是符号链接、审批期间被改指到另一个项目」——两个项目里的同名文件都归一为 `config.txt`，相对路径比较通过，写入落到未经审批的项目。现同时记录并比较**绝对真实目标**（新增 `sameAbsolutePath()`，Windows 大小写/分隔符不敏感），工作区物理身份漂移同样在此暴露
- **第五轮复审返工（P1 两项 + P2 三项 + P3 一项）**：
  - **审批等待期间替换符号链接（P1，检查与使用不一致）**：守卫取到真实目标后仍把**原始路径**交给 `tool.execute()`，于是「检查 `link.txt -> safe.txt`、审批期间被换成 `-> 工作区外`、用户点同意、按原始路径写入」可以绕过检查。现文件类工具的实际 I/O 一律使用**已验证的真实相对路径**，并在审批返回后**再复核一次**真实目标：若与审批前不一致则取消本次调用（单次复检不能彻底消除外部并发修改，但能收掉「等待用户点同意」这段最长窗口；真正强约束需宿主级句柄 / `O_NOFOLLOW` 能力，已在 README 边界说明中标注）
  - **非工具读取入口仍可越界（P1）**：新增真实路径守卫只接在 `executeTool()` 上，两个旁路读取仍走词法 `resolveWorkspacePath()`——`resolveCodeRangeMentions()`（`@file:line` 片段会**注入模型上下文**）与 `readWorkspaceFile()`（文件树预览）。克隆仓库里 `notes.md -> /home/user/private.txt` 外观与普通文件无异，用户在文件树点开或引用即泄露。现两个入口共用同一守卫，越界直接拒绝
  - **Node 下限与测试脚本不兼容（P2）**：根 `test` 脚本使用 `--test-force-exit`（Node ≥ 20.14.0 提供），但 `engines.node` 写的是 `>=20`，20.0–20.13 符合声明却跑不了测试。现收紧为 `>=20.14.0`
  - **Tauri 宿主把测试超时硬裁到 10 分钟（P2）**：设置页与引擎上限均为 1800s，而 Rust `proc_run` 仍是 `clamp(1_000, 600_000)`，用户设 20/30 分钟时主力端会在 10 分钟强杀。现统一为 1_800_000，并补「>600s 参数透传 + 越界钳制」回归
  - **同一物理工作区跨写法锁不互斥（P2）**：`WorkspaceLockManager` 只做尾斜杠 / 分隔符 / 大小写标准化，不解析文件系统别名；`/tmp/project` 与指向它的 `/tmp/project-link` 会拿到两把锁，会话 A/B 分别绑定后工作区互斥失效。现新增 `registerAlias()` 与 `lockKey()`，由 `AgentServer.resolveWorkspaceIdentity()`（`realpath` 解析物理身份）在绑定工作区时登记，锁键以物理身份为准
  - **状态标记不规范（P3）**：测试自愈完成的 toast 与失败提示改用 `[ OK ]` / `[ ERR ]`
- **第四轮复审返工（P1 两项 + P2 一项）**：
  - **悬空符号链接仍可让 `write_file` 写出工作区（P1）**：`realpath()` 对「路径不存在」与「路径是指向不存在目标的符号链接（悬空链接）」都返回 ENOENT。守卫把两者混为一类，于是把悬空链接当成「待新建的普通文件」放行，`writeFile` 随后跟随该链接在工作区外创建文件。现新增 `Host.fs.lstat`（Node `fsp.lstat`、Tauri 新增 `fs_lstat` 走 `std::fs::symlink_metadata`、MemoryHost 等价），守卫在 `realpath` 返回 null 时先判 `isSymbolicLink`：悬空链接以 `dangling-symlink` **保守拒绝**，绝不退化为普通新建路径；宿主既无 `realpath` 又无 `lstat` 时同样拒绝
  - **`search_files` 递归可读取工作区外文件（P1）**：守卫只校验了调用传入的起始目录（如 `.`），递归遍历发现的每个条目没有再校验——工作区内一个 `leak.txt -> /outside/secret.txt` 会让 `stat` / `readFile` 跟随链接读到工作区外内容。现遍历阶段**读取每个候选文件前都重新校验真实目标**，越界或无法确认的直接跳过并**统计跳过数量**回传给用户（静默跳过会让人误以为「工作区里确实没有」）；子目录内的外部链接同样覆盖
  - **测试命令未纳入工作区互斥（P2，历史遗留）**：`run_command` 等敏感工具经 `workspaceLock.withLock()` 串行化，而 `runTestLoop` 直接调用 `host.process.run()`；会话级 `withSessionOpLock` 只保护同一会话，无法阻止两个会话同时操作同一工作区。现将**执行单次测试命令**纳入既有工作区锁——锁粒度严格限定为「跑一次测试」，绝不包住整个自愈循环（中间的修复回合还要获取同一把锁执行 `edit_file`，包住会死锁）
- **第三轮复审返工（P1 三项 + P2 一项 + P3 两项）**：
  - **符号链接绕过路径权限规则（P1）**：`paths.resolve()` 只做词法归一化，不识别 symlink。工作区内 `public/key.txt -> ../private/key.txt` 时，词法路径是 `public/key.txt`，针对 `private/**` 的 `deny` 不命中，而实际读到的是 `private/key.txt`；指向工作区外部的链接还会绕过词法 containment。这是文件路径规则的核心职责，不能静默失效。现新增 `Host.fs.realpath` 能力（Node 用 `fsp.realpath`、Tauri 新增 `fs_realpath` 命令走 `std::fs::canonicalize`、MemoryHost 词法等价），并新增 `packages/core/src/path-guard.ts`：文件类工具在权限裁决与边界检查前先取**真实目标**——已存在目标消解全部链接，新建文件则回溯校验其**最近存在的父目录**；宿主不支持 `realpath`、无法解析（权限不足 / 循环链接）时**保守拒绝**，绝不当作无风险。裁决使用真实相对路径，别名路径同样命中针对真实目标的规则
  - **信任撤销失效（P1）**：UI 自行用「分隔符等价」判断信任、却用严格字符串比较撤销，`C:\Work\Repo` 与 `C:/Work/Repo` 会显示已信任但撤销后列表仍保留原条目，底层授权不变。现信任的查询 / 授予 / 撤销**全部交给引擎**（`isProjectTrusted` / `setProjectTrust` / `countIgnoredProjectAllowRules` 经 `AgentClient` 暴露），UI 只回读、不再自行推导路径语义；`setProjectTrust` 按规范化绝对路径去重（重复授权不累积、等价写法撤销可真正移除）
  - **busy 检查与异步操作之间的 TOCTOU（P1）**：`setSessionWorkspace` 通过 busy 检查后停在 `await stat()`，期间测试循环启动并进入 busy，该切换随后仍会完成；`revertTurnCheckpoint` 同理（检查后才异步查询快照）。现引入会话级执行互斥 `withSessionOpLock()`，把「检查 + 写入」收敛进同一临界区并在**临界区内复核 busy**，覆盖工作区 / Provider / 模型切换、快照回退、历史压缩、会话分叉；`runTestLoop` 也改为在临界区内完成「检查 + 置 busy」
  - **修复回合内部 `done` 提前结束 UI 回合（P2）**：修复回合是一次内部 Agent 回合，`runAgentLoop` 照常发 `done`，前端据此关闭回合、恢复 idle 甚至弹「任务完成」，而外层循环还要继续跑测试——表现为一个任务被拆成多段 UI 回合、未完成就提示完成。现引擎在修复回合期间置 `suppressDone` 抑制常规 `done`，结束语义由外层 `test_loop_done` 唯一掌握（过程事件不受影响）
  - **会话加载未先加载设置（复审中新发现）**：`listSessions()` 冷启动恢复会话时用 `settings.defaultApprovalMode` 构造运行时，但此前未 `ensureSettings()`，导致历史会话的审批模式退回 `DEFAULT_SETTINGS`（ask），用户配置的 yolo 在重启后失效、测试自愈直接卡在审批上。现于入口先行加载设置
  - **状态标记与项目规范不一致（P3）**：`TestRunCard` 的执行状态与权限面板按钮改用 `[ OK ]` / `[ ERR ]` / `[ WAIT ]` / `[ DENY ]` / `[ ADD ]` / `[ DEL ]`，替换原先的 `◍` / `✓` / `✕` / `＋` 符号
  - **被忽略规则数量未接入 UI（P3）**：`countIgnoredProjectAllowRules()` 结果经客户端接入设置页「权限规则」面板，展示「N 条项目级 allow 规则已被忽略」
- **第二轮复审返工（P1 三项 + P2 两项）**：
  - **路径「先离开再进入」绕过**：`../ws/private/key.json` 在 `/ws` 下经 `resolve` 会回到工作区内，而词法层遇到开头 `..` 直接放弃匹配 → 权限层认为无法映射、文件层却能访问。现彻底放弃自行猜测路径合法性：抽出 `resolveWorkspaceRelative(workspace, input, paths)`，与 `resolveWorkspacePath()` **共用同一套解析入口**（`paths.resolve(workspace, input)` + 工作区包含性校验），先得真实绝对路径再折算相对路径做 glob 匹配。Windows 大小写不敏感语义一并统一（`sep === '\\'` 时按小写比对），避免 `C:\WS` 与 `C:\ws` 被判越界
  - **审批拒绝不收敛**：用户点「拒绝」后后端直接返回 `aborted`，不发 `test_loop_done`，而前端已因审批请求建立运行态 → 会话永久卡在 running、无法再发消息。现在只要本次调用已让前端进入运行态（发出审批请求或启动循环），退出时**必发且只发一次**终止事件；`finally` 兜底覆盖初始化失败与异常路径
  - **测试期间可切换运行上下文**：`busy` 期间 `running === false`，而 `setSessionWorkspace` / `setSessionProvider` / `revertTurnCheckpoint` 只看 `running` → 修复回合可能改到另一个项目、下一轮测试却仍在原项目跑。现统一为 `isSessionBusy(id)` 判据并覆盖工作区切换、Provider 切换、模型切换、快照回退；`repair()` 内额外校验工作区未漂移，作为拒绝静默改错项目的最后防线
  - **`runTurn` 状态泄漏**：`rt.running = true` 之后的快照序号分配与回合开启位于 `try` 之外，分配抛错会永久留下 running。现全部纳入 `try/finally`
  - **长日志摘录丢失失败点**：两段化时中间省略标注本身未计入预算（实测 2020 > 2000），且预算过小时会拼出荒谬内容。现预留标注长度、极小预算退化为纯尾部；无失败标记时不做无意义的两段拼装
- **权限绕过（PR #9 审查返工，P1 三项）**：
  - **路径 `..` 绕过**：`pathCandidates()` 原先只处理分隔符与工作区前缀，未解析 `..`——规则拒绝 `src/private/**` 时，`src/tmp/../private/key.json` 匹配不到，而文件工具经 `resolveWorkspacePath()` 会真实访问该文件。现新增 `normalizePathSegments()` 做词法规范化（折叠 `.`、消解 `..`、统一分隔符，等价 `path.resolve` 字符串语义且不触碰文件系统）后再做 glob 匹配；相对路径逃出工作区时返回 `null`，规则不命中并回落审批模式（安全默认）
  - **`search_files` 省略 path 时规则被跳过**：该工具默认递归整个工作区，实际会读到 `src/private/**` 却因「无 path 参数」跳过路径规则。现按各工具真实默认作用域求值（`list_dir` / `search_files` 默认 `.`），并对递归搜索类工具做**只收紧不放宽**的子树推断：规则指向子目录时从上层发起搜索同样命中（`deny` / `ask` 保守放大，`allow` 绝不凭前缀推断放宽审批）
  - **带引号的环境变量赋值绕过**：`ENV_PREFIX_RE` 用 `\S*` 匹配值，`FOO="hello world" rm -rf build` 会在空格处断开，`rm` 没被识别成命令。现改为**词法解析**（单引号 / 双引号含反斜杠转义 / 裸值三类消费，赋值后必须紧跟空白），无法可靠识别的写法（引号未闭合、`FOO=1rm` 复合写法）原样返回，**不声称已通过危险命令筛查**
- **测试自愈并发与生命周期（PR #9 审查返工，P1/P2）**：
  - `runTestLoop` 的 `busy` 占位过晚：状态检查与占位之间存在多次 `await`（读项目配置、探测命令、解析规则），两次快速启动都能通过检查并并发跑两个循环、竞争覆盖 `rt.controller`。现于同步检查后**立即占位**，全部初始化移入 `try/finally`；`forkSession` / `trimSessionHistory` / `setSessionModel` 同步补 `busy` 校验
  - 测试命令命中 `allow` 时未生效：原先只区分 `force`，ask 模式下仍会弹窗。现抽出 `resolveApprovalRequirement()` 作为**常规工具调用与引擎内置动作共用的统一裁决入口**（`allow` 免审批 / `ask` 强制 / 无命中跟随模式），`executeTool` 与 `runTestLoop` 共用同一实现，杜绝两条链路各写一份判断而漂移
  - 修复回合失败未收敛：`await repair(prompt)` 无异常保护，模型初始化或持久化故障会让循环**静默退出且不发 `test_loop_done`**；`runTurn()` 的 `reason: 'error'` 也未回传循环，导致「修复没成功仍继续重跑」白烧轮次。现 `repair` 返回结构化 `RepairOutcome`（成功 / 失败 / 中止），`runTurn()` 返回 `LoopResult`，所有终止路径**只发一次** `test_loop_done`
- **审批与 UI 状态一致性（PR #9 审查返工，P2）**：
  - `/test-loop` 的审批卡片停在「等待批准」：审批发生在任何测试事件之前，卡片落到顶层而 `approval_resolved` 只查 `currentTurn`。现在 `approval_request`（`toolName === 'test_loop'`）先行建立回合容器，保证「审批 → 测试 → 修复」处于同一条时间线；`approval_resolved` 同时兼容顶层条目查找
  - 权限规则拒绝显示为执行成功：`executeTool` 对 `deny` 返回 `isError: false`，而 UI 靠匹配中文「用户拒绝」判断状态，权限拒绝文案不含该词。现 `tool_result` 事件显式携带结构化 `approved`，UI 据此渲染拒绝态，**不再依赖提示文本**
- **失败日志摘录丢失关键错误（PR #9 审查返工，P2）**：`extractFailureExcerpt()` 的标记正则整体带 `\b`，而 `✖` / `✕` / `×` / `●` 是非单词字符，「符号 + 空格」之间 `\b` 恒为假 → `✖ broken test` 完全匹配不到，长日志下退回到尾部 80 行、丢掉真正失败位置。现拆分为「`FAIL` / `FAILED` / `--- FAIL` 带词边界 + 符号类不带边界」，并修正标记落在首行时被丢弃的 `> 0` 判断
- **测试自愈循环在界面上完全不可见（P1）**：`/test-loop` 不经 `send()` 启动，没有被创建回合容器，`test_run_start` 与修复回合的工具/助手条目全部落到 `state.items` 顶层；而 `Transcript` 顶层渲染只处理 `user` 与 `turn`，对其余条目直接 `return null` 静默丢弃——表现就是「点了 `/test-loop`，界面什么都没有」。现修复三处：① `test_run_start` 经 `ensureWritableTurnInState` 显式保证存在未折叠回合，测试轮次与随后的修复过程都挂进该回合；② `Transcript` 顶层改为兜底渲染 `ItemView`，任何条目都不再被静默吞掉；③ `TurnView` 折叠态在无助手最终文本时保留该回合最后一张 `TestRunCard`，避免回合收起后结果凭空消失；`test_loop_done` 统一折叠回合并复位运行态（含错误态与快照/文件树刷新）
- 审批可能永久挂起（`ApprovalManager.request` 时序缺陷）：原先先派发 `approval_request` 事件、后登记 resolver，同进程宿主（CLI / 演示模式 / 单测）在事件回调里同步应答时，应答会因为 `pending` 中尚无该 `requestId` 被静默丢弃，promise 永不 resolve——对外表现为「跑到审批就不动了、任务不会自动停止」。现改为**先登记 resolver 再派发事件**，并补 `try/catch`：订阅者抛错时清理未决态按拒绝收尾，绝不悬挂
- 测试自愈循环的中止传播：修复回合由 `runTurn` 重新创建 `AbortController` 导致用户在修复过程中点「停止」只打断该回合、循环 signal 依旧存活并继续跑下一轮测试；现修复回合复用循环持有的 controller，停止一次即整体收敛
- 审批等待期占位 `busy`：`runTestLoop` 原先在审批通过后才置位 `busy`，用户可在审批卡片挂起期间另发消息，两条链路争用同一 controller；现于审批前占位（并经审查返工提前到同步检查后），结束后统一清理
- 测试脚本超时保护：根 `test` 脚本补入遗漏的 `permissions` / `test-runner` / `test-loop` / `approval` 测试，统一加 `--test-timeout=60000`，并补 `--test-force-exit`——前者让悬挂的单测在 60s 内判定失败，后者保证即使存在未释放的句柄，测试进程也一定会退出，不再出现「`pnpm test` 跑完不返回」

### 安全边界说明
命令前缀权限规则是**命令级审批策略，不是进程级安全沙箱**：它按命令前缀匹配，无法阻止间接执行——`package.json` 的 `scripts.test` 内部可执行任意命令，此时被检查的是 `pnpm test` 而非展开后的每条语句；`a && b`、管道与脚本同样不在匹配范围内。该限制已在设置页「权限规则」面板与 README「安全设计」中明示，不将前缀匹配表述为沙箱防护。

### 测试
- 全仓 **173 项测试通过**（约 5.0s）：新增权限规则单测（命令前缀词边界、环境变量前缀与 shell 包装解包、路径 glob 单段/跨目录、`deny > ask > allow` 裁决、非法条目跳过）、`executeTool` 三态短路（deny 不弹审批、allow 在 ask 模式免审批、ask 在 yolo 模式强制审批并携带规则来源）、测试输出解析与失败摘录（含 Node spec / TAP 两种 reporter 与 `# TODO`/`# SKIP` 排除）、自愈循环五态（首轮全绿、失败→修复→重跑、轮次耗尽、中止、异常收敛）、`AgentServer.runTestLoop` 集成（项目级 `.easycode/test.json` + `permissions.json`、不可信测试命令被 deny 拦截、ask 规则在 YOLO 下强制审批、修复回合被停止后不再跑下一轮）、审批时序四项回归（同步应答不丢失、同步拒绝、`force` 语义、`denyAll` 中止路径、订阅者抛错不悬挂）
- **第七轮复审新增 5 项回归**：拼接式赋值前缀（`FOO="a"b` / `FOO=x"a b"` / 三段拼接 / 转义引号）全部归一化为真实命令并被 `deny` 命中（已实测反证：退回旧逻辑时该用例必然失败）、词边界与未闭合引号语义不变；**修复回合落盘等待期间点停止**——用可控闸门精确卡在 `persistSession` 内再 `abort()`，断言结果为 `aborted` 且测试只执行过一轮（反证：不继承循环 controller 时会跑完并报 passed）；**启动阶段删除会话**——断言会话不回到会话表、文件不被写回、循环不再执行测试；**运行中删除会话**——断言文件不复活（反证：去掉 `deleted` 守卫与在途落盘等待后文件会被重新创建）
- **第六轮复审新增 4 项回归（真实文件系统）**：`AGENTS.md -> 工作区外` 被忽略而普通 `AGENTS.md` 正常加载、`.easycode/prompts/*.md` 越界模板被跳过而正常模板仍可用、信任撤销后全量保存其它设置不恢复授权（授权只经 `setProjectTrust` 变更）、**工作区根本身是符号链接**时审批期间改指到另一项目必须拒绝（已实测反证：仅比相对路径时该用例必然失败，另一个项目文件保持原样）
- **第五轮复审新增 7 项回归（真实文件系统）**：审批回调内替换符号链接 → 调用被取消且工作区外文件内容原样保留（已实测反证：禁用复检后该用例必然失败）、文件工具实际写入的是**已验证的真实目标**（别名写入落到真实文件）、`@file` 行范围引用不读取工作区外链接也不注入上下文、文件预览入口拒绝越界链接、同一物理工作区的**别名路径共享同一 Mutex 实例**、`engines.node` 下限与 `--test-force-exit` 匹配、设置页允许的超时（1200s）原样透传宿主且越界值钳制到 1800s
- **第四轮复审新增 7 项回归（真实文件系统）**：悬空符号链接的 `write_file` 被拒且工作区外文件**始终不存在**、悬空链接的父目录（深层路径）同样不得穿越、`search_files` 递归不读取工作区外链接且**报告跳过数量**、子目录内的外部链接同样覆盖、正常新建与读取不受影响、测试命令在会话内持锁时被挡、**跨会话**持锁时另一会话的测试循环被挡（证明会话级锁之外确实引入了工作区级互斥）
- **第三轮复审新增 8 项回归**：真实文件系统符号链接（别名指向工作区内敏感文件 → 命中 deny 且不泄露内容；指向工作区外 → 以「路径越界」拒绝；父目录为链接时新建文件同样拦截；宿主无 `realpath` → 保守拒绝；普通路径与既有规则语义不变）、信任撤销（等价路径写法重复授予不累积、等价写法撤销真正生效、忽略条数上报）、修复回合内部 `done` 不外泄且过程事件仍可见、工作区切换与测试循环启动的**真实交错**（在宿主 `stat` 中制造 await 窗口，断言二者不得同时成功且循环期间工作区不被切走）
- **PR #9 审查返工新增 16 项回归**：项目级 `allow` 默认被忽略且 `deny` 保留（含显式信任后的行为反转）、`FOO="hello world" rm` 等引号赋值与未闭合引号的原样返回、`src/tmp/../private/key.json` / 反斜杠 / 绝对路径三类 `..` 绕过、省略 path 的 `list_dir` / `search_files` 按真实默认作用域求值、子树推断只收紧不放宽（`allow` 不得凭前缀放宽）、`resolveApprovalRequirement` 三态语义、路径解析边界（含逃出工作区返回 `null`）、连续两次启动 `/test-loop` 只允许一次进入运行态、修复回合抛异常 / 返回失败 / 返回中止三种收敛路径且 `test_loop_done` 只发一次、权限规则拒绝时 `tool_result` 事件携带 `approved=false`、长日志中 `✖` / `✕` / `×` / `●` 摘录命中且不从首行丢弃、`FAILOVER` 不被误判为失败标记
- **第二轮复审新增 8 项回归**：`resolveWorkspaceRelative` 的 POSIX / Windows 双语义（含「先离开再进入」与大小写变体）、权限层与 `resolveWorkspacePath` 解析结果一致（同一路径在两层解析出同一绝对路径）、按工作区授予信任且信任 A 不连带 B、可撤销信任、拒绝审批必发终止事件、运行期四项操作全拦截、快照分配失败后状态复位、长日志两段保留（失败断言 + 末尾汇总）与极小预算不产生负数省略标注
- 审查返工验证：中止传播用例在移除修复后必然失败（已实测反证），确保该回归测试真的锁住了缺陷
- **真实环境端到端验证（23/23 通过，直接驱动 `AgentServer` + `NodeHost`；覆盖审查要求的 8 项回归表）**：真文件系统 + 真子进程 + 真 git 仓库 + 真实模型（复用本机已配置供应商），临时数据目录隔离，跑完即清理。验证点包括：不可信项目自带 `allow run_command` 无法取消 ask 保护（含被忽略条数上报）、`FOO="a b" rm` 命中 deny、`src/tmp/../private/key.json` 真实工具调用被拒绝且未读到密钥、并发启动两次 `/test-loop` 仅一次成功、ask 模式 + 未信任项目级 allow 时先弹审批（首个审批来自 `test_loop`）后由模型真实改回源码并重跑至全绿、审批事件先于测试事件（同回合时间线）、修复回合被中止时只发一次 `test_loop_done`、deny 结果携带 `approved=false` 且目标文件未被删除、长日志 `✖` 摘录命中
- **第二轮复审证据复验（17/17 通过，真实 Runtime）**：按复审点名要求逐项取证——① 路径「先离开再进入」在 POSIX（`../projA/src/private/key.json`）与 Windows（`..\ws\src\private\key.json`，大小写+反斜杠变体）下均被解析回工作区内并命中 deny，真正越界（`../../outside.txt`）返回 `null`；② 拒绝测试循环审批后返回 `aborted`、**发出且仅发出一次** `test_loop_done`、`isSessionBusy` 复位、可立即再次启动；③ 测试命令执行期间（`running === false` 的窗口）工作区切换 / Provider 切换 / 模型切换 / 快照回退**全部被拦截**（4/4），循环结束后工作区仍为原项目；④ 注入快照序号分配失败后 `running` 与 `busy` 均复位，且恢复后可正常再次发送消息
- **第三轮复审证据复验（20/20 通过，真实 Runtime + 真实符号链接）**：在临时工作区创建**真实 symlink** 后逐项取证——① `public/alias.txt -> private/key.txt` 的真实目标归一为 `private/key.txt`，`read_file` 被 deny 拦截且未泄露 `TOP-SECRET`；② `public/escape.txt -> 工作区外` 即使**不配置任何规则**也以「路径越界」拒绝，未泄露外部内容；③ 信任按工作区授予（他人项目不受影响）、等价写法重复授予不累积、等价写法撤销后 `allow` 立即失效且忽略条数可上报；④ 新实例从磁盘恢复会话后审批模式仍为 `yolo`（未退回 `DEFAULT_SETTINGS` 的 ask）；⑤ 真实 `node --test` 项目「失败 → 模型真实改源码 → 重跑全绿」两轮收敛，过程中**无内部 `done` 外泄**、`test_loop_done` 唯一、修复过程事件仍可见、收尾后不 busy
- **第四轮复审证据复验（19/19 通过，真实 Runtime + 真实符号链接）**：按复审点名的三个场景逐项取证——① 真实**悬空 symlink**（`dangling.txt -> 工作区外/escaped.txt`，目标不存在）被守卫识别为 `dangling-symlink`，`write_file` 拒绝执行，断言工作区外文件**始终不存在**；② `search_files` 递归扫描到 `leak.txt -> 工作区外` 时未读到任何外部内容，工作区内文件正常命中，且结果里**明确报告「已跳过 1 个真实目标在工作区外的符号链接文件」**，子目录内的外部链接同样覆盖；③ 会话 A 持有工作区锁（等价于正在执行 `edit_file`）时，会话 B 的测试命令**未执行**，释放后正常完成且 A 不受影响（证明会话级锁之外确实引入了工作区级互斥）；④ 正常新建 / 读取与真实 `node --test` 两轮自愈链路不受影响
- **第五轮复审证据复验（17/17 通过，真实 Runtime + 真实符号链接）**：① 在审批回调内把 `link.txt` 从「指向工作区内」换成「指向工作区外」后，调用被取消且工作区外文件内容**原样保留**；② 别名写入落到**真实文件**（`link.txt -> public/safe.txt` 写入后真实目标被更新）；③ `@file:1-5` 引用越界链接时**不切片、不注入上下文**，工作区内文件仍可引用；④ 文件预览入口对越界链接报「路径越界」，工作区内预览正常；⑤ 指向工作区的 junction 别名与真实路径归一为同一物理身份并**取得同一个 Mutex 实例**；⑥ 设置页 1200s 超时**原样透传**宿主（未被裁剪到 600s）；⑦ 真实 `node --test` 两轮自愈链路不受影响、无内部 `done` 外泄
- **第六轮复审证据复验（17/17 通过，真实 Runtime + 真实符号链接）**：① `AGENTS.md -> 工作区外` 被 `getProjectRules()` 忽略（返回 null），独立工作区的普通 `AGENTS.md` 仍正常加载且不含外部内容；② `.easycode/prompts/leak.md -> 工作区外` 被跳过，只剩正常模板且不含外部内容；③ 信任 → 撤销 → 全量保存其它设置后 `isProjectTrusted` 仍为 `false`、`maxSteps` 正常更新、项目 `allow` 仍被忽略；④ 工作区根为 junction 时，审批期间改指到另一项目后写入被拒绝，**另一个项目的文件原样保留**；⑤ 真实 `node --test` 两轮自愈链路不受影响
- **第七轮复审证据复验（16/16 通过，真实 `bash` + 真实 Runtime）**：① 三种拼接前缀写法先用真实 `bash -c` 确认确实执行赋值后的程序，再断言归一化为 `rm -rf build` 且 `deny` 端点裁决生效；② 真实 `node --test` 两轮自愈链路不受影响、无内部 `done` 外泄、`test_loop_done` 唯一、会话回到空闲；③ 运行中 `abort()` 后结果为 `aborted` 且会话空闲；④ 删除正在运行的测试循环后会话文件不存在、会话不在列表

## [0.1.24] - 2026-10-12

### 新增
- 回合级代码改动快照与一键回退（Turn Checkpoint & Safe Undo，经五轮审查返工）：`write_file` 与 `edit_file` 接入 `onFileChange` 原子回调，由会话级 `CheckpointManager` 记录回合 Pre-edit 原始状态（若 `write_file` 读取原文件基准失败则立即中止覆盖以保护原文件；若工作区文件写入成功后 `onFileChange` 快照持久化或容量校验失败，工具立即自动回滚工作区文件与内存缓存并报告回滚结果，绝不留下未受快照保护的文件改动）；同一回合内多次修改同一文件严格以该回合首次修改前的原始版本为基准，回合内改回原样自动消除净零变更，校验失败或审批拒绝绝不产生脏快照；编辑最后一条提问（`editLastUserMessage`）时自动分配新消息身份并清理被截断回合残留快照，UI 严格按实际执行的写文件 `toolCallIds` 关联快照；快照独立存储于 `${dataDir}/checkpoints/${sessionId}.json`（带单文件 2MB、单会话 30 回合及单回合/单会话总容量 8MB 硬上限；通过同目录 `.tmp` + `host.fs.rename` 执行原子替换提交，写入或 `rename` 失败时立即清理未提交 `.tmp` 且正式文件不存在时拒绝晋升残留未提交 `.tmp`，杜绝重启复活已回滚的事务；`loadSessionRecords` 严格区分文件不存在、读取失败与 JSON 损坏）（TODOS #36）
- `<TurnUndoModal>` 撤销确认弹窗、双层 CAS 乐观并发校验与多文件异常回滚：在回合头部（`TurnView`）、回合右键菜单及 Composer `/undo` 快捷指令提供一键回退入口；执行回退时严格按快照自身记录的 `workspaceRoot` 获取工作区互斥锁并失效对应缓存（杜绝会话中途切换工作区后锁错项目，且跨工作区同名文件及后续回合中已单独撤销的文件不误报后续冲突）；双宿主（`NodeHost` 与 Tauri `fs_stat`）统一收紧 `stat()` 错误语义——仅在目标明确不存在（`ENOENT` / `ENOTDIR` / `NotFound`）时返回 `null`，权限拒绝等异常原样抛出；`revertTurn` 预检阶段无条件拦截 `stat` 不可访问或文件存在但 `readFile` 失败（不可读）的目标文件（即使 `force=true` 亦保守拒绝，且回滚彻底移除 `?? ''` 兜底，杜绝将未知原内容伪造成空文件）；回退写入前执行双层 CAS 乐观并发校验（对比预览时刻磁盘指纹 `expectedFingerprints` 与回合结束快照）；新建文件回退经 `unlink` 删除并通过后置 `stat` 探活验证；多文件回退中途发生异常或最终持久化 `revertedAt` 失败时，将当前正在执行并发生部分写入的 `inFlight` 文件与已修改前序文件一并纳入逆序补偿恢复（若恢复失败则明确告警受损或部分完成状态）（TODOS #36）
- 代码行号范围引用语法与发送时静态固化（Code Range Mention，经审查返工）：支持在 Composer 输入 `@path/to/file.ts:50-100` 或单行 `@path/to/file.ts:35`（新增 `formatFileMention` 统一对含空格路径加双引号转义 `@"path with space.ts":10-12`，起始行超出文件总行数时直接跳过而非错误钳制到末尾行）；在 `@` 补全后按 `:` 自动收紧空格并弹出 `[ : 行范围切片 ]` 语法提示；行范围切片仅在消息首次发送时解析并固化至 `UserMessage.rangeContext`，后续轮次直接复用发送时的静态切片快照，根除跨轮次重复磁盘读取与历史上下文漂移；读取前先经 `stat.size`（2MB 上限）前置拦截大文件，并限制单行（2,000 字符）与单片段总长度（24KB）（TODOS #38）
- 工作区轻量文件树与代码框选预览（`<WorkspaceFileTree>` & `<FilePreviewModal>`）：侧栏底部新增可折叠 `[TREE] 工作区文件树` 面板（超过 1,500 项时显示截断提示）；支持关键词过滤、右键菜单与悬停快捷操作；单击文件呼出轻量暗黑代码预览弹窗（前置 2MB 体积拦截），支持点击/Shift+点击或鼠标拖拽行号与代码行框选任意行区间，一键将 `@path:start-end`（含空格自动引号包裹）插入 Composer（新增 `consumeComposerInsert` 消费确认机制，防止切换设置页返回重新挂载时重复插入）（TODOS #38）

### 测试
- engine 新增 8 项综合与五轮审查回归单元测试（全仓 73 项测试通过）：覆盖 `CheckpointManager` 同回合多次修改基准保持、新建文件回退删除、跨回合冲突与双层 CAS（含预览后磁盘指纹 `expectedFingerprints` 变动拦截）、跨工作区切换后回退互斥锁目标一致性与同名文件零误报、`stat` 权限异常（`EACCES`）保守拒绝、存在但不可读文件在 `force=true` 下防清空保护、`unlink` 失败探活定性上报、多文件回退中途失败（含 `inFlight` 当前文件部分写入后抛 `ENOSPC`/`EIO` 及最终 `persistSessionRecords` 失败）逆序自动恢复与受损/部分完成告警、`onFileChange` 快照落盘或单回合超 8MB 硬上限时 `write_file`/`edit_file` 自动回滚工作区文件与内存态、首次快照 `rename` 失败清理 `.tmp` 且重启后拒绝复活未提交事务、`.tmp` + `rename` 原子提交与损坏/不可读快照保护、越界行号跳过、Composer 切页重挂载防重复插入、后续回合部分撤销不误报冲突、分多次部分回退后整回合完成标记与再次修改动态复位、`write_file` 原文件读取失败保护、上下文压缩后单调 `turnSeq` 与 `pruneCheckpointsByIds` 精确裁剪、非 System 模型零污染、`rangeContext` 防历史漂移、含空格路径引号转义闭环，以及真实 `NodeHost` 临时目录端到端回退验证（TODOS #36, #38）

## [0.1.23] - 2026-10-12

### 新增
- 长期运行后台进程管理与端口探测（Background Tasks & Port Watcher）：`run_command` 扩展 `background` 参数，dev server / watch / 容器等长期命令后台常驻运行，调用立即返回任务 ID 与 PID，不再被 120s 超时强杀或残留孤儿端口；配套新增 `read_task_logs`（列任务 / 流式查看输出 / 确认服务就绪）与 `stop_task`（Windows `taskkill /T /F` 树杀整棵进程树）两个工具（TODOS #37）
- 会话级后台任务管理器（`BackgroundTaskManager`）：环形行缓冲实时输出（约 1200 行 / 200KB 上限）、`\r` 覆盖语义与单行硬上限保证裸回车进度输出与无换行流的内存有界、单调 `outputBytes` 增量信号、正则捕获 localhost / 127.0.0.1 服务地址、宿主 TCP 探活确认就绪（TTL 缓存防轮询压力）、单会话任务数上限（默认 8）；kill 失败自动回滚停止意图保持状态真实，宿主登记仅在确认目标消亡后移除（失败保留句柄使重试语义成立）；删除会话同步终止其后台任务（清理失败时保留管理器供退出兜底再清一次），应用退出统一清场（Tauri 退出钩子 / Electron `before-quit` 等待终止流程真正完成——跨会话并行执行，5s 超时兜底保证永不阻塞退出），WebView 重载后经宿主 `proc_list` 自动恢复接管仍存活的进程（保留 cwd / shell 供按原样重启）（TODOS #37）
- 底部常驻后台任务条与实时日志抽屉：会话存在后台任务时，Composer 上方展示任务 chip（`● 命令 · 服务地址 · 运行中 Xm Ys`，秒级本地计时）与「⧉ 预览 / ↗ 浏览器 / ■ 停止」快捷操作；点击 chip 滑出半屏拟终端日志抽屉，ANSI 解码渲染、1s 轮询增量、贴底跟随与「↓ 回到最新」（TODOS #37）
- 双宿主流式进程能力与真树杀：Host 接口扩展 `process.spawn / kill / listSpawned / probePort`（core 保持零依赖，能力注入）；Windows 以 `taskkill /T /F` 树杀整棵进程树，Unix 以独立进程组启动（Node `detached` / Rust `process_group(0)`）并以进程组为生命周期单位——Node 宿主从入口到出口均以组探活为准（组长 shell 先退出而后代忽略 SIGTERM 存活时同样走完整终止流程：`组 SIGTERM → 等待组长退出或 3s 宽限 → 组探活 → 仍存活则组 SIGKILL → 确认消亡`），Tauri 宿主直接组 SIGKILL 强杀（与 Windows 强杀语义一致，graceful 终止由 Node 宿主承担）；kill 真失败（如权限不足且进程仍存活）经探活定性后向上抛出，Core 据此回滚停止意图保持 UI 与真实进程一致，进程已消亡（ESRCH / taskkill 128）不误报；NodeHost 以 `StringDecoder` 增量解码输出，Tauri 新增 `proc_spawn`（Channel 流式帧推送，确定性编码模式解码器：UTF-8 增量解出、出现确定非法字节即整流切换 ANSI 代码页，并按真实 ACP 的 DBCS lead+trail 成对消费、末尾孤立 lead 跨块持有，trail 字节落在 lead 区间也不会被碎解）、`proc_list`、`net_probe`（TCP 探活不受 WebView CORS 限制）；系统提示词同步增加后台任务使用纪律（TODOS #37）
- 内嵌 Web 预览面板（Embedded Preview）：右侧滑出预览分区与会话区左右分栏（左缘拖拽调宽），内嵌 iframe 实时加载本地服务；极客风地址栏支持编辑跳转、⟳ 刷新、⚡ 跟随刷新（轮询任务输出行数增量自动轻刷新，HMR 失效兜底）、↗ 外部浏览器兜底与桌面 / 平板 / 手机视口宽度快捷切换（TODOS #44）
- 预览面板与后台任务条联动：任务条 / 日志抽屉「⧉」一键内嵌预览捕获的服务地址并锚定任务；服务停止或端口失活时自动切换失联占位态 `● 服务已停止 [▶ 重新启动] [⟳ 重试连接]`，重启经 `restartBackgroundTask` 以原命令、原工作目录与原 shell 重新拉起并即时恢复预览（抽屉/预览锚点自动跟进新任务）；跟随刷新以引擎单调 `outputBytes` 为增量信号（与日志 tail 行数无关，长任务不失效）；新增跨宿主 `openUrl` 能力（Tauri `open_url` / Electron `shell.openExternal` / 演示 `window.open`）（TODOS #44）

### 修复
- 启动白屏修复：会话内容含 `<|im_start|>` 等特殊 token 字面量时，`ContextChip` 的 `gpt-tokenizer` 默认抛出 `Disallowed special token found`，渲染期异常导致整棵 React 树卸载、窗口只剩背景色；token 估算改为 `disallowedSpecial: new Set()` 按普通文本计数
- 根组件新增 `ErrorBoundary` 兜底：今后任何渲染期异常都显示错误堆栈与重载提示，不再整屏空白

### 测试
- core 新增 16 项 `tasks` 单元测试：任务元数据立即返回、输出行缓冲与 URL 捕获归一化、停止语义（先记录停止意图，杜绝宿主迟到退出事件把「已停止」误判为「failed」；kill 失败回滚保持 running）、自然退出事件流、并发上限与不支持环境、宿主恢复接管 scope 过滤（保留 cwd/shell）、`disposeAll` 清场、日志 tail 截断；审查修复回归：无换行超长输出内存有界且尾部可见、裸 `\r` 进度帧覆盖不堆积、`outputBytes` 与实际输出字节一致、开放尾部行可见、`restart` 复用原命令/cwd/shell、MemoryHost 真实链路（不经过测试替身：输出接收/URL 捕获/停止后无残余输出）（TODOS #37）
- Rust 新增 4 项 `StreamDecoder` 单元测试：UTF-8 多字节跨块、ASCII 直通、GBK 流整段切换 ANSI 模式且按真实 ACP 的 DBCS 语义成对消费（完整字符落在 chunk 末尾不被拆坏、trail 字节不被误判为 lead）、精确字符断言按 `GetACP()==936` 门控（TODOS #37）
- 真实环境验证：真实 Node HTTP server 启动 → stdout 捕获地址 → TCP 探活就绪 → 树杀后端口释放 → 事件流 `started→stopped` 全链路通过；Electron GUI 实测（隔离数据目录）跑通审批启动后台 dev server → 任务条 → 日志抽屉 → 内嵌预览 → 停止失联占位 → 重启恢复 → WebView 重载进程接管闭环；Unix 进程组终止路径（TERM→宽限→组探活→KILL）无法在 Windows 实测，按实现与评审把关，建议合并后在 Linux/macOS 冒烟

## [0.1.22] - 2026-09-29

### 修复
- 智能贴底跟随与双层视口滚动体验修复（Smart Auto-Scroll & Viewport Sync）：外层主视口引入基于 `ResizeObserver` 的智能贴底跟随器，贴底锁定态下内容因新回合创建、工具卡片加入、文本增量增长或回合折叠而高度膨胀时自动无感跟进，彻底解决新生成回答被挤到视窗下方看不到的问题；用户主动上翻立即解除锁定进入自由阅读模式，重新锁定只认「真正滚回最底」（极小容差判定），杜绝小幅上滚被滚动事件误判回贴底后又被跟随器拉回的意图吞没问题（内外双层视口同语义）（TODOS #46）
- 「↓ 回到底部」双层视口独立状态与联动：外层主视口 `atBottom` 与活动回合内部视窗 `turnAtBottom` 相互独立，任一视口离开底部按钮即出现，修复外层贴底但内层上翻时按钮不可达的双层割裂问题；点击后经 `store.jumpTick` 同步恢复内层视窗贴底并重新锁定全部跟随状态（TODOS #46）
- 回合完结自动对齐与状态下沉：Store 层接管 `turnAtBottom` 贴底状态全生命周期管理（完成、停止、异常、切回聊天视图时确保复位，避免组件卸载后遗留残态），回合折叠时触发一次精准视口校准（确定性兜底），保证最终结果完整呈现在可视区域内（TODOS #46）

### 优化
- 流式输出渲染优化（Streaming Render Pipeline）：流式渲染期间仅对「未闭合的尾部围栏代码块」跳过 `hljs.highlight` 语法分词（每帧增长的真正热点，严格遵循 CommonMark 围栏字符/长度/前导空格与尾缀规范），仅作转义纯文本呈现；已闭合代码块内容稳定、跨帧命中高亮 LRU 缓存，照常高亮近乎零开销；退出流式态后再全量高亮并写入 LRU 缓存。流式中间文本不写入 Markdown LRU 缓存，避免挤占已定型内容；实际性能收益仍需真实负载测量（TODOS #45）
- 演示模式流速优化：MockProvider 流式模拟由 6 字符/12ms 调整为 12 字符/8ms，在保证打字机动画流畅的同时贴近真实模型吞吐（TODOS #45）

## [0.1.21] - 2026-09-24

### 新增
- 端侧微决策小模型（Reflex ~22M DeBERTa-v3 QInt8）影子模式接入（Shadow Mode）：在 Agent 执行主循环中实现纯旁路无感观测，不阻断主 Agent 推进；单次决策纯异步调用，异常自动捕获隔离，主循环零停顿、零等待（TODOS #40）
- 5 大关键决策任务族旁路观测与前瞻预测：覆盖推理深度动态分配（`reasoning_effort`）、前置无泄漏工具路由前瞻预测（`tool_routing`）、工具执行错误自愈恢复（`recovery`）、上下文智能修剪前瞻（`context_management`）与敏感命令安全风控（`safety`）；其中工具路由前移至主模型生成前执行，结合按用户回合隔离的动态动作轨迹（Action Trace），从源头根除答案泄漏（TODOS #40）
- WebAssembly SIMD 端侧本地推理引擎（`ReflexWebPolicy`）：在 WebView2 内置 `onnxruntime-web` 与 Fast Tokenizer，利用现代浏览器 WebAssembly SIMD 技术实现 ~30ms 超低延迟推理，开箱即用，免除外部 Python 环境与复杂原生 C++ 依赖；增加后台空闲静默预热机制，消灭冷启动延迟（TODOS #40）
- 全局影子模式旁路观测开关（`reflexShadowMode`）：设置页提供显式全局开关（默认关闭），关闭时完全不装配决策策略，零额外 CPU 开销、零模型内存占用、零文件写入；严格执行安全门禁，模型未就绪或未产生真实推断时坚决不记录任何垃圾数据（TODOS #40）
- 设置页「微模型决策 (Reflex)」可视化监控面板：顶部集成 KPI 统计大屏（总决策量、端侧平均延迟、与实际动作一致率、弱监督样本数）与彩色任务族分布条；主体采用「项目 → 会话 → 决策事件明细」三级折叠树；直观展示模型预测 vs 实际动作、Softmax 候选概率横向条形柱状图与 Prompt 状态上下文抽屉（TODOS #40）
- 证据驱动的弱监督微调集一键导出（Silver 弱监督数据）：建立基于可观测因果事实（命令退出码 0、工具执行成功、上下文安全水位、回合实际复杂度）的自动标注与筛选引擎，排除执行失败及不可靠记录，一键导出 100% 符合 Reflex V1 标准的 JSONL 数据集，免除人工逐条审核负担（TODOS #40）

### 安全与优化
- 本地日志深度安全脱敏与写盘统一关口：落盘前对请求文本、状态描述、会话标题进行递归清洗打码（过滤 API Key、Token、私钥与连接串）；对 `metadata` 实施严格的基础标量白名单过滤，物理丢弃非白名单键及嵌套对象（TODOS #40）
- 结构化非敏感事实提炼：工具报错自愈提取纯净错误事实（`command_not_found`, `command_timeout`, `permission_denied`, `file_or_dir_not_found`, `non_zero_exit`），安全风控仅记录固定白名单动词枚举（如 `shell_git`, `shell_rm`）与解包命令，绝不将具体敏感参数或原始报错全文传入旁路记录（TODOS #40）
- 退出码判错修正：`run_command` 出现非零退出码或信号中断时精准标记为执行失败，并在轨迹中正确显示 `(error)`，杜绝误判为成功（TODOS #40）

## [0.1.20] - 2026-09-22

### 新增
- Composer `/` 斜杠快捷指令系统（Slash Commands & Custom Prompts）：在 Composer 输入框处于首字符或空格后输入 `/` 字符时即时唤出极客暗黑风指令建议面板（`.command-pop`）；具备清晰的分组与类型徽标（`[Git]` / `[审查]` / `[测试]` / `[修复]` / `[会话]` / `[自定义]`）；支持纯键盘驱动交互（`↑` / `↓` 移动选择、`Tab` / `Enter` 快速触发、`Esc` 随时退出、输入法合成中 `isComposing` 防误触）（TODOS #32）
- 动作类指令与高密度提示词模板：内置两类指令——① 立即执行动作类（零 Token 消耗）：`/compact` 就地触发上下文压缩与历史归档、`/fork` 一键分叉新会话分支、`/export` 直接导出会话为 Markdown 离线文档、`/clear` 清空输入草稿；② 结构化提示词模板类：`/commit` 自动化分析 Git 改动并生成 Conventional Commits、`/review` 对当前改动或指定文件进行质量与安全审查、`/test` 自动设计并执行单元测试、`/fix` 结构化定位与修复报错异常，展开后支持无缝追加参数或结合 `@文件` 引用（TODOS #32）
- 项目级自定义指令扩展：Engine 自动扫描工作区根目录 `.easycode/prompts/*.md`，将文件名映射为快捷指令名，文件首行解析为功能简述，文件正文作为 Prompt 模板自动合流至指令面板并标注 `[自定义]` 徽标（TODOS #32）
- 项目级上下文与行为规范系统（Rules System: `.easycoderules` / `AGENTS.md`）：支持自动层级探测工作区工程纪律与架构约定（优先级：`.easycoderules` > `AGENTS.md` > `CLAUDE.md` > `.cursorrules` > `.easycode/rules.md`），自动注入系统提示词的 `## 项目规范` 独立高优先级章节；由于系统提示词独立于消息历史传输，规则天然具备抗上下文压缩特性，长程对话与多轮任务推进中永不遗忘、永不漂移（TODOS #33）
- RulesChip 规则状态感知胶囊与一键初始化模板：在 Composer 顶部工具栏增设极客风规则感知胶囊 `<RulesChip>`，工作区检测到规则时以绿色亮态呈现 `[ 📋 规则: {文件名} ]`，点击浮出卡片查看规范摘要、字符数统计并支持一键打开所在目录；未配置规则时展示 `[ ＋ 规则 ]`，支持一键在工作区生成涵盖架构约定、编码纪律与验证流程的标准 `.easycoderules` 模板骨架（TODOS #33）
- 全局开发偏好设置（Global Rules）：设置页「常规」面板新增「全局开发偏好与行为规范」多行文本配置，支持用户配置跨项目的通用偏好（如中文注释、纯函数优先、编辑前读文件等），与项目专属规范叠加生效（TODOS #33）
- 工作区 Git 状态感知与改动检视面板（Git Status & Diff Inspector）：解决 Agent 跨文件读写后改动审查离散的痛点；标题栏与 Composer 工具栏实时呈现 Git 状态胶囊 `[ ⑂ {branch}* · {count} 改动 (+{ins} -{del}) ]`，窗口聚焦与工具执行完毕后自动增量刷新（TODOS #34）
- 全尺寸 Git 审查面板与全键盘闭环：点击 Git 胶囊或在工作区右键「📂 审查工作区 Git 改动」一键呼出极客风全尺寸弹窗 `<GitInspectorModal>`；左栏分 Staged、Unstaged、Untracked 分组展示改动文件、状态徽标与行数统计；右栏呈现结构化红绿双侧行号 Diff 视窗与一键复制 Patch；底部提供暂存全部（`git add .`）、放弃当前修改（带安全确认）、一键填入 Composer `/commit` 闭环生成提交信息（TODOS #34）
- Core 扩展只读免审批 Git 工具：注册 `git_status` 与 `git_diff` 免审批工具，模型需要获知工作区整体变动时可自主调用，免除 `run_command` 的审批弹窗与噪音（TODOS #34）

## [0.1.19] - 2026-09-22

### 新增
- 极客终端风自绘右键菜单（Custom Context Menu）：彻底替换白色的原生 WebView 菜单，全局自绘暗黑终端风微质感菜单 `<ContextMenu>`；具备强大的上下文感知能力——智能识别当前选中文本（复制/作为指令）、代码块（一键复制代码块纯文本）、用户消息（复制提问/从此节点分叉）与模型回答（复制 Markdown/从此回合分叉），空白处提供新建会话、工作区直达与停止任务；采用 `useLayoutEffect` 边界防溢出微调与 Escape 键盘无障碍交互，输入框与文本域内保留原生菜单保障输入法与粘贴习惯（TODOS #16）
- 关闭最小化到系统托盘常驻后台（System Tray）：双端宿主（Tauri 2.0 与 Electron）全面支持系统托盘图标；点击窗口右上角关闭按钮（✕）时平滑拦截并隐藏至系统托盘，后台并发会话、长程任务继续稳定执行；托盘图标支持左键点击快速还原/聚焦主窗口，右键弹出「显示主窗口」与「退出 EasyCode」（TODOS #5）
- 托盘常驻配置开关：设置页「常规」面板新增「关闭窗口时最小化到系统托盘」开关（默认开启），支持用户自主关闭托盘常驻直接退出应用（TODOS #5）

## [0.1.18] - 2026-09-22

### 新增
- 多会话并发执行与无感切换（Multi-Session Concurrency & Seamless Switching）：彻底解除运行中全局界面锁定限制；支持在任一会话执行耗时任务时，自由在侧栏切换到其他历史会话查阅代码、复盘，或在空闲会话中并发启动新任务（TODOS #29）
- 会话视图状态隔离池化（SessionViewState）：Store 引入会话状态池 `Map<sessionId, SessionViewState>`，时间线条目、进行中回合、当前待办清单、Token 消耗统计及运行状态全面按会话解耦独立管理；已访问或运行中的会话切换实现 0ms 瞬间瞬切，切回时即时呈现当前实时进度与 LiveTicker，杜绝反复请求白屏与画面跳跃（TODOS #29）
- 全局事件路由与后台静默推进：`client.onEvent` 扩展全量会话事件分流机制，后台会话无缝推进回合状态与任务进度；当前活动会话维持高频 RAF 流式渲染，后台会话在关键状态跃迁（启动、审批请求、完成、出错）时发送通知并刷新状态指示器（TODOS #29）
- 侧栏多会话实时状态指示徽标：侧栏各会话条目独立呈现动态运行态——绿色呼吸脉冲点（`running`，后台执行中）、琥珀色呼吸徽标（`waiting`，任务等待用户审批，点击直达审批卡片）、红色指示点（`error`）；会话删除按钮仅在目标会话自身运行中时禁用，不影响并发期间管理其他空闲会话（TODOS #29）
- 引擎端工作区互斥锁（Workspace Lock）：引入基于 FIFO 队列与 AbortSignal 感知的轻量异步互斥锁 `Mutex` 与 `WorkspaceLockManager`（标准化处理消除 Windows 路径大小写差异）；不同工作区会话完全并发，同一工作区会话执行敏感工具（`write_file`, `edit_file`, `run_command`）时安全排队，只读工具与人工审批等待期不占锁，保障多 Agent 并发与文件一致性（TODOS #29）

### 优化
- 切换时序安全保护：`selectSession` 引入递增序列号 `selectSeq`，防范快速连击侧栏产生的异步竞态覆盖（TODOS #29）
- 后台审批即时提醒：后台运行的会话触发工具人工审批时，自动向当前视图浮出包含会话标题与工具名的轻量 Toast 提醒，协助开发者快速定位（TODOS #29）

## [0.1.17] - 2026-09-22

### 新增
- 上下文超限保护与智能自动压缩（Context Compaction）：对标顶尖 Coding Agent 建立阶梯式上下文压缩体系，彻底消灭长会话多轮交互与大文件读取下的 Token 单调累积与 HTTP 400（Context Length Exceeded）崩溃（TODOS #31）
- 第一级压缩（历史工具长输出折叠裁切）：Core 导出 `pruneHistoricalToolResults`，安全裁剪早于保留轮次的大型工具输出（如数千行 `read_file`、大型构建日志），提取保留首尾关键定义（各 10 行）与行数/字符统计，严格保持 `toolCallId` 完备配对，零模型调用秒级缩减 50%~80% 冗余上下文（TODOS #31）
- 第二级压缩（历史轮次阶段记忆归档）：Core 导出 `compactHistoryMessages`，自动提炼早期轮次涉及的全部读写文件清单、执行的关键命令与全局最新 `todo_write` 任务清单快照，聚合成高密度阶段记忆说明消息，保留最近 2 轮活跃上下文（TODOS #31）
- Agent 循环内步间无感自动压缩：`runAgentLoop` 动态感知当前模型 `contextWindow` 与配置阈值（默认 85%）；在多步循环中若上一轮输入 Token 逼近上限，就地原子触发阶梯压缩，无损更新消息数组并派发 `context_compacted` 事件，保障长任务平滑推进不中断（TODOS #31）
- ContextChip 多级容量预警看板与主动压缩入口：容量达到 80%~95% 时触发琥珀色警戒态（`.ctx-warn`，文字/边框/SVG环变黄并显示预警横条），超过 95% 触发红色高危呼吸态（`.ctx-danger`）；浮层脚部配备极客风「✄ 压缩上下文（归档早期历史）」操作按钮，支持开发者一键主动瘦身（TODOS #31）
- 上下文自动压缩配置项：设置页「常规」新增「上下文超限自动压缩」开关（默认开启）与「自动压缩触发阈值（50%~95%）」调节控件，防超限策略完全自主可控（TODOS #31）

### 优化
- 会话历史精简升级：`AgentServer.trimSessionHistory` 全面升级为基于阶段记忆压缩器驱动，并对保留轮次中的旧工具输出执行长输出折叠，精简质量与信息保留度大幅提升（TODOS #31）

## [0.1.16] - 2026-09-22

### 新增
- 会话一键导出（Session Export）：在标题栏（`TitleBar`）新增极客终端风格 `⤓` 导出会话下拉菜单；支持导出为完整结构化 Markdown 文档（`.md`，包含元数据、GitHub 风格任务清单、折叠思考过程、行级 Diff 与命令执行输出）及单文件离线自包含 HTML 报告（`.html`，内嵌极客暗黑终端调色板、highlight.js 代码高亮样式、原生 `<details>` 交互卡片与红绿 Diff 视窗，零外部网络依赖，双击即开即审）（TODOS #26）
- 模型热切换容量安全预警（Model Switch Guard）：在 `ModelEffortPicker` 切换模型或服务商时，自动比对当前会话 Token 用量与目标模型上下文上限（`contextWindow`）；若已用 Token 超过 80% 推荐安全阈值，自动拦截并弹出 `<ModelSwitchGuardModal>` 预警看板，提供直观的容量超额占比对比条与风险提示，杜绝小窗口模型直接请求遭遇 HTTP 400 崩溃（TODOS #30）
- 三大上下文继承与裁剪策略：模型切换超限预警弹窗提供三大策略——「⑂ 分叉为新分支并精简历史（推荐）」保持原会话全量状态不受损，新分支继承工作区与最新待办；「✄ 在当前会话裁剪早期历史」调用 Engine 裁剪历史并注入归档标记，保留核心任务清单与最近 2 轮关键交互；「⚠ 忽略风险直接切换」满足极短指令提问需求（TODOS #30）
- 会话历史裁剪接口（`trimSessionHistory`）：Engine、Client 与各端 IPC 全面打通会话历史裁剪接口，智能保留最新待办清单快照并持久化更新（TODOS #30）

### 优化
- 跨厂商 Wire Format 兼容清洗：Core 层各 Provider 适配器大幅增强历史消息序列化兼容性——Anthropic 适配器自动过滤缺少有效服务端签名的 thinking 块，消除跨厂商模型切换至 Claude 时的 400 签名报错；OpenAI 适配器严格校验并过滤孤儿 `role: 'tool'` 消息，并对异常中断造成的断尾 `tool_calls` 自动补齐占位取消响应，保障协议合法性（TODOS #30）
- 全局 Token 估算器解耦：将 `ContextChip` 的 Token 估算提取为全局复用的纯函数 `estimateSessionTokens`，多处共享 WeakMap 多级缓存与分词结果，避免重复计算开销（TODOS #30）

## [0.1.15] - 2026-09-22

### 新增
- 会话分支/分叉（Fork Session）：在历史回合头部（`TurnView`）与用户提问操作条（`UserView`）增设「`⑂ 分叉`」入口；完整继承原会话工作区绑定与模型/思考档位配置，无损深拷贝截取范围内的历史消息与任务清单，新会话自动命名追加「（分支）」并无缝切换至侧栏高亮；解决编辑重发破坏性截断历史的痛点，满足多技术方案并行对比的开发需求（TODOS #27）
- Composer `@文件` 快捷引用与模糊补全（Context Mention）：在输入框输入 `@` 或光标紧随 `@query` 时，即时唤出终端极客风文件建议面板；支持纯键盘导航（`↑`/`↓` 移动、`Tab`/`Enter` 一键补全相对路径并后置空格、`Esc` 退出、输入法合成防误触）；未绑定工作区时显示友好提示（TODOS #25）
- 工作区文件极速遍历与智能评分：Core 导出轻量文件遍历器 `listFilesRecursively`（自动过滤构建与虚拟环境目录）；Engine 引入 3 秒短时缓存与智能加权匹配（文件名开头 > 文件名包含 > 路径包含），支持毫秒级响应（TODOS #25）

### 优化
- 流式事件 RAF 批量合并（Batching & Coalescing）：在 `store.ts` 引入 `scheduleNotify()` 批处理调度，高频纯文本增量（`text_delta`、`reasoning_delta`）原地追加缓冲，通过 `requestAnimationFrame`（50ms 定时器兜底）合并刷新，消灭每秒几十次的全树重渲，彻底根治流式期间打字滞后与掉帧（TODOS #28）
- 细粒度版本信号解耦：拆分 `structureVersion` 结构版本号，仅在新增/删除消息、回合折叠等关键时刻递增，将重度 DOM 测量与高频文本流式彻底解耦（TODOS #28）
- 消除回合条目线性扫描：`appendToBlock` 与 `flushAssistant` 采用 `WeakSet` O(1) 判定，消除每个 delta 对回合条目数组的线性扫描（TODOS #28）
- Token 估算多级缓存与轻量化：静态系统提示词与工具规格缓存避免每次组件渲染重复序列化和分词数万 Token；历史定型条目与完结回合全量采用 `WeakMap` 多级缓存，历史长文本 O(1) 秒取，消除长会话重复 BPE 编码（TODOS #28）
- 根治滚动中的 Layout Thrashing：时间线轨道 `measure()` 刻度计算解耦仅响应结构性变动；滚动监听采用 `requestAnimationFrame` 节流；静态 Y 坐标偏移仅在尺寸或结构变动时预存，滚动中只做纯数字比对，杜绝滚动中密集调用 `getBoundingClientRect()`（TODOS #28）
- 时间线轨道动效平滑化：时间线悬停波浪动效引入 RAF 节流，消除指针移动时的样式计算堆积（TODOS #28）
- Markdown 与代码高亮多级缓存：`markdown.ts` 引入双 LRU 缓存（Markdown 编译结果 200 条、hljs 代码高亮 300 条），避免已闭合代码块重复执行复杂的正则着色；`Md` 组件引入 `React.memo` 浅比对优化（TODOS #28）

## [0.1.14] - 2026-09-21

### 新增
- 侧栏项目分组折叠：项目分组组头支持 `▾` / `▸` 折叠与展开，点击项目整行卡片即可就地折叠/展开与激活；折叠状态持久化存储于 `Settings.collapsedProjects`，重启应用后保持记忆，大幅释放侧栏纵向空间（TODOS #4）
- 会话标题重命名：支持在会话悬停时点击 `✎` 按钮或双击会话标题直接进入行内编辑，回车保存、Esc 取消、失焦自动保存，打通 UI → Store → Engine 全链路，侧栏与顶部标题栏即时同步（TODOS #4）
- 项目管理操作菜单（···）：项目组头悬停浮出 `···` 按钮，提供「在文件管理器中打开」、「在 VS Code 中打开」、「重命名项目别名」、「移除项目」等完整管理入口（TODOS #4）
- 单次任务最大步数配置化：引擎与设置全面打通 `maxSteps`（缺省 200 步，支持 10~500 步可调），设置页「常规」新增步数配置控件，提供防死循环与异常空转保险（TODOS #15）
- 第二阶段高价值需求规划：在 TODOS 中详细设计并收录了 Composer `@文件` 快捷引用补全 (#25)、会话一键导出为 Markdown/HTML 报告 (#26)、会话分支/分叉 (#27)

### 优化
- 会话卡片视觉降噪与高度压缩：剔除会话条目冗余的模型提供商与模型名称展示，去除项目组头会话数计数，信息全面聚焦于会话主题；会话卡片压缩为紧凑单行（28px），操作按钮垂直居中，大幅提升侧栏纵向利用率
- Composer 项目切换器显示与操作优化：未在设置中命名的已绑定目录智能显示当前文件夹名，并在下拉底部提供「＋ 将当前目录存为项目」快捷入口，方便一键持久化（TODOS #4）
- 侧栏树形架构重构：项目作为第一层容器，归属会话直接作为子节点挂载展开；项目整行卡片均可直接点击切换折叠与展开，交互连贯顺畅（TODOS #4）

### 技术
- `packages/core/src/test/loop.test.ts` 补充 `maxSteps` 耗尽报错与终止测试，`pnpm test` 自动化测试集扩展至 13 个测试项全绿
- `packages/engine/src/settings.ts` 与 `server.ts` 扩展 `maxSteps` 与 `collapsedProjects` 配置契约与持久化

## [0.1.13] - 2026-09-21

### 新增
- 折叠容器吸顶体验：工具卡片头部、拟终端卡片头部、思考过程头部与回合头部全部吸顶常驻（`position: sticky` + 实色背景 + 层次阴影），长内容向下阅读时折叠条平滑贴附在可视视口顶部，看完直接在顶部点击即可收起，免除数百上千像素的回滑成本（TODOS #24）
- 吸顶钉位贴平与多层避让：按 Chromium「sticky 以滚动容器 padding box 为基准」的实测行为做负值补偿（回合头 `-22px`、卡片头 `-4px`）真正贴平视窗顶缘；运行态 Live Ticker / 任务清单吸顶栏在场时，折叠头以 `:has()` 规则自动钉位于其正下缘，互不遮挡（TODOS #24）
- Composer 输入框自适应撑高：按内容即时量高（2 行起步、最多 8 行），超出出纵向滚动条，发送后自动收缩回初始高度，高度变化带平滑过渡（TODOS #20）
- 顶部栏响应式收敛：可用宽度紧张（< 640px）时，Token 用量收敛为 `⇅` 微型图标、上下文容量收敛为 SVG 进度环，Tooltip 携带完整数值且悬停即浮出明细看板，优先保障审批模式与模型选择控件完整可见（TODOS #20）
- 文件拖拽填充：从系统文件管理器拖放文件至输入框即把绝对路径插入光标位置，多文件换行拼接、含空格路径自动加引号，拖拽悬停时绿色高亮 + 「松开插入文件路径」行内提示；Tauri 走窗口级 `onDragDropEvent`（含坐标命中判定），Electron 走 `webUtils.getPathForFile`，浏览器演示兜底文件名（TODOS #20）

### 优化
- 文件工具卡片视觉降噪：`write_file` / `edit_file` 展开态不再渲染冗余的 raw JSON 输入块（与上方结构化 Diff 视窗 100% 重复），聚焦「Diff 视窗 + 执行结果」，关键状态与耗时不再被大段转义字符挤到最底部；其他工具保留正常参数显示（TODOS #23）
- Live Ticker 吸顶钉位统一贴平视窗顶缘（`top: -4px`），与折叠头钉位基准一致（TODOS #24）
- 拟终端命令卡片默认折叠：`TerminalCard` 初始展开状态由 `true` 调整为 `false`（默认收起），展开回合详情时不会再被所有命令的大段控制台输出霸屏，保持单行简洁，由用户自主按需点开
- 重构思考过程卡片（Thinking）：重构为统一极客终端风卡片，提供 `[ THINK ]` 状态徽标（思考中动态呼吸）、字符量统计与一键复制工具栏，规避原生 details 内边距漏洞与文字叠加异常，支持吸顶与开闭态圆角平滑过渡

### 修复
- 修复浏览器演示模式整链路瘫痪：旧版设置迁移剔除 `demo` 供应商的规则误伤了演示模式自带的 mock 服务，导致会话无法创建、侧栏空白；现于设置加载后重新注入 mock 供应商再预创建演示会话
- 修复 Composer 命令行提示符 `❯` 在输入框多行撑高时沉底错位的问题，改为固定对齐第一行
- 修复拖拽文件悬停提示（`.drop-hint`）遮挡右侧发送按钮的问题，避让并定位至输入框内部右上角
- 修复卡片解除 `overflow: hidden` 后折叠态直角刺出外层圆角边框的问题，为工具卡片、终端卡片及思考头部补充开闭态圆角适配与边框重叠规避

### 技术
- 解除 `.tool-card` / `.term-card` 的 `overflow: hidden`（会禁用内部 sticky），思考块 summary 以负外边距撑满盒子宽度防侧边穿模
- Electron preload 增补 `getPathForFile`（`webUtils` 白名单通道）
- Composer 增加 ResizeObserver（+window resize 兜底 + 初始测量）驱动顶部栏紧凑态

## [0.1.12] - 2026-09-21

### 新增
- 模型过程独立滚动视窗：回合展开态的过程体（思考过程、工具调用卡片、过程输出等）设为局部独立滚动视窗（`max-height: 55vh`），流式输出期间局部自动贴底跟随，外层主会话区域不再疯狂下滚，用户的 Prompt 和上下文平稳停留在可视区上方（TODOS #18）
- 任务清单常驻吸顶（Sticky Header）：新增 `StickyTodoBar` 组件，基于 `activeTodos` 响应式状态常驻固定在会话可视区顶部；默认单行极客风紧凑状态栏（`[◍ 进度 N/M · P%] 正在进行: xxx ▾`），点击可平滑展开完整步骤清单与优先级徽标（TODOS #18）
- Agent 实时动作指示器（Live Ticker）：运行中常驻展示动态瞬态状态行（`❯ [{tool_name}] 正在执行: {summary} (已耗时 {seconds}s) █`），支持毫秒/秒级平滑自增计时、终端闪烁光标，遇审批时智能切换为 `[ 等待审批 ]` 状态，彻底消除等待焦虑（TODOS #21）
- `run_command` 拟终端卡片：定制极客控制台窗口样式（顶部 `$ 命令` 标题栏、`exit: 0` 绿标 / `exit: 1` 红标），执行中带拟终端动态光标，完成后标明执行状态码与耗时（TODOS #21）
- 零依赖轻量 ANSI 颜色高亮与进度条清洗：自研轻量解码模块 `ansi.ts`，解析 ANSI SGR 标准 16 色、高亮色、粗体、暗淡等样式，并处理 `\r` 回车覆盖（平滑支持带有动态进度条和加载动画的 CLI 工具输出）（TODOS #21）

### 优化
- 会话主视口滚动逻辑解耦：解除外层随每个 token delta 强制滚底的联动，外层仅响应发消息和切会话事件；隔离回合内部滚轮事件，内部向上翻看不触发外层脱离贴底状态（TODOS #18）
- 时间线轨道精确锚定：重构刻度计算逻辑，基于精确相对位置高亮当前视口刻度，并配置 `scroll-margin-top` 避免跳转时被吸顶组件遮挡（TODOS #18）

### 技术
- 新建 `packages/ui/src/ansi.ts` 纯 TS 实现标准 ANSI 16 色与转码
- `ToolItem` 增加 `startedAt` 启动时间戳，`store.ts` 提供 `activeTool` 与 `pendingApproval` 响应式数据流

## [0.1.11] - 2026-09-21

### 新增
- 代码块语法高亮：引入 highlight.js 覆盖 30+ 主流编程语言（TS/JS/Rust/Python/Bash/Go/JSON/HTML/CSS 等），配合 EasyCode 暗黑极客终端调色板（冷绿/青色/琥珀/品红等），代码阅读体验显著提升（TODOS #19）
- 代码块顶部语言栏与一键复制：代码块顶部展示 `// 语言` 标识，右上角配备 `[ ⧉ 复制 ]` 按钮，点击一键提取纯净代码，1.5 秒内即时反馈 `✓ 已复制`（TODOS #19）
- `edit_file` 可视化 Diff 视图：重构 `ToolDiff` 接入 `diffLines`，呈现红底 `-`（删除行）与绿底 `+`（新增行）并标注精确旧/新行号，支持全局替换徽标、实时增删统计（`-N +M`）与超长差异自动折叠保护（TODOS #19）
- 审批卡片内置 Diff 预览：`ApprovalCard` 针对 `edit_file` 与 `write_file` 操作直接展示结构化差异对比，用户批准前即可全面审查改动详情（TODOS #19）
- 设置页「常规」新增「复古 CRT 扫描线」开关：默认开启，关闭后全局扫描线平滑淡出，无缝切换为纯黑极简现代终端风，把视觉风格选择权交还给用户（TODOS #22）
- 弹窗与浮层微动效：模态弹窗（`.modal-mask`, `.modal`）与下拉菜单/浮层（`.proj-pop`, `.me-pop`, `.effort-pop`, `.update-pop`, `.help-menu`, `.tsel-menu` 及 Toast）加入 140ms~200ms 平滑微缩放淡入动效，消除生硬瞬切感，并完备支持 `prefers-reduced-motion` 无障碍回退（TODOS #22）

### 技术
- `packages/ui` 引入 `highlight.js` 依赖，重构 `markdown.ts` 渲染器
- `Transcript.tsx` 主容器挂载代码块一键复制事件委托
- 扩展 `Settings` 接口与默认值：新增 `crtScanline?: boolean`（默认 `true`），`App.tsx` 动态同步根节点 `html.crt-off` 类名

## [0.1.10] - 2026-09-21

### 新增
- 任务清单 TodoWrite：新增内置 `todo_write` 工具，Agent 执行多步骤复杂开发任务时自主规划并维护清单状态（待办 pending / 运行中 in_progress / 完成 completed）（TODOS #12）
- 终端极客风 TodoCard 面板：Transcript 会话流中定制展示任务进度（`[◍] 进度 N/M (百分比)`），各项清晰呈现状态图标与优先级，支持面板折叠与展开（TODOS #12）
- 回合折叠态进度指示：回合执行完毕折叠后，在最终输出上方保留任务清单进度汇总条，任务完成进展一目了然（TODOS #12）
- Windows Shell 增强：`run_command` 启动时自动探测系统最优可用 Shell（优先级：`PowerShell 7 (pwsh) → Git Bash → Windows PowerShell 5.1 → Command Prompt (cmd)`），模型可顺畅执行 Linux 习惯命令（`ls`、`cat`、`rm -rf` 等）（TODOS #1）
- 设置页「常规」新增「命令行终端 (Shell)」下拉单选：动态展示系统各 Shell 探测状态（可用/未检测到），默认自动探测，支持用户手动覆盖（TODOS #1）

### 修复
- 修复 Windows 中文编码乱码：Rust 宿主对子进程输出增加自适应智能转码（`decode_output`），优先解析合法 UTF-8，包含非法字节时按 Windows 当前 ANSI 代码页（CP_ACP/GBK）无损转码，彻底杜绝 cmd 和 powershell 中文输出乱码（TODOS #1）

### 技术
- 新增 `todo_write` 工具与 `TodoItem` 类型定义，`SessionData.todos` 随会话自动持久化
- 系统提示词工作纪律注入多步骤任务使用 `todo_write` 规划的主动引导
- 新增宿主命令 `proc_detect_shells`，返回各终端可用性与探测路径
- `proc_run` 扩展 `shell` 参数，支持动态路由与分流调用
- Core 与 Engine 链路全打通：`ProcessRunOptions.shell`、`ToolContext.shell`、`Settings.shell`（默认 `auto`）

## [0.1.9] - 2026-09-21

### 新增
- 模型弹窗底部新增「⚙ 管理模型」入口，一键跳转设置页模型服务分区（TODOS #6 子项）
- 通知点击唤起：Windows 上点击系统通知即还原主窗口并聚焦（winrt toast on_activated 回调）（TODOS #13 子项）
- 任务出错也通知：回合内出现错误时，通知文案区分「任务出错 / Agent 完成」（TODOS #13 子项）
- 设置页「常规」新增「任务完成桌面通知」开关（默认开，关闭后不再发系统通知）（TODOS #13 子项）
- 「打开工作区」支持 VS Code：探测 PATH 中的 code 命令，未安装时 toast 提示；设置页「常规」新增「打开工作区方式」下拉（文件管理器 / VS Code），项目切换器按钮文案与行为跟随默认方式（TODOS #14 子项）

### 技术
- Windows 通知改为直接构建 winrt toast（新增 tauri-winrt-notification 依赖）以挂点击回调；非 Windows 仍走 notification 插件；dev 构建回退 PowerShell AUMID 的策略与插件保持一致
- 新增宿主命令 `open_in_vscode`（Rust where/which 探测 + 隐藏窗口 spawn；Electron 同语义实现）
- Settings 新增 `desktopNotify`、`openWorkspaceWith` 两个可选项，缺省行为与旧版一致

## [0.1.8] - 2026-09-20

### 新增
- 模型选择器支持跨服务切换：composer 的模型菜单改为「当前服务在上、其余服务分组在下」，点选其他服务下的模型即同时切换会话的服务与模型，思考强度一并重置为该服务默认（TODOS #6）
- 任务完成桌面通知：Agent 跑完时若窗口不在前台，发系统原生通知（标题「EasyCode — Agent 完成」+ 会话名），前台时静默不打扰（TODOS #13）
- 「在文件管理器中打开」：项目切换器新增入口，用系统文件管理器打开当前会话的工作区（TODOS #14）

### 技术
- 新增宿主能力命令 `open_path`（tauri-plugin-opener）与 `send_notification`（tauri-plugin-notification），二者经 AgentClient 抽象，Tauri / Electron / 演示模式各有实现（Electron 走 shell.openPath 与原生 Notification，演示模式退回 Web Notification）

## [0.1.7] - 2026-09-20

### 新增
- edit_file 强制「先读后改」：本会话未读过的文件拒绝编辑，覆盖已有文件的 write_file 同样要求先读，引导模型先 read_file 再修改，消灭盲改类误操作（TODOS #2）

### 优化
- 单次任务步数上限 25 → 200，大任务不再过早中断（TODOS #15）
- 应用内右键不再弹出 WebView 原生菜单，输入框内保留右键粘贴（TODOS #16）

### 修复
- 更新详情弹窗改为向右展开，不再被窗口左缘截断，宽度加大到 320px（TODOS #17）
- 修复工具事件被重复处理：store 的事件订阅在 StrictMode 双挂载下注册了两份监听（dev 构建），导致工具卡片成对出现、文本增量重复追加、结果回填错位——订阅移入 store 构造函数并加防重入保护
- 修复并行工具调用显示异常：部分网关返回的并行调用带重复 id，导致结果回填错位、第二张工具卡片永远停在「RUN」——适配器现对重复/缺失的调用 id 原地唯一化，界面回填时优先匹配仍在运行的卡片
- 修复工具调用被成对重复执行：部分网关会把工具调用的流式分片整个复制重发（index+1、id 与内容照抄），现判定为重复分片直接丢弃，同一工作只执行一次

## [0.1.6] - 2026-09-20

### 新增
- 回合聚合：思考与工具调用折叠进回合块，默认只显示最终结果，可展开回看全过程
- 回合头部显示任务用时；结束后自动折叠
- 会话左侧时间线轨道：按用户消息定位，悬停预览内容、点击跳转
- 用户消息显示发送时间并支持复制；助手最终输出支持一键复制
- 输入框 ↑/↓ 浏览当前会话已发送消息（草稿保护，多行编辑不冲突）

### 优化
- 滚动改为仅发送消息与切换会话时回到底部，流式输出不再打断阅读
- 滚动行为升级为贴底跟随：输出时位于底部则自动跟随，上翻即停止跟随；右下角新增「回到底部」按钮

### 文档
- 重写 README：新增 logo、下载指引、功能总览与联网搜索/模型服务配置说明

## [0.1.5] - 2026-09-20

### 新增
- 标题栏更新入口：检测到新版本即出现在窗口控制按钮左侧，悬停弹出更新说明
- 运行期间每小时静默复查新版本，使用途中发布新版同样会亮起更新角标

### 优化
- 更新说明渲染为 Markdown 并完整展示（此前为截断的纯文本提示）
- 下载更新时面板内常驻进度条

### 修复
- 应用启动检测到新版本后更新入口不显示、需进入设置页才出现的问题
- 关于页版本号硬编码 v0.1.0 的问题（改为动态读取）

### 调整
- 关于页精简：仅保留信息表格，更新入口移至标题栏

### 文档
- 重写 README：新增 logo、下载指引、功能总览与联网搜索/模型服务配置说明

## [0.1.4] - 2026-09-20

### 新增
- 联网搜索：内置 `web_search` 工具，支持 SearXNG、Tavily 与自定义 API（GET 模板，兼容 SearXNG results 格式）
- 搜索分流：GPT/Claude 等有原生搜索的模型走原生工具，GLM/DeepSeek 等走内置 `web_search()`；总开关关闭时全部不搜索
- 未绑定项目的会话也可以联网搜索（文件/命令类工具仍需绑定项目）
- 设置页新增「联网搜索」分区：总开关、后端选择、地址/密钥、结果条数（默认 5）、测试搜索
- 模型列表：上下文窗口与视觉徽标（如 `1M` / `视觉`），模型参数自动探测（models.dev 在线目录 + 内置规格库，官方来源优先）
- 模型配置弹窗：智能配置自动探测参数；高级配置支持输入类型、模型能力、推理档位与推理参数映射
- 模型连通性测试：逐模型发送最小真实请求，返回延迟或错误详情
- 模型能力真实生效：原生联网搜索、对话中系统消息（关闭时系统提示词并入首条消息）、结构化输出（DeepSeek 需手动开启）
- 思考强度档位自动跟随模型官方档位（如 GPT-5.6 的 none→max 六档）

### 修复
- 未绑定项目的会话所有工具不可用的问题（联网搜索不再依赖工作区）
- 部分视觉模型被误标注、最大输出参数不准确的问题
- 标题栏不再显示版本号

## [0.1.3] - 2026-09-19

### 新增
- 精确 token 计数（o200k_base 分词器），上下文容量面板按消息/系统工具/系统提示词分类统计
- 平均缓存命中率显示（三种 API 格式均解析缓存命中）
- 模型上下文窗口默认 1,000,000

### 优化
- 上下文容量面板文案精简

## [0.1.2] - 2026-09-19

### 新增
- API 格式统一为三种协议：Anthropic Messages / Chat Completions / Responses
- 模型列表自动获取与手动添加，自定义供应商显示名称与启停
- Composer 模型选择器与思考强度切换（ChatGPT 同款）

### 修复
- 每次启动后模型列表消失的问题
- 部分自定义供应商无法获取模型的问题

## [0.1.1] - 2026-09-19

### 新增
- 应用内自动更新：检查更新、下载进度、安装重启；侧栏更新入口仅在有新版本时出现
- 项目化会话管理：侧栏项目分组、创建项目对话框、会话切换所属项目
- 设置改为全屏页面（模型服务 / 常规 / 关于）

### 修复
- GitHub Actions 三平台构建产物缺失问题

## [0.1.0] - 2026-09-18

### 首个版本
- 终端风界面、自绘标题栏与窗口缩放；pnpm monorepo（core 零依赖 + Tauri 壳）
- 三种 API 协议接入与演示模式（无需 Key 体验完整链路）
- Agent 工具：读写文件、精确编辑、目录浏览、正则搜索、执行命令、审批门
- 多会话与项目管理、上下文容量与用量展示、会话持久化
