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



