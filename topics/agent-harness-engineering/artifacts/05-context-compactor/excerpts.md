# excerpts —— claude-code compact 子系统关键源码

> 备查文档。所有片段来自本机 `/Users/stringzhao/workspace/claude-code/src/services/compact/` 工作副本。
> notes.md 的 4 条要点对照按需引用本文片段。

---

## §1. groupMessagesByApiRound —— API round 分组（推论 1：round 原子单位）

**文件**：`src/services/compact/grouping.ts:22-63`

```ts
export function groupMessagesByApiRound(messages: Message[]): Message[][] {
  const groups: Message[][] = []
  let current: Message[] = []
  // message.id of the most recently seen assistant. This is the sole
  // boundary gate: streaming chunks from the same API response share an
  // id, so boundaries only fire at the start of a genuinely new round.
  let lastAssistantId: string | undefined

  // In a well-formed conversation the API contract guarantees every
  // tool_use is resolved before the next assistant turn, so lastAssistantId
  // alone is a sufficient boundary gate.
  for (const msg of messages) {
    if (
      msg.type === 'assistant' &&
      msg.message.id !== lastAssistantId &&
      current.length > 0
    ) {
      groups.push(current)
      current = [msg]
    } else {
      current.push(msg)
    }
    if (msg.type === 'assistant') {
      lastAssistantId = msg.message.id
    }
  }

  if (current.length > 0) {
    groups.push(current)
  }
  return groups
}
```

**关键**：边界 = `assistant.message.id` 变化。注释明说 *"the API contract guarantees every tool_use is resolved before the next assistant turn"* —— 这就是 Socratic 06 Q1 收紧验证的 round 原子性来源。v5 简化版用"assistant 出现就切分"，等价（因为 v5 单次响应不分块）。

---

## §2. TIME_BASED_MC_CLEARED_MESSAGE 字面量（推论 2：事实≠原文）

**文件**：`src/services/compact/microCompact.ts:36`

```ts
export const TIME_BASED_MC_CLEARED_MESSAGE = '[Old tool result content cleared]'
```

**文件**：`src/services/compact/microCompact.ts:40-50`

```ts
// Only compact these tools
const COMPACTABLE_TOOLS = new Set<string>([
  FILE_READ_TOOL_NAME,
  ...SHELL_TOOL_NAMES,
  GREP_TOOL_NAME,
  GLOB_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
])
```

**关键**：字面量 `'[Old tool result content cleared]'` 直接被 v5 引用（`CLEARED_MARKER` 常量同字面量）—— 这是 microCompact 的语义本质：保留 tool_use 占位（让 model 知道"调用过"），但清空 result 内容（"事实已融入 reasoning text，原文是冷状态"）。`COMPACTABLE_TOOLS` 白名单只清"内容大、可重读"的工具（read/grep/bash 等），不清需要保持精确 result 的工具。v5 简化为"所有 tool_result 都按字节阈值压"，没分工具类型。

---

## §3. NO_TOOLS_PREAMBLE —— 专用 compaction LLM call 的 prompt（推论 3）

**文件**：`src/services/compact/prompt.ts:19-26`

```ts
// Aggressive no-tools preamble. The cache-sharing fork path inherits the
// parent's full tool set (required for cache-key match), and on Sonnet 4.6+
// adaptive-thinking models the model sometimes attempts a tool call despite
// the weaker trailer instruction. With maxTurns: 1, a denied tool call means
// no text output → falls through to the streaming fallback (2.79% on 4.6 vs
// 0.01% on 4.5). Putting this FIRST and making it explicit about rejection
// consequences prevents the wasted turn.
const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`
```

**关键**：注释解释了 *为什么* NO_TOOLS_PREAMBLE 必须放 prompt 最前面 —— 工业 compaction LLM call 的痛苦经验：即使 `maxTurns: 1`，model 仍可能尝试调用工具浪费这唯一一次机会，导致整个 compact 失败。v5 用同样精神：`NO_TOOLS_PREAMBLE` 常量在 fullCompact 里作为 system prompt，**且** `callModel(compactionMessages, NO_TOOLS_PREAMBLE, [])` 第三参数 **空 tools 数组** —— 双层保险（prompt 警告 + 物理移除）。

---

## §4. autoCompact 触发：三层阈值 + 熔断器

**文件**：`src/services/compact/autoCompact.ts:62-76`

```ts
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000
// ...
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3
// ...
export function getAutoCompactThreshold(model: string): number {
  const effectiveContextWindow = getEffectiveContextWindowSize(model)
  const autocompactThreshold =
    effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS
  // ...
}
```

**关键**：工业实现的两个生产级设计 v5 都简化了：

- **三层阈值（autoCompact / warning / error）**：v5 用 1 个静态阈值 (`MAX_ROUNDS_BEFORE_FULL_COMPACT = 4`)，工业按 token 推算动态阈值并预留 13K buffer
- **熔断器（MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3）**：连续 3 次 compact 失败就当轮停止，防止"compact 自身消耗光预算"的死循环 —— v5 没实现，notes.md §6 失败模式记录为 ⬛ 待补

v5 教学简化是合理的（4 round 阈值方便观察触发），但 production 必须这两条保险。

---

## §5. shouldAutoCompact 跳过 subagent 防递归（推论 4：multi-agent compact 隔离）

**文件**：`src/services/compact/autoCompact.ts:160-239`（关键片段 ≈ line 200）

```ts
// 防止 compact 自身的子 agent 触发 compact —— 否则递归死锁
if (querySource === 'session_memory' ||
    querySource === 'compact' ||
    querySource === 'marble_origami') {
  return false  // 这些子代理不触发 compact
}
```

**关键**：工业实现禁止 compact 子代理自己也触发 compact —— 因为 compact 本身就是一次 LLM call，如果 compact LLM call 又因为它自己的 context 大触发 compact，会无限递归。v5 不需要这个判断（v5 fullCompact 直接 await callModel，不构造 sub-agent），但 multi-agent 场景下的同精神在 `postCompactCleanup.ts:31-39` 体现 —— 区分主线程 vs subagent 决定清理范围。

---

## §6. postCompactCleanup 区分主线程 vs subagent

**文件**：`src/services/compact/postCompactCleanup.ts:31-39`（全 77 行短文件）

```ts
const isMainThreadCompact =
  querySource === undefined ||
  querySource.startsWith('repl_main_thread') ||
  querySource === 'sdk'

// ...

if (isMainThreadCompact) {
  resetContextCollapse()  // 仅主线程重置 context-collapse 状态
}
if (isMainThreadCompact) {
  getUserContext.cache.clear?.()
  resetGetMemoryFilesCache('compact')
}
clearSystemPromptSections()  // 全线程清
clearClassifierApprovals()   // 全线程清
clearSpeculativeChecks()     // 全线程清
clearBetaTracingState()      // 全线程清
```

**关键**：post-compact 清 6 类缓存，但有些**只在主线程**清。subagent compact 不重置全局状态 —— **防止 swarm 内部 compact 污染主线程 coordinator state**。这是 Socratic 06 Q4 收紧验证的"隔离原则跨维度延伸"的工业实现：context 隔离不只在 messages 数组层，也在 compact 副作用层。v5 简化版没有跨进程缓存层（单进程闭包），但**每个 role 独立 messages 数组 + maybeCompact 只动当前数组**已经体现同精神：swarm compact 只影响自己的 messages，coordinator 不感知。

---

## §7. 工业 4 个 compact 变体（粒度分层 / 优先级链）

`src/services/compact/` 目录文件大小（grep 结果）：

```
compact.ts             59.4K (1705 行)  ← 重量级 fullCompact，调专用 LLM call
sessionMemoryCompact.ts 20.6K  (630 行)  ← 跨 session 持久化记忆压缩
microCompact.ts        19.1K  (530 行)  ← 单 tool_result 替换
autoCompact.ts         12.6K  (351 行)  ← 调度入口 + 阈值检查 + 熔断
apiMicrocompact.ts      4.9K  (153 行)  ← API 原生 context management（如 clear_thinking_20251015）
prompt.ts              15.9K  (374 行)  ← compaction LLM call 的 prompt 模板
grouping.ts             2.7K   (63 行)  ← round 边界分组（§1）
postCompactCleanup.ts   3.7K   (77 行)  ← 清 6 类缓存（§6）
```

**关键**：4 个粒度变体（micro / sessionMemory / fullCompact / apiMicrocompact）是**优先级链**：autoCompact.ts 调度入口先试 sessionMemory（最便宜，复用已存的）→ 命中跳过；未命中试 micro（清老 tool_result，无 LLM call）→ 仍超阈值上 fullCompact（调 LLM）→ 仍超阈值上 apiMicrocompact（API 原生 vendor 端清理）。**从小到大、便宜到贵、保留多到保留少**。同 v3 mode 矩阵的有序 if 链 + 早返回设计模式。

v5 实现 2 种（micro + full），按同样的优先级链：`maybeCompact` 先调 microCompact，再检查阈值决定是否 fullCompact。
