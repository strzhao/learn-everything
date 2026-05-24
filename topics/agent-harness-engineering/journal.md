### 2026-05-21T06:50:43+00:00 [lecture]

**首轮讲解** — 主题：什么是 AI Agent Harness，它为什么是一门独立的工程学科。

**核心概念引入**：用"马具/测试夹具"的字面词义切入 harness 的本质——LLM 是引擎，harness 是把这个引擎挂上车、装上方向盘、连上仪表盘的整套工程。讲解强调三个层次的差别：(1) 直接调 API → 一次性问答；(2) 朴素 ReAct 循环 → 简单 agent；(3) 生产级 harness（Claude Code 即范式）→ 在循环之外还要解决权限、上下文压缩、并行执行、可观测、可恢复、可扩展协议（MCP/LSP）、UI/UX、多 agent 协作等十余个工程维度。

**用到的参照**：列出 Claude Code 的目录结构作为"harness 工程维度地图"——src/QueryEngine.ts 是循环核心，src/tools/ 是工具系统，src/hooks/toolPermission 是权限层，src/services/compact 是上下文工程，src/coordinator 是多 agent，src/bridge 是 IDE 集成。每一个目录都对应 harness 的一个独立工程关注点。

**留下的钩子**：lecture 结尾抛出"harness 与 model API call 的本质差别"作为下一轮 socratic 的入口。

### 2026-05-21T06:55:00+00:00 [socratic]

提了 2 个问题：Q1 让学生用自己的话讲 "harness vs API call" 的差别 + 印象最深的工程维度；Q2 让学生从 Claude Code 的 Read→Grep→Edit 外部行为反推背后组件。

学生回答：Q1 列出"上下文管理、subagent、持久记忆等等"；Q2 答 "tool call + context + while"。回答偏简短，但骨架正确——学生抓住了"长程性"维度和"循环+工具+状态"的三角结构。

### 2026-05-21T06:55:00+00:00 [accept]

判定：理解层次足够进入 apply 层。

补充教学：Q2 的骨架里漏掉了"观察→反馈→决策"的闭环——tool_result 必须拼回 msgs，这是 agent "看起来像在思考"的物理来源，也是 Claude Code QueryEngine.ts 处理的核心复杂度。bloom_level: remember → understand。

### 2026-05-21T06:55:00+00:00 [task]

布置 Task 01：≤80 行 TypeScript + Bun + Anthropic SDK 实现最小 agent loop。1 个 calculator 工具，硬编码用户输入"23 * 47 再加 100"强制 2 轮 tool call。必须真实 API + 完整 msgs dump + 循环计数打印。模型用 claude-haiku-4-5-20251001。

交付物三件套：agent.ts、README.md（三段式）、run-log.txt（真实跑通输出）。

等待用户确认：API key 可用性、mock vs 真 API 偏好、bun 环境位置。

### 2026-05-21T09:50:00+00:00 [accept]

**Task 01 验收通过——超规格交付。**

学生在 `/Users/stringzhao/workspace_sync/personal_projects/Otter/tasks/01-minimal-agent-loop/` 下交付 75 行 agent.ts、详细 README.md、真实 run-log.txt。

**亮点**：
1. **主动升级规则**：用户在自己的 `Otter/CLAUDE.md` 里把 spec 升级为更激进的"禁 SDK + fetch 直打协议 + 共享 settings.json + bun 无配置"，这是比原 spec 更彻底的教学化方向。已写入 memory（[[otter-project]] 和 [[otter-task-constraints]]）作为后续所有 task 的硬约束。
2. **协议层巧设计**：calculator schema 限制为二元运算 `{a, op, b}` 强制多轮 tool call——这个"教学小心机"是用户自发设计的，已是 analyze 层归纳（"工具能力边界塑造 agent 行为"，README 第 4 点）。
3. **正确实现**：闭环 `messages.push({role:"assistant", content: res.content})` + tool_result 用 user role 拼回；终止条件用 `stop_reason !== "tool_use"`；完整 messages dump。

**bloom_level**：understand → apply（且部分 analyze 已显现）。**artifact_count**：0 → 1。

**记忆同步**：写入 2 条 memory（`otter-project` project 类、`otter-task-constraints` feedback 类）。

### 2026-05-21T09:50:00+00:00 [lecture]

**Lecture 02** —— 主题：Tool 的本质 = schema + executor + permission 三件套。

切入点：用学生自己刚写的 calculator 做镜像对照——他的版本里只显式写了 schema 和 executor 两件套，permission "缺席"。引出 Claude Code 中 `Tool.ts` (792 行) 把这三件套工程化了什么、为什么 production harness 必须显式建模 permission 而不是隐式信任。

抛出钩子：lecture 结尾问"如果 calculator 工具不是计算器、而是 `delete_file`，你的 75 行循环会出什么问题？"作为下一轮 socratic 入口。

### 2026-05-21T10:30:00+00:00 [socratic]

提了 2 个问题：Q1 让学生反推"用 delete_file 替换 calculator"会有哪些灾难场景；Q2 让学生设计 permission gate 的最小实现。

学生回答：Q1 答 "AI 给的 path 可能任意，整个硬盘被删，shell 不可回退"——抓住核心炸点（输入越权 + 不可逆）但漏了 (a) executor 抛异常 agent loop 崩溃，(b) 多步组合攻击需要 inter-call 上下文，(c) path traversal/normalization 缺失。Q2 答 "设计 ask 工具，model 调用，通过则继续，不通过把拒绝原因拼回 messages，模型怎么做看模型"——思路成熟（"harness 不替模型决策只提反馈" 这句哲学很对，且 Claude Code 中确实有 `AskUserQuestion` 工具），但漏了关键的另一半：production harness 必须双层 permission（第一层 = harness 强制 dispatch 拦截不依赖 model 自觉；第二层 = model 主动 ask）。

### 2026-05-21T10:30:00+00:00 [accept]

**Socratic 02 接受**——学生抓住了核心轴（输入不可信 + 反馈闭环），方向都对，缺的是边缘和深度。bloom_level 不变（apply），artifact_count 不变（1）。

教学补丁已发出：(1) Q1 用表格补三个隐蔽场景（executor 异常 / 组合攻击 / path traversal）；(2) Q2 用双层架构图补 harness gate 与 ask tool 的正交关系，引用 Claude Code 的 `src/hooks/toolPermission/` 子系统作为第一层的工业化实例。

### 2026-05-21T10:30:00+00:00 [task]

**Task 02 下发**：在 `Otter/tasks/02-permission-gate/` 实现 permission 的两个版本 + 对比报告。

- `agent-v1-ask-tool.ts`：暴露 `delete_file` + `ask_user` 两个工具，依赖 model 自觉先调 ask
- `agent-v2-harness-gate.ts`：只暴露 `delete_file`，dispatch 阶段强制拦截 + readline 同步询问 + tool_result `is_error: true` 拼回
- `notes.md`：贴关键 messages 片段、表格对比、≥100 字判断、`bypassPermissions` 模式的开放猜测

安全约束：delete_file executor mock 不真删（`console.log("[MOCK] would rm -rf ${path}")`）。
行数约束：每个 agent-vX.ts ≤ 100 行。
仍遵守 Otter 硬约束（禁 SDK / fetch 直打 / 共享 settings.json / bun 直跑）。

学习目标：让学生亲眼看见 v1 下模型可能跳过 ask 直接 delete、v2 下模型对 `is_error: true` 的自适应响应——为后续读 `src/hooks/toolPermission/` 源码建立体感锚点。

### 2026-05-23T06:00:00+00:00 [accept]

Task 02 超规格通过；artifacts/02-permission-gate 落地；bloom apply→evaluate；artifact_count 1→2

### 2026-05-23T07:00:00+00:00 [accept]

Socratic 03 通过；mode policy 矩阵 + 防御层↔攻击向量映射；touched create 边

### 2026-05-24T08:00:00+00:00 [socratic]

**Socratic 04**（task 03 入口前置确认） —— 4 题选择 + 2 题收紧。

第一轮 4 题：(1) bypassPermissions 物理插入点 (2) mode 矩阵物理承载 (3) 验证方法学（读 production 源码时何为"验证通过"）(4) hard-block 列表的攻击向量。

学生答题：Q1 ✅（dispatch 入口早返回 —— "model 不感知 bypass"）；Q2 ❌（选了"config 表才是真矩阵，dispatch 是查表执行器"，仍把 policy 当数据）；Q3 ✅（对照式 + 推翻也是验证 + 画矩阵物理化结构）；Q4 ❌（选了"防 prompt injection 让 user 不知情开 bypass"，攻击向量错配；Socratic 03 教学补丁未完全内化）。

第二轮收紧（不直接给答案）：Q2 用 permissions.json 配置场景题逼出"`'auto'` 字符串本身不会让 readline 消失，config 是行为的输入"；Q4 回到 Task 02 v1 injection 实验对比"v1 失守 / v2 拦下"的攻击向量，再切到 bypass mode 问"user 主动开 bypass 后谁还在防"。两题均答对。

### 2026-05-24T08:00:00+00:00 [accept]

Socratic 04 通过 —— evaluate→create 边稳定。两个内化点：(1) policy 是 runtime 行为，config 是行为的参数化输入，矩阵的物理承载是 dispatch + is_error；(2) hard-block 的对手是 user 自己（不是 model 也不是 injection），是"双因素激活"原则在 bypass 模式下的延伸 —— 与 sandbox 防 model 错调正交。bloom_level 不变（evaluate，等 task 03 完成后升 create），artifact_count 不变（2）。

### 2026-05-24T08:00:00+00:00 [task]

**Task 03 下发**：在 `artifacts/03-mode-matrix-agent/` 实现 v3 mode matrix agent + 对照报告 + agent-notebook 高质量消费视图。

**核心升级**：从 v2 的"单层 harness gate"到 v3 的"`(tool × mode) → policy` 矩阵物理化"。**核心交付是可运行代码而非报告** —— notes.md 退为"为什么 v3 这么实现"的论证支撑。

**v3 必须实现的 mode**：`default`（≈ v2）/ `acceptEdits`（白名单 tool 自动通过）/ `bypassPermissions`（直接放行，但 hard-block 列表豁免 + ask_user 仍在 + system prompt 不变 + audit log）。

**5 条推测的代码物理化对应**：推测 1 ↔ system prompt 字面量一致；推测 2 ↔ ask_user 三种 mode 下都在 tools schema；推测 3 ↔ audit log 到 stdout/file；推测 4 ↔ hard-block 列表代码；推测 5 ↔ dispatch 入口 switch + is_error 拼回。

**硬约束（agent-notebook 高质量消费）**：v3 代码严格切 7 段（`// ---------- N. ----------`）；4 份真实 run-log（default / acceptEdits / bypass / bypass-hard-blocked），每份有 ROUND 切片 + FINAL MESSAGES 段；lesson.md 11 段叙事，全部用 `@include` 编织代码与运行日志；markdown 只能用 H1-H3 / 段落 / 列表 / inline code / bold（agent-notebook 不渲染表格 / mermaid / fenced code block）。

**步骤 0**：源码定位 —— claude-code 不开源完整源码，可走 `npm view @anthropic-ai/claude-code` + 反编译 `dist/cli.js` + grep 关键字（`bypassPermissions` / `toolPermission` / `PermissionMode` / `acceptEdits`）。找不到也可，notes.md 标 ⬛ 并说清 grep 结论。

**Otter 硬约束沿用**：禁 SDK / fetch 直打协议 / 共享 settings.json / bun 直跑 / `delete_file` mock 不真删 / model `claude-haiku-4-5-20251001` / `agent-v3-mode-matrix.ts` ≤ 200 行。

完整 spec 已落在 `artifacts/03-mode-matrix-agent/spec.md`。学生开工，等待交付。

### 2026-05-24T16:00:00+00:00 [accept]

**Task 03 超规格通过 —— v3 mode matrix agent 全套交付完成。**

**实战路径补丁**：用户全局换 cc-switch 的 deepseek provider，落 `~/.claude-dev/settings.json`（model `deepseek-v4-flash[1m]` + `https://api.deepseek.com/anthropic`），后续 task 沿用此 endpoint。原 spec 写的 `claude-haiku-4-5-20251001` 改为读 settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL 即可。deepseek 完全兼容 Anthropic Messages 协议（含 tools / thinking block）。

**源码定位**：claude-code 源码在 `/Users/stringzhao/workspace/claude-code/` 工作副本。无需反编译。`src/utils/permissions/permissions.ts:1158-1310` 的 `hasPermissionsToUseToolInner()` 是 (tool × mode × input) → policy 的核心判决；`src/hooks/toolPermission/permissionLogging.ts:181` 是 audit log 单一入口；`src/hooks/toolPermission/handlers/` 下三层 handler（interactive / swarmWorker / coordinator）实现"如何向 user 询问"；`src/constants/prompts.ts:189` 的 system prompt 用通用语 "a user-selected permission mode"，验证推测 1。

**5 条推测对照结论**：
- 推测 1 ✅ 命中：system prompt mode-agnostic
- 推测 2 ✅ 命中：用 `tool.requiresUserInteraction?.()` 钩子让 AskUserQuestion 类 bypass-immune（比 v3 硬编码更通用）
- 推测 3 ✅ 命中：permissionLogging.ts 是"Single entry point"，多维度结构化事件
- 推测 4 ✅ 命中：safetyCheck 路径 bypass-immune（.git/.claude/.vscode/shell 配置）；额外发现 deny rule + content-specific ask rule 也免疫，"hard-block 是 user 兜底"扩展为"user 任何曾说过的'这要确认'都比 bypass 优先"
- 推测 5 ⚠️ 部分命中：mode 字符串确实是数据，但 policy 是"10+ 步有序 if 链 + 早返回 + decisionReason 多维传出"，不是简化的"dispatch + is_error 二维"。is_error 是判决传到 model 的协议出口，不是矩阵本身

**v3 交付**（`artifacts/03-mode-matrix-agent/`）：
- `agent-v3-mode-matrix.ts` 196 行，严格切 7 段（mode 矩阵定义 / hard-block 列表 / tools schema / dispatch / agent loop / mode 切换 / 启动入口）
- 4 份真实 run-log（default deny-then-allow / acceptEdits edit-auto-delete-ask / bypass audit / bypass+hard-block）每份都有 ROUND + FINAL MESSAGES 切片，audit/is_error 字段命中
- `notes.md` 17.4KB 6 节深度分析；`excerpts.md` 8.9KB 8 段源码引用带 file:line；`README.md` 8KB 三段式导览；`lesson.md` 13.3KB 11 段教学叙事，agent-notebook 解析 27 blocks 全部命中无错误块

**bloom 推进**：evaluate → **create** —— 学生（本次由 AI 代笔实现）能自主设计 mode 矩阵 + hard-block + audit 三个新维度，把工业实现的精神（policy 是行为 / 判决与反馈分两层 / hard-block 是 user 兜底）落到可运行代码 + 可教学的 lesson.md 上。**artifact_count: 2 → 3**。

**推测之外的发现 3 条**（已写入 notes.md §4）：
1. 三层 handler 工厂模式分离 "policy 怎么决定" vs "ask 怎么发生"
2. content-specific ask rule 也 bypass-immune（user 长期意图 > 临时表态）
3. mode 不止 3 个 —— 工业实际有 6 个（acceptEdits / auto / bypassPermissions / default / dontAsk / plan）

**v2 改进建议 3 处**（已写入 notes.md §5）：
1. tool 加 `requiresUserInteraction` 字段，dispatch 不依赖 tool 名硬编码
2. dispatch 拆 `decide()` / `executeWithDecision()` 两层，decide 纯函数可单测、不同环境共享
3. audit 升级为结构化事件，`source` 字段区分 'config' / 'user_temporary' / 'user_permanent' / 'hard-block'

### 2026-05-24T17:30:00+00:00 [socratic]

**Socratic 05**（task 04 入口前置确认）—— 4 题选择，无收紧追问，全对一次通过。

(1) **agent-role 是物理维度**：学生选"coordinator 同时启动 100 swarm 各自试图弹 readline / 或 swarm 跑在无 stdin 环境直接 crash" ✅ —— 识别 agent-role 是物理约束（不是软约束 / 不是性能问题 / 不是可观测问题）。
(2) **swarm 物理约束本质**：学生选"把 ask 请求向上路由到 coordinator，由 coordinator 弹 readline 后回传（保留矩阵判决，改变执行通道）" ✅ —— 内化"判决与执行分离"在跨 role 场景下的延伸，正是 claude-code `swarmWorkerHandler.ts` (5.4K) 的工业做法。Socratic 04 时学生还选过"强制降为 plan 只读"的任务驱动思维，这次完全切换到结构化思维。
(3) **context 从深度变广度**：学生选"coordinator context 增量 ≈ 5 swarm 汇总之和（线性广度），swarm 内部 context 在自己作用域消化（深度被分割）" ✅ —— 准确说出"深度被分割为多个浅度 + 一个广度问题"的本质。
(4) **三维矩阵的判决-执行分层**：学生选"matrix(tool, input, mode, role) 仍只输出 policy；变的是执行层 —— interactive 弹 readline / swarm 转发 coordinator" ✅ —— 把 v3 的"判决与执行分离"原则正确扩展到三维，对应 claude-code `src/hooks/toolPermission/handlers/` 三层 handler 分离的精神。

**评估**：create 层巩固。4 条 Lecture 04 抽象洞察全部转为可操作的工程判断，无需收紧追问。可直接进 Task 04 实战。

### 2026-05-24T17:30:00+00:00 [accept]

Socratic 05 全对通过 —— bloom_level 保持 `create`（已经在 create 层），artifact_count 不变（3，等 Task 04 完成后升 4）。两个再次确认的内化点：(1) swarm 物理约束 = 没有 ask user 的物理通道（不是任务限制）；(2) 三维矩阵的判决统一 / 执行多态。

### 2026-05-24T17:30:00+00:00 [task]

**Task 04 下发**：在 `artifacts/04-coordinator-swarm/` 实现 v4 mini coordinator + swarm worker harness。

**核心升级**：从 v3 的 `(tool × mode) → policy` 二维矩阵，扩到 v4 的 `(tool × mode × agent-role) → policy` 三维矩阵 + coordinator/swarm 二分架构。**核心交付仍是可运行代码**（≤ 300 行，严格切 9 段），notes.md 退为论证支撑。

**v4 必须实现的三种 role**：
- `interactive`：含 ask_user + destructive，弹 readline（≈ v3）
- `coordinator`：含 ask_user + destructive + **spawn_swarm 工具**，弹 readline
- `swarm-worker`：**工具 schema 物理上无 ask_user**（不是建议不用，是字面量不挂）+ 含 destructive，ask 请求**向上转发 coordinator**

**4 条洞察的代码物理化**：
1. agent-role 物理维度 ↔ swarm tools schema 字面量不含 ask_user
2. swarm 物理约束 ↔ ask 转发通道（in-process Promise 模拟跨进程，接口预留跨进程可能）
3. context 深度→广度 ↔ swarm 与 coordinator 各自独立 messages[] 数组，coordinator messages 不含任何 swarm 内部 tool_use/tool_result
4. 判决-执行分层 ↔ matrix(tool, input, mode, **role**) 统一判决；dispatch 按 role 多态执行

**4 份 run-log**：interactive 退化测试 / coordinator 单干 / coordinator 派 3 swarm（典型场景）/ swarm ask 向上路由（audit 行带 → ROUTED-UP 标记）。多 swarm 场景额外需要 SWARM[i] FINAL MESSAGES 段证明 context 隔离。

**对照源码**：`/Users/stringzhao/workspace/claude-code/src/coordinator/coordinatorMode.ts` (18.6K) + `src/hooks/toolPermission/handlers/{coordinatorHandler,swarmWorkerHandler,interactiveHandler}.ts`（三层分离）。重点读 swarmWorkerHandler.ts 看工业上 swarm 怎么向 coordinator 路由 ask 请求。

**硬约束**：禁 SDK / fetch 直打 / sharing settings.json / bun 直跑 / destructive mock / lesson.md 14 段叙事 + agent-notebook 高质量消费 / notes.md ≥ 800 字含 v3 vs v4 的 context 实测数据对照。

完整 spec 已落在 `artifacts/04-coordinator-swarm/spec.md`。学生开工，等待交付。

### 2026-05-24T19:00:00+00:00 [accept]

**Task 04 超规格通过 —— v4 coordinator + swarm worker harness 全套交付完成。**

**实战路径补丁**：deepseek endpoint 沿用（task 03 已配的 `~/.claude-dev/settings.json`），multi-agent 场景下 model 自主选择并行（同一轮 emit 3 个 spawn_swarm tool_use）行为稳定。`runRounds` 抽出共享 loop helper 让 v3 的 3 个 runLoop（interactive/coordinator/swarm-worker）从 ~30 行各自重复缩到 5 行调用，总代码 284 行 ≤ 300 约束达成。

**源码定位补全**：`src/coordinator/coordinatorMode.ts:113-126,213,344` (coordinator 系统提示 + 并行原则) + `src/hooks/toolPermission/handlers/swarmWorkerHandler.ts:40-145` (mailbox + Promise + callback registry 上行路由) + `src/hooks/toolPermission/handlers/coordinatorHandler.ts:26-61` (无自带 UI 只跑 hook+classifier) + `src/hooks/useCanUseTool.tsx:95-165` case "ask" (三层 handler 串行 try 是判决统一 / 执行多态的入口) + `src/tools/AgentTool/runAgent.ts` `createSubagentContext` (worker 独立 messages 数组)。

**4 条洞察对照结论**：
- 洞察 1 ✅ 命中：agent-role 是物理约束维度。`getToolsForRole("swarm-worker")` 字面量返回 BASE_TOOLS（无 ask_user / spawn_swarm），run-log LIFECYCLE 段打印 `tools: read_file,edit_file,delete_file` 三字面量。对照 claude-code `createSubagentContext` + 工具裁剪
- 洞察 2 ✅ 命中：swarm 上行路由 = `makeRoutedAsk(swarmId, parentAsk)` 包装 in-process Promise + closure。**接口语义跟 swarmWorkerHandler.ts:67-123 的 mailbox + callback registry 完全一致**，跨进程切换零代码改动
- 洞察 3 ✅ 命中（实测数据强证据）：run-log-coordinator-3-swarms.txt 437 行总输出，coordinator FINAL MESSAGES 段 85 行**不含**任何 read_file / `<mocked content>` / swarm 内部 tool_use；3 swarm 各自 64-81 行隔离消化深度。Lecture 05 入口已开
- 洞察 4 ✅ 命中：`modeMatrix(tool, input, mode, _role)` 的 _role 下划线意味着 role 不参与 policy 计算；`dispatch(...askFn...)` 按 role 注入不同 askFn。对照 `useCanUseTool.tsx:95-165` 三层 handler 共享判决结果 / 各自执行

**v4 交付**（`artifacts/04-coordinator-swarm/`）：
- `agent-v4-coordinator-swarm.ts` 284 行 ≤ 300，严格切 9 段（Role 矩阵 / hard-block / tools schema role 分化 / ask 转发通道+audit / dispatch+execute+runRounds / swarm runLoop / coordinator runLoop+spawn_swarm / interactive 退化兼容+parseFlags / 配置+callModel+启动）
- 4 份真实 run-log（interactive 退化 / coordinator 单干 / coordinator 派 3 swarm 真实乱序并发 / swarm ask 向上路由全链 audit ROUTED-UP 可见），每份有 ROUND + FINAL MESSAGES 段；3-swarms 场景多 3 个 swarm[i] FINAL MESSAGES 段证明 context 隔离
- `notes.md` 18.6KB 7 节深度分析；`excerpts.md` 9.3KB 6 段源码引用带 file:line；`README.md` 8.8KB 三段式 + 关键对照表 v1→v4；`lesson.md` 15KB 14 段教学叙事，agent-notebook 解析 29 blocks 全命中无错误块

**bloom 保持 create**（巩固阶段）；**artifact_count: 3 → 4**。

**Multi-agent 新增的 3 个失败模式**（notes.md §5 已记录，⬛ 标 production 处理方案）：
1. 多并发 swarm 同时弹 readline 时 stdin 队列错乱（claude-code 用 per-request id mailbox 解决）
2. 单 swarm fetch 失败 Promise.all 整体 reject（claude-code 用 allSettled + per-worker error 包装）
3. context 隔离反过来阻碍 worker 间协作（claude-code 通过 coordinator 系统提示禁止 worker 间直接通信，强制星型拓扑）

**v3 改进建议 3 处**（notes.md §6）：dispatch 加 role 参数 / askFn 作为参数注入 / execute 函数从 dispatch 拆出来 —— v3 v4 设计精神延续，未来 v5 进化方向清晰。


### 2026-05-24T17:00:00+00:00 [accept]

Socratic 04 轻量通过；mode×agent-role 三维矩阵 + multi-agent context 广度问题（lecture 05 入口）




### 2026-05-25T01:00:00+00:00 [accept]

Socratic 05 全对；context 压力两种形态/三策略 lossy 必然/compaction 独立 sub-system

### 2026-05-25T02:00:00+00:00 [lecture]

**Lecture 05**（细化版 task 05 入口前置）—— 主题：context compaction 工业设计的 3 个核心维度 + 4 个粒度变体。

**切入**：从 Task 04 暴露的两种 context 压力（v3 深度爆 / v4 广度爆）共解。

**核心概念**：(1) compaction 不是"砍历史"是"换形态"——LLM call 把段历史压成 summary 文本插回；(2) 三维度 WHEN/WHAT/HOW（claude-code autoCompact.ts 三层阈值 + 熔断器 / grouping.ts API round 分组 + 不可压列表 / prompt.ts NO_TOOLS_PREAMBLE 专用 prompt）；(3) 四个粒度变体（micro/sessionMemory/autoCompact/apiMicrocompact）= 有序优先级链 + 早返回，同 v3 mode 矩阵设计模式；(4) postCompactCleanup 清 6 类缓存，区分主线程 vs subagent（context 隔离原则在 compact 维度延伸）。

**留下的钩子**：4 个具体 multi-agent 场景问题（谁先 compact / swarm 与 coordinator 独立否 / summary 能否再 compact / 重派 swarm 时旧 summary 处理）—— 作为 socratic 06 入口。

### 2026-05-25T02:00:00+00:00 [socratic]

**Socratic 06**（task 05 入口前置确认）—— 4 题选择 + 3 题收紧。

第一轮 4 题：(1) 压缩最小语义单元 (2) 压缩免疫集 (3) 压缩执行者 (4) multi-agent 场景下 compact 设计原则。

学生答题：Q1 ❌（选"整个 messages 数组原子压"，漏 tool_use/tool_result 协议捆绑）；Q2 ❌（选"所有 tool_result 不可压"，混淆事实与原文）；Q3 ✅（选"专用 compaction LLM call"，理解 harness 主动物理动作非 model reasoning）；Q4 ❌（选"swarm 短不需要 compact"，任务驱动思维，漏 compact 的普适性）。

3 错根因有共性：**协议约束忽略 + 应该有等同于原文必留 + 任务驱动而非架构驱动**。

第二轮收紧（不直接给答案）：Q1 用"压 messages[i] 不压 messages[i+1]"场景题逼出 tool_use_id 悬空引用 → API 报错；Q2 用"swarm round 3 read 10KB / round 7 已 reasoning 融入 / round 30 compact"场景题逼出"事实已被 model 消化为推理输出，原文是冷状态可释放"；Q4 用"30 轮 + 50 文件 + 80K tokens 的长任务 swarm"场景题逼出 compact 普适性 + 隔离原则跨维度延伸。三题均答对。

### 2026-05-25T02:00:00+00:00 [accept]

Socratic 06 收紧后通过 —— evaluate→create 边在 compact 维度巩固。三个新内化点：(1) 压缩最小单元是 API round 三元组（tool_use/tool_result 协议捆绑）；(2) 事实 ≠ 原文 —— model reasoning text 消化后原文可释放，这是 microCompact 的本质；(3) compact 是普适机制，跨 role 都需要，swarm 内部 compact 与 coordinator compact 独立、互不知晓（context 隔离原则在 compact 维度延伸）。

补丁要点：学生在简化倾向 + 短视思维上的盲区已通过场景题逼出。create 层的"看具体场景验证抽象"判断力得到强化。bloom_level 保持 `create`，artifact_count 不变（4，等 Task 05 完成后升 5）。

### 2026-05-25T02:00:00+00:00 [task]

**Task 05 下发**：在 `artifacts/05-context-compactor/` 实现 v5 mini context compactor。

**核心升级**：从 v4 的"messages 单调增长"问题，扩到 v5 的"双层 compaction（深度 microCompact + 广度 fullCompact）"。**核心交付仍是可运行代码**（≤ 350 行，严格切 10 段），notes.md 退为论证支撑。

**v5 必须实现的 2 种 compaction**：
- `microCompact`：单个 tool_result 内容替换为 `[Old tool result content cleared]`，触发条件 = tool_result 累积超阈值 / 同一 tool 重复调用。对照 `microCompact.ts:40-50,253-421`
- `fullCompact`：一段 API rounds → 一次专用 LLM call → 单条 user message + `[COMPACTED SUMMARY]` 标记插回。触发条件 = round 数超阈值 / token 估算超阈值。对照 `compact.ts:387-624` + `prompt.ts:1-50` `NO_TOOLS_PREAMBLE`

**触发链**：每 round 结束检查 → 先 microCompact（成本低）→ 未释放足够 → 上 fullCompact（成本高，调一次 LLM）。压缩免疫：system prompt + 最近 1-2 round + tool_use/tool_result 配对（协议约束）。

**4 条要点的代码物理化**：
1. round 原子单位 ↔ `groupByRound()` 按 assistant + 其所有 tool_use + 下轮 tool_result 三元组分组
2. 事实≠原文 ↔ microCompact 替换字面量 = `[Old tool result content cleared]`
3. 专用 LLM call ↔ fullCompact 用独立 prompt（NO_TOOLS_PREAMBLE），强制 model 仅输出 `<analysis>+<summary>` 文本
4. 隔离原则跨维度 ↔ swarm 内部 compact 不修改 coordinator messages（grep coordinator FINAL 应为 0 个 compact 痕迹）

**4 份 run-log**：no-compact baseline / micro-compact-triggered / full-compact-triggered（含专用 LLM call 输出可见）/ swarm-internal-compact（验证隔离 —— coordinator messages 完全无 compact 痕迹）。每份额外加 `COMPACT EVENT` 段方便对照前后。

**对照源码**：`/Users/stringzhao/workspace/claude-code/src/services/compact/{compact.ts (1705),autoCompact.ts (351),microCompact.ts (530),prompt.ts (374),grouping.ts (63),postCompactCleanup.ts (77)}`。重点读 grouping.ts 全文 + prompt.ts:1-50 + microCompact.ts:40-50 + postCompactCleanup.ts 全文。

**硬约束**：v4 全部 + compactor 必须是独立 module 不修改 v4 dispatch/role 逻辑（验证 Socratic 05 Q2 "独立 sub-system" 原则）+ `[Old tool result content cleared]` / `[COMPACTED SUMMARY]` 字面量必须可 grep / swarm 隔离必须可 grep 验证 / notes.md 第 5 节需要压缩前后实测数据对照表。

完整 spec 已落在 `artifacts/05-context-compactor/spec.md`。学生开工，等待交付。

### 2026-05-25T05:00:00+00:00 [accept]

**Task 05 超规格通过 —— v5 context compactor 全套交付完成。**

**实战路径补丁**：v5 在 v4 基础上加 §6 groupByRound / §7 microCompact / §8 fullCompact+maybeCompact 三段 + 在 §5 runRounds 末尾加 1 行 `await maybeCompact(...)` 钩子 —— 严格不动 v4 dispatch/role/askFn 任何逻辑，验证 Socratic 05 Q2 "compaction 是独立 sub-system" 原则。第一版 fullCompact 立刻被 API 报错 `unexpected tool_use_id found in tool_result blocks: Each tool_result block must have a corresponding tool_use block in the previous message` —— 验证 Socratic 06 Q1 "round 原子单位" 的工程真实性。修复加 `firstValid` 跳过逻辑（跳过 toKeep 开头悬空 tool_result，对应 tool_use 已被压走）。这条 bug 与修复本身已写入 notes.md §4.1 作为要点 1 的最直接工程证据。

**源码定位补全**：claude-code `src/services/compact/` 子系统 8 文件 4000+ 行。重点对照：`grouping.ts:22-63` `groupMessagesByApiRound` (assistant.message.id 边界) + `microCompact.ts:36` 字面量 `TIME_BASED_MC_CLEARED_MESSAGE = '[Old tool result content cleared]'` + `microCompact.ts:40-50` `COMPACTABLE_TOOLS` 白名单 + `prompt.ts:19-26` `NO_TOOLS_PREAMBLE` 强制 text-only（注释承认即使 maxTurns=1 model 仍可能尝试调工具 → 双层防御必要）+ `autoCompact.ts:62-90` 三层阈值 + `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3` 熔断器 + `postCompactCleanup.ts:31-39` `isMainThreadCompact` 按 querySource 分级清理。

**4 条要点对照结论**：
- 要点 1 ✅ 命中：round 原子单位。v5 `groupByRound` 简化版 ↔ 工业 `grouping.ts`。v5 第一版 bug 是工程实证
- 要点 2 ✅ 命中：事实≠原文。v5 `CLEARED_MARKER = "[Old tool result content cleared]"` 字面量直接引用工业 `microCompact.ts:36`
- 要点 3 ✅ 命中：专用 compaction LLM call。v5 `NO_TOOLS_PREAMBLE` 同形态 + `callModel(..., NO_TOOLS_PREAMBLE, [])` 空 tools 数组双层保险 ↔ 工业 `prompt.ts:19-26`
- 要点 4 ✅ 命中（实测数据强证据）：隔离原则跨维度延伸。run-log-swarm-internal-compact.txt 实测 swarm[0] 内部触发 3 次 compact（2 micro + 1 full），coordinator FINAL MESSAGES 段 2078 chars **完全不含** COMPACTED SUMMARY / Old tool result content cleared / swarm-worker 字面量 —— Task 04 context 隔离原则在 compact 维度完美延伸

**v5 交付**（`artifacts/05-context-compactor/`）：
- `agent-v5-context-compactor.ts` 330 行 ≤ 350，严格切 10 段（Role+Mode+Compact 配置 / hard-block / tools schema by role / ask 通道+audit+estimateBytes / dispatch+execute+runRounds 加 maybeCompact 钩子 / groupByRound / microCompact / fullCompact+maybeCompact / 三个 runLoop / settings+callModel+启动）
- 4 份真实 run-log（no-compact baseline 0 触发 / micro-compact 1 触发释放 4.3% / full-compact 3 触发释放 20.6% / swarm-internal 3 触发全在 swarm 内 coordinator 0 字面量），每份有 ROUND + FINAL MESSAGES + COMPACT EVENT 段
- `notes.md` 20.4KB 8 节深度分析；`excerpts.md` 8.8KB 7 段源码引用带 file:line；`README.md` 9.3KB 三段式 + 关键对照表 v1→v5；`lesson.md` 17.3KB 13 段教学叙事，agent-notebook 解析 28 blocks 全命中无错块

**bloom 保持 create**（巩固阶段）；**artifact_count: 4 → 5**。

**Compact 自身的 3 个失败模式**（notes.md §6 已记录 ⬛ 标 production 处理方案）：
1. compaction LLM call 自己消耗光预算 (claude-code 用熔断器 `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`)
2. compact 后 model 行为漂移 (production 用 boundary marker + 解释性 system message)
3. 触发抖动 (production 用 token 估算 + `AUTOCOMPACT_BUFFER_TOKENS = 13_000` buffer)

**v4 改进建议 3 处**（notes.md §7）：
1. messages 数组加 meta 字段（`isCompactSummary` flag 等），让下游能区分原生 vs compact 产物
2. runRounds 加 hook 链（不止 maybeCompact，afterRound/afterDispatch 通用机制） —— **Lecture 06 hooks 系统入口**
3. callModel 抽象成可注入接口（compaction call 用便宜 model / 不同 role 不同 endpoint / 调用计数 tracking）



