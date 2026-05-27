# notes.md —— Task 05 对照报告

> Lecture 05 + Socratic 06 抽象出的 4 条 context compaction 设计要点 ↔ v5 代码 ↔ claude-code `src/services/compact/` 工业实现的对照报告。
>
> 4 条要点源自 Socratic 06 收紧后内化：(1) round 是原子单位；(2) 事实 ≠ 原文；(3) 专用 compaction LLM call；(4) 隔离原则跨维度延伸。v5 的 321 行代码不是凭空设计 —— 它是这 4 条要点 + Lecture 05 讲解的 3 个核心维度（WHEN / WHAT / HOW）+ 工业 4 个粒度变体（micro / sessionMemory / autoCompact / apiMicrocompact）的代码物理化。

---

## §1. 源码定位（步骤 0）

**结论**：claude-code `src/services/compact/` 子系统有 8 个文件、共 ~4000 行 TypeScript，结构清晰，4 条要点都能逐条对应到具体源码片段。

### 8 个文件 + 角色分工

| 文件 | 行数 | 角色 |
|---|---|---|
| `compact.ts` | 1705 | 重量级 fullCompact 主流程 + summary 插回 |
| `sessionMemoryCompact.ts` | 630 | 跨 session 持久化记忆压缩（autoCompact 前优先级最高） |
| `microCompact.ts` | 530 | 单个 tool_result 替换 + cached MC 状态机 |
| `prompt.ts` | 374 | 给 LLM 的 compaction prompt 模板 + `NO_TOOLS_PREAMBLE` |
| `autoCompact.ts` | 351 | 调度入口 + 三层阈值 + 熔断器 |
| `apiMicrocompact.ts` | 153 | API 原生 vendor 端 context management |
| `postCompactCleanup.ts` | 77 | 清 6 类缓存 + 区分主线程 vs subagent |
| `grouping.ts` | 63 | round 边界分组 |

### 关键 grep 命中（v5 直接引用）

- `groupMessagesByApiRound` — `grouping.ts:22`（v5 §6 `groupByRound` 简化对照）
- `TIME_BASED_MC_CLEARED_MESSAGE = '[Old tool result content cleared]'` — `microCompact.ts:36`（v5 §7 `CLEARED_MARKER` 字面量同）
- `NO_TOOLS_PREAMBLE` — `prompt.ts:19-26`（v5 §8 同形态常量）
- `AUTOCOMPACT_BUFFER_TOKENS = 13_000` + `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3` — `autoCompact.ts:62,70`（v5 阈值简化为静态 round 数）
- `isMainThreadCompact` — `postCompactCleanup.ts:31-39`（v5 通过"每 role 独立 messages 数组"实现同精神）

完整源码片段汇总在 [excerpts.md](./excerpts.md)，下文按需引用。

---

## §2. 4 条要点逐条对照

### 要点 1：round 是原子单位（tool_use 与 tool_result 协议捆绑）

**判定**：✅ **命中**

**v5 代码体现**：`agent-v5-context-compactor.ts` §6 `groupByRound`

```ts
function groupByRound(messages: any[]): any[][] {
  const groups: any[][] = [];
  let cur: any[] = [];
  for (const m of messages) {
    cur.push(m);
    if (m.role === "assistant") { groups.push(cur); cur = []; }
  }
  if (cur.length > 0) groups.push(cur);
  return groups;
}
```

**工业版**：[excerpts.md §1](./excerpts.md) — `grouping.ts:22-63`，用 `assistant.message.id` 变化作为边界（处理 streaming 分块同 id 不切的情况），但**核心边界规则一致**：每个新 assistant 启动一个新 round group。

**推理**：Socratic 06 Q1 收紧场景题已证明：如果 `messages[i]` 是 `assistant(tool_use_a)`、`messages[i+1]` 是 `user(tool_result_a)`，只压 `[i]` 不压 `[i+1]` → API 报错 `unexpected tool_use_id found in tool_result blocks: Each tool_result block must have a corresponding tool_use block in the previous message`。这正是 v5 **fullCompact 修复 bug** 的真实证据 —— 我第一版没考虑跨 round 边界的悬空 tool_result，第一次跑就被 API 拒了。修复后 v5 在 fullCompact 里加了 `firstValid` 跳过逻辑，专门处理 toKeep 开头悬空 tool_result（对应 tool_use 在 toCompact 段被压走了）。这条 bug 与修复本身就是要点 1 最直接的工程验证。

---

### 要点 2：事实 ≠ 原文（model reasoning text 已融入信息）

**判定**：✅ **命中**

**v5 代码体现**：`agent-v5-context-compactor.ts` §7 `microCompact` + 字面量 `CLEARED_MARKER`

```ts
const CLEARED_MARKER = "[Old tool result content cleared]";
// ...
block.content = CLEARED_MARKER;
```

**工业版**：[excerpts.md §2](./excerpts.md) — `microCompact.ts:36` `export const TIME_BASED_MC_CLEARED_MESSAGE = '[Old tool result content cleared]'` —— **字面量完全一致**（v5 直接引用工业版字符串作为致敬）。

**推理**：Socratic 06 Q2 收紧场景题 *"swarm[0] round 3 读 10KB / round 7 model 已 reasoning 融入 / round 30 compact"* 已内化：原文 10KB 是"冷状态"，model 后续推理输出已经把关键信息融入它自己的 text content。replace 为 `[Old tool result content cleared]` 保留 tool_use_id 占位（让 model 仍能看到"调用过 read_file"），但释放原文字节。v5 实测：run-log-micro-compact-triggered.txt 第 4 round 触发后 grep `Old tool result content cleared` = 1 次，释放 94 bytes。工业 `microCompact.ts:40-50` 用 `COMPACTABLE_TOOLS` 白名单（read/grep/bash/edit/write 等），只清"可重读 / 内容大"的工具；v5 简化为按字节阈值（`MIN_TOOL_RESULT_BYTES_TO_CLEAR = 30`）。

---

### 要点 3：专用 compaction LLM call（与主 loop 隔离）

**判定**：✅ **命中**（v5 + 工业版同形态）

**v5 代码体现**：`agent-v5-context-compactor.ts` §8 `fullCompact`

```ts
const NO_TOOLS_PREAMBLE = "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools. " +
  "You already have all context you need in the conversation above. " +
  "Tool calls will be REJECTED and waste your only turn. " +
  "Your entire response must be plain text: an <analysis> block followed by a <summary> block.";
// ...
const res = await callModel(compactionMessages, NO_TOOLS_PREAMBLE, []); // 空 tools 数组：物理禁工具
```

**工业版**：[excerpts.md §3](./excerpts.md) — `prompt.ts:19-26` `NO_TOOLS_PREAMBLE` 字面量同（v5 致敬简化版）。注释解释 *"on Sonnet 4.6+ adaptive-thinking models the model sometimes attempts a tool call despite the weaker trailer instruction. With maxTurns: 1, a denied tool call means no text output → falls through to the streaming fallback (2.79% on 4.6 vs 0.01% on 4.5)"* —— **工业实现踩过的痛苦经验**：即使 maxTurns=1，model 仍可能浪费唯一一次机会。所以 NO_TOOLS_PREAMBLE 必须**最先**出现 + **明确警告 rejection 后果**。

**推理**：Socratic 06 Q3 一次答对 *"专用 compaction LLM call"* 是关键认识。compaction 不是主 loop 的 model 推理副作用，是 harness 在主 loop 之外**主动调一次专用 LLM call**：传专用 system prompt（`NO_TOOLS_PREAMBLE` 禁工具）+ 传需要压缩的 messages 作为 user content + **传空 tools 数组**（双层保险：prompt 警告 + 物理移除）+ 获得 model 输出文本 + 解析 `<analysis>+<summary>` + 插回原 messages 数组。v5 实测 run-log-full-compact-triggered.txt 第 5 round 触发，messages 从 2335 bytes 压到 1854 bytes（释放 481 bytes），summary 包含详细的 `<analysis>` 和 `<summary>` 块。

---

### 要点 4：隔离原则跨维度延伸（swarm compact 不影响 coordinator）

**判定**：✅ **命中**（实测数据强证据）

**v5 代码体现**：`agent-v5-context-compactor.ts` §9 三个 runLoop 各自 `const messages: any[] = [...]` 局部声明，`maybeCompact(messages, role, system)` 只动当前 messages 引用，不跨 role 边界。

**工业版**：[excerpts.md §6](./excerpts.md) — `postCompactCleanup.ts:31-39`：

```ts
const isMainThreadCompact =
  querySource === undefined ||
  querySource.startsWith('repl_main_thread') ||
  querySource === 'sdk'

if (isMainThreadCompact) {
  resetContextCollapse()  // 仅主线程重置 context-collapse 状态
}
```

工业版按 querySource 区分主线程 vs subagent 决定哪些全局缓存要清。v5 简化为"每 role 独立 messages 数组"，但**同精神**。

**推理**：Socratic 06 Q4 收紧场景题 *"30 轮 + 80K tokens 的长任务 swarm"* 内化了 "compact 是普适机制 + swarm 内部 compact 独立不外泄"。v5 实测：`run-log-swarm-internal-compact.txt`：
- swarm[0] 内部在 round 4 + round 5 触发了 2 次 microCompact + 1 次 fullCompact（grep 见 LIFECYCLE 段内 3 个 COMPACT EVENT）
- swarm[0] FINAL MESSAGES 段（line 163）含 `COMPACTED SUMMARY` 字面量 ✅
- **coordinator FINAL MESSAGES 段（line 256+）完全不含 COMPACTED SUMMARY、不含 Old tool result content cleared、不含任何 swarm compact 痕迹** ✅
- coordinator 只看到 spawn_swarm 的 tool_result，content 是 swarm 返回的最终 summary 字符串

这是 v4 context 隔离原则在 compact 维度的完美延伸：swarm 内部状态 + swarm 内部 compact 事件 + swarm 内部 messages 历史，**三者都不外泄**到 coordinator messages 数组。

---

## §3. mode 矩阵 + compact 钩子的物理承载结构

```
                +-------------------------------+
                |  runRounds(messages, system,  |
                |    tools, mode, role, askFn,  |
                |    spawnFn, formatHeader)     |
                +-------------------------------+
                              |
                              v
                     for round = 1..8:
                              |
                              v
            +-----------------+------------------+
            |  callModel(messages, system, tools)|
            +-----------------+------------------+
                              |
                              v
                  push assistant content
                              |
                              v
            if stop_reason === "tool_use":
              +-----------------+
              | Promise.all(    |
              |  tool_use.map → |
              |  dispatch(...)  |
              |              )   |
              +-----------------+
                              |
                              v
                push user(tool_results)
                              |
                              v
              +-----------------+
              | await maybeCompact(messages, role, system)  ← 唯一介入点
              +-----------------+
                              |
                              v
                  +-----------+-----------+
                  | groupByRound(messages)|
                  +-----------+-----------+
                              |
                              v
                  +-----------+-----------+
                  | microCompact(messages)| ← 先试便宜的
                  +-----------+-----------+
                              |
                              v
                  if rounds.length > MAX:
                       +-------+-------+
                       | fullCompact   | ← 再试贵的（调专用 LLM）
                       +---------------+
                              |
                              v
                       next round...
```

**关键节点对照工业实现**：

- `runRounds` 末尾 `maybeCompact` 钩子 ↔ `autoCompact.ts:160-239` `shouldAutoCompact` + 在 query loop 中的调用点
- `maybeCompact` 优先级链（micro → full）↔ `autoCompactIfNeeded()` 优先 sessionMemoryCompact → microCompact → autoCompact → apiMicrocompact 的 4 级链
- `groupByRound` ↔ `grouping.ts:22-63`
- `microCompact` ↔ `microCompact.ts:36,40-50`
- `fullCompact` + `NO_TOOLS_PREAMBLE` ↔ `compact.ts:387-624` + `prompt.ts:19-26`

---

## §4. 推论之外的发现（spec § 第 4 节）

### 4.1 fullCompact 必须处理"悬空 tool_result"边界（v5 自己踩的坑）

v5 第一版 fullCompact 没考虑 toKeep 开头 user(tool_result) 对应的 tool_use 已被 toCompact 压走 —— 实测立刻 API 报错。修复加 `firstValid` 跳过逻辑。

**洞察**：要点 1 "round 原子单位"不只是分组时要考虑，**在保留边界也要考虑** —— 跨 compact 边界的 tool_use/tool_result 引用关系会断裂，必须主动清理。工业 `compact.ts` 有 `ensureToolResultPairing` 函数专门处理这个 (`grouping.ts:11-12` 注释提到 *"For malformed inputs the fork's ensureToolResultPairing repairs the split at API time"*)。

### 4.2 fullCompact 之后第一个 user message 角色冲突

v5 fullCompact 用 user role 装 `[COMPACTED SUMMARY]`，然后保留段（toKeep）通常也是 user(tool_result) 开头 —— 实测如果不跳过悬空 tool_result，会出现 user/user 相邻违反 API。

**洞察**：API 协议要求 user/assistant 严格交替，compact 边界既要维护协议又要保留语义连续性，是个微妙的边界条件。工业用 boundary marker + summary message + `isCompactSummary` flag 等多种 metadata 解决，v5 简化为字符串前缀 `[COMPACTED SUMMARY]` + 跳过悬空 tool_result。

### 4.3 compaction LLM call 本身的失败模式

v5 实测 run-log 显示有时 deepseek 在 fullCompact 后会出现：
- `stop_reason=undefined` —— 实际是 API 返回了 error object（v5 内部加了 `RAW RES` 调试输出捕获）
- compaction LLM 偶尔仍尝试调用工具（即使有 `NO_TOOLS_PREAMBLE` 警告 + 空 tools 数组）—— v5 用空 tools 数组物理拦住

**洞察**：production compaction LLM call 必须有"非常防御性"的实现 —— 工业 `prompt.ts:14-18` 注释 *"sometimes attempts a tool call despite the weaker trailer instruction"* 直接承认这点。`MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3` 熔断器就是为此存在的最后防线。

---

## §5. 压缩前后实测数据对照表

### 数据采集

| run-log 文件 | 触发场景 | COMPACT EVENT 数 | micro 次 | full 次 |
|---|---|---|---|---|
| `no-compact.txt` | 1 文件 + 2 round | 0 | 0 | 0 |
| `micro-compact-triggered.txt` | 3 文件 + 4 round | 1 | 1 | 0 |
| `full-compact-triggered.txt` | 5 文件 + 6 round | 3 | 2 | 1 |
| `swarm-internal-compact.txt` | coordinator 派 1 swarm + swarm 内 5 文件 + 6 round | 3（**全在 swarm 内**） | 2 | 1 |

### 字节释放实测

| run-log | 触发点 | type | before bytes | after bytes | 释放率 |
|---|---|---|---|---|---|
| micro-compact-triggered | round 4 | micro | 2188 | 2094 | -4.3% |
| full-compact-triggered | round 4 | micro | 1938 | 1844 | -4.9% |
| full-compact-triggered | round 5 (pre-full) | micro | 2429 | 2335 | -3.9% |
| full-compact-triggered | round 5 (full) | **full** | 2335 | **1854** | **-20.6%** |
| swarm-internal-compact | round 5 (full, **swarm 内**) | full | 2688 | 1946 | -27.6% |

### 关键观察

- **microCompact 释放率较小（~4%）**：因为 v5 mocked tool_result 内容只有 ~120 bytes（500-byte placeholder text 描述），每次清掉 1 条释放 ~94 bytes
- **fullCompact 释放率明显（~20-28%）**：调专用 LLM call 把多 round 历史压成一段 summary，字节减少显著
- **swarm-internal 场景**：full 释放 27.6%（比 interactive 场景的 20.6% 还高），因为 swarm system prompt 更长 + read_file 历史更密
- **fullCompact 是有 LLM 成本的**：每次 fullCompact 多花一次完整 API call（v5 实测 deepseek 响应 ~3-5 秒）—— 这就是 production 用 sessionMemoryCompact 作为优先级最高的便宜选项的原因

### Coordinator messages 隔离实测（最关键的隔离证据）

| 段 | bytes | COMPACTED SUMMARY | Old tool result cleared |
|---|---|---|---|
| swarm[0] FINAL MESSAGES（含 swarm 内 compact 痕迹） | ~2300 | **1 次** | 0 次（被 full 一起压走了）|
| coordinator FINAL MESSAGES | ~2078 | **0 次** | **0 次** |

**结论**：swarm 内部触发 3 次 compact，coordinator messages 完全感知不到任何字面量痕迹 —— context 隔离原则在 compact 维度延伸的工程证据。

---

## §6. Compact 自身的失败模式

### 失败模式 A：compaction LLM call 自己消耗光预算

**场景**：fullCompact 调一次 LLM call。这次 call 本身要传入待压缩的 messages 作为 user content + system prompt（NO_TOOLS_PREAMBLE）+ max_tokens 设置 → 也消耗 token。如果待压缩 messages 已经接近 context window 上限，compaction call 自己就会失败（input + system + reasonable max_tokens 还是超 window）。

**v5 当前处理**：⬛ 未处理。v5 用 `max_tokens: 2048` 调 compaction LLM call，输入截断到 6000 chars（`.slice(0, 6000)`）—— 防御性截断但没有"compact 自身预算管理"。

**production 补救**：claude-code `autoCompact.ts:67-70` `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3` 熔断器 —— 连续 3 次 compaction LLM call 失败就当轮停止重试，避免死循环。同时 `sessionMemoryCompact` 作为 autoCompact 前优先级最高的便宜路径（复用持久化 memory，不调 LLM）。

### 失败模式 B：compaction 后 model 行为漂移

**场景**：fullCompact 后 messages 数组结构剧变（10 条 → 3 条），model 在下一轮调用时可能：(a) 重复已经做过的 tool_use；(b) 误解 `[COMPACTED SUMMARY]` 是新指令；(c) 失去对最近 tool 调用上下文的细节感知。

**v5 当前处理**：⬛ 未直接处理。但 v5 通过 `KEEP_RECENT_ROUNDS = 2` 保留最近 2 round 原样，缓解 model 失忆问题。

**production 补救**：claude-code 的 fullCompact 在 summary 之后插入精心设计的 boundary marker（system message）+ 给 model 解释 "之前的对话已被 compact，summary 在上"，且保留最近 N round + `getLastAssistantMessage()` 始终不动。v5 简化为字符串前缀 `[COMPACTED SUMMARY]` —— production 级要更精致。

### 失败模式 C：触发抖动

**场景**：fullCompact 后字节数刚好降到阈值之下，下一 round 又涨过阈值，又触发 fullCompact。每 round 都 compact 一次，消耗大量 LLM call。

**v5 当前处理**：⬛ 未处理。v5 用 round 数阈值 `MAX_ROUNDS_BEFORE_FULL_COMPACT = 4`，每次 fullCompact 后 round 数会回到 2-3（KEEP_RECENT_ROUNDS=2 + summary 1 条），下一轮升到 4 再触发 —— 不会立即抖动，但有 cycle 风险。

**production 补救**：claude-code 用 token 估算 + buffer（`AUTOCOMPACT_BUFFER_TOKENS = 13_000`）+ 三层阈值（autoCompact / warning / error），triggering 后留出足够 buffer 避免立即重触发。

---

## §7. 写回 v4 的 3 处改进意见

### 7.1 messages 数组结构加 meta 字段

v4 messages 只有 `{role, content}` 标准 Anthropic 协议形态。v5 fullCompact 后 user message 加了 `[COMPACTED SUMMARY]` 字符串前缀作为 marker —— hacky。

**改进**：加 metadata 字段（`isCompactSummary?: boolean` / `compactRound?: number` / `compactedFromRounds?: [number, number]`），让 messages 数组可以"知道自己是否经历过 compact"。**对照工业实现** `compact.ts:614-624` 用 `isCompactSummary` flag + `isVisibleInTranscriptOnly` 等多 metadata。这样下游消费方（audit log / UI / debugger）能区分原生 messages vs compact 产物。

### 7.2 runRounds 应该有 hook 机制（不止 maybeCompact）

v5 在 runRounds 末尾硬编码加了 `await maybeCompact(...)`。如果还要加 hook 链（PreToolUse / PostToolUse 等），就要继续在 runRounds 内插更多调用点 —— 不可扩展。

**改进**：让 runRounds 接受一个 `hooks?: { afterRound?: AfterRoundHook[]; afterDispatch?: AfterDispatchHook[] }` 参数，maybeCompact 作为 afterRound hook 之一注册。其他 cross-cutting concerns（observability / tracing / audit aggregator）也走 hook 链。**对照 Lecture 06 即将讲的 hooks 系统**，这是 v6 的入口。

### 7.3 callModel 抽象成可注入接口

v5 callModel 是顶层 const + 全局共享。fullCompact 用同一个 callModel 调专用 prompt + 空 tools，但 production 可能需要：(a) compaction call 用更便宜的 model；(b) 不同 role 用不同 endpoint；(c) 调用计数 / token tracking。

**改进**：把 callModel 改为接口 `LLMCall = (messages, system, tools, options?) => Promise<any>`，运行时按 role 注入不同实现。这跟 v4 已有的 `AskFn` 多态注入是同一精神 —— **接口注入比硬编码全局函数更可扩展**。

---

## §7.5. Retrospective（2026-05-27 / 学完 v10 后补的 cache 经济关系）

v5 写这份 notes 时，cache 经济还不在主线讨论范围。完成 v10 task 10（system prompt 子系统化）后，学生在 v10 lesson 讨论中反问"microCompact 改 message 不也炸 cache prefix 吗"——揭示 v5 设计的一个未在原 notes 展开的关键真相。这一节补上。

### 7.5.1 v5 microCompact 与 Anthropic prompt cache 的真实关系

v5 `microCompact()` 修改 client 端 `messages` 数组里 tool_result 的内容（替换为 `CLEARED_MARKER`）。Anthropic prompt cache 是 **byte-level prefix 哈希**——任何字节变化都让从该位置开始的 cache prefix 全部失效。

第一次触发时（`rounds.length=5 / KEEP_RECENT_ROUNDS=2`），v5 会动 round 1/2/3 全部符合条件的 tool_result。**从 round 1 开始的 cache prefix 全炸**。

### 7.5.2 v5 的真实 trade-off

v5 microCompact 的设计动机不是"减小 cache 破坏"（那是不可能的，公开 API 用户改 messages 必炸 cache），是**"接受一次性 cache 大损失，换长期 messages 数组不膨胀"**：

| 不做 microCompact | 做 microCompact |
|---|---|
| messages 累积到 80K tokens | 砍后变 30K tokens |
| 每轮 cache hit 但每轮按 0.1× 付 80K | 触发那轮 cache miss 按 1.25× 写 20K |
| 长期单轮成本线性增长 | 下一轮起单轮成本降一半 |
| —— | ~5 轮后摊薄初始 cache miss 损失 |

`KEEP_RECENT_ROUNDS=2` + `MIN_TOOL_RESULT_BYTES_TO_CLEAR=30` 不是为了"保 cache"，是 **throttle 触发频率**——别为几百字节去炸 80K cache，账算不回来。

### 7.5.3 工业 cached microcompact 怎么真正"既省 token 又保 cache"

源码字面证据：`src/services/compact/microCompact.ts:295-303`

```
/**
 * Cached microcompact path - uses cache editing API to remove tool results
 * without invalidating the cached prefix.
 *
 * Key differences from regular microcompact:
 * - Does NOT modify local message content (cache_reference and cache_edits
 *   are added at API layer)
 */
```

两条 microCompact 路径对照：

| 路径 | 修改 messages | cache 影响 | 启用条件 |
|---|---|---|---|
| **Legacy**（v5 教学版同款）| 直接改 client `messages[].content` | ❌ 炸 cache prefix | 任何 client 默认 |
| **Cached microcompact** | 不动 client messages，请求加 `cache_edits` 块 | ✅ cache prefix 字面保住 | `feature('CACHED_MICROCOMPACT')` flag |

**`cache_edits` 协议工作流**（基于 `microCompact.ts:334-339` + `claude.ts:3164-3188` 源码推断）：

```
1. Client 端 messages 数组字面不变 (Round 1-3 的 tool_result 仍在原位)
2. 请求体追加 cache_edits 块:
   { type: "cache_edits",
     edits: [
       { cache_reference: "ref_round1_tr_abc", action: "delete" },
       { cache_reference: "ref_round2_tr_def", action: "delete" }, ... ] }
3. Anthropic 服务器:
   - 哈希 client messages prefix → cache 命中 (字面没变)
   - 处理 cache_edits 指令: server 端按 reference 删除对应 tool_result 的 KV
   - 实际推理见到精简后的 KV 序列
4. 结果: 省 token (input 减少) + 保 cache prefix (字面没变)
```

关键创新：把"修改 messages"的语义从 client 端搬到 server 端，绕过 byte-level prefix 哈希约束。

### 7.5.4 v5 教学版选 legacy path 的 inherent 原因

不是 v5 设计差，是教学版在公开 API 范围内**只能用 legacy path**：

1. `cache_edits` + `cache_reference` 是 Anthropic 内部协议（gated by `CACHED_MICROCOMPACT` feature flag）
2. 公开 SDK / DeepSeek Anthropic 兼容端点都不支持
3. 教学版要单文件可跑、依赖最小 → 必然选公开 API → 必然选 legacy

这跟 v10 不真发 `cache_control` 到 API 是同款决策——教学版以"概念清晰"换"工业 cache 真实命中率"。

### 7.5.5 衔接 v10 的两个正交体系

- **v10 sectionCache** → 让 system prompt prefix 跨 turn 字面稳定 → 服务端 system 部分 cache 命中
- **cached microcompact** → 让 messages prefix 跨 turn 字面稳定 → 服务端 messages 部分 cache 命中

两者在 Anthropic API 的 cache_control breakpoint 体系里是不同字段、不同 marker（参考 task 10 notes / lesson），互不替代。完整的"cache 经济同权"图景需要两者协同：v10 解决 system 字段的 cache，cached microcompact 解决 messages 字段的 cache。

### 7.5.6 启示：教学版 disclaimer 的必要性

v5 写 notes 时 cache 经济还不在主线（task 10 才正式登场）。学完 v10 回看 v5 才发现"事实≠原文"这条要点的 cache 代价从未量化。这条 retrospective 把账补上。

更一般的 CLAUDE.md 0 假设原则启示：**notes.md/lesson.md 是某次对话的产出，论断可能漂移；学生学完更新版课程后可能发现旧 notes 的盲区**。修正机制是显式追加 retrospective 而非悄悄改——让学习路径本身可被审计。

---

## §8. 一句话总结

4 条 Lecture 05 + Socratic 06 要点全部命中工业实现。最大学习：

> **context compaction 是 cross-cutting concern：不是 model 自身职责，是 harness 主动的物理动作。它有 3 个维度（WHEN/WHAT/HOW）+ 4 个粒度变体（micro/sessionMemory/full/apiMicro），构成优先级链（同 v3 mode 矩阵的有序 if 链 + 早返回设计模式）。round 原子性 + 事实≠原文 + 隔离原则跨维度延伸 —— 三条约束在边界条件上互相印证，少一条就会踩坑（v5 第一版 bug 就是漏了"round 边界的悬空 tool_result"）。**

v5 + 这 4 条要点是进入 Lecture 06 的基础：hooks 系统会把 compact 进一步抽象为"运行时注册的 cross-cutting concern"之一，与 permission / audit / observability 等共享同一套 hook 链机制。
