# Task 05：v5 context compactor —— 把 4 条 compact 要点落到代码

> v4 解决了 multi-agent 架构问题，但留下两种 context 压力：单 agent 深度爆 + coordinator 广度爆。本任务把 Lecture 05 抽象的 3 个核心维度（WHEN / WHAT / HOW）+ Socratic 06 内化的 4 条要点（round 是原子单位 / 事实≠原文 / 专用 LLM call / 隔离原则跨维度延伸），落到 321 行 v5 代码 + 4 份真实 run-log，对照 claude-code `src/services/compact/` 子系统验证每一条。看完你应该能说清：(1) compaction 为什么必须是独立 sub-system 不是 dispatch 的一部分；(2) tool_use 与 tool_result 跨 compact 边界的"悬空"问题是什么、v5 第一版怎么踩坑、怎么修；(3) coordinator messages 完全不感知 swarm 内部 compact —— 物理隔离的实测数据。

## 是什么

Task 04 的 v4 给我们 1 个 coordinator + N 个 swarm 各自独立 messages 数组，但每个数组随 round 单调增长。production 必须解决：

- **单 agent 深度爆**：长会话里 messages 数组累积到模型 context window 上限
- **coordinator 广度爆**：派的 swarm 越多，coordinator messages 里 spawn_swarm 历史越长

**两个问题本质同一个**：messages 数组占用 model context window 受限。**解决方案**：compaction —— 用一段更精炼的形态替换原段。**关键约束**：compaction 不是 model 自身在主 loop 里做（会引入递归 + token 压力），而是 harness 主动调一次专门的 LLM call。

v5 在 v4 基础上加 3 个新段（§6 groupByRound / §7 microCompact / §8 fullCompact + maybeCompact），**不修改 v4 dispatch / role 逻辑**，只在 §5 runRounds 末尾加一个 `await maybeCompact(...)` 钩子。这是 Socratic 05 Q2 内化的 *"compaction 是独立 sub-system"* 原则在代码层的物理体现。

## §1. 三个核心维度（WHEN / WHAT / HOW）+ v5 选择

| 维度 | claude-code 工业版 | v5 简化版 | 文件位置 |
|---|---|---|---|
| **WHEN** 触发时机 | 3 层阈值（autoCompact 13K buffer / warning 20K / error 20K）+ 熔断器 `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3` | 静态 `MAX_ROUNDS_BEFORE_FULL_COMPACT = 4` | `autoCompact.ts:62-90` |
| **WHAT** 压什么 | 按 API round 分组（`assistant.message.id` 边界），保留 system reminders + 最近 N round + pinned + boundary 后 | `groupByRound()` 按 assistant 出现切分，保留最近 `KEEP_RECENT_ROUNDS = 2` | `grouping.ts:22-63` |
| **HOW** 压成什么 | LLM 输出 `<analysis>+<summary>` 文本，插回 user message + `isCompactSummary` flag | LLM 输出同结构文本，插回 user message + `[COMPACTED SUMMARY]` 前缀 | `compact.ts:614-624` + `prompt.ts:19-26` |

v5 的简化都是**教学化**：让阈值定低方便观察触发，让 marker 用纯字符串方便 grep 验证。Production 必须更精致。

## §2. Round 是原子单位（要点 1）

Socratic 06 Q1 收紧场景题已验证：`tool_use` 与 `tool_result` 由 `tool_use_id` 字段指针绑定，压缩边界必须以 round 为单位 —— 否则会出现"悬空 tool_result"（对应 tool_use 已被压走）。

@include(./agent-v5-context-compactor.ts, section=6)

v5 `groupByRound` 简化版：每个 assistant 出现就切一个 round group。对照 claude-code `grouping.ts:22-63` 用 `assistant.message.id` 变化作为边界（处理 streaming 分块同 id 不切），但**核心边界规则一致**：每个新 assistant 启动一个新 round group。

**v5 实际踩的坑**：第一版 fullCompact 没考虑 toKeep 开头 user(tool_result) 对应的 tool_use 已在 toCompact 段被压走 → 立刻 API 报错 `unexpected tool_use_id found in tool_result blocks: Each tool_result block must have a corresponding tool_use block in the previous message`。修复加 `firstValid` 跳过逻辑（见 §4 fullCompact 段）。**这条 bug 就是要点 1 最直接的工程证据 —— 跨 compact 边界的引用关系会断裂，必须主动处理**。

## §3. 事实 ≠ 原文（要点 2）—— microCompact

Socratic 06 Q2 收紧场景题 *"swarm[0] round 3 读 10KB / round 7 已 reasoning 融入 / round 30 compact"* 内化：原文 10KB 是"冷状态"，model 后续推理输出已经把关键信息融入它自己的 text content。原文可以替换为 `[Old tool result content cleared]` —— 保留 tool_use_id 占位让 model 知道"调用过"，但释放原文字节。

@include(./agent-v5-context-compactor.ts, section=7)

`CLEARED_MARKER` 字面量 `[Old tool result content cleared]` **直接引用工业版** `microCompact.ts:36` 的 `TIME_BASED_MC_CLEARED_MESSAGE` —— 一字不差。

**关键设计**：
- 跳过最近 `KEEP_RECENT_ROUNDS = 2` 个 round（保留 ongoing context）
- 跳过已 cleared 的（幂等）
- 跳过 < `MIN_TOOL_RESULT_BYTES_TO_CLEAR = 30` 字节的小 result（不值得清）

## §4. 专用 compaction LLM call（要点 3）—— fullCompact

Socratic 06 Q3 一次答对 *"专用 compaction LLM call"*。compaction 不是主 loop 副作用，是 harness 在主 loop 之外**主动调一次专用 LLM call**。

@include(./agent-v5-context-compactor.ts, section=8)

`NO_TOOLS_PREAMBLE` 常量是 v5 的关键设计 —— **从工业 `prompt.ts:19-26` 致敬简化**：

```ts
// claude-code/src/services/compact/prompt.ts:19-26
const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.
`
```

注释解释 *"on Sonnet 4.6+ adaptive-thinking models the model sometimes attempts a tool call despite the weaker trailer instruction. With maxTurns: 1, a denied tool call means no text output → falls through to the streaming fallback (2.79% on 4.6 vs 0.01% on 4.5)"* —— **工业实现踩过的痛苦经验**：即使 maxTurns=1，model 仍可能尝试调用工具浪费这次机会。所以：

1. **NO_TOOLS_PREAMBLE 必须最先**出现在 system prompt
2. **明确警告 rejection 后果**
3. **传空 tools 数组**（v5 用 `callModel(..., NO_TOOLS_PREAMBLE, [])` 第三参数空数组）—— 物理移除工具

**fullCompact 的关键步骤**：

1. groupByRound 拿到 rounds 列表
2. 切分 toCompact（要压的）+ toKeep（最近 KEEP_RECENT_ROUNDS 个）
3. 构造 compactionMessages（user content 是 toCompact 的 JSON dump，截断到 6000 chars）
4. 调 `callModel(compactionMessages, NO_TOOLS_PREAMBLE, [])` —— 专用 prompt + 空 tools
5. 解析 response 的 text content 作为 summary
6. **关键修复**：跳过 toKeep 开头悬空 tool_result（对应 tool_use 已被压走）
7. `messages.length = 0` 清空 + push summary user message + push 跳过悬空后的 toKeep

## §5. Compact 作为独立 sub-system 的钩子

@include(./agent-v5-context-compactor.ts, section=5)

注意 `runRounds` 末尾的 `await maybeCompact(messages, role, system)` —— **这是 compact 唯一介入 v4 主循环的代码点**。dispatch / execute / role 路由全都不动，maybeCompact 在每 round 结束后看一眼 messages 数组要不要 compact。

`maybeCompact` 内部按优先级链：先 microCompact（成本低 / 无 LLM call），再检查 round 数决定是否 fullCompact（成本高 / 调专用 LLM）。这跟工业 `autoCompact.ts:160-239` 的 sessionMemoryCompact → microCompact → autoCompact → apiMicrocompact 四级优先级链是同一设计模式 —— **小到大、便宜到贵、保留多到少**。

**为什么这种"独立 module 钩子"是正确架构**：

- compact 是 cross-cutting concern（横切关注点），跟 dispatch / role 路由是不同维度
- 如果把 compact 内联到 dispatch，dispatch 会变得臃肿、难以单测、难以扩展
- 独立 module + runRounds 单点钩子 = 修改 compact 不动 dispatch，修改 dispatch 不动 compact

对照 Lecture 06 即将讲的 hooks 系统：compact 钩子是 hooks 链的第一种实例化。未来 PreToolUse / PostToolUse / observability / audit aggregator 都走同一套钩子机制。

## §6. 场景 A：no-compact baseline（验证 v5 向下兼容 v4）

User prompt：`请读取 /tmp/a.txt 这个文件并总结。`

@include(./run-log-no-compact.txt, round=1)

@include(./run-log-no-compact.txt, round=2)

只 2 round（read + 总结），round 数 < `MAX_ROUNDS_BEFORE_FULL_COMPACT = 4`，tool_result 字节累积也不够触发 microCompact。**0 个 COMPACT EVENT**。v5 行为完全等同 v4 —— 验证 compact sub-system "不打扰短任务"。

## §7. 场景 B：microCompact 触发

User prompt：`请依次读取 /tmp/a.txt /tmp/b.txt /tmp/c.txt 这 3 个文件，每个读完用一句话告诉我大致内容再读下一个。`

@include(./run-log-micro-compact-triggered.txt, round=3)

Round 3 model 调第 3 个 read_file。这一轮结束后 messages 累积到 round=4 时 `maybeCompact` 检查 —— 有 ≥ 3 个老 tool_result（已超过 KEEP_RECENT_ROUNDS=2），且每个 tool_result 内容 > MIN_TOOL_RESULT_BYTES_TO_CLEAR=30 → 触发 microCompact，清 1 条最老的 tool_result。

stderr 输出：

```
[AUDIT] COMPACT type=micro role=interactive cleared=1_tool_results freed=94b
```

stdout 输出：

```
========== COMPACT EVENT round=4 type=micro role=interactive before=2188 after=2094 ==========
```

释放率 4.3%（94 / 2188 字节）。看 ROUND 4 model 怎么处理：

@include(./run-log-micro-compact-triggered.txt, round=4)

model 在 ROUND 4 用 end_turn 完成总结。**注意**：model 看到的 messages 数组里第一个 read_file 的 tool_result 已被替换为 `[Old tool result content cleared]`，但 model 没有 confused —— 它能从后续 round 的 reasoning text + 自己的 thinking 段里恢复"读过 a.txt"的事实。**这就是要点 2 "事实≠原文" 的实战验证**。

## §8. 场景 C：fullCompact 触发 + 专用 LLM call 输出可见

User prompt：`请依次读取 /tmp/a.txt /tmp/b.txt /tmp/c.txt /tmp/d.txt /tmp/e.txt 这 5 个文件。每次只读一个，每读完一个用一句话告诉我大致内容再读下一个。`

@include(./run-log-full-compact-triggered.txt, round=5)

ROUND 5 是关键：跑完后 maybeCompact 发现 round 数已经 > MAX_ROUNDS_BEFORE_FULL_COMPACT=4，触发 fullCompact。

**专用 LLM call 输出可见**：fullCompact 调一次 callModel 用 NO_TOOLS_PREAMBLE + 空 tools 数组，model 必须输出纯文本 `<analysis>+<summary>`。看 COMPACT EVENT 段：

```
========== COMPACT EVENT round=5 type=full role=interactive before=2335 after=1854 ==========
summary (first 600 chars): <analysis>
The user's intent was to read five files...
```

释放率 20.6%（481 / 2335 字节）。注意 summary 同时包含 `<analysis>` 和 `<summary>` 两个 XML 块 —— 这是工业 `prompt.ts:61-77` `BASE_COMPACT_PROMPT` 模板要求的双段结构（analysis 是给下次 compact 看的草稿，summary 是给后续 model 看的浓缩 context）。

ROUND 6 model 在新 messages 上继续干活：

@include(./run-log-full-compact-triggered.txt, round=6)

model 看到的 messages 是：`[user("[COMPACTED SUMMARY]\n<analysis>...<summary>..."), assistant(read /tmp/d.txt), user(tool_result), assistant(read /tmp/e.txt), user(tool_result)]` —— **大部分历史已被压成 summary**，但最近 2 round（包括 d.txt 和 e.txt 的读取）原样保留。model 在 ROUND 6 用 end_turn 完成。

## §9. 场景 D：swarm 内部 compact + coordinator 隔离（要点 4 实测）

User prompt：`请派一个 swarm worker 依次读取 /tmp/a.txt /tmp/b.txt /tmp/c.txt /tmp/d.txt /tmp/e.txt 这 5 个文件，每读完一个用一句话总结，然后 swarm 把整理给你，你转给我。只派 1 个 swarm。`

@include(./run-log-swarm-internal-compact.txt, round=1)

ROUND 1 coordinator 派 1 个 swarm。swarm[0] 开始 LIFECYCLE：

@include(./run-log-swarm-internal-compact.txt, section="swarm[0] LIFECYCLE")

swarm[0] 内部跑 5 个文件 + 触发 3 次 COMPACT EVENT（2 次 micro + 1 次 full） —— 全部发生在 swarm 进程内。看 swarm[0] FINAL MESSAGES：

@include(./run-log-swarm-internal-compact.txt, section="swarm[0] FINAL MESSAGES")

swarm[0] messages 数组里**含** `[COMPACTED SUMMARY]` 字面量（line 163）—— swarm 自己的 messages 经历过 fullCompact。

现在看 coordinator FINAL MESSAGES：

@include(./run-log-swarm-internal-compact.txt, section="FINAL MESSAGES")

**关键观察**：

- coordinator messages 数组 **完全不含** `COMPACTED SUMMARY` 字面量（grep = 0）
- coordinator messages 数组 **完全不含** `[Old tool result content cleared]` 字面量（grep = 0）
- coordinator messages 数组 **完全不含** `swarm-worker` 字符串（role 标记）
- coordinator 只看到 spawn_swarm 的 tool_result，content 是 `[swarm[0]] 所有 5 个文件现已全部读取完毕...` —— 仅 swarm 的最终 summary 字符串

**结论**：swarm 内部触发 3 次 compact，coordinator messages 完全感知不到任何字面量痕迹。**Task 04 的 context 隔离原则在 compact 维度完美延伸**：不只 swarm 内部 messages 不外泄，swarm 内部 compact 事件也不外泄。

对照工业 `postCompactCleanup.ts:31-39`：

```ts
const isMainThreadCompact =
  querySource === undefined ||
  querySource.startsWith('repl_main_thread') ||
  querySource === 'sdk'
if (isMainThreadCompact) {
  resetContextCollapse()  // 仅主线程重置 context-collapse 状态
}
```

工业版按 `querySource` 区分主线程 vs subagent 决定哪些缓存要清，**防止 swarm 内部 compact 污染主线程 coordinator state**。v5 简化为"每 role 独立 messages 数组 + maybeCompact 只动当前数组"，**精神一致**。

## §10. 压缩前后实测数据对照表

| run-log | 触发场景 | COMPACT EVENT | micro 释放率 | full 释放率 |
|---|---|---|---|---|
| `no-compact.txt` | 短任务 2 round | 0 | — | — |
| `micro-compact-triggered.txt` | 中等 3 文件 4 round | 1 micro | -4.3% | — |
| `full-compact-triggered.txt` | 长 5 文件 6 round | 2 micro + 1 full | -3.9% ~ -4.9% | **-20.6%** |
| `swarm-internal-compact.txt` | swarm 内 5 文件 6 round | 2 micro + 1 full（**全在 swarm 内**） | -3.4% ~ -4.2% | **-27.6%** |

**关键洞察**：

- microCompact 释放率小（~4%），但**无 LLM call 成本** —— 总是先试它
- fullCompact 释放率明显（~20-28%），但**多一次完整 LLM call** —— 阈值触发才上
- swarm-internal 场景 full 释放 27.6% > interactive 场景 20.6%，因为 swarm system prompt 更长 + read_file 历史更密
- **coordinator messages 在 swarm-internal 场景中完全不动**（隔离原则的物理证据）

## §11. Compact 自身的失败模式

v5 实测发现 3 个 compact 子系统特有的失败模式：

- **A：compaction LLM call 自己消耗光预算**。fullCompact 调 LLM 也消耗 token，如果待压 messages 已接近 context window，compaction 调用本身会失败。v5 简化用 `.slice(0, 6000)` 防御性截断 + `max_tokens: 2048`。Production 用 `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3` 熔断器
- **B：compaction 后 model 行为漂移**。messages 结构剧变后 model 可能重复已做过的 tool_use / 误解 summary 是新指令。v5 通过 KEEP_RECENT_ROUNDS=2 缓解。Production 用精心设计的 boundary marker + 解释性 system message
- **C：触发抖动**。fullCompact 后立刻又涨过阈值，每 round 都 compact。v5 round 数阈值能缓解但有 cycle 风险。Production 用 token 估算 + buffer (`AUTOCOMPACT_BUFFER_TOKENS = 13_000`)

详细分析见 [notes.md §6](./notes.md)。

## §12. 4 条要点对照工业实现（小结）

- **要点 1 round 是原子单位** ✅ 命中 — `grouping.ts:22-63` `groupMessagesByApiRound` 用 `assistant.message.id` 边界 / v5 `groupByRound` 简化版。**v5 第一版踩的"悬空 tool_result" bug 是要点 1 的最直接工程证据**
- **要点 2 事实≠原文** ✅ 命中 — `microCompact.ts:36` `TIME_BASED_MC_CLEARED_MESSAGE = '[Old tool result content cleared]'`，v5 `CLEARED_MARKER` 字面量同
- **要点 3 专用 compaction LLM call** ✅ 命中 — `prompt.ts:19-26` `NO_TOOLS_PREAMBLE`，v5 同形态常量 + 空 tools 数组双层保险
- **要点 4 隔离原则跨维度延伸** ✅ 命中 — `postCompactCleanup.ts:31-39` `isMainThreadCompact` 按 querySource 分级清理，v5 每 role 独立 messages 数组 + maybeCompact 只动当前数组同精神

完整对照与推理见 [notes.md §2](./notes.md)。

## §13. 写回 v4 的 3 处改进意见

- **messages 数组加 meta 字段**（如 `isCompactSummary` flag），让下游能区分原生 messages vs compact 产物
- **runRounds 加 hook 链**（不止 maybeCompact）—— afterRound / afterDispatch hook 注册，所有 cross-cutting concerns 走同一机制（Lecture 06 hooks 系统的入口）
- **callModel 抽象成可注入接口** —— compaction call 可以用更便宜 model / 不同 role 不同 endpoint / 调用计数 tracking

完整建议与对应工业实现见 [notes.md §7](./notes.md)。

## §14. Retrospective（2026-05-27 / 学完 v10 后回看 microCompact 的 cache 经济真相）

完成 v10 task 10（system prompt 子系统化）后讨论 Anthropic prompt cache 机制时，学生反问揭示了 v5 设计的一个**未在 v5 lesson 里展开的关键事实**：v5 microCompact **会炸 Anthropic prompt cache prefix**。这一节做 retrospective 订正。

### 事实修正

v5 `microCompact()` 把 `KEEP_RECENT_ROUNDS` 之前所有 round 里的大 tool_result 替换为 `CLEARED_MARKER` 字符串——**修改了 client 端 `messages` 数组的字节内容**。而 Anthropic prompt cache 是 **byte-level prefix 哈希**：任何 message 内容变化都会让从该位置开始的 cache prefix 全部失效。

具体地，v5 第一次触发 microCompact 时（rounds.length=5 / KEEP=2），会动 round 1/2/3 全部大 tool_result。结果是：**从 round 1 开始的 cache prefix 直接全失效**——不是"动一点失效一点"，是"动了最早一个就从最早开始失效"。

### v5 的真实 trade-off（不是 "保 cache"）

v5 microCompact 的设计动机**不是减小 cache 破坏**（那是不可能的，公开 API 用户改 messages 必炸 cache），而是 **"接受一次性 cache 大损失，换长期 messages 数组不膨胀"**：

```
不做 microCompact:
  messages 累积到 80K tokens → 每轮 cache hit 但每轮按 0.1× 价格付 80K → 长期单轮成本线性增长

做 microCompact (一次性损失):
  触发那轮 cache miss → 按 1.25× 价格写 20K (Anthropic 注释"~20K per flip")
  下一轮起 messages 变 30K → 长期单轮成本降一半 → ~5 轮后摊薄回来
```

`KEEP_RECENT_ROUNDS=2` + `MIN_TOOL_RESULT_BYTES_TO_CLEAR=30` 不是为了"保 cache"，是为了 **throttle 触发频率**——别为了砍几百字节去炸 80K cache，那笔账算不回来。

### 工业 claude-code 的"既省 token 又保 cache"方案

源码字面证据（`src/services/compact/microCompact.ts:295-303`）：

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

工业有**两条 microCompact 路径**：

| 路径 | 修改 messages | cache 影响 | 你能用 |
|---|---|---|---|
| **Legacy**（= v5 教学版）| 改 client `messages[].content` | ❌ 炸 cache prefix | ✅ 任何 client |
| **Cached microcompact**（feature: CACHED_MICROCOMPACT）| 不动 client messages，往请求加 `cache_edits` 协议块 | ✅ cache prefix 字面保住 | ⚠️ Anthropic 内部 / 灰度 |

**Cached microcompact 工作原理**：client 端 messages 数组**字节一字不变**，请求体里多塞 `cache_edits: [{ cache_reference: "ref_round1_tr_abc", action: "delete" }, ...]`。Anthropic 服务器 prefix 哈希命中 → 按 reference 在 server 端 KV 里删除特定 tool_result → 推理时实际见到精简后的 KV → **同时省 token + 保 cache**。

这是 Anthropic 自己的 KV cache 内部协议，把"修改 messages"的语义从 client 端搬到 server 端，绕过了 byte-level prefix 哈希约束。

### v5 教学版的局限 + 怎么衔接 v10

v5 的局限是 **inherent** 的——teaching-quality 实现 + 公开 API 能力 = 必然选 legacy path = 必然炸 cache。不是 v5 设计差。

v10 sectionCache 处理的是 **system prompt 字段的 cache 命中**，跟 messages 字段的 cache 是两个正交体系：

- **v10 sectionCache** → 让 system prompt prefix 跨 turn 字面稳定 → 服务端 system 部分 cache 命中
- **cached microcompact** → 让 messages prefix 跨 turn 字面稳定 → 服务端 messages 部分 cache 命中

未来 task 候选：可以做"cached microcompact mock"——用 Anthropic 真实 `cache_edits` 协议（如 DeepSeek 端点不支持就 mock）。这会把 v5 task 05 + v10 task 10 的 cache 经济故事补齐成完整链条。

### 教训：教学版 disclaimer 的必要性

v5 lesson 写时没展开 cache 经济的真相，因为 v5 task 05 的 4 条要点本来就侧重"round 原子单位 / 事实≠原文 / 专用 LLM call / 隔离原则"——cache 是 task 10 才正式登场的主题。学完 v10 回看 v5 才发现："事实≠原文"这条要点的 cache 代价从未量化。这条 retrospective 把账补上。

更一般的 CLAUDE.md 0 假设原则启示：**lesson.md 是某次对话的产出，引用的论断可能漂移；学生学习更新版课程后可能发现旧 lesson 的盲区**。修正机制是显式追加 retrospective 而非悄悄改，让学习路径本身可被审计。

## 下一步

回到 `learn-everything/topics/agent-harness-engineering/` 让课程验收这次交付。v5 把 cross-cutting concern（compact）的注入机制走通了，下一步 **Lecture 06** 会把 hooks 系统作为通用化抽象：permission / compact / audit / observability 等所有横切关注点都走同一套 PreToolUse / PostToolUse / afterRound 钩子链机制。
