# Excerpts — v13 Industrial Source References

> 8 段 claude-code 工业源码引用 / 每段含 file:line + 关键代码片段 + 教学解释 / 严格 0 假设原则前置验证。

---

## §1 加载入口：`processMemoryFile` + 三层加载顺序

**文件**: `src/utils/claudemd.ts:618-625` + `:790-934`

```typescript
// :618-625 函数签名
export async function processMemoryFile(
  filePath: string,
  type: MemoryType,  // 'Managed' | 'User' | 'Project' | 'Local' | 'AutoMem'
  processedPaths: Set<string>,
  includeExternal: boolean,
  depth: number = 0,
  parent?: string,
): Promise<MemoryFileInfo[]>

// :790-934 三层加载顺序 (简化引语):
// Managed (804): /etc/claude-code/CLAUDE.md (企业部署)
// User    (827): ~/.claude/CLAUDE.md (用户全局)
// Project (878-920): 从 root 到 cwd 的所有 CLAUDE.md (root→CWD cascade)
// Local   (923):  <cwd>/CLAUDE.local.md (项目私人)
```

**v13 教学等价**: §27 `loadMemoryFiles` / 砍 Managed 层 / 保留 root→CWD cascade（user 反馈点 2）。

---

## §2 TOCTOU rule: `safelyReadMemoryFileAsync`

**文件**: `src/utils/claudemd.ts:424-436` + `src/bridge/bridgePointer.ts:76-82`

```typescript
// claudemd.ts:424-436 (简化)
async function safelyReadMemoryFileAsync(filePath: string): Promise<...> {
  try {
    return await fs.readFile(filePath, { encoding: 'utf-8' })
  } catch {
    return null
  }
}

// bridgePointer.ts:76-82 字面注释
/**
 * Read the pointer and its age (ms since last write). Operates directly
 * and handles errors — no existence check (CLAUDE.md TOCTOU rule). Returns
 * null on any failure: missing file, corrupted JSON, schema mismatch, or
 * stale (mtime > 4h ago).
 */
```

**关键字面**: `"no existence check (CLAUDE.md TOCTOU rule)"` —— 通用工程规则不限 CLAUDE.md / 避免 stat→read 之间竞态窗口。

**v13 教学等价**: §30 `safelyReadMemoryFile` 直接 `fs.readFile` try/catch return null。

---

## §3 上轨注入: `systemPromptSection('memory', loadMemoryPrompt)`

**文件**: `src/constants/prompts.ts:495`

```typescript
// :491-498 (memory section 注册)
sections.push(
  systemPromptSection('memory', () => loadMemoryPrompt())
)
```

**v13 教学等价**: §3 PROMPT_SECTIONS_BEFORE_BOUNDARY[4] 用 `systemPromptSection("memory", () => loadMemoryPrompt())` —— v12 是 mock string `"User preferences (mocked):..."` / v13 替换为真调 §27 `loadMemoryFiles()` 的格式化输出。

---

## §4 下轨注入: `nested_memory` case → `wrapMessagesInSystemReminder`

**文件**: `src/utils/messages.ts:3700-3707`

```typescript
case 'nested_memory': {
  return wrapMessagesInSystemReminder([
    createUserMessage({
      content: `Contents of ${attachment.content.path}:\n\n${attachment.content.content}`,
      isMeta: true,
    }),
  ])
}
```

**关键工业洞察**: 转成**独立 isMeta user message** 不是为了 isMeta semantics —— **是为了避开 tool_use→tool_result 位置约束**。独立 message 可以用 system-reminder wrap 自由编排。详见 lesson.md "工业洞察" 段。

**v13 教学等价**: §10 toolResults 之后 append `<system-reminder>\nContents of ${path}:\n\n${content}\n</system-reminder>` text block（同 user message append 而非独立 message / 必须 toolResults-first）。

---

## §5 双层 dedup: Session-Set + readFileState LRU

**文件**: `src/Tool.ts:217-225` + `src/utils/attachments.ts:1718-1750`

```typescript
// Tool.ts:215-225 字面注释
nestedMemoryAttachmentTriggers?: Set<string>
/**
 * CLAUDE.md paths already injected as nested_memory attachments this
 * session. Dedup for memoryFilesToAttachments — readFileState is an LRU
 * that evicts entries in busy sessions, so its .has() check alone can
 * re-inject the same CLAUDE.md dozens of times.
 */
loadedNestedMemoryPaths?: Set<string>

// attachments.ts:1718-1750 双层 dedup 物理实现 (简化)
for (const memoryFile of memoryFiles) {
  // Dedup: loadedNestedMemoryPaths is a non-evicting Set; readFileState
  // is a 100-entry LRU that drops entries in busy sessions, so relying
  // on it alone re-injects the same CLAUDE.md on every eviction cycle.
  if (toolUseContext.loadedNestedMemoryPaths?.has(memoryFile.path)) {
    continue  // ← 永不驱逐 Set 第一道防线
  }
  if (!toolUseContext.readFileState.has(memoryFile.path)) {
    attachments.push({ type: 'nested_memory', ... })
    toolUseContext.loadedNestedMemoryPaths?.add(memoryFile.path)
    toolUseContext.readFileState.set(memoryFile.path, {
      content: memoryFile.contentDiffersFromDisk
        ? (memoryFile.rawContent ?? memoryFile.content)
        : memoryFile.content,
      isPartialView: memoryFile.contentDiffersFromDisk,
      ...
    })
  }
}
```

**v13 教学等价**: §29 `loadedNestedMemoryPaths` Set 永不驱逐 + `readFileStateLRU` Map 8-entry 自实现 LRU（教学版 8 / 工业 100 / 25MB 字节限不实）。

---

## §6 LRU 实现: `FileStateCache` 包 lru-cache npm

**文件**: `src/utils/fileStateCache.ts:1-93`

```typescript
// :1
import { LRUCache } from 'lru-cache'

// :14-15 isPartialView 字段定义
isPartialView?: boolean
// True when this entry was populated by auto-injection (e.g. CLAUDE.md) and
// the injected content did not match disk (stripped HTML comments, stripped
// frontmatter, truncated MEMORY.md). The model has only seen a partial view;
// Edit/Write must require an explicit Read first.

// :18 容量常量
export const READ_FILE_STATE_CACHE_SIZE = 100

// :22 字节限
const DEFAULT_MAX_CACHE_SIZE_BYTES = 25 * 1024 * 1024

// :30-39 双重容量上限
constructor(maxEntries: number, maxSizeBytes: number) {
  this.cache = new LRUCache<string, FileState>({
    max: maxEntries,                              // 100 entry
    maxSize: maxSizeBytes,                        // 25MB 字节
    sizeCalculation: value =>
      Math.max(1, Buffer.byteLength(value.content)),
  })
}

// :41-52 path normalize
get(key: string)    { return this.cache.get(normalize(key)) }
set(key: string, v) { this.cache.set(normalize(key), v); ... }
has(key: string)    { return this.cache.has(normalize(key)) }
```

**关键设计点**:
- 双重容量上限（100 entry **或** 25MB 字节，谁先满谁先驱逐）
- 所有 key normalize（处理 `/foo/../bar` 路径冗余 / Windows `\` vs `/` 混用）
- isPartialView 字段标记"model 见到的不是磁盘原文"（详见 §7 isPartialView 防御）

**v13 教学等价**: §29 `readFileStateLRU` Map 自实现 LRU（不依赖 lru-cache npm）/ 8 entry / 不实 25MB 字节限。

---

## §7 isPartialView 防御: Edit/Write 强制 Re-Read

**文件**: `src/tools/FileEditTool/FileEditTool.ts:275-287` + `:289-311` (mtime 对齐)

```typescript
// :275-287 isPartialView 检查
const readTimestamp = toolUseContext.readFileState.get(fullFilePath)
if (!readTimestamp || readTimestamp.isPartialView) {
  return {
    result: false,
    behavior: 'ask',
    message: 'File has not been read yet. Read it first before writing to it.',
    errorCode: 6,
  }
}

// :289-311 mtime 对齐
if (readTimestamp) {
  const lastWriteTime = getFileModificationTime(fullFilePath)
  if (lastWriteTime > readTimestamp.timestamp) {
    // Windows fallback: full read + content unchanged → safe
    const isFullRead = readTimestamp.offset === undefined && readTimestamp.limit === undefined
    if (isFullRead && fileContent === readTimestamp.content) {
      // Content unchanged, safe to proceed
    } else {
      return {
        result: false,
        behavior: 'ask',
        message: 'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.',
        errorCode: 7,
      }
    }
  }
}
```

**两套同源防御**:
- isPartialView: 防"压根没读过——只是被自动注入了 stripped 版本"
- mtime 对齐: 防"读过但已过时"（用户外部改了）

**v13 教学等价**: 教学版 read_file 真读 + 不实 strip / `isPartialView` 始终 false。但 §29 ReadFileStateEntry 类型保留 isPartialView 字段供未来扩展。

---

## §8 compact-triggered cache clear: **两个 clear site**

内存清理分两处协作完成：

**Site 1 — `src/services/compact/compact.ts:521-522`（full）/ `:920-921`（partial）** 清 **per-context** 状态：

```typescript
// 生成 summary 后、丢历史前：
const preCompactReadFileState = cacheToObject(context.readFileState) // 先快照
context.readFileState.clear()
context.loadedNestedMemoryPaths?.clear()   // ← Session-Set 跟 readFileState 绑一起 clear
// 对比 :524-529 注释：sentSkillNames 故意 NOT clear（skill content 另由 invoked_skills attachment 保留）
// 再 createPostCompactFileAttachments(preCompactReadFileState, ctx, 5) 回灌最近 5 文件
```

**Site 2 — `src/services/compact/postCompactCleanup.ts:31-70`（`runPostCompactCleanup`）** 清 **module-level** memoize 缓存：

```typescript
getUserContext.cache.clear?.()           // :59 外层 memoize
resetGetMemoryFilesCache('compact')      // :60 getMemoryFiles cache（否则下轮命中外层 cache，armed hook 不 fire）
clearSystemPromptSections()              // :62 v10 学过的同精神
// Intentionally NOT resetSentSkillNames() :65-69
```

**关键设计点**:
- compact 后语义状态变 → cached value stale → 必须丢 cache 强制重算（跟 v10 `clearSystemPromptSections` 同因果链）
- **`loadedNestedMemoryPaths` 必须清**（Site 1）：compact 抹掉持有 nested CLAUDE.md 注入内容的历史 messages，闸门若不重开 → path 永远命中 `.has()` → 永不重注 → 永久丢失。
- 对比：`sentSkillNames` 故意不清（skill content 另存）—— 两类 dedup 区别对待，正说明清 nested dedup 是刻意的。
- **区分两种"不清"**：Session-Set 对 LRU 驱逐免疫（non-evicting / §5），但对 compact 不免疫。

**v13 教学等价**: §31 `clearMemoryCache` 把两个 site 合一 —— 清 `memoryCache`（≈Site2 getMemoryFiles cache）+ `readFileStateLRU`（≈Site1 readFileState）+ `loadedNestedMemoryPaths`（≈Site1 Session-Set）三者，对齐工业。

---

## §9 /init 设计哲学: every-line-test

**文件**: `src/commands/init.ts:97` + `:110-117`

```typescript
// :97 every-line-test 字面
"Write a minimal CLAUDE.md at the project root. Every line must pass this test:
 'Would removing this cause Claude to make mistakes?' If no, cut it."

// :110-117 排除清单
"DO NOT include:
 - file lists / standard project structure
 - standard conventions (e.g. 'use TypeScript')
 - long tutorials / comprehensive API docs
 - frequently-changing info ('current sprint is doing X')
 - abstract principles without case examples"
```

**v13 教学等价**: demo-project/CLAUDE.md 6 条规则全 pass test / 每条附判例 + How to apply / 砍 4 条候选不 pass 的规则。详见 lesson.md "设计哲学下半场" 段。

---

## §10 OLD_INIT_PROMPT vs NEW_INIT_PROMPT: 反向工程压缩原则

**文件**: `src/commands/init.ts:6-25` (OLD) + `:28-...` (NEW)

```typescript
// OLD_INIT_PROMPT 早期版本 (line 6-25 简化)
"Please analyze this codebase and create a CLAUDE.md file containing:
- Build/lint/test commands
- Code style guidelines  
- Important files and their purposes
- Project structure overview
- Common gotchas and edge cases"

// NEW_INIT_PROMPT 现役版本 (line 28+ 简化)
"Set up a minimal CLAUDE.md (and optionally skills and hooks).
Phase 4: Write CLAUDE.md (if user chose project or both)
Write a minimal CLAUDE.md at the project root. Every line must pass this test:
'Would removing this cause Claude to make mistakes?' If no, cut it."
```

**关键演化**:
- OLD: 包含清单（"Build/lint/test commands" / "Project structure overview" 等）→ CLAUDE.md 越写越冗长
- NEW: every-line-test + 排除清单 → 反向工程压缩函数

**这是工业反向工程出来的设计原则** —— 跟 v10 cacheBreak DANGEROUS 必填 reason 同精神（强制 self-audit "为什么允许这条")。

**v13 教学等价**: lesson.md "设计哲学下半场" + demo-project/CLAUDE.md 重写过程 / 砍 4 条候选规则就是反向工程压缩函数的物理产出。
