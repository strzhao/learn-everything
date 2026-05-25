# Task 06 Spec —— v6 Mini Hook Engine

下发日期：2026-05-25
父 topic：agent-harness-engineering
前置 artifact：[`05-context-compactor/`](../05-context-compactor/)
对照源码：`/Users/stringzhao/workspace/claude-code/src/utils/hooks.ts` (5022 行) + `src/utils/hooks/` (18 文件) + `src/types/hooks.ts` (290 行) + `src/entrypoints/sdk/coreTypes.ts:25-53` HOOK_EVENTS 27 项

---

## 任务定位

从 v5 的"compact 是独立 sub-system + maybeCompact 单点钩子"扩展为 v6 的"统一 hook 系统 + 4+ events + 多 handler 形态 + 失败容忍"。

**核心交付是一份可运行的 v6 mini hook engine**：把 Lecture 06 / Socratic 07 抽象的核心 distinction（**sub-system 是 in-process production-critical path 必须可靠 / hook 是 cross-cutting 旁路广播可以失败**）落到 ≤ 400 行代码 + 4 份真实 run-log（含失败 hook 不阻断核心）+ 教学叙事 lesson.md。

这是 create 层第四次巩固：**v5 给出独立 sub-system 钩子 → v6 把钩子通用化为 emit/registry/handler 三层抽象**，permission / compact / observability 都能走同一机制。

---

## 4 条核心要点（Socratic 07 已确认）

1. **Hook 替代 sub-system 的隐患**（Q1）：sub-system 是 in-process critical path（permission gate 必须可靠拦 / compact 必须保证 messages 合法），hook 是 cross-cutting 旁路（可失败 / 可超时 / 可不在线）。两者职责不同，hook 不能替代 sub-system
2. **sub-system 入口 vs hook emit point**（Q2）：v5 `maybeCompact` 是 **sub-system 入口**（compact 真正发生地）；工业 `PreCompact`/`PostCompact` 是 **sub-system 内部 emit 的 event**（让 hook 系统旁路观察 compact 事件）—— 两者**叠加而非替代**，hook 不替代 sub-system 的核心动作
3. **27 个 HOOK_EVENTS**（事实证据）：claude-code `entrypoints/sdk/coreTypes.ts:25-53` 字面量 27 项，包括工具周期 / 用户交互 / 会话生命周期 / subagent 生命周期 / PreCompact PostCompact / permission / 外部 worktree / config / file changes 等
4. **3 种 handler 执行形态**：execAgentHook（多轮 LLM agent 验证条件，60s timeout）/ execHttpHook（POST 外部端点 + SSRF guard 防云元数据 IP，10min timeout）/ execPromptHook（单轮 LLM 询问，30s timeout，要求 JSON `{ok, reason}` 返回）

---

## v6 必须实现的 hook 系统

### 注册中心

```ts
type HookEvent = "PreToolUse" | "PostToolUse" | "PreCompact" | "PostCompact"; // 至少 4 种，v6 教学子集
type HookHandler = FunctionHandler | PromptHandler | HttpHandler;  // 3 种执行形态

class HookRegistry {
  private hooks = new Map<HookEvent, HookHandler[]>();  // 对照工业 AsyncHookRegistry.ts:28 Map 数据结构
  register(event: HookEvent, handler: HookHandler): void;
  async emit(event: HookEvent, ctx: any): Promise<HookOutcome[]>;
}
```

**关键约束**：`emit` 用 **`Promise.allSettled`** 隔离单个 handler 失败 —— 对照工业 `AsyncHookRegistry.ts:144` `await Promise.allSettled(hooks.map(...))`。一个 handler 抛错不影响其他 handler，更不阻断核心 sub-system。

### Handler 形态

| 形态 | v6 简化 | 工业对照 |
|---|---|---|
| **FunctionHandler** | `{ kind: "function", fn: (ctx) => Promise<HookOutcome> }` | （v6 新增的最简形态 - in-process JS function）|
| **PromptHandler** | `{ kind: "prompt", prompt: string }` —— 调一次 LLM，传 system prompt 要求返回 JSON `{ok, reason?}` | `execPromptHook.ts:21-30` 30s timeout / 单轮 LLM / JSON 返回 |
| **HttpHandler**（可选）| `{ kind: "http", url: string }` —— 用 fetch POST + 简化 SSRF guard | `execHttpHook.ts:123-150` + `ssrfGuard.ts:5-40` 阻 0.0.0.0/8、10.0.0.0/8、169.254.0.0/16 等私有 IP |

**至少实现 Function + Prompt 两种**，Http 可选（带简化 SSRF guard：禁用 `localhost`、`127.*`、`10.*`、`169.254.*`、`172.16-31.*`、`192.168.*` 这些字面量字符串前缀检查）。

### 失败容忍策略

- handler 抛错：catch + log audit + 返回 `{ outcome: "non_blocking_error", error }` —— 对照工业 `outcome: 'non_blocking_error'` 字面量
- handler 超时：每个 handler 用 `Promise.race([fn(), timeout])`，超时返回同上
- emit 调用方（dispatch / maybeCompact）**永不 throw** —— 核心 sub-system 跟 hook 失败完全解耦

---

## 4 个 hook event 在 v5 dispatch / compact 哪里 emit

### PreToolUse / PostToolUse

`dispatch(name, input, mode, role, askFn, spawnFn)` 内部：
- 执行 modeMatrix 判决之前：`await hooks.emit("PreToolUse", { tool, input, mode, role })`
- execute 返回之后：`await hooks.emit("PostToolUse", { tool, input, result, mode, role })`

emit 是 fire-and-forget 风格 —— **结果用于 audit / observability，不影响 dispatch 决策**。这与工业 `executePreToolHooks` (`hooks.ts:3410-3436`) 是 async generator yield 结果但不阻塞 critical path 同形态。

### PreCompact / PostCompact

`maybeCompact(messages, role, system)` 内部：
- 触发 fullCompact 之前：`await hooks.emit("PreCompact", { messages, rounds, role })`
- fullCompact 返回后：`await hooks.emit("PostCompact", { before, after, summary, role })`

PreCompact 不可阻止 compact 真正发生（**sub-system 必须可靠**）—— 这正是 Socratic 07 Q2 内化的"两者叠加不替代"原则的代码体现。

---

## 步骤

### 步骤 0：源码定位（10 分钟）

```bash
ls /Users/stringzhao/workspace/claude-code/src/utils/hooks/
# AsyncHookRegistry.ts (8.7K)  execAgentHook.ts (12.2K)  execHttpHook.ts (8.7K)
# execPromptHook.ts (6.7K)  ssrfGuard.ts (8.5K)  hookEvents.ts (4.4K)  ...
```

**重点读**：
- `AsyncHookRegistry.ts` 全文（8.7K，含 `Map<processId, PendingAsyncHook>` + `checkForAsyncHookResponses` + `Promise.allSettled`）
- `execPromptHook.ts:21-30` 函数签名
- `execHttpHook.ts:123-150` 函数签名
- `ssrfGuard.ts:5-40` IP block 列表 + `:216-283` lookup 签名
- `entrypoints/sdk/coreTypes.ts:25-53` HOOK_EVENTS 27 项

把"我读懂了什么 / 工业版与 v6 简化版的差异表"写在 notes.md 第 1 节。

### 步骤 1：写 v6 代码

按 §"v6 代码切段约束"组织。

### 步骤 2：跑 4 份真实 run-log

按 §"Run-log 约束"。

### 步骤 3：写 notes.md（4 条要点对照 + 失败实测）

每条要点产出：
- 工业源码引用（file:line）+ v6 对应代码段 + 推理链
- 第 5 节"失败容忍实测"：故意让一个 hook 抛错 / 超时，证明 (a) 其他 hook 继续；(b) 核心 sub-system 完成；(c) audit 完整记录失败
- 第 6 节"hook vs sub-system 边界判断准则"：什么应该放 hook，什么必须留 sub-system —— 教学化 Socratic 07 Q1 的判定标准
- 第 7 节"写回 v5 的扩展点"：v5 中哪些点应该改造成 hook emit

### 步骤 4：写 lesson.md（agent-notebook 入口）

按 §"agent-notebook 高质量消费"，14-16 段叙事。

---

## v6 代码切段约束

`agent-v6-hook-engine.ts` 在 v5 基础上扩展。按教学叙事顺序切段，每段一个 `// ---------- N. <段名> ----------` 标记。建议 11 段：

1. `1. Role + Mode + Compact 配置（v5 继承）`
2. `2. Hard-block + Mode 矩阵（v5 继承）`
3. `3. Tools schema by role（v5 继承）`
4. `4. Ask 转发通道 + audit + estimateBytes（v5 继承）`
5. `5. Dispatch + execute + runRounds（v5 继承 + 内部新增 PreToolUse/PostToolUse emit）`
6. `6. groupByRound + microCompact（v5 继承）`
7. `7. fullCompact + maybeCompact（v5 继承 + 内部新增 PreCompact/PostCompact emit）`
8. `8. HookRegistry：注册中心 + Map<event, handler[]> + emit Promise.allSettled`
9. `9. Handler 形态：Function / Prompt / Http（含简化 SSRF guard）`
10. `10. 三个 runLoop（v5 继承）`
11. `11. 配置 + callModel + 启动入口 + 默认 hook 注册`

每段独立可读。

---

## Run-log 约束

至少 **4 份真实运行日志**：

| 文件 | 场景 |
|---|---|
| `run-log-no-hooks.txt` | 不注册任何 hook —— baseline，证明 v6 向下兼容 v5（行为完全相同）|
| `run-log-pre-post-tool.txt` | 注册 1 个 Function PreToolUse hook + 1 个 Function PostToolUse hook，跑长任务，观察 emit 顺序 + ctx payload |
| `run-log-pre-post-compact.txt` | 注册 PreCompact + PostCompact hook，跑长任务触发 fullCompact，看 hook 在 compact 前后各调一次 |
| `run-log-failing-hook.txt` | 注册 1 个故意抛错的 Function hook + 1 个故意 timeout 的 hook + 1 个正常 hook，验证：(a) 正常 hook 仍执行；(b) 核心 dispatch / compact 完成；(c) audit 完整记录 |

每份 run-log：
- `========== ROUND N stop_reason=X ==========` 切片
- `========== FINAL MESSAGES ==========` 段
- hook 触发时多 `[HOOK event=X handler=Y outcome=Z]` audit 行（写到 stderr）
- 失败场景多 `[HOOK event=X handler=Y outcome=non_blocking_error error=...]` 行

---

## agent-notebook 高质量消费（硬约束）

打开 http://localhost:3737/?task=06-hook-engine 应该能从开篇看到结尾独立讲完 v6 设计。

### lesson.md 16 段叙事

1. **开篇**（H1 + 段落）：从 v5 maybeCompact 单点钩子切入 —— "compact 是独立 sub-system 是一回事，但所有 cross-cutting concern 都要这样写吗？"
2. **Sub-system vs hook 边界**（H2 + 表格）：production-critical path vs 旁路广播
3. **27 个工业 HOOK_EVENTS** + v6 教学子集 4 项：`@include(./excerpts.md, section="HOOK_EVENTS")` 或 inline 列表
4. **HookRegistry 数据结构**：`@include(./agent-v6-hook-engine.ts, section=8)` + 解读 Map<event, handler[]>
5. **3 种 handler 形态**：`@include(./agent-v6-hook-engine.ts, section=9)` + 各自语义
6. **Function handler 示例**：解读 v6 默认注册的几个 function hook
7. **Prompt handler 示例**：解读 LLM 询问"该不该继续 / 操作合规吗"
8. **失败容忍**：`Promise.allSettled` + try-catch + outcome 字段
9. **PreToolUse / PostToolUse emit 位置**：`@include(./agent-v6-hook-engine.ts, section=5)` 看 dispatch 哪几行加 emit
10. **PreCompact / PostCompact emit 位置**：`@include(./agent-v6-hook-engine.ts, section=7)` 看 maybeCompact 哪几行加 emit
11. **场景 A：no-hooks baseline**：`@include(./run-log-no-hooks.txt, round=1)` + 验证向下兼容
12. **场景 B：PreToolUse + PostToolUse 触发**：`@include(./run-log-pre-post-tool.txt, round=1)` + emit 顺序观察
13. **场景 C：PreCompact + PostCompact 触发**：`@include(./run-log-pre-post-compact.txt, round=N)` + compact 前后 hook 各调
14. **场景 D：故障 hook 不阻断核心**：`@include(./run-log-failing-hook.txt, round=N)` —— **教学黄金**：核心 sub-system 完成、其他 hook 仍执行、audit 完整
15. **4 条要点对照工业实现**（H2 + 列表）
16. **写回 v5 的扩展点 + 进入 Lecture 07 的钩子**（H2 + 列表）

### Markdown 子集

H1-H3 / 段落 / 无序列表 / `inline code` / `**bold**` / GFM 表格 / fenced code block。不能用 mermaid。

---

## 交付清单

| 文件 | 角色 |
|---|---|
| `agent-v6-hook-engine.ts` | **核心产出**：v6 实现，≤ 400 行，严格切 11 段 |
| `lesson.md` | **核心产出**：agent-notebook 入口，16 段叙事 |
| `run-log-no-hooks.txt` | baseline，无注册 |
| `run-log-pre-post-tool.txt` | 工具周期 hook 触发 |
| `run-log-pre-post-compact.txt` | compact 周期 hook 触发 |
| `run-log-failing-hook.txt` | 故障 hook 不阻断核心（教学黄金）|
| `notes.md` | 7 节深度分析（源码定位 / 4 要点对照 / 失败容忍实测 / hook vs sub-system 判定准则 / v5 改进意见 / 一句话总结）≥ 1200 字 |
| `excerpts.md` | claude-code hook 系统 6+ 段源码引用带 file:line |
| `README.md` | 三段式 |
| `spec.md` | 本文件 |

---

## 约束

- **必须真实运行**：4 份 run-log 都是 v6 真实跑出来的，不能手写
- 所有 destructive 工具仍 mock
- `agent-v6-hook-engine.ts` ≤ 400 行
- 用 `fetch` 直打 Anthropic 协议
- 沿用 `~/.claude-dev/settings.json` deepseek endpoint
- **不修改 v5 dispatch / role / compact 任何核心逻辑**，只新增 §8/§9 两段 + 在 §5 dispatch / §7 maybeCompact 内部加 emit 调用点 —— 验证 socratic 07 Q2 "hook 是叠加不替代"原则
- hook handler 失败必须 catch + audit，**永不上抛** —— 验证 socratic 07 Q1 "hook 可失败 / sub-system 必须可靠"
- emit 用 `Promise.allSettled`（不能用 `Promise.all`，否则单 handler 失败会让整批 reject）
- 至少 1 个 Function handler + 1 个 Prompt handler 真实跑通；Http handler 可选
- `outcome: "non_blocking_error"` 字面量必须出现在 audit 行（致敬工业字面量）

---

## 验收标准

1. v6 严格切 11 段（`grep -c "^// ----------"` = 11）
2. 4 份 run-log 每份都有 ROUND + FINAL MESSAGES
3. lesson.md 在 agent-notebook 打开后无红色错误块
4. `run-log-pre-post-tool.txt` 含 `[HOOK event=PreToolUse` + `[HOOK event=PostToolUse` 字面量
5. `run-log-pre-post-compact.txt` 含 `[HOOK event=PreCompact` + `[HOOK event=PostCompact` 字面量
6. `run-log-failing-hook.txt` 含 `outcome=non_blocking_error` 字面量 **且** ROUND 仍正常完成（核心未被阻断）
7. notes.md 4 条要点全部判决 + 论证（≥ 1200 字）
8. emit 调用方（dispatch / maybeCompact）从未因 hook 失败而 throw —— 代码中 grep `try.*await.*emit` 应能找到防御性 catch

---

## 完成后

- artifact_count: 5 → 6
- bloom_level 保持 `create`（第四次巩固）
- 更新 INDEX.md、写 journal accept 条
- 下一步：**Lecture 07** —— Observability / Streaming / MCP 协议 中选其一

---

## 验证方法

- `wc -l artifacts/06-hook-engine/agent-v6-hook-engine.ts` ≤ 400
- `grep -c "^// ----------" artifacts/06-hook-engine/agent-v6-hook-engine.ts` = 11
- `ls artifacts/06-hook-engine/run-log-*.txt | wc -l` ≥ 4
- 每份 run-log: `grep -c "^========== ROUND" *.txt` ≥ 1
- `grep -l "outcome=non_blocking_error" artifacts/06-hook-engine/run-log-*.txt` = `run-log-failing-hook.txt`
- `grep -E "HOOK event=(PreToolUse|PostToolUse|PreCompact|PostCompact)" run-log-*.txt | wc -l` ≥ 4
- `~/.bun/bin/bun run tools/agent-notebook/server.ts artifacts/06-hook-engine/` → 浏览器无红色错误块
