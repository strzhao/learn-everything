# Notes — v13 Mini Project-Memory System 实现笔记

## §1 改动统计

| 段 | 类型 | 行数 |
|---|---|---|
| 头注释（line 1-26）| 重写 v12→v13 | 26 |
| §27/§28/§29/§30/§31 新增段（line 887 之前插入）| 新增 | ~165 |
| §3 PROMPT_SECTIONS memory 占位填充 | 改 4 行 | -3 +4 |
| §5 read_file mock → 真读 + nested 触发 | 改 1 行 → 多行 | -1 +10 |
| §7 maybeCompact 末尾 clearMemoryCache | 加 2 行 | +2 |
| §10 runRounds toolResults 后追加 nested attachment 注入 | 改 1 行 → 多行 | -1 +6 |
| §32 lru-busy demo 函数（dispatch 前）| 新增 | ~30 |
| **总计** | v12 1334 → v13 1529 | **+195 行** |

**spec 估 +197 行 / 实际 +195 / 误差 1%。架构正交性第 7 次验证物理证据**：v12 §1-26 字面 0 修改（除 4 处共 +12 行最小侵入）。

## §2 工业对照速查（8 项）

| 工业组件 | file:line | v13 教学等价 |
|---|---|---|
| `processMemoryFile` 加载入口 | `claudemd.ts:618-625` | `loadMemoryFiles` (§27) |
| 三层加载顺序 Managed→User→Project→Local | `claudemd.ts:790-934` | 简化为 User→Project root→CWD cascade→Local |
| Project root→CWD cascade | `claudemd.ts:878-920` | §27 projectDirs unshift loop |
| `safelyReadMemoryFileAsync` TOCTOU | `claudemd.ts:424-436` | §30 `safelyReadMemoryFile` try/catch return null |
| 上轨 systemPromptSection('memory') | `prompts.ts:495` | §3 替换 v12 mock string → `loadMemoryPrompt()` |
| 下轨 nested_memory case | `messages.ts:3700-3707` | §10 `<system-reminder>\nContents of...` text block append |
| 4 阶段 nested 加载处理 | `attachments.ts:1792-1862` | §28 简化只走 Phase 3 nested directories |
| Session-Set + readFileState LRU 双层 dedup | `Tool.ts:217-225` + `attachments.ts:1718-1750` + `fileStateCache.ts:30-93` | §29 `loadedNestedMemoryPaths` Set + 自实现 LRU 8-entry Map |
| compact-triggered cache clear | `compact.ts:521-522`（full）/ `:920-921`（partial）+ `postCompactCleanup.ts:25,52-54` | §31 `clearMemoryCache` 清 memoryCache + LRU + **Session-Set 三者**（对齐工业：readFileState 与 loadedNestedMemoryPaths 绑一起 clear）|
| every-line-test 立法门槛 | `init.ts:97` + `:110-117` | demo-project/CLAUDE.md 6 条规则全 pass test |

## §3 双重 dedup 工程必要性详解（论断 3 深化）

**为什么单 LRU 不够**：

LRU 的核心承诺是"被驱逐 = 不再用"—— 这对 model 主动访问的文件成立（你 30 轮没 Read，确实没在用）。但 CLAUDE.md **不是 model 主动访问的** —— 是系统通过 cascade（启动）或 FileReadTool 触发器（运行时）**自动注入**的。

LRU 把 CLAUDE.md 驱逐 → 下次 nested 加载又触发它（依然由系统而非 model 触发）→ 它又被注入 → cache prefix 距离中断 → prompt cache 失效 → 重复扣 token。

**单 LRU 不是 bug 是 LRU 抽象覆盖不到这类访问模式**。Session-Set 处理 LRU 抽象之外的另一类需求 —— 不是给 LRU 修 bug，是另一层独立防御。

跟 task 02 sandbox+permission 双层防御**完全同源**：sandbox 防文件系统逃逸 / permission 防 prompt injection / 两层针对不同攻击向量 / 不是冗余。

run-log-dedup-busy-session.txt 字面演示：
- 阶段 1: 9 次 add 让 LRU 8 entry 触顶 / dir-1 被驱逐 / Session-Set 9 个全保留
- 阶段 2: dir-1 不在 LRU（false）/ 在 Session-Set（true）
- 阶段 3: 同 path 重新 attempt → Session-Set 拦截 → `[DEDUP] ... already in session-set, skipping`

## §4 砍掉项详解（11 项工业特性教学化简）

| 工业特性 | v13 决策 | 详细理由 |
|---|---|---|
| 4 层加载（Managed `/etc/claude-code` + User + Project + Local）| 3 层（去 Managed）| Managed 是企业部署场景 / 跟 User 机制相同 / 教学版砍 |
| Project 内部 root→CWD cascade | **保留**（user 反馈点 2）| monorepo 场景必需 / 演示后加载者优先最直接 |
| 三套独立缓存（getMemoryFiles memoize + getUserContext memoize + cachedClaudeMdContent state）| 单 `memoryCache: Map<string, MemoryFile[]>` | 工业避免 yoloClassifier→permission→claudemd 循环依赖 / 教学版无此压力 |
| readFileState LRU 100 entry / 25MB 字节双限 | LRU 8 entry / 不实 25MB 字节限 | 8 entry 演示驱逐场景 / 25MB 字节限是大文件兜底防御 / 教学版砍但注释 |
| `MemoryFile` 完整字段（path/type/content/parent/globs/contentDiffersFromDisk/rawContent）| 简化 `{path, type, content, contentDiffersFromDisk:false}` | parent/globs 服务条件激活 / contentDiffersFromDisk 服务 strip 检测 / 教学版不实 strip 全设 false |
| `processedPaths` Set 防递归 | 不实现 | 教学版 nested 不支持递归 import 链 |
| `safelyReadMemoryFileAsync` 多种错误分类 | try/catch return null | TOCTOU 核心是"不预检查" / 错误分类是健壮性补丁 / 教学版砍 |
| `isInjectedMemoryFile` filter（防 system prompt 重复注入 nested）| 不实现 | 教学版上轨只 cascade User+Project+Local 三层主文件 / nested 永远走下轨 |
| `--add-dir` 多目录支持 | 不实现 | 单 cwd 覆盖核心机制 |
| Auto-memory（memdir）/ team-memory / Managed conditional rules | 不实现 | 跟 CLAUDE.md 子系统正交 / 属另一学习主题 |
| `/init` 命令 + OLD/NEW INIT_PROMPT 全文 | 不实现命令 / demo 实践 every-line-test | 命令本身工程量大 / 教学版用重写 demo CLAUDE.md 物理证明 every-line-test |

## §5 5 份 run-log 串读

### run-log-eager-load.txt（21 行 / 起步版 / stub config）
启动期 [MEMORY LOAD] 字面证据 / 后续 fetch failed（stub URL invalid）/ 起步阶段证明上轨 wiring 工作。

### run-log-root-to-cwd-cascade.txt（39 行 / DeepSeek API）
cwd=demo-project/packages/foo 启动 / 5 层 cascade 全部加载 / model thinking 字面引用 packages/foo/CLAUDE.md 规则原文 / 输出 `[ROOT-RULE][FOO-PKG] hello world`。**论断 1+2 物理证据**。

### run-log-nested-trigger.txt（91 行 / DeepSeek API / 含真 bug 修复）
cwd=demo-project / model read_file ./subdir/file.ts → triggers Set 登记 → 下一轮 [NESTED INJECT] / 三层规则同时生效 `[LOCAL-OVERRIDE] task done [NESTED-LOADED]` / Round 1 显示原 prepend 实现失败的 API 报错（修复后 append-only）。**论断 1+2+5 物理证据 + 真 bug 修复纪录**。

### run-log-compact-reload-fix.txt（compact-reload demo / 不调 API）
seed 5 层 memory 进 dedup 闸门 → `clearMemoryCache()` 三者全清 → 闸门 `.has()` 由 true 翻 false → 下一轮全层重注。**论断 4 物理证据（§31 compact 清三者 → 闸门重开 → 重注）**。

### run-log-dedup-busy-session.txt（lru-busy demo / 不调 API）
9 次 nested attempt → LRU 8 entry 触顶 → dir-1 驱逐 → Session-Set 9 个全保留 → 同 path 重 attempt 被 Session-Set 拦截。**论断 3 物理证据**。

## §6 真 bug 修复纪录（工业洞察来源）

**Bug**：§10 wiring 把 nestedReminders prepend 到 toolResults 之前。

**报错**（run-log-nested-trigger.txt 旧版 Round 2）:
```
messages.2: tool_use ids were found without tool_result blocks immediately after:
  call_00_SBWZphR5UCCx8kPOmivb3183.
Each tool_use block must have a corresponding tool_result block in the next message.
```

**修复**：`[...toolResults, ...nestedReminders]`（append 而非 prepend）/ 让 toolResults 紧跟 tool_use。

**工业洞察**：现在回头看 `messages.ts:3700-3707` 把 nested_memory 转**独立 isMeta user message** 不是为了 isMeta semantics —— 是为了**避开 tool_use→tool_result 位置约束**！独立 message 没有这个问题，可以用 system-reminder wrap 自由编排。教学版用同一 user message append 也工作 / 但条件是必须 toolResults-first 顺序。

**这次踩坑反向揭示工业实现的隐藏动机** —— spec 文档没写 / 真跑才发现。验证 0 假设原则：spec 写得再细也不能替代真跑物理验证。

## §7 v13 教学偏离工业（合规清单）

详见 lesson.md "工业偏离教学化简（合规清单）" 段。

关键偏离需要 lesson 标注：
1. **上轨 cascade 也查 Session-Set**（工业不查）—— 把 User/Project/Local 主层也接进统一 dedup 的教学化简。因 §31 compact 时三者一起清，主层下一轮照常重注，无副作用。
2. **nested_memory 同 user message append**（工业独立 isMeta message）—— 避开 tool_use→tool_result 位置约束需要 toolResults-first 顺序

## §5 compact 为什么必须清 Session-Set

compact 抹掉持有 nested CLAUDE.md 注入内容的历史 messages，内容随之蒸发。Session-Set 同时把守上轨 Project cascade（line 992）和下轨 nested（line 1047）的 dedup 闸门 —— 闸门若不重开，path 永远命中 `.has()` → 永不重注 → 指令永久丢失。

**工业 ground truth**：`src/services/compact/compact.ts:521-522`（full / `compactConversation`）与 `:920-921`（partial）两条路径都是：
```ts
const preCompactReadFileState = cacheToObject(context.readFileState) // 先快照
context.readFileState.clear()
context.loadedNestedMemoryPaths?.clear()                            // 闸门一起重开
// ... createPostCompactFileAttachments(preCompactReadFileState, ctx, 5) 再回灌最近 5 文件
```
对比 `:524-529` 注释明确 sentSkillNames **故意不清**（skill content 另由 invoked_skills attachment 保留）—— 两类 dedup 区别对待，正说明清 nested dedup 是刻意为之，目的就是 post-compact 重注。

**两种"不清"分清**：
- Session-Set 对 **LRU 驱逐**免疫（non-evicting / `attachments.ts:1719`）—— 这是它相对 LRU 的存在意义（论断 3 lru-busy demo 证明的层）。
- Session-Set 对 **compact** 不免疫 —— compact 是会话语义重置，注入内容已蒸发，必须重开闸门。

**mini 重注路径**：上轨 `loadMemoryFiles` 缓存 miss 重算（每轮装配 system prompt 自动触发）/ 下轨按 FileReadTool trigger 重注。工业额外有 `createPostCompactFileAttachments` 立即回灌 top-5，mini 不实现（"走到哪触发哪"语义足够，下一轮自然重注）。`--demo=compact-reload` 确定性证明闸门 `.has()` 翻转（不调 API）。

## §8 task 13 设计哲学下半场总结

**every-line-test 实践**：demo-project/CLAUDE.md 6 条规则 / 每条附判例 + How to apply / 砍掉 4 条候选规则（标准约定 / 抽象原则 / 文件结构 / 团队规范）。

**reflection（lesson.md 已详述）**：批判 learn-everything 自身 CLAUDE.md / 最强 2 条（0 假设原则 + why/how 优先于 what 原则）/ 可砸掉 1-2 条（代码风格段 + 仓库结构 ASCII tree）。

**核心结论**：CLAUDE.md = prompt 软契约的最浓密物理载体 / 跟 v6 hook reason / v10 cacheBreak / v11 INLINE_PATTERN / v12 TodoWrite 不变量同源 / 但 CLAUDE.md 把范式推到极致 —— **不仅约束写在 prompt，连"什么样的约束值得写"的元约束也写在 prompt 里**（every-line-test 是元约束）。这是 v6/v10/v11/v12 软契约线索的最浓密物理载体。
