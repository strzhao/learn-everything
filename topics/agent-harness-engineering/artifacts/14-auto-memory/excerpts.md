# v14 工业源码引用 (Excerpts)

## 1. extractMemories.ts:7-9 — forked agent pattern 注释

```ts
/**
 * Uses the forked agent pattern (runForkedAgent) — a perfect fork of the main
 * conversation that shares the parent's prompt cache.
 */
```
v14 对照：§35 `executeExtractMemories` 复用 v4 `runSwarm` 作为 fork sub-agent。教学版无法验证 prompt cache 共享（DeepSeek API 不暴露），但 fork 机制和 fire-and-forget 模式 1:1。

## 2. extractMemories.ts:121-148 — hasMemoryWritesSince

```ts
export function hasMemoryWritesSince(
  messages: Message[],
  sinceUuid: string | undefined,
): boolean {
  // ... scans messages after sinceUuid cursor position
  // looking for assistant messages containing Write/Edit tool_use blocks
  // targeting an auto-memory path (isAutoMemPath)
  // Returns true → extraction skipped (main agent already wrote)
}
```
v14 对照：§35 `hasMemoryWritesSince(messages, cursor)` 同结构 — 扫 assistant messages 找 FileWriteTool/FileEditTool → AUTO_MEMORY_DIR。

## 3. extractMemories.ts:348-360 — skipping log

```ts
// When hasMemoryWritesSince returns true:
log('[extractMemories] skipping — conversation already wrote to memory files')
// Advances cursor, fires telemetry: tengu_extract_memories_skipped_direct_write
// Returns early
```
v14 对照：`audit('[EXTRACT] skipping — main agent already wrote memory in this turn')` 字面命中。run-log-main-write-direct + run-log-mutual-exclusion-skip 两份实证。

## 4. extractMemories.ts:415-427 — runForkedAgent

```ts
const result = await runForkedAgent({
  promptMessages: [createUserMessage({ content: userPrompt })],
  cacheSafeParams,
  canUseTool,
  querySource: 'extract_memories',
  forkLabel: 'extract_memories',
  skipTranscript: true,
  maxTurns: 5,
})
```
v14 对照：`runSwarm(extractionTask, "bypassPermissions", interactiveAsk)` — 复用 v4 fork。教学版 3 turn cap（工业 5），无 skipTranscript（教学版无 transcript），无 cacheSafeParams（无 prompt cache 物理）。

## 5. memdir.ts:199-266 — buildMemoryLines (4 类型 guidance)

```ts
// Builds typed-memory behavioral instructions:
// - TYPES_SECTION_INDIVIDUAL (user/feedback/project/reference)
// - WHAT_NOT_TO_SAVE_SECTION
// - "## How to save memories" (Step 1 write file + Step 2 update MEMORY.md)
// - WHEN_TO_ACCESS_SECTION
// - TRUSTING_RECALL_SECTION ("Before recommending from memory")
```
v14 对照：§33 `loadAutoMemoryIndexPrompt()` 教学浓缩版 — 4 类型各 1 行 + What NOT + Step 1/2 + Forget。

## 6. attachments.ts:2520-2541 — filterDuplicateMemoryAttachments

```ts
export function filterDuplicateMemoryAttachments(
  attachments: Attachment[],
  readFileState: FileStateCache,
): Attachment[] {
  return attachments
    .map(attachment => {
      if (attachment.type !== 'relevant_memories') return attachment
      const filtered = attachment.memories.filter(
        m => !readFileState.has(m.path),  // Layer 1: model 已 Read
      )
      for (const m of filtered) {
        readFileState.set(m.path, { content: m.content, timestamp: m.mtimeMs, ... })
      }
      return filtered.length > 0 ? { ...attachment, memories: filtered } : null
    })
    .filter((a): a is Attachment => a !== null)
}
```
v14 对照：§34 `selectRelevantMemories` 内双层过滤 — `readFileStateLRU.has(normPath)` (Layer 1) + `surfacedMemoryPaths.has(normPath)` (Layer 2)。工业把 Layer 2 mark-after-filter 放在同函数内（避免 self-referential filter bug）；教学版在 `injectRelevantMemories` 选完后 `surfacedMemoryPaths.add()`。

## 7. messages.ts:3708-3722 — case 'relevant_memories'

```ts
case 'relevant_memories': {
  return wrapMessagesInSystemReminder(
    attachment.memories.map(m => {
      const header = m.header ?? memoryHeader(m.path, m.mtimeMs)
      return createUserMessage({
        content: `${header}\n\n${m.content}`,
        isMeta: true,
      })
    }),
  )
}
```
v14 对照：§34 `injectRelevantMemories` — `<system-reminder>\nRelevant memories for this turn:\n\n## Memory: ${m.name}...\n</system-reminder>` 嵌入最后一条 user message content 数组。教学简化不用独立 isMeta message（避免 Anthropic API 连续 user message 问题）。

## 8. stopHooks.ts:141-153 — fire-and-forget

```ts
if (
  feature('EXTRACT_MEMORIES') &&
  !toolUseContext.agentId &&  // 只对主 agent
  isExtractModeActive()
) {
  void extractMemoriesModule!.executeExtractMemories(
    stopHookContext,
    toolUseContext.appendSystemMessage,
  )
}
```
v14 对照：§10 runRounds 末尾 `if (role !== "swarm-worker") hooks.emit("Stop", ...)` + §36 `hooks.register("Stop", { fn: executeExtractMemories })`. 工业用 `void`（真 fire-and-forget / 不 await），教学版通过 hook engine 的 Promise.allSettled 隔离等效。

## 9. memoryTypes.ts:14-19 + :28-31 — 类型枚举 + optional 容错

```ts
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]

export function parseMemoryType(raw: unknown): MemoryType | undefined {
  if (typeof raw !== 'string') return undefined
  return MEMORY_TYPES.find(t => t === raw)
}
```
v14 对照：§32 `AutoMemoryType = "user" | "feedback" | "project" | "reference"` + `parseFrontmatter` 后 `validTypes.includes(meta.type)` 否则 undefined。NO RUNTIME ENFORCEMENT — 全靠 model 自律。

## 10. memoryAge.ts:15-20 — 人类可读 age

```ts
export function memoryAge(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs)
  if (d === 0) return 'today'
  if (d === 1) return 'yesterday'
  return `${d} days ago`
}
```
v14 对照：§34 `memoryAge(mtimeMs)` 字面 1:1 实现。用在 `injectRelevantMemories` 的 header 渲染里（"saved 3 days ago"）。
