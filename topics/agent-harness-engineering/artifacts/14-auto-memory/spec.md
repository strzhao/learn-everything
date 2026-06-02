# Task 14 Spec: v14 Mini Auto Memory System

> v13 给了 agent **项目级硬约束记忆**（CLAUDE.md / 人手维护 / git tracked）。v14 加最后一层——**agent 自己学着记住的个人画像 / 项目临时态 / 外部指针**：auto memory。它复用 v10 systemPromptSection（接 MEMORY.md 索引上轨）+ v11 wrapMessagesInSystemReminder（接 relevant_memories attachment 下轨）+ v4 fork sub-agent（接 background extraction agent 兜底）—— **架构正交性第 8 次验证**。核心分水岭：**双轨并发互斥** ≠ 单轨 prompt 协议（v12/v13 同源）≠ 单轨 runtime 提取（独立 sub-system），而是 prompt 协议主路径 + runtime fork 兜底路径，互斥而非流水线。

## 目标

在 v13 1529 行之上加 ~200 行实现 mini auto memory 系统，验证 5 个核心论断：

1. **分水岭：双轨并发互斥**——主 agent 用 prompt 协议（system prompt 给完整 save instructions / 用 FileWriteTool 写 `.md` 文件 / 跟 v12 TodoWrite 软契约同源 / **没有 MemoryWriteTool 专用工具**）+ stop hook 触发 background extraction agent（forked sub-agent / 共享主对话 prompt cache / 最大 5 轮 / 权限仅写 memory 目录）。**互斥逻辑**：`hasMemoryWritesSince` 检查主 agent 是否在本 turn 已写了 memory → 已写则 background 跳过（避免重复）。工业对照：`extractMemories.ts:7-8` 注释字面 "The main agent's prompt has full save instructions — when it writes memories, the forked extraction is redundant" + `:118-148` `hasMemoryWritesSince` + `:348-360` skipping log

2. **双轨注入：索引常驻 + 内容按需**——MEMORY.md 索引走 system prompt section（v10 工厂字面不动 / cache-stable / 一行 `[Title](file.md) — one-line hook` / 限 200 行 25KB）+ 单条 memory 走 relevant_memories attachment（v11 通道字面不动 / per-turn helper 选 5 条 / `<system-reminder>` 包裹）。这是 v13 双轨注入第二次显形，结构同型。工业对照：`prompts.ts:495` `systemPromptSection('memory')` + `messages.ts:3708-3722` `case 'relevant_memories'` + `findRelevantMemories.ts:39-75` Sonnet 选择器

3. **双层 dedup = v13 双重 dedup 同源**——Layer 1 `readFileState` 检查（model 已用 Read 工具读过的不再 surface / 避免重复给 model 看相同内容）+ Layer 2 `collectSurfacedMemories` 检查（attachment 已 surface 过的 path 不再 surface / 避免 attachment 重复占 context）。**单层不够**：单 readFileState 漏跨大 turn 段（attachment 早被 truncate / readFileState 还在）/ 单 collectSurfacedMemories 漏 model 已读但选择器又选了。工业对照：`attachments.ts:2520-2541` `filterDuplicateMemoryAttachments` 双层 + `:288` `MAX_SESSION_BYTES = 60 * 1024`

4. **cache 经济极致 = v9/v10 cache 经济第三次显形**——(a) memoryHeader 注入前预算（`messages.ts:3715` 避免 render 时 `Date.now()` 变化破 cache）/ (b) memoryAge 用 `"3 days old"` 文本而非 ISO timestamp（`memoryAge.ts:15` / 同一文件相邻 turn age 文本相同 → cache 稳）/ (c) **forked extraction agent 共享主对话 prompt cache**（`extractMemories.ts:415-427` `runForkedAgent()` / 不重建 prefix / 完全免费搭便车）—— v10 cache 经济在 sub-agent 层的极致体现

5. **类型四分软契约 = 软契约第六次显形**——user / feedback / project / reference 四类，system prompt 各有独立 `when_to_save` / `how_to_use` / `examples`（`memdir.ts:199-266`）。Frontmatter `type` 字段**可选**（`memoryTypes.ts:28-31` 缺失返 undefined 容错 / 向后兼容）。**NO RUNTIME ENFORCEMENT** —— 全靠 model 自律。注释 `memoryTypes.ts:182-194` 明确禁止保存可推导内容（代码模式 / 架构 / git 历史），但**无强制**。这是 v6 hook reason → v10 cacheBreak reason → v11 INLINE_PATTERN → v12 TodoWrite 不变量 → v13 every-line-test → **v14 类型四分**软契约线索的第六次显形

## 教学复杂度控制（工业砍掉项）

| 工业特性 | v14 决策 | 理由 |
|---|---|---|
| Sonnet helper model 做相关性选择（`findRelevantMemories.ts:39-75` 调 Sonnet API + JSON schema 输出 5 条 path） | **简化为规则化 selector**（mtime 倒序 + 用户消息关键词包含匹配 / 取前 5 条） | 教学版避免外部 API 依赖；helper call 的"独立 head 不污染主 reasoning"概念已在 socratic 19 内化；用 disclaimer 标偏离 |
| `~/.claude/projects/<sanitized-git-root>/memory/` 路径 + `paths.ts:223-235` 沙箱化路径 | 简化为 `demo-project/.claude-memory/` | 避免污染用户真实 `~/.claude` / 演示环境隔离 |
| 60KB session cap（`MAX_SESSION_BYTES = 60 * 1024`）| 简化为 5 文件硬上限（每次 prefetch 最多 surface 5 条） | 文件数易演示驱逐场景；字节 cap 是工业生产保护机制 |
| 200 行 / 25KB MEMORY.md 上限 + 截断 + WARNING（`memdir.ts:35-103`） | 保留 MEMORY.md 索引文件但不实现截断 | 索引存在 + 一行一条格式核心保留；超限保护是健壮性 |
| 双轨写入互斥（hasMemoryWritesSince 检查 last cursor）| **完整实现**（核心论断 1 物理证据）| 这是分水岭题答案 / 教学心智模型核心 |
| forked extraction agent 共享 prompt cache | 复用 v4 `spawn_swarm` fork sub-agent | v4 已有 fork 机制 / 教学版无 prompt cache 物理（DeepSeek API 不暴露 cache）/ 用 disclaimer 标偏离 |
| stop hook fire-and-forget（`stopHooks.ts:141-153` `void extractMemoriesModule!.executeExtractMemories(...)`）| 在 v6 hook engine 上注册 `Stop` event handler 触发 extraction | v6 hook engine 已有 / 复用而非新建机制 |
| 4 类型 system prompt 完整指导（每类 ~30 行）| 简化为 4 类型一行描述 + 1 个示例 | 软契约本质保留 / 完整指导是工业 prompt engineering 量产 |
| 类型四分 + frontmatter 可选 type 字段 | **完整实现**（核心论断 5 物理证据）| 软契约第六次显形 |
| `memoryAge` "3 days old" 文本 | 简化为 unix timestamp 字段 | 纯 cache 经济优化 / 不影响主论断 |
| extraction agent 5 turn cap + 权限仅写 memory 目录（`createAutoMemCanUseTool`）| 简化为 3 turn cap + 同 cwd 写权限 | 沙箱化是生产安全 / 教学验证机制即可 |
| `pendingMemoryPrefetch` async 非阻塞 prefetch | 简化为同步选择 + inject | async prefetch 是延迟优化 / 不影响双轨论断 |
| Forget 机制 prompt 指令 | 保留 prompt 指令"用户说忘了 X 时找到对应 entry 删除" | 跟 task 02 sandbox / v13 TOCTOU 同精神：runtime 不强制 / 全靠 model 自律 |
| TeamMem + AutoMem `MemoryType` 枚举区分 | 不实现 TeamMem | TeamMem 跟 AutoMem 正交 / 团队协作场景独立学习主题 |

## 设计要点

### §30: AutoMemoryDir（路径管理 + 文件读写）

```ts
const AUTO_MEMORY_DIR = path.join(process.cwd(), '.claude-memory')
const MEMORY_INDEX_FILENAME = 'MEMORY.md'

interface MemoryFile {
  path: string             // absolute
  name: string             // frontmatter.name
  description: string      // frontmatter.description
  type?: 'user' | 'feedback' | 'project' | 'reference'  // frontmatter.type 可选
  mtimeMs: number          // fs.stat 拿
  body: string             // 去掉 frontmatter 后的正文
}

async function ensureMemoryDirExists(): Promise<void>  // mkdir -p .claude-memory/
async function scanMemoryFiles(): Promise<MemoryFile[]>  // 扫所有 .md（排除 MEMORY.md）+ 解析 frontmatter
async function loadMemoryIndex(): Promise<string | null>  // 读 .claude-memory/MEMORY.md，不存在返 null
```

工业对照：`paths.ts:223-235` `getAutoMemPath()` + `memoryScan.ts:21,41-62` `scanMemoryFiles()` + `memdir.ts:129-147` `ensureMemoryDirExists()`

### §31: MEMORY.md 索引上轨（system prompt section）

- 在 v10 §19 `PROMPT_SECTIONS` 数组追加 `systemPromptSection('memory_index', () => loadMemoryIndexPrompt())`
- `loadMemoryIndexPrompt()` 调 §30 `loadMemoryIndex()` + 拼装 system prompt 指导段（4 类型 when_to_save + Step 1/2 写入指令 + forget 指令）
- **v10 工厂字面 0 修改** —— 架构正交性第 8 次验证物理证据
- 工业对照：`prompts.ts:495` `systemPromptSection('memory', loadMemoryPrompt)` + `memdir.ts:199-266` `buildMemoryLines()`

### §32: relevant_memories 下轨（attachment + helper selector）

- 每个 user turn 触发 `selectRelevantMemories(userMessage)`：
  - 输入：当前 user message text
  - 算法（教学版规则化）：
    1. `scanMemoryFiles()` 拿全部 memory
    2. 按 mtime 倒序（最新写的优先）
    3. 用户消息关键词包含匹配（description 命中关键词加权）
    4. 取前 5 条
  - **disclaimer**：工业用 Sonnet helper model 做语义判断（`findRelevantMemories.ts:39-75` JSON schema 输出 5 个 path），教学版用规则化避免外部依赖
- 选中的 memory → 构造 `Attachment { type: 'relevant_memories', files: [{path, name, description, body}] }`
- 渲染时走 v11 `wrapMessagesInSystemReminder` 通道，转成 `{role: 'user', content: '<system-reminder>\nRelevant memories for this turn:\n\n## Memory: {name}\n\n{body}\n...\n</system-reminder>', isMeta: true}`
- **v11 通道字面 0 修改** —— 只新增 `'relevant_memories'` case 分支
- 工业对照：`messages.ts:3708-3722` `case 'relevant_memories'` + `attachments.ts:2279-2321` `readMemoriesForSurfacing` + `:2361-2424` `startRelevantMemoryPrefetch`

### §33: 双轨写入（main prompt 协议 + background extraction agent）

**主路径（prompt 协议）**：
- §31 system prompt 已包含 Step 1/Step 2 写入指令 + 4 类型指导
- 主 agent 用标准 `FileWriteTool`（v8 已有）写 `.claude-memory/<name>.md` + Edit `.claude-memory/MEMORY.md` 添加索引行
- **没有专用 MemoryWriteTool** —— 跟 v12 TodoWrite 软契约同源 / 工业字面 `extractMemories.ts:237-249` `getWrittenFilePath()` 检查的就是 `FileWriteTool` / `FileEditTool`

**兜底路径（runtime fork agent）**：
- 在 v6 hook engine 上注册 `Stop` event handler：每个 query loop 结束时 fire-and-forget 调 `executeExtractMemories(messages, lastMemoryCursor)`
- `executeExtractMemories`：
  1. 检查 `hasMemoryWritesSince(messages, lastMemoryCursor)` —— 主 agent 已写则跳过（互斥逻辑核心 / 见 §34）
  2. 否则用 v4 `spawn_swarm` fork sub-agent，传 prompt "扫描下面 messages 提取应记忆点 → 写 memory 文件 + 更新 MEMORY.md"
  3. sub-agent 最大 3 turn / 同 cwd 写权限 / 完成后 cursor 推进到 `messages.length`
- **disclaimer 1**：工业 forked agent 共享主对话 prompt cache（`extractMemories.ts:415-427`），教学版用 v4 spawn_swarm 复用主对话 messages 但不享 cache（DeepSeek API 不暴露 cache）
- **disclaimer 2**：工业 stop hook 通过 `stopHooks.ts:141-153` 触发，教学版通过 v6 hook engine `Stop` event 等价机制
- 工业对照：`extractMemories.ts:415-427` `runForkedAgent()` + `:171-222` `createAutoMemCanUseTool` + `stopHooks.ts:141-153` fire-and-forget

### §34: 互斥逻辑 + 双层 dedup

**互斥逻辑（hasMemoryWritesSince）**：
```ts
function hasMemoryWritesSince(messages: Message[], cursor: number): boolean {
  for (let i = cursor; i < messages.length; i++) {
    const m = messages[i]
    if (m.role !== 'assistant') continue
    for (const block of m.content) {
      if (block.type !== 'tool_use') continue
      if (block.name !== 'FileWriteTool' && block.name !== 'FileEditTool') continue
      const filePath = getWrittenFilePath(block.input)
      if (filePath?.startsWith(AUTO_MEMORY_DIR)) return true
    }
  }
  return false
}
```
- 主 agent 在本 turn 已用 FileWriteTool/FileEditTool 写 `.claude-memory/` 下任何文件 → 返回 true → background 跳过
- 工业对照：`extractMemories.ts:118-148` 同结构

**双层 dedup（filterDuplicateMemoryAttachments）**：
```ts
function filterDuplicateMemoryAttachments(
  candidates: MemoryFile[],
  readFileState: Map<string, FileState>,
  messages: Message[]
): MemoryFile[] {
  const surfaced = collectSurfacedMemories(messages)  // Layer 2: 扫历史 attachment 找 path
  return candidates.filter(m =>
    !readFileState.has(m.path) &&  // Layer 1: model 已 Read 过
    !surfaced.has(m.path)           // Layer 2: attachment 已 surface 过
  )
}
```
- Layer 1 防"model 已经在 context 里有的不再注"
- Layer 2 防"attachment 已 surface 过的 path 跨 turn 重复 surface"
- 跟 v13 双重 dedup（Session-Set + LRU）同源 —— 单层防御针对单一漏洞向量，双层覆盖正交场景
- 工业对照：`attachments.ts:2520-2541` `filterDuplicateMemoryAttachments`

## 4 份 run-log 设计

### run-log-main-write-direct.txt（主路径 prompt 协议证据）

**场景**：用户消息 "以后用第二人称叫我，不要叫学生"

**预期物理现象**：
- 主 agent 识别这是显式 feedback → 调 FileWriteTool 写 `.claude-memory/feedback_addressing.md` 含 frontmatter `type: feedback` + body 内容
- 主 agent 调 FileEditTool 把新条目追加到 `.claude-memory/MEMORY.md`
- Round 末尾 hook engine `Stop` event 触发 → `executeExtractMemories` 检测 `hasMemoryWritesSince` = true → **跳过** background extraction
- AUDIT log 字面：`[EXTRACT] skipping — main agent already wrote memory in this turn`

**run-log 命中关键字**：
- `[FileWrite] .claude-memory/feedback_addressing.md`
- `[FileEdit] .claude-memory/MEMORY.md`
- `[EXTRACT] skipping — main agent already wrote`

### run-log-background-extract-fallback.txt（兜底路径 runtime fork 证据）

**场景**：用户聊天里有"我们发布日是周二，周三尽量别 merge"，但**没明说"记住"** —— 主 agent 不主动写

**预期物理现象**：
- 主 agent 正常回复内容讨论（无 FileWrite 到 `.claude-memory/`）
- Round 末尾 hook engine `Stop` event 触发 → `executeExtractMemories` 检测 `hasMemoryWritesSince` = false → **触发** background extraction agent
- background agent fork（用 v4 spawn_swarm）扫描 messages → 识别"发布周二 / 周三别 merge"是 project type 信号 → 调 FileWriteTool 写 `.claude-memory/project_release_cadence.md` + 更新 MEMORY.md
- AUDIT log 字面：`[EXTRACT] triggering background agent` + `[EXTRACT-AGENT] wrote .claude-memory/project_release_cadence.md`

**run-log 命中关键字**：
- `[EXTRACT] triggering background agent`（互斥未命中）
- `[SWARM] spawn_swarm extraction-agent`（v4 fork 复用证据）
- `[EXTRACT-AGENT] FileWrite .claude-memory/project_release_cadence.md`

### run-log-mutual-exclusion-skip.txt（互斥逻辑核心证据）

**场景**：用户消息 "记住我喜欢简洁回复" —— 主 agent 主动写 + background 必须跳过

**预期物理现象**：
- 主 agent 写 `.claude-memory/feedback_terse.md` + 更新 MEMORY.md
- 同一 round 末尾 hook engine `Stop` event 触发 → `executeExtractMemories` 检测 `hasMemoryWritesSince` = true → **跳过**
- AUDIT log 字面：`[EXTRACT] skipping — main agent already wrote memory in this turn`（精确字面）
- **关键反例**：log 中**没有** `[SWARM] spawn_swarm extraction-agent`（证明真跳过 / 不只是写完不动）

**run-log 命中关键字**：
- `[FileWrite] .claude-memory/feedback_terse.md`
- `[EXTRACT] skipping — main agent already wrote memory in this turn`
- **缺失**：无 `[SWARM] spawn_swarm extraction-agent`

### run-log-relevant-prefetch-double-dedup.txt（双轨注入 + 双层 dedup 证据）

**场景**：跑 5 轮对话，第一轮写 3 条 memory，第二轮起每轮触发 relevant_memories prefetch，第 4 轮 model 用 Read 工具读了 memory 文件，第 5 轮再次 prefetch 应被 dedup 拦截

**预期物理现象**：
- Round 1: 主 agent 写 3 条 memory（user_role.md / feedback_terse.md / project_release.md）+ 更新 MEMORY.md 索引
- Round 2: user 问"我们的发布日是？" → §32 selector 选中 project_release.md → attachment 注入下一轮 messages → AUDIT `[RELEVANT] surfaced 1 memory: project_release.md`
- Round 3: user 问其他话题 → selector 选其他 → attachment 注入
- Round 4: user 让 model 主动 `Read .claude-memory/feedback_terse.md` → readFileState 记录 path
- Round 5: user 问"我喜欢什么风格？" → selector 选中 feedback_terse.md（关键词 "风格" 匹配）→ Layer 1 readFileState 命中 → **dedup 拦截** → AUDIT `[DEDUP] feedback_terse.md already in readFileState — skipping surface`
- 同时验证 Layer 2：第 6 轮 user 又问相关问题 → selector 选 project_release.md（已在 Round 2 surfaced）→ Layer 2 collectSurfacedMemories 命中 → **dedup 拦截** → AUDIT `[DEDUP] project_release.md already surfaced earlier — skipping`

**run-log 命中关键字**：
- `[INDEX LOAD] MEMORY.md 3 entries`（system prompt section 加载证据）
- `[RELEVANT] surfaced 1 memory: project_release.md`（attachment 注入证据）
- `[DEDUP] feedback_terse.md already in readFileState`（Layer 1 字面）
- `[DEDUP] project_release.md already surfaced earlier`（Layer 2 字面）

## 验收标准

### 物理交付清单

- `agent-v14-auto-memory.ts` ~1730 行（v13 1529 + 新增 ~200 行 / 误差 ±20）
- v13 §1-29 字面不动 + 最小侵入新增（§30/§31/§32/§33/§34 五段共 ~200 行）
- demo-project/.claude-memory/ 目录（含 demo MEMORY.md + 3 条预置 memory `.md` 文件作 round 0 状态）
- 4 份 run-log（如上）
- lesson.md ~250 行（按 8 条 lesson narrative 规则严格执行）
- notes.md（改动统计 + 工业对照 + 砍掉项详解 + 5 论断 run-log 串读 + 真 bug 修复纪录如有）
- excerpts.md（≥7 段工业源码引用 / 必含 `extractMemories.ts:7-8 + :118-148 + :348-360 + :415-427` / `prompts.ts:495` / `messages.ts:3708-3722` / `attachments.ts:2520-2541` / `findRelevantMemories.ts:39-75` / `memoryTypes.ts:14-19,28-31,182-194` / `memdir.ts:35-38,199-266`）
- README.md 三段式

### 5 论断必须 ✅ 字面命中

1. **分水岭** ✅：run-log-main-write-direct + run-log-mutual-exclusion-skip 中 `[EXTRACT] skipping` 字面证明互斥；run-log-background-extract-fallback 中 `[EXTRACT] triggering background agent` 字面证明兜底
2. **双轨注入** ✅：run-log-relevant-prefetch 中 `[INDEX LOAD]` 上轨 + `[RELEVANT] surfaced` 下轨同时存在；OBS METRIC 显示 system prompt section + relevant_memories attachment 双通道
3. **双层 dedup** ✅：run-log-relevant-prefetch 中 `[DEDUP] already in readFileState`（Layer 1）+ `[DEDUP] already surfaced earlier`（Layer 2）字面分别命中
4. **cache 经济**：复用 v4 spawn_swarm fork（不新建 sub-agent 通道）+ memoryAge 用 mtime（避免 Date.now 注入破 cache）；disclaimer 1 标注教学版无 prompt cache 物理
5. **类型四分软契约** ✅：3 条预置 memory 各示一种 type / extraction agent 写的 memory 自动归类 user/feedback/project/reference 之一 / frontmatter type 字段 optional 容错（缺失文件能被 scan 不崩）

### 架构正交性第 8 次验证

v13 §1-29 字面不动 + 复用清单：
- 复用 v4 `spawn_swarm` fork sub-agent → background extraction agent
- 复用 v6 hook engine `Stop` event → stop hook fire-and-forget
- 复用 v7 obs → memory 写入/读取 自动 cardinality 控制（OBS METRIC tool_name=FileWriteTool path_redacted）
- 复用 v8 streaming → 不阻塞主 conversation
- 复用 v8 `FileWriteTool` / `FileEditTool` → memory 写入（**没有 MemoryWriteTool**）
- 复用 v10 `systemPromptSection` 工厂 → MEMORY.md 索引上轨
- 复用 v11 `wrapMessagesInSystemReminder` 通道 → relevant_memories attachment 下轨
- 复用 v13 nested attachment 通道结构 → relevant_memories 同型

整个 auto memory 子系统**不需要新通道**，全靠已有子系统接住。这是 mini harness 7 大子系统正交性的第 8 次验证。

## 0 假设原则严格执行

所有 file:line 引用必须经实际 Read / grep 验证。本 spec 已严格执行：

| 关键论断 | file:line | 验证状态 |
|---|---|---|
| 互斥跳过逻辑字面 | `extractMemories.ts:7-8` 注释 + `:348-360` skip log + `:118-148` hasMemoryWritesSince | ✅ Explore 报告 |
| 双轨注入上轨 | `prompts.ts:495` systemPromptSection('memory') | ✅ Explore 报告 |
| 双轨注入下轨 | `messages.ts:3708-3722` case 'relevant_memories' | ✅ Explore 报告 |
| Sonnet helper | `findRelevantMemories.ts:39-75` JSON schema + `:98-131` output 5 path | ✅ Explore 报告 |
| 双层 dedup | `attachments.ts:2520-2541` filterDuplicateMemoryAttachments | ✅ Explore 报告 |
| forked agent share cache | `extractMemories.ts:415-427` runForkedAgent | ✅ Explore 报告 |
| 类型四分软契约 | `memoryTypes.ts:14-19` 枚举 + `:28-31` optional + `:182-194` NO ENFORCEMENT 注释 | ✅ Explore 报告 |
| stop hook fire-and-forget | `stopHooks.ts:141-153` void executeExtractMemories | ✅ Explore 报告 |
| `getWrittenFilePath` 检查 FileWriteTool/FileEditTool | `extractMemories.ts:237-249` | ✅ Explore 报告 |
| 60KB session cap | `attachments.ts:288` MAX_SESSION_BYTES = 60 * 1024 | ✅ Explore 报告 |
| MEMORY.md 200 行 25KB 上限 | `memdir.ts:35-38` + `:57-103` truncateEntrypointContent | ✅ Explore 报告 |
| ensureMemoryDirExists | `memdir.ts:129-147` | ✅ Explore 报告 |
| memoryAge 文本 | `memoryAge.ts:6-8,15,33-42` | ✅ Explore 报告 |
| 路径沙箱化 | `paths.ts:223-235` getAutoMemPath | ✅ Explore 报告 |

实现过程中如发现 spec 描述的任何 file:line 与源码实际不符 → **立刻停下来源码重读 + 修正 spec** —— 跟 task 13 真 bug 发现（nestedReminders prepend vs append）同精神。

## 实现优先级建议

按"先骨架 + 再分支 + 最后 dedup/edge case"次序：

1. **§30 路径管理 + frontmatter 解析**（基础设施 / 不做就跑不起来）
2. **§31 MEMORY.md 索引上轨**（system prompt section / 静态 / 验证 v10 工厂复用）
3. **§32 relevant_memories 下轨**（attachment / 静态 selector 即可 / 验证 v11 通道复用）
4. **§33 主路径 prompt 协议**（在 §31 prompt 中加 Step 1/2 指令 / 主 agent 自然会写）
5. **§33 兜底路径 background fork**（hook engine Stop event / 复用 v4 spawn_swarm）
6. **§34 互斥逻辑 hasMemoryWritesSince**（双轨连通 / 关键论断 1 物理证据）
7. **§34 双层 dedup**（关键论断 3 物理证据）
8. **4 份 run-log 跑通 + 字面证据收集**

## 备择方案（如果 spec 某点不切合）

- **备择 A**：如果 helper selector 规则化无法可靠选中相关 memory（5 文件少没问题 / 多了关键词匹配会糊）→ 改为最简化"全部 surface（如 ≤5 条）"（disclaimer 标偏离 / 不影响双轨论断验证）
- **备择 B**：如果 v4 spawn_swarm fork 在 background context 跑时 messages 注入有问题（教学版 fork 是同进程 async 不是工业 multi-process）→ 改为同进程异步函数直接 await（disclaimer 标"教学版用同进程 fork-like 异步函数 / 工业用 forked sub-agent"）
- **备择 C**：如果 hook engine Stop event 触发时机不准确 → 改在 runRounds 末尾直接调（不走 hook）+ disclaimer 标"工业是 stopHooks.ts:141-153 fire-and-forget / 教学版直接 inline call"

## 出现源码偏离时的处理流程

1. 实现中发现某 file:line 描述与 ../claude-code/src/ 实际不符
2. **立刻停下来 Read 源码确认**（不要凭印象修正）
3. 在 notes.md 记录"我说错了 X / 真相是 Y / 修正过程"
4. 同步修正 spec.md（这份文档），保持 spec 跟工业 ground truth 一致
5. 跟 task 13 真 bug 发现同精神 / 0 假设原则的价值在 task 14 同样适用
