# v10: System Prompt Assembly Engine —— 偿还 v9 的 cache 经济债

从 v1 到 v9，所有 system prompt 都是固定字符串常量 `const SYSTEM_PROMPT = "..."`。v10 跨过的边界是：**system prompt 从字符串改造为完整子系统**——6 section 注册 + memoization + cache 边界 + 显式清理触发。这不是为了"代码组织好看"，而是 v9 同权论断埋下的最深一根刺。

## v9 留下的债：dispatch 同权 ≠ cache 经济同权

v9 验证了 MCP 同权 4 论断：MCP tool 复用 dispatch / permission / hook / obs 管道。但 lesson 10 我埋了最深的钩子——**dispatch 同权 ≠ cache 经济同权**。

工业 claude-code 在 `src/constants/prompts.ts:524-532` 把 `mcp_instructions` 标成 `DANGEROUS_uncachedSystemPromptSection(..., reason: "MCP servers connect/disconnect between turns")`。意思是 MCP server 一旦断连重连，system prompt 里这一段就变了，cache 必须丢。

v9 教学版无 cache 系统，看不到这条债。v10 引入 sectionCache 后债面化：mcp_instructions 必 DANGEROUS_uncached，每轮 miss + cache 仍写副本但下次跳读。这正是 v10 task 想字面化的钩子。

## 跨领域类比：build system 的 chunk splitting

把 v10 想成 webpack / vite 的 `splitChunks`。一个 JS bundle 拆成多个 chunk，每个 chunk 单独决定"是否可缓存 / 缓存粒度多大"：

```
vendor chunk    = node_modules 第三方库   ─→ CDN 长 cache，跨用户共享
runtime chunk   = webpack runtime        ─→ inline 嵌进 HTML
app chunk       = 业务代码                ─→ 中 cache，按 commit hash 失效
dynamic import  = 按需加载的功能模块       ─→ 用户触发时再下载
```

v10 同结构：

```
core_instruction / tool_list_hint  = static 不变            ─→ memoize 长期 hit
env_info / memory                  = per-session 不变      ─→ memoize 中期 hit
mcp_instructions                   = turn 间可变           ─→ DANGEROUS 永远 miss
session_context                    = 工业 BOUNDARY 之后    ─→ 不进 Anthropic cache，每轮重传
BOUNDARY sentinel                  = chunk 之间 manifest   ─→ 下游 cache 引擎物理分割
```

**system prompt 不是字符串，是 build artifact**。chunk splitting 的本质是"按变化频率分组"——v10 sectionCache 的本质也一样。

## 概念地图：4 论断 → 4 实施位置

```
论断 1: memoization 默认开 + DANGEROUS opt-out (cache 默认安全)
   → §19 systemPromptSection (cacheBreak: false) + DANGEROUS_uncachedSystemPromptSection (cacheBreak: true)

论断 2: _reason 类型系统 self-audit (review-time 强制 disclaimer / runtime 不消费)
   → §19 工厂第 3 参数 `_reason: string` 必填 + 下划线前缀

论断 3: clearSystemPromptSections 在 maybeCompact 末尾 (语义因果链)
   → §7 maybeCompact 函数末尾 + 末尾不是开头 (避免浪费已建立的 cache)

论断 4: BOUNDARY sentinel 是下游 cache 物理分割点
   → §21 assembleSystemPrompt 返回 { prefix, suffix } 两段 + audit 输出两段长度
```

## §19: SystemPromptSection 子系统内核

@include(./agent-v10-system-prompt.ts, section=19)

3 个关键技术决策：

1. **`sectionCache` 选 `Map<string, string>` 而非 closure cache**：闭包 cache 在每次工厂调用时重建，跨 turn 持久失败。Module-scoped Map 是工业标准（对照 `bootstrap/state.ts:203`）
2. **DANGEROUS 不绕过 cache 写入！它只是跳过 cache 读取**：line 47 `sectionCache.set(s.name, value)` 对 DANGEROUS section 也执行。这意味着 DANGEROUS section 也会留一份"上次的副本"，只是下次永远不读它——工业语义跟 v10 1:1
3. **`_reason: string` 是 review-time 强制 disclaimer**：下划线前缀告诉 TS/ESLint "故意 unused"。runtime 不消费这个值——它的全部价值在 review 时强制开发者说服自己"这段为什么必须每轮重算"。这跟 v6 task 06 的 hook handler "必填 reason" 同源——**类型系统替代代码审查 checklist**

## §20: 6 个 prompt section 注册

@include(./agent-v10-system-prompt.ts, section=20)

6 段安排（v10 教学版 vs 工业偏离）：

| section | v10 安排 | 工业 prompts.ts:491-555 安排 |
|---|---|---|
| `core_instruction` | BEFORE | static 字符串函数（绕过 sectionCache）|
| `tool_list_hint` | BEFORE | static 字符串函数（绕过 sectionCache）|
| `env_info` | BEFORE memoized | AFTER dynamicSections / memoized |
| `mcp_instructions` | BEFORE DANGEROUS | AFTER dynamicSections / DANGEROUS |
| `memory` | BEFORE memoized | AFTER dynamicSections / memoized |
| `session_context` | AFTER memoized | （工业无此对应段，per-turn instructions 由其他机制注入）|

**为什么 v10 把 5 dynamic section 放 BEFORE_BOUNDARY？** 为了让 sectionCache 命中现象在 audit 中可视化（5 hit + 1 miss 一目了然），代价是 BOUNDARY 切分语义偏离工业。学生学完应理解这是教学化简、不是工业默认。

**`mcp_instructions` 的 `_reason` 字符串**：保留工业前缀 `"MCP servers connect/disconnect between turns"` + 加教学解释后缀 `"; instruction state may diverge from cached value"` —— 工业版 reason 单句更简洁，v10 加后缀让 review 时学生看到完整动机。

## §21: assembleSystemPrompt + BOUNDARY 切分

@include(./agent-v10-system-prompt.ts, section=21)

3 个 audit 输出策略：

1. **`[CACHE hit=X/N miss=Y/N cache_size=Z]`**：核心指标，单行汇总，让 cache 工作状态一目了然
2. **`[CACHE hit-sections=...] / [CACHE miss-sections=...]`**：分别列出哪些段命中 / 哪些段未命中——可在 run-log 一眼定位"为什么本轮 mcp_instructions 又 miss 了"
3. **`[BOUNDARY prefix=N_chars / suffix=M_chars]`**：两段长度让学生眼见 cache 边界。工业上 prefix → scope:'global'（跨组织 Anthropic cache）/ suffix → scope:null（不进 cache，每轮 API 重传）

教学决策：v10 **不**真发 `cache_control` 到 API——DeepSeek Anthropic 兼容端点未必支持。只 audit 让学生眼见。如果切到真 Anthropic API，下游 `splitSysPromptPrefix` 会读这两段长度并发 `cache_control: { type: "ephemeral" }`。

## §22 改造：maybeCompact 末尾的 clearSystemPromptSections

v10 在 v9 的 maybeCompact 函数末尾加了 6 行（不算注释）：

```typescript
clearSystemPromptSections("compact");
```

为什么放末尾而不放开头？

**末尾派**（v10 + 工业）：cache 的有效寿命 = 从首次 compute 到 compact 触发的全部 round
**开头派**（错误设计）：cache 寿命 = 从首次 compute 到下次 maybeCompact 调用（即使本轮不真触发 fullCompact）

工业 `src/services/compact/postCompactCleanup.ts:62` 的位置是 compact "post" 阶段调用——跟 v10 末尾派一致。

为什么 compact 必须 clear？compact 后会话语义状态变化（早期 tool_result 内容被砍 / messages 数组重排），section compute fn 可能依赖旧上下文（如 `memory` section 可能根据近期对话内容动态生成）。cached value 瞬间 stale，必须强制重算。**这是语义因果链，不是缓存优化技巧**——cache 不清，下一轮 system prompt 跟新 messages 状态对不上号，model 会被"上轮的 system 描述" + "新轮的 user/assistant 历史"夹击产生 confusion。

## run-log cache-warm：4 论断字面证据

@include(./run-log-cache-warm.txt, round=1)

Round 1 启动阶段 audit 行清晰呈现整个 system prompt 子系统的工作过程：

```
[CACHE bootstrap] sectionCache initial size=0 (expected 0)
[CACHE bootstrap] registered sections: core_instruction, tool_list_hint, env_info, mcp_instructions[DANGEROUS], memory, session_context
[CACHE hit=0/6 miss=6/6 cache_size=6]          ← bootstrap 全 cold
[CACHE miss-sections=core_instruction,tool_list_hint,env_info,mcp_instructions,memory,session_context]
[BOUNDARY prefix=743_chars / suffix=98_chars]   ← 切分边界可见
```

然后 Round 1 model 开始读文件 → Round 2 / Round 3 system prompt 重新 assemble：

@include(./run-log-cache-warm.txt, round=2)

Round 2 关键证据：`[CACHE hit=5/6 miss=1/6 cache_size=6]` + `miss-sections=mcp_instructions`——**5 段全 hit + 唯独 DANGEROUS 段 miss**。这字面证明了 4 论断中的论断 1（memoization 默认开）+ 论断 2（DANGEROUS opt-out）+ 论断 4（BOUNDARY 切分稳定）。

## run-log compact-clear：cache 清空的字面因果链

@include(./run-log-compact-clear.txt, round=5)

Round 5 是核心证据所在。Round 4 末尾的 maybeCompact 检测 `rounds.length=5 > MAX_ROUNDS_BEFORE_FULL_COMPACT=4`，触发 fullCompact。fullCompact 完成后立刻字面 audit：

```
[HOOK event=PostCompact handler=log-post-compact kind=function outcome=success ok=true ...]
[CACHE cleared by compact: 6 entries dropped]   ← clearSystemPromptSections 字面命中
[CACHE hit=0/6 miss=6/6 cache_size=6]            ← 紧跟下一次 assemble = cold start
[CACHE miss-sections=core_instruction,tool_list_hint,env_info,mcp_instructions,memory,session_context]
```

时序的精确性是关键证据：`cleared by compact` → `hit=0/6` 这两行紧挨着出现，证明 clear 真把 cache 砍光。然后 Round 5 的 assemble 真去执行了 6 个 compute fn。

Round 6 又恢复 `hit=5/6 miss=1/6`——compact 后第 2 轮 assemble 立刻命中。**cache 不是一次清空就永久死掉，它在 clear 后立刻进入新一轮 warmup 周期**。

## v9 同权论断的还账：cache 经济同权债

v9 验证了同权 4 论断（dispatch / permission / hook / obs）。v10 揭示第 5 个维度——cache 经济同权——并不真"同权"：

| 维度 | v9 已验证 | v10 揭示 |
|---|---|---|
| dispatch 入口 | MCP tool 走 execute() 同分支 ✅ | 无差异 |
| permission gate | modeMatrix 对 MCP tool 同样判决 ✅ | 无差异 |
| hook 触发 | PreToolUse/PostToolUse 自动触发 ✅ | 无差异 |
| obs 命中 | OBS METRIC `tool_name=mcp__mock__*` ✅ | 无差异 |
| **cache 经济** | ?（v9 没设计 cache）| **mcp_instructions DANGEROUS_uncached 必每轮 miss** ❌ |

v9 同权论断让 MCP tool 享受到了 dispatch 的所有 affordance，但代价是 cache 经济差——**dispatch 同权付费在 cache 上**。每个 turn 都要重新 compute `getMcpInstructionsSection(mcpClients)` 检查 server 当前连接状态。

## v10 偏离工业的两个化简（教学清晰度优先）

1. **BEFORE_BOUNDARY / AFTER_BOUNDARY 分布**：v10 把 5 dynamic section 放 BEFORE_BOUNDARY 让 cache 命中可视化；工业 `prompts.ts:560-576` 的 dynamicSections 全在 BOUNDARY 之后 cacheScope:null。**学生学完应理解这是教学化简**
2. **不真发 cache_control 到 API**：v10 只 audit 输出两段长度，不真在 Anthropic API 的 `system` 字段写 `cache_control: { type: "ephemeral" }`。理由：DeepSeek 端点未必支持，且教学版重点不在 cache 真实命中率而在 cache 边界的物理分割

## 工业 vs v10 决策对照表

| 工业细节 | v10 决策 | 理由 |
|---|---|---|
| 11+ section 注册 | 简化到 6 | 教学复杂度 |
| `splitSysPromptPrefix` 4-block 切分 | 简化到 `{ prefix, suffix }` 2-block | 重点在边界存在，不在 4-way 路径 |
| `cacheScope: 'global' / 'org' / null` 三档 | 不实现，仅 audit 长度 | 端点不支持 |
| 4 个 clearSystemPromptSections 调用点 | 只保留 compact 一个 | 其他 3 个跟教学重点无关 |
| `getSystemPrompt()` 返回 `string[]` 经多层 transform | 直接返回 `{ prefix, suffix }` | 减少抽象层 |
| Section value 类型 `string \| null` | 简化为 `string` | `null` 语义（"本段不输出"）教学版用不到 |

## 下节预告（task 11+ 候选）

- **Skill 系统**（如何从 `.claude/skills/<name>/` 加载 SKILL.md + frontmatter + tools allowlist）
- **Slash command 系统**（`/clear / /compact / /skill <name>` 等 inline 命令的注册与 dispatch）
- **子 agent 资源管理**（TaskCreate / TaskUpdate / TaskList 工具背后的子 task 生命周期）
- **Plugin 系统**（第三方 plugin 注入 tools / hooks / sections 的协议）
- **Final 拼装**（v1-v10 完整组件做 mini 工程演示）

v10 是 mini-工具最后一块系统化拼图——system prompt 子系统化后，agent harness 的 5 大子系统（permission / compact / hook / observability / streaming / system-prompt）已全部齐备。final/ 会把它们 assembled 成完整可运行版本。
