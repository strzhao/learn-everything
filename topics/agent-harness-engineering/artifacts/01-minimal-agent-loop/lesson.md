# Task 01：最小 Agent Loop

> 75 行 TypeScript，不依赖任何 SDK，从 0 到 1 跑通一个能多轮调用工具的 agent。本课用 notebook 视图把代码、讲解和真实运行日志拼在一起阅读。

## 是什么

这是 Otter 的第一个任务，目标是**让你亲手看见 "agent" 在物理层面到底由什么构成**。

> agent loop = `fetch` + `messages` 拼接 + `while`，仅此而已。

我们不用 `@anthropic-ai/sdk`、不用任何抽象类、不做错误处理、不做流式响应。所有"魔法"都被剥光，剩下一个 75 行的纯 TypeScript 文件，每一行都对应一个明确的概念。

跑完一次后，你应该能凭印象画出：

- HTTP 请求/响应的真实形状（model、messages、tools、content blocks、stop_reason）
- tool_use 出现后，下一轮 messages 数组是怎么"长出来"的
- 循环什么时候停下

## 怎么跑

前置：`~/.claude-dev/settings.json` 已经配好了 API。

`bun run tasks/01-minimal-agent-loop/agent.ts`

完整输出在 `run-log.txt`。每次会有微小差异（模型 thinking 的措辞），但骨架始终是：

- ROUND 1 stop_reason=tool_use → `tool_use {a:23, op:"*", b:47}`
- ROUND 2 stop_reason=tool_use → `tool_use {a:1081, op:"+", b:100}`
- ROUND 3 stop_reason=end_turn → 最终结果 1181
- FINAL MESSAGES → 6 条消息历史完整 dump

## 学到了什么

### 1. harness 不是 SDK，是协议 + 拼接

整个 agent 只用了 `fetch`、`JSON.stringify`、`Bun.file`、一个 `for` 循环。SDK 把这些封装得很好看，但封装的代价是你看不见 messages 数组在每一轮怎么变化。**先手写一遍，再用 SDK，才不会被抽象绑架。**

下面是配置加载，最朴素的环境读取：

@include(./agent.ts, section=1)

### 2. 协议约束塑造行为：calculator 工具的小心机

注意 tool schema 只允许 `{a, op, b}` 二元运算。这不是写不出来，而是**故意**这么设计 —— 它让 "23 × 47 + 100" 必须分两轮调用。如果允许 `expression: string`，模型可能一次就算完，你就观察不到多轮 tool_use 的现象了。

> 工具的能力边界，决定了 agent 的行为模式。

@include(./agent.ts, section=2)

初始 messages 数组只有一条 user 消息——这是整段对话的起点：

@include(./agent.ts, section=3)

### 3. agent loop 的真身

终止条件就一行：`if (res.stop_reason !== "tool_use") break;`。这是 Anthropic 协议规定的唯一退出信号。

@include(./agent.ts, section=4)

### 4. 第一轮：模型决定调工具

看 ROUND 1 的真实响应。注意 `stop_reason=tool_use`，content 里同时有 thinking、text、tool_use 三种 block。

@include(./run-log.txt, round=1)

> **关键观察**：`tool_use` block 的 `id` 字段（如 `call_00_DmcxLs9jQntHJToJtRC24385`）会在下一轮的 `tool_result.tool_use_id` 中"回引"——这是模型知道哪个结果对应哪个调用的物理依据。右侧 messages 侧栏现在已经增长了——assistant 消息和 user[tool_result] 消息标了 NEW。

### 5. 第二轮：把工具结果拼回去再追问

agent loop 的代码把 `1081` 包成 tool_result 拼回 messages，下一轮 POST 时这段历史一起送过去。模型于是"看见"了上一步发生的事情。

@include(./run-log.txt, round=2)

> 第二轮 `tool_use_id` 又是新的——同色高亮帮你视觉化"调用-结果"的因果配对（与下一轮 user[tool_result] 颜色对照）。

### 6. 第三轮：end_turn，循环退出

模型不再调工具，给出最终答案。`stop_reason=end_turn`，下一句 `break` 跳出 for 循环。

@include(./run-log.txt, round=3)

### 7. dump 完整 messages 历史

最后一段把 messages 数组全打出来，你可以肉眼数：6 条消息（user / assistant / user / assistant / user / assistant）一字排开，刚好对应 3 轮 agent loop。

@include(./agent.ts, section=5)

@include(./run-log.txt, section="FINAL MESSAGES")

## 下一步

回到 `learn-everything/.learn/topics/agent-harness-engineering/` 让课程批改这次交付，然后等待 Task 02。
