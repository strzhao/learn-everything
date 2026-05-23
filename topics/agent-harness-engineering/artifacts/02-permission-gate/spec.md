# Task 02 — permission gate（双版本对比）

## 学习目标

亲眼看见两种 permission 实现的行为差异：
- **v1**（依赖 model 自觉调 `ask_user`）→ 模型可能跳过 ask 直接 delete 的现象
- **v2**（dispatch 强制拦截 + `is_error: true` 反馈）→ 模型对 harness 拒绝信号的自适应响应

形成"production permission 必须双层正交（harness gate + ask tool）"的工程体感，为后续读 `claude-code/src/hooks/toolPermission/` 源码建立锚点。

## 交付清单

- [ ] `agent-v1-ask-tool.ts` — 暴露 `delete_file` + `ask_user` 两个工具，依赖 model **先调 ask 后 delete**
- [ ] `agent-v2-harness-gate.ts` — 只暴露 `delete_file`，dispatch 阶段强制 readline 询问，拒绝时 tool_result `is_error: true` 拼回
- [ ] `notes.md` — 对比报告（含真实 messages 片段）

## 硬约束

沿用 Otter 全工程约束（详见 `Otter/CLAUDE.md`）：

- **禁 SDK**：fetch 直打 `https://api.anthropic.com/v1/messages`
- **共享配置**：API key 读 `../../settings.json`（不维护 .env）
- **bun 无配置直跑**：`bun run agent-v1-ask-tool.ts` 即可
- **model**：`claude-haiku-4-5-20251001`

任务专属约束：

- **安全 mock**：`delete_file` executor 必须 mock，仅 `console.log("[MOCK] would rm -rf ${path}")`，**绝不真删**
- **行数约束**：每个 `agent-vX.ts` ≤ 100 行（force minimal core）
- **真实 API**：不用 mock response，跑出真的 model 行为

## v1 关键设计点

- 工具集：`ask_user(question, default_action)` + `delete_file(path)`
- system prompt **引导**模型"删除前先 ask"，但**不写硬规则**（"You must always..."）——观察 model 自觉性
- 用户输入硬编码：`"删除 /tmp/test1.txt 和 /tmp/test2.txt 这两个文件"`
- 至少跑 **2-3 次**（同一 prompt），观察 model 是否每次都先 ask

## v2 关键设计点

- 工具集：只有 `delete_file(path)`
- dispatch 拿到 `tool_use.name === "delete_file"` → **同步** readline 问用户 `Allow delete <path>? [y/N]`
- 用户 `N` → tool_result：`{ type: "tool_result", tool_use_id: ..., content: "User denied delete operation: <path>", is_error: true }`
- 至少跑一次：用户拒绝第一个文件、允许第二个，**观察 model 在拒绝后下一轮的响应**

## notes.md 必含

1. **v1 messages 关键片段**：贴出 model 在某一次跳过 ask 直接 delete 的那一轮（如出现）
2. **v2 messages 关键片段**：贴出 `is_error: true` 反馈后下一轮 model 的 response
3. **行为对比表**：v1 vs v2 在 (a) 用户控制力 (b) 可信度 (c) 实现复杂度 (d) 模型行为可预测性 四列上的对比
4. **判断（≥100 字）**：production harness 只走 v1 路线行不行？为什么？
5. **开放猜测**：Claude Code 的 `bypassPermissions` permission mode 可能是怎么实现的？（凭借你目前对 dispatch + tool_result 的理解推测，不要去看源码）

## 验收

三件交付物到位后，回到 learn-everything 仓库运行 `/learn 验收 Task 02`。

AI 验收时会重点看：
- v1 是否真的复现了"model 跳过 ask 直接 delete"现象（关键学习信号）
- v2 是否正确实现了 dispatch 拦截 + `is_error: true` + 模型自适应（看下一轮 messages）
- notes.md 第 4 题的判断是否触及 evaluate 层（不只是"v2 更好"这种廉价结论）
- notes.md 第 5 题的开放猜测是否合理（不要求答对，要求**有结构地推测**）
