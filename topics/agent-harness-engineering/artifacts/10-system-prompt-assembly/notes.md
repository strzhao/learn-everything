# v10 实现笔记：System Prompt Assembly Engine

## §1. 工厂函数签名设计：`_reason` 不是修辞

```typescript
function systemPromptSection(name: string, compute: ComputeFn): SystemPromptSectionDef
function DANGEROUS_uncachedSystemPromptSection(name: string, compute: ComputeFn, _reason: string): SystemPromptSectionDef
```

**为什么必填 `_reason`，又为什么加下划线？**

工业 `src/constants/systemPromptSections.ts:30-37` 签名 1:1 对应。`_reason: string` 的设计意图是**类型系统强制的 review-time disclaimer**：

- **强制必填**：编译器拦截"忘了写理由就用 DANGEROUS"——任何 `DANGEROUS_uncachedSystemPromptSection("foo", fn)` 三参版本会 TSC 报错
- **下划线前缀**：TypeScript/ESLint 约定，下划线开头的参数是"故意 unused"信号，runtime 永远不消费这个值
- **效果**：用户必须**在 review 时**说服自己（和 reviewer）"这段为什么必须每轮重算"——通常是 server-state-dependent 或 user-input-dependent，cache 副本会 stale

这条设计跟 v6 task 06 的 hook handler "必填 reason 字段"同源——都是用类型系统替代代码审查 checklist。**类型签名是契约，不是文档**。

## §2. memoization 数据结构选择

候选三种：
| 选项 | 优点 | 缺点 | 工业选择 |
|---|---|---|---|
| `Map<string, string>` | name 作 key 天然唯一 / 跨调用持久 / 可显式 clear | 模块级全局可变状态 | ✅ 工业用 |
| `WeakMap<SectionDef, string>` | 自动 GC 释放 | section 永不被回收（module top-level 永生），WeakMap 没意义 | ❌ |
| Closure cache（每 factory 自带）| 局部性好 | 不能跨 factory 共享 / 难以 clear all | ❌ |

工业 `bootstrap/state.ts:203` 字面 `systemPromptSectionCache: Map<string, string \| null>`——选 1。**关键**：value 类型是 `string \| null`（compute 可能返回 null 表示"这段本轮不输出"），v10 教学版用 `Map<string, string>`（compute 永远返回 string）简化。

注意：选 closure cache 会有一个隐藏 bug——工厂函数每次被调用时 closure 重建，cache 失效。这是 v10 选 module-scoped `Map` 而不是工厂内 closure 的根本原因。

## §3. BOUNDARY 切分方向：lesson 10 讲不精确处的修正

讲 lesson 10 时我描述为"BOUNDARY 之前是 cacheable / 之后是会话隔离"——方向是对的，但**精度**待修正：

**工业实际**（`utils/api.ts:321-360` splitSysPromptPrefix）：
- BOUNDARY 之前 → `cacheScope: 'global'`（Anthropic prompt cache + 跨组织共享）
- BOUNDARY 之后 → `cacheScope: null`（**不进 Anthropic cache**，每轮 API 完整重传）

`cacheScope: null` 不是"会话隔离的小 cache"，是"根本不 cache"。后段每轮都是 fresh string，API 端不做 cache 对比。

**为什么这么设计？** 后段是 per-session dynamic context（如 token budget / per-turn instructions），频繁变化，缓存的命中率低且失效频繁，cache 反而是负收益——直接不 cache 更简单。

**v10 教学版的偏离**：`PROMPT_SECTIONS_BEFORE_BOUNDARY` 放了 5 段（含 `mcp_instructions` DANGEROUS），`PROMPT_SECTIONS_AFTER_BOUNDARY` 只放了 1 段（`session_context`）。工业实际 `getSystemPrompt()` 的 array literal 是 `[...static_functions, BOUNDARY, ...dynamic_sections]`——dynamic_sections（含 mcp_instructions）全在 BOUNDARY 之后。v10 这么放是为了让 sectionCache 命中现象在 audit 中可视化（5 hit + 1 miss 一目了然），代价是 BOUNDARY 切分语义偏离工业。在 lesson 11 学新概念前**学生应理解这是教学化简，不是工业默认**。

## §4. `clearSystemPromptSections` 在 maybeCompact 末尾 vs 开头

我把 `clearSystemPromptSections("compact")` 放在 `maybeCompact` 函数的**末尾**（fullCompact + PostCompact hook 之后）。为什么不放开头？

放开头会浪费上一轮已经计算好的 cache。考虑两种时序：

**末尾派**（v10 + 工业）：
```
round N callModel(系统 prompt 还是 warm) → maybeCompact → fullCompact → clear → round N+1 cold start
```

**开头派**（错误设计）：
```
round N → maybeCompact → clear → 上一轮的 cache 直接被丢 → 但 fullCompact 还要计算 → round N+1 cold start
```

差别看似只是顺序，实际上影响很大：**末尾派**让 cache 的有效寿命覆盖从首次 compute 到 compact 触发的全部 round；**开头派**让 cache 只覆盖到下次 maybeCompact 调用之前。

工业 `src/services/compact/postCompactCleanup.ts:62` 的位置是 compact "post" 阶段调用的，跟 v10 末尾派一致。

## §5. v9 同权论断的隐藏代价：cache 经济同权债

v9 (Task 09) 验证了同权 4 论断：MCP tool 复用 dispatch / permission / hook / obs 管道。但**lesson 10 埋的最深钩子**是："dispatch 路径同权 ≠ cache 经济同权"。

v9 教学版无 cache 系统，看不到这条债。v10 引入 sectionCache 后债面化：

| 维度 | v9 同权（已验证）| v10 揭示的不同权 |
|---|---|---|
| dispatch 入口 | MCP tool 走 execute() 同分支 ✅ | 无差异 |
| permission gate | modeMatrix 对 MCP tool 同样判决 ✅ | 无差异 |
| hook 触发 | PreToolUse/PostToolUse 自动触发 ✅ | 无差异 |
| obs 命中 | OBS METRIC `tool_name=mcp__mock__*` ✅ | 无差异 |
| **cache 经济** | ?（v9 没设计 cache） | **mcp_instructions 必 DANGEROUS_uncached** ❌ |

工业 `prompts.ts:530` 给 mcp_instructions 标的 `_reason` 字面是 `"MCP servers connect/disconnect between turns"`——意思是 server 列表会在 turn 间动态变化，缓存的字符串瞬间 stale，必须每轮重算。**v9 同权论断让 MCP tool 享受到了 dispatch 的所有 affordance，但代价是 cache 经济差**——dispatch 同权付费在 cache 上。

run-log-cache-warm.txt 字面证据：`miss-sections=mcp_instructions` 在 Round 1/2 都出现，跟其他 5 段 hit-sections 形成对比。

## §6. 改动统计 + 工业对照速查

### 改动统计（v9 730 → v10 889 行 = 159 新增/改造）

| 段 | 改动 | 行数 |
|---|---|---|
| 顶部注释 | v9 → v10 描述 | ±6 |
| §7 maybeCompact 末尾 | 加 6 行 `clearSystemPromptSections("compact")` + 注释 | +6 |
| §10 runRounds 签名 | system: string → systemAssembler: () => Promise<{prefix,suffix}> | +6 改 |
| §10 runRounds 内部 | 每轮 await assembler + 拼接 prefix+suffix | +5 |
| §10 runSwarm/runCoordinator/runInteractive | SYSTEM_PROMPT → assembler 函数 | ±15 |
| §13 SYSTEM_PROMPT 字符串 | 删除 + 加 3 行注释说明 | -5 +3 |
| §19 新增子系统内核 | sectionCache + 2 工厂 + clear + resolve | +49 |
| §20 新增 section 注册 | BEFORE 5 + AFTER 1 共 6 section | +48 |
| §21 新增 assembler | assembleSystemPrompt + BOUNDARY_SENTINEL + audit | +24 |
| §22 启动入口 | 加 USE_CACHE_AUDIT + bootstrap audit + final audit | +13 |
| **总计** | | **+159 改造** |

### 工业对照速查（7 个对照点）

| v10 教学版 | 工业 claude-code | 文件:行 |
|---|---|---|
| `systemPromptSection(name, fn)` | 同名同签名 | `src/constants/systemPromptSections.ts:20-26` |
| `DANGEROUS_uncachedSystemPromptSection(name, fn, _reason)` | 同名同签名 | 同文件:30-37 |
| `sectionCache: Map<string, string>` | `STATE.systemPromptSectionCache: Map<string, string\|null>` | `src/bootstrap/state.ts:203,399` |
| `clearSystemPromptSections(reason)` | `clearSystemPromptSectionState()` | 同文件:1651-1654 |
| `resolveSystemPromptSections(sections)` | 同名同签名 | `src/constants/systemPromptSections.ts:43-58` |
| `BOUNDARY_SENTINEL = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__"` | 同名字面值 | `src/constants/prompts.ts:114-115` |
| `clearSystemPromptSections("compact")` 调用位置 | `runPostCompactCleanup() → clearSystemPromptSections()` | `src/services/compact/postCompactCleanup.ts:31-62` |

### v10 砍掉的工业复杂度（教学版决策）

- 工业 11+ section（session_guidance / output_style / language / scratchpad / frc / summarize_tool_results / token_budget / 等）→ v10 简化为 6
- 工业 `splitSysPromptPrefix` 4-block 切分（attribution + prefix + static + dynamic）→ v10 简化为 2-block（prefix + suffix）
- 工业 `cacheScope: 'global' / 'org' / null` 三档 → v10 不真发 `cache_control` 到 API（DeepSeek 端点未必支持），只 audit 输出两段长度
- 工业 4 个 clearSystemPromptSections 调用点（compact / worktree-enter / worktree-exit / undercover-detect）→ v10 只保留 compact 一个
- 工业 `getSystemPrompt()` 返回 `string[]` 经多层 transform 才到 API → v10 直接返回 `{ prefix, suffix }` 一步到位
