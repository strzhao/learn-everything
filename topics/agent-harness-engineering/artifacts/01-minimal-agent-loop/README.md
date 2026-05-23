# Task 01：最小 Agent Loop

> 75 行 TypeScript，不依赖任何 SDK，从 0 到 1 跑通一个能多轮调用工具的 agent。

## 是什么

agent-harness-engineering topic 的第一个 artifact，目标是**让你亲手看见 "agent" 在物理层面到底由什么构成**。

> agent loop = `fetch` + `messages` 拼接 + `while`，仅此而已。

我们不用 `@anthropic-ai/sdk`、不用任何抽象类、不做错误处理、不做流式响应。
所有"魔法"都被剥光，剩下一个 75 行的纯 TypeScript 文件，每一行都对应一个明确的概念。

跑完一次后，你应该能凭印象画出：
1. HTTP 请求/响应的真实形状（model、messages、tools、content blocks、stop_reason）
2. tool_use 出现后，下一轮 `messages` 数组是怎么"长出来"的
3. 循环什么时候停下

## 怎么跑

**前置**：`~/.claude-dev/settings.json` 已经配好了 API（本机直接用，无需自己配 `.env`）。

```bash
bun run topics/agent-harness-engineering/artifacts/01-minimal-agent-loop/agent.ts
```

或者用 agent-notebook 工具看交互式 lesson 视图：

```bash
bun run tools/agent-notebook/server.ts \
  topics/agent-harness-engineering/artifacts/01-minimal-agent-loop/
```

完整输出已经存在 [`run-log.txt`](./run-log.txt)，每次会有微小差异（模型 thinking 的措辞），但骨架始终是：

```
========== ROUND 1  stop_reason=tool_use ==========
  → tool_use {a:23, op:"*", b:47}
========== ROUND 2  stop_reason=tool_use ==========
  → tool_use {a:1081, op:"+", b:100}
========== ROUND 3  stop_reason=end_turn ==========
  → 最终结果：1181
========== FINAL MESSAGES ==========
  → 6 条消息历史完整 dump
```

## 学到了什么

### 1. harness 不是 SDK，是协议 + 拼接

整个 agent 只用了 `fetch`、`JSON.stringify`、`Bun.file`、一个 `for` 循环。
SDK 把这些封装得很好看，但封装的代价是你看不见 messages 数组在每一轮怎么变化。
**先手写一遍，再用 SDK，才不会被抽象绑架。**

### 2. tool_result 必须拼回 messages —— 这就是 agent "看起来在思考" 的物理来源

模型本身是无状态的。每一轮请求都重新发送**完整的 messages 历史**给 API。
所谓 "agent 看见了工具结果"，本质就是你在客户端把上一轮的 `tool_use` 和算出来的 `tool_result` 拼进 `messages`，
然后下一轮 POST 时这段历史会一起送过去。

如果你忘了拼回 `tool_result`，模型在下一轮就像得了失忆症 —— 看不见上一步发生了什么。
这就是 `agent.ts` 第 60-72 行做的唯一一件"非平凡"的事情。

### 3. `stop_reason === "tool_use"` 是循环的唯一开关

Anthropic 协议规定：当模型决定调用工具时，响应里 `stop_reason: "tool_use"`；否则是 `end_turn` / `max_tokens` / `stop_sequence`。
所以 agent loop 的 while 条件其实就一行：

```ts
if (res.stop_reason !== "tool_use") break;
```

整个 Claude Code 的 `QueryEngine.ts`（1295 行）解决的核心问题，就是把这个 while 循环周边的各种复杂度（取消、并发、权限、上下文压缩、流式）一层层包起来。
但内核还是这个 if。

### 4. 协议约束塑造行为：calculator 工具的小心机

注意 tool schema 只允许 `{a, op, b}` 二元运算。
这不是写不出来，而是**故意**这么设计 —— 它让 "23 × 47 + 100" 必须分两轮调用。
如果允许 `expression: string`，模型可能一次就算完，你就观察不到多轮 tool_use 的现象了。

> 工具的能力边界，决定了 agent 的行为模式。这是后续设计任何工具时都要记住的元规律。

## 与其他组件的关系（在课程中的位置）

这是 agent-harness-engineering topic 的**首个** artifact（01-xxx），尚无依赖。但它是后续所有组件的物理基础：

- **02-permission-gate**（已在仓）—— 把单工具 calculator 替换成 `delete_file`，引入 ask_user / dispatch gate 双层 permission，让"工具可以拒绝执行"成为一等概念
- **后续讲解 Tool.ts** 时，会把这里"硬编码的工具数组 + 一个执行函数"对照 Claude Code 中 `src/Tool.ts`（792 行）的工程化抽象，识别多出来的复杂度都在解决什么真实问题
- **后续讲解 QueryEngine.ts** 时，会把这里"75 行 for 循环"对照 Claude Code 的 `src/QueryEngine.ts`（1295 行），识别 streaming / 取消 / 重试 / 上下文压缩 / 并发工具调用 等十余种工程关注点是怎么一层层包到这个内核 if 上的

## 下一步

回到 `learn-everything/topics/agent-harness-engineering/` 让课程继续推进。
