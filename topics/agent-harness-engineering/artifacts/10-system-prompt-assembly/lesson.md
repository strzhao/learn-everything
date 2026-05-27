# v10: System Prompt Assembly Engine

> 把 system prompt 从一个固定字符串改造成一个完整子系统——6 段注册、按变化频率 memoize、显式 cache 边界切分、compact 后自动 clear。159 行新增代码，v9 核心不动。

## 是什么

v1-v9 的 system prompt 是一个 `const SYSTEM_PROMPT = "..."` 常量字符串。每轮 agent loop 都原样传给 API，简单直白。但 v9 的 MCP 同权论断暴露了一个问题：MCP server 会在 turn 间断连重连，system prompt 里的 mcp_instructions 段随之变化——如果整个 prompt 是固定字符串，变了的部分和没变的部分混在一起，downstream cache 全部失效。

v10 的解法：**把 system prompt 拆成 6 个独立 section**，每个 section 单独决定"是否可缓存"。跟 webpack 把一个 JS bundle 拆成多个 chunk 是同一个思路。

## 跨领域类比：webpack chunk splitting

一个 JS bundle 拆成多个 chunk，每个 chunk 按变化频率独立缓存：

```
vendor chunk   = node_modules 第三方库    ─→ CDN 长 cache，跨用户共享
runtime chunk  = webpack runtime         ─→ inline 嵌进 HTML
app chunk      = 业务代码                 ─→ 中 cache，按 commit hash 失效
dynamic import = 按需加载                 ─→ 用户触发时再下载
```

v10 的 system prompt 同结构：

```
core_instruction / tool_list_hint  = 从不变       ─→ memoize 长期命中
env_info / memory                  = 会话内不变   ─→ memoize 中期命中
mcp_instructions                   = turn 间可变  ─→ DANGEROUS，每轮重算
session_context                    = 工业 BOUNDARY 之后  ─→ 不进 API cache
```

记住这个类比：**system prompt 不是字符串，是 build artifact**。

## 怎么跑

```bash
bun run topics/agent-harness-engineering/artifacts/10-system-prompt-assembly/agent-v10-system-prompt.ts
```

两份 run-log 看两种核心现象：
- **run-log-cache-warm.txt**：Round 1 全 cold（6 miss），Round 2+ 稳态（5 hit / 1 miss）
- **run-log-compact-clear.txt**：Round 5 compact 触发后 cache 清空 → Round 6 恢复

## §19: sectionCache + 两个工厂函数

下面是 v10 子系统的内核——一个 module-scoped `Map` 作为 cache，两个工厂函数注册 section。注意第二个工厂的第三参数 `_reason`：

@include(./agent-v10-system-prompt.ts, section=19)

3 个设计决策值得关注：

1. **`sectionCache` 是 module-scoped `Map`**——闭包 cache 在每次工厂调用时重建，跨 turn 持久不了。Module-scoped Map 才能跨轮次存活
2. **DANGEROUS 不绕过写入，只跳过读取**——`sectionCache.set(s.name, value)` 对 DANGEROUS section 也执行。cache 里始终有"上次的副本"，只是下次永远不读它
3. **`_reason: string` 是 review-time 强制 disclaimer**——runtime 不消费这个值，它的全部作用是强制开发者在代码里说清"为什么这段必须每轮重算"。跟 v6 hook handler 的必填 reason 字段同源

## §20: 6 个 section 注册

下面是 6 段 prompt 的注册代码。注意哪些用普通工厂（memoized），哪些用 DANGEROUS 工厂（每轮重算）：

@include(./agent-v10-system-prompt.ts, section=20)

核心教学内容——6 段的分布和 cache 策略：

| section | 位置 | cache 策略 | 变化频率 |
|---|---|---|---|
| `core_instruction` | BEFORE | memoized | 从不变 |
| `tool_list_hint` | BEFORE | memoized | 从不变 |
| `env_info` | BEFORE | memoized | 会话内不变 |
| `mcp_instructions` | BEFORE | **DANGEROUS** | turn 间可变 |
| `memory` | BEFORE | memoized | 会话内不变 |
| `session_context` | AFTER | memoized | per-turn |

v10 教学版把 5 段放 BEFORE_BOUNDARY 是为了让 cache hit/miss 现象在 audit 中一目了然。工业版的 dynamic sections 全在 BOUNDARY 之后——学完本节要记住这是教学化简。[详见 notes.md §3]

## §21: assembleSystemPrompt + BOUNDARY 切分

下面是装配函数——把 6 段 resolve 后拼成完整 prompt，用 BOUNDARY sentinel 切成前后两段返回。观察 audit 输出部分（`[CACHE hit=...]` 行）：

@include(./agent-v10-system-prompt.ts, section=21)

3 层 audit 输出让 cache 工作状态透明：
- `[CACHE hit=X/N miss=Y/N]` —— 单行汇总
- `[CACHE hit-sections=...] / [CACHE miss-sections=...]` —— 逐段明细
- `[BOUNDARY prefix=N_chars / suffix=M_chars]` —— cache 边界两段长度可见

## §22: compact 后为什么必须 clear cache

v10 在 maybeCompact 函数**末尾**加了一行 `clearSystemPromptSections("compact")`。

**为什么放末尾不放开头？**
- 末尾派（v10 + 工业）：cache 有效寿命 = 从首次 compute 到 compact 触发的全部 round
- 开头派（错误）：cache 在 fullCompact 还没执行时就被丢弃，浪费了上一轮刚算好的值

**为什么 compact 后必须 clear？**
- compact 改变了 messages 数组内容（早期 tool_result 被砍 / messages 重排）
- section compute 函数可能依赖会话上下文（如 memory section 根据近期对话动态生成）
- cached value 瞬间 stale——不清 cache，下一轮 system prompt 跟新 messages 状态对不上号

**这是语义因果链，不是缓存优化技巧。** 工业 `postCompactCleanup.ts:62` 位于 compact "post" 阶段——跟 v10 末尾派一致。

## 第一轮证据：cache warm-up 过程

看 Round 1 的 audit 输出。你会看到 `hit=0/6 miss=6/6`——bootstrap 阶段所有 section 都是 cold start：

@include(./run-log-cache-warm.txt, round=1)

关键行：`[CACHE hit=0/6 miss=6/6 cache_size=6]` + `[BOUNDARY prefix=743_chars / suffix=98_chars]`。6 段全 miss 是预期的——第一次跑没有任何 cache。

现在看 Round 2。跟 Round 1 对比，hit 从 0 变成 5——唯独 `mcp_instructions` 还是 miss：

@include(./run-log-cache-warm.txt, round=2)

`[CACHE hit=5/6 miss=1/6]` + `miss-sections=mcp_instructions`。这一行字面证明了两个论断：(1) memoization 默认开（5 段 hit），(2) DANGEROUS opt-out 生效（唯独 mcp_instructions miss）。BOUNDARY 两段长度跨轮稳定（prefix=743 / suffix=98），证明切分边界工作正常。

## 第二轮证据：compact 触发后 cache 清空

Round 5 是核心证据——Round 4 末尾的 maybeCompact 检测 `rounds.length > MAX_ROUNDS`，触发 fullCompact。compact 完成后立刻看到 cache 被清空：

@include(./run-log-compact-clear.txt, round=5)

时序的精确性是关键证据——`[CACHE cleared by compact: 6 entries dropped]` → 紧跟 `[CACHE hit=0/6 miss=6/6]`。clear 真把 cache 砍光，下一次 assemble 重新执行 6 个 compute 函数。

然后 Round 6 恢复到 `hit=5/6 miss=1/6`——compact 后第 2 轮 cache 立刻 warm 回来。**cache 不是一次清空就死掉，它在 clear 后立刻进入新一轮 warmup 周期**。

## 4 论断小结（回看）

学完全部代码和 run-log，回看本节验证的 4 条核心论断：

| # | 论断 | 代码位置 | run-log 字面证据 |
|---|---|---|---|
| 1 | memoization 默认开 | §19 `systemPromptSection` 工厂 | Round 2 `hit=5/6` |
| 2 | DANGEROUS opt-out（每轮重算）| §19 `DANGEROUS_uncachedSystemPromptSection` | Round 2 `miss-sections=mcp_instructions` |
| 3 | compact 后 clear section cache | §22 `clearSystemPromptSections("compact")` | Round 5 `cleared by compact: 6 entries dropped` |
| 4 | BOUNDARY 是 cache 物理分割点 | §21 `assembleSystemPrompt` 返回 `{prefix, suffix}` | `prefix=743_chars / suffix=98_chars` 跨轮稳定 |

v9 同权论断的 cache 经济代价、完整工业 vs v10 决策对照等深度内容 → [详见 notes.md §5 §6]

## 下一步

回到 `learn-everything/topics/agent-harness-engineering/` 让课程验收这次交付。v10 完成后，mini harness 的 6 大子系统（permission / compact / hook / observability / streaming / system-prompt）全部齐备——下一站是把它们拼装成完整可运行的最终产物。
