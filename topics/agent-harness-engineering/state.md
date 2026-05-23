---
topic: 构建 AI Agent Harness（以 Claude Code 为参照系，从 0 到 1）
slug: agent-harness-engineering
status: active
stuck_count: 0
created_at: 2026-05-21T06:50:43+00:00
updated_at: 2026-05-21T10:30:00+00:00
bloom_level: apply
artifact_count: 1
---

## 当前位置

学生通过 socratic 02，进入 **apply** 层（仍在）+ analyze 层苗头（permission 设计哲学）。Task 02 已下发，等待交付。

**已掌握概念**：
1. harness ≠ LLM API call
2. agent loop 三角骨架（tool call + context + while）
3. 观察→反馈→决策闭环（tool_result 拼回 messages）
4. stop_reason === "tool_use" 是循环的唯一开关
5. 协议约束塑造行为（calculator 二元运算 schema 强制多轮）
6. **Tool = schema + executor + permission 三件套**（permission 缺席是默认 always-allow）
7. **production permission 必须双层**：
   - 第一层（harness 强制 gate）：dispatch 阶段无条件拦截，不依赖 model 自觉
   - 第二层（model 主动 ask 工具）：model 协作澄清意图，依赖 model 自觉
   - 两层正交、必须并存

**学生 Socratic 02 的洞察盲点**（已通过教学补丁补充）：
- Q1 漏了：(a) tool executor 抛异常时 agent loop 崩溃；(b) 多步组合攻击 permission gate 需要 inter-call 上下文；(c) path traversal
- Q2 漏了：把"ask 工具"和"harness 强制 gate"合并成一层——production harness 必须双层

**已完成 artifact**：
- `01-minimal-agent-loop` —— 75 行最小 fetch agent loop（calculator 强制 2 轮 tool_use）

**Task 02 下发**（等待交付）：
- 工程位置：`Otter/tasks/02-permission-gate/`
- 三件交付物：`agent-v1-ask-tool.ts`（model 主动 ask 版）+ `agent-v2-harness-gate.ts`（dispatch 强制拦截版）+ `notes.md`（对比报告）
- 安全约束：delete_file executor mock，不真删
- 行数约束：每个 agent-vX.ts ≤ 100 行
- 关键学习目标：让学生亲眼看见两个版本下模型行为差异，体感 "permission 不能只靠 model 自觉" 的工程理由

## 下一步建议

**等学生交付 Task 02 后**：
- 检查 v1 是否真的复现了"模型可能不调 ask 直接 delete"的现象
- 检查 v2 是否正确实现了 dispatch 拦截 + tool_result `is_error: true` + 模型在下一轮的自适应响应
- 检查 notes.md 第 4 题（关于 `bypassPermissions` 模式的开放猜测）是否展现了 evaluate 层思考

**Task 02 accept 后**：
- 进入 **Task 03：对照阅读 `claude-code/src/hooks/toolPermission/` 子系统源码**，把自己写的两版 permission gate 跟工业级实现做对比
- 或先插一段 **lecture 03**：讲 permission mode 的设计空间（`default | plan | bypassPermissions | auto`），把 Anthropic 在多次访谈/技术博客中阐述的"sandbox + permission"哲学引入

## 卡点记录

（暂无卡点）
