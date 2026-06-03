# v14 Auto Memory System — Notes

## 改动统计

| 区域 | v13 行数 | v14 新增/改动 | 说明 |
|------|---------|-------------|------|
| 文件头注释 | 25 行 | 重写 33 行 | v14 对照表 + 5 论断 |
| §3 BASE_TOOLS | 5 行 | +4 行 | FileWriteTool 独立 tool |
| §5 execute | ~60 行 | +14 行 | FileWriteTool 分支 + read_file lruSet |
| §8 HookEvent | 1 行 | +1 类型 | 'Stop' 扩展 |
| §10 runRounds | ~45 行 | +8 行 | injectRelevantMemories + Stop emit |
| §20 PROMPT_SECTIONS | 5 行 | +5 行 | auto_memory_index section |
| §31 clearMemoryCache | 5 行 | +1 行 | surfacedMemoryPaths.clear() |
| §32-§36（全新） | 0 行 | +195 行 | Auto Memory 子系统核心 |
| **总计** | 1611 行 | → 1933 行 | +322 行（含注释） |

## 5 论断对照工业源码

| # | 论断 | 工业 file:line | v14 物理证据 |
|---|------|--------------|-------------|
| 1 | 双轨并发互斥 | extractMemories.ts:121-148 hasMemoryWritesSince + :348-360 skip | `[EXTRACT] skipping` / `[EXTRACT] triggering` |
| 2 | 双轨注入 | prompts.ts:495 + messages.ts:3708-3722 | `[RELEVANT] surfaced` + system prompt 含 MEMORY.md |
| 3 | 双层 dedup | attachments.ts:2520-2541 filterDuplicate | `[DEDUP] readFileState` + `[DEDUP] surfaced earlier` |
| 4 | cache 经济 | extractMemories.ts:415-427 runForkedAgent shared cache | 复用 v4 spawn_swarm / memoryAge 文本 |
| 5 | 类型四分软契约 | memoryTypes.ts:14-19 + :28-31 optional | frontmatter type 可选 / scan 不崩 |

## 教学砍掉项详解

1. **Sonnet helper → 规则化 selector**：工业用 `findRelevantMemories.ts:39-75` 调 Sonnet API + JSON schema 返 5 个 path。教学版用 mtime 倒序 + 关键词 description 匹配。理由：避免外部 API 依赖；"独立 head 不污染主 reasoning"概念已在 socratic 19 Q5 内化。

2. **~/.claude/projects/xxx/memory/ → demo-project/.claude-memory/**：避免污染用户真实 `~/.claude`。工业 `paths.ts:223-235` 做 git-root 路径沙箱化。

3. **60KB session cap → 5 文件硬上限**：工业 `MAX_SESSION_BYTES = 60 * 1024`（attachments.ts:288）是长会话累积保护。教学版 `MAX_RELEVANT_MEMORIES = 5` 更直观。

4. **extraction agent 5 turn → 3 turn**：教学环境 extraction 1-2 turn 即完成；3 turn 足够容错。

5. **pendingMemoryPrefetch async → 同步 select+inject**：工业在 query 准备阶段非阻塞 prefetch 减少延迟。教学版同步执行不影响论断验证。

6. **memoryAge "3 days old" → 仅在 attachment 渲染用**：工业 memoryAge.ts 精确避免 Date.now() 注入破 cache。教学版在 `injectRelevantMemories` 调 `memoryAge(mtimeMs)` 同精神。

7. **Forget 机制**：保留 prompt 指令"用户说忘了 X 时删除对应 entry"但不实现专用 tool——跟整个 auto-memory 无专用 MemoryWriteTool 的设计哲学一致。

8. **TeamMem**：跟 AutoMem 正交的团队协作场景，不在 v14 范围。

## 真 bug 修复纪录

1. **§5 FileWriteTool 分支尾部缺注释分隔**：初始 edit 把 v11 SkillTool 分支的注释头（"—— 同权于内置 tool"）错误拼接到 FileWriteTool 的闭合大括号 `}` 后面，导致 Bun parser 报 `Unexpected ——`。修复：在 `}` 后换行加 `// v11 新增` 注释恢复原结构。

2. **injectRelevantMemories 连续 user message 问题**：初版直接 `messages.push({role: "user", ...})` 添加 system-reminder，可能导致连续两条 user message 违反 Anthropic API 交替规则。修复：改为 append text block 到最后一条 user message 的 content 数组末尾。

3. **read_file 不写 readFileStateLRU**：v13 的 `read_file` 分支只写 `nestedMemoryAttachmentTriggers`，不写 `readFileStateLRU`。导致 dedup Layer 1 对 model 主动读过的 memory 文件无效。修复：在 read_file 成功后追加 `lruSet(fullPath, ...)`。这个 bug 反向验证了工业 FileReadTool 写 readFileState 的必要性。

## 5 份 run-log 串读

| run-log | 核心证据 | 验证论断 |
|---------|---------|---------|
| main-write-direct | `[FileWrite]` + `[EXTRACT] skipping` | #1 主路径 + 互斥 |
| background-extract-fallback | `[EXTRACT] triggering` + swarm[0] spawn | #1 兜底路径 |
| mutual-exclusion-skip | `[FileWrite]` + `[EXTRACT] skipping` + 无 swarm | #1 互斥（反证：无 fork） |
| relevant-prefetch-double-dedup | `[RELEVANT]` + `[DEDUP] readFileState` + `[DEDUP] surfaced earlier` | #2 + #3 |

## 工业速查

| 概念 | 工业位置 | 教学版位置 |
|------|---------|-----------|
| hasMemoryWritesSince | extractMemories.ts:121-148 | §35 hasMemoryWritesSince |
| getWrittenFilePath | extractMemories.ts:232-249 | §35 getWrittenFilePath |
| runForkedAgent | extractMemories.ts:415-427 | §35 → runSwarm (v4 复用) |
| filterDuplicateMemoryAttachments | attachments.ts:2520-2541 | §34 selectRelevantMemories 内双层过滤 |
| loadMemoryPrompt (index) | prompts.ts:495 + memdir.ts:199-266 | §33 loadAutoMemoryIndexPrompt |
| relevant_memories render | messages.ts:3708-3722 | §34 injectRelevantMemories |
| scanMemoryFiles | memoryScan.ts:41-62 | §32 scanAutoMemoryFiles |
| parseMemoryType (optional) | memoryTypes.ts:28-31 | §32 AutoMemoryFile.type? |
| Stop hook trigger | stopHooks.ts:141-153 | §36 hooks.register("Stop") |
| memoryAge text | memoryAge.ts:15-20 | §34 memoryAge() |
