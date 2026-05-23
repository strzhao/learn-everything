# Artifact 01：最小 Agent Loop

## 它做什么

**这是把 "agent" 这个看起来很玄的东西剥光到 75 行代码后的样子**——一个用 `fetch` 直接打 Anthropic Messages API、能多轮调用工具、终于让你亲眼看见 messages 数组怎么"长出来"的最小可运行实现。

不依赖任何 SDK、不做错误处理、不做流式响应、不做权限检查。只剩三件事：
1. 一个 `fetch` 调用循环
2. 一个 `messages` 数组（每轮往里 push assistant 响应 + user 的 tool_result）
3. 一个 `stop_reason !== "tool_use"` 的退出开关

跑一次后你会建立的物理直觉：agent loop 的"思考链"不是模型有记忆，而是客户端把上一轮的 `tool_use` 和算出来的 `tool_result` 拼回 `messages`，下一次 POST 把完整历史送过去——模型每一轮看到的都是新的、但带完整历史的请求。

## 怎么用

实际代码不在这里——它在练手工程 [[otter-project]]：

```
/Users/stringzhao/workspace_sync/personal_projects/Otter/tasks/01-minimal-agent-loop/
├── agent.ts        # 75 行 TypeScript，bun 直跑
├── README.md       # 详细的"学到了什么" 4 点（含工具 schema 设计哲学）
└── run-log.txt     # 真实跑通一次的完整 console 输出（含 thinking / text / tool_use / tool_result 全部 block）
```

跑法：
```bash
bun run /Users/stringzhao/workspace_sync/personal_projects/Otter/tasks/01-minimal-agent-loop/agent.ts
```

**前置**：`~/.claude-dev/settings.json` 里已配好 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_DEFAULT_HAIKU_MODEL`。Otter 工程统一从这里读，不维护单独的 `.env`。

## 与其他组件的关系

这是**首个** artifact（01-xxx），尚无依赖。但它是后续所有组件的物理基础：

- **后续 02 (待定)** 大概率扩展工具数量 + 加入错误处理 / permission gate，需要在本文件的 agent loop 骨架上演化
- **后续讲解 Tool.ts** 时，会把这里"硬编码的工具数组 + 一个执行函数"对照 Claude Code 中 `src/Tool.ts`（792 行）的工程化抽象，识别多出来的复杂度都在解决什么真实问题
- **后续讲解 QueryEngine.ts** 时，会把这里"75 行 for 循环"对照 Claude Code 的 `src/QueryEngine.ts`（1295 行），识别 streaming / 取消 / 重试 / 上下文压缩 / 并发工具调用 等十余种工程关注点是怎么一层层包到这个内核 if 上的

设计哲学（学生在 Task 01 README 里自行提炼出来的、值得记住的元规律）：**工具的能力边界，决定了 agent 的行为模式**——calculator schema 故意限制为二元运算 `{a, op, b}`，强制 "23×47+100" 必须分两轮调用。这种"协议层约束塑造行为"的思路在后续设计任何工具时都要复用。
