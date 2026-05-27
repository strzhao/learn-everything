# claude-code System Prompt 子系统关键源码引用（v10 对照）

所有片段都经实际 Read 验证（CLAUDE.md 0 假设原则）。引用格式：`file:start-end`。

## 1. 两个工厂函数定义：cacheBreak flag 是 DANGEROUS 的本质

> `src/constants/systemPromptSections.ts:20-38`

```typescript
export function systemPromptSection(
  name: string,
  compute: ComputeFn,
): SystemPromptSection {
  return { name, compute, cacheBreak: false }
}

export function DANGEROUS_uncachedSystemPromptSection(
  name: string,
  compute: ComputeFn,
  _reason: string,
): SystemPromptSection {
  return { name, compute, cacheBreak: true }
}
```

**v10 对照**：`agent-v10-system-prompt.ts §19` 同名同签名。`cacheBreak` flag 的语义在 `resolveSystemPromptSections` 中起作用——见 §3 引用。

**关键技术决策**：
1. 两个工厂签名差一个参数（`_reason: string` 必填）——TS 编译器强制类型契约
2. 返回值都是 `SystemPromptSection` 接口，差别在 `cacheBreak` 字段（false vs true）
3. 工厂函数本身不做 memoization——memoization 在 resolve 时通过 cache 查询实现

## 2. 全局 sectionCache：Map<string, string \| null>

> `src/bootstrap/state.ts:203` + `:399` + `:1641-1654`

```typescript
// 接口定义（line 203）：
systemPromptSectionCache: Map<string, string | null>

// 初始化（line 399）：
systemPromptSectionCache: new Map(),

// 访问 + 清空（line 1641-1654）：
export function getSystemPromptSectionCache(): Map<string, string | null> {
  return STATE.systemPromptSectionCache
}

export function setSystemPromptSectionCacheEntry(
  name: string,
  value: string | null,
): void {
  STATE.systemPromptSectionCache.set(name, value)
}

export function clearSystemPromptSectionState(): void {
  STATE.systemPromptSectionCache.clear()
}
```

**v10 对照**：v10 用 module-scoped `const sectionCache = new Map<string, string>()`（同 Map 数据结构）。工业 value 类型 `string | null`——`null` 表示"本轮 compute 决定不输出此段"。v10 教学版 compute fn 永远返回非 null 字符串简化。

**为什么用 Map 而不是普通 object？** Map 有 `.clear()` / `.has()` / `.size` 等优势 API；普通 object 不能简单 `.clear()`。

## 3. resolveSystemPromptSections：cacheBreak: true 跳读但仍写

> `src/constants/systemPromptSections.ts:43-58`

```typescript
export async function resolveSystemPromptSections(
  sections: SystemPromptSection[],
): Promise<(string | null)[]> {
  const cache = getSystemPromptSectionCache()

  return Promise.all(
    sections.map(async s => {
      if (!s.cacheBreak && cache.has(s.name)) {
        return cache.get(s.name) ?? null
      }
      const value = await s.compute()
      setSystemPromptSectionCacheEntry(s.name, value)
      return value
    }),
  )
}
```

**核心语义**：
- `!s.cacheBreak && cache.has(s.name)` 双条件：必须不是 DANGEROUS **且**已有缓存才走 cache 路径
- 否则（DANGEROUS **或** cache miss）执行 compute → 写入 cache → 返回
- **关键**：DANGEROUS 不绕过 cache 写入！它只是跳过 cache 读取。这意味着 DANGEROUS section 也会在 cache 里有一份"上次的副本"，只是下次永远不读它。

**v10 对照**：v10 同款逻辑 + 额外返回 `hitCache: boolean` 用于 audit 输出。工业函数返回 `(string | null)[]`，丢失了 hit/miss 信息——但工业不需要 audit 这个，OTEL 系统在更高层管。

## 4. BOUNDARY sentinel 字面值

> `src/constants/prompts.ts:114-115`

```typescript
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY =
  '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'
```

**v10 对照**：`const BOUNDARY_SENTINEL = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__"` 字面 1:1 抄。

**为什么是字符串 sentinel 而不是数组分组？** 工业 `getSystemPrompt()` 返回 `Promise<string[]>` —— 单一类型。如果用嵌套数组 `[static, dynamic]` 类型变成 `string[][]`，下游所有消费方都要改。用 sentinel 字符串塞进 flat array，下游 splitSysPromptPrefix 自己识别——单一类型不变，新功能可插拔。

## 5. 11+ section 注册 + DANGEROUS_uncached mcp_instructions 字面 reason

> `src/constants/prompts.ts:491-555`

```typescript
const dynamicSections = [
  systemPromptSection('session_guidance', () =>
    getSessionSpecificGuidanceSection(enabledTools, skillToolCommands),
  ),
  systemPromptSection('memory', () => loadMemoryPrompt()),
  systemPromptSection('ant_model_override', () =>
    getAntModelOverrideSection(),
  ),
  systemPromptSection('env_info_simple', () =>
    computeSimpleEnvInfo(model, additionalWorkingDirectories),
  ),
  systemPromptSection('language', () =>
    getLanguageSection(settings.language),
  ),
  systemPromptSection('output_style', () =>
    getOutputStyleSection(outputStyleConfig),
  ),
  DANGEROUS_uncachedSystemPromptSection(
    'mcp_instructions',
    () =>
      isMcpInstructionsDeltaEnabled()
        ? null
        : getMcpInstructionsSection(mcpClients),
    'MCP servers connect/disconnect between turns',
  ),
  systemPromptSection('scratchpad', () => getScratchpadInstructions()),
  systemPromptSection('frc', () => getFunctionResultClearingSection(model)),
  systemPromptSection(
    'summarize_tool_results',
    () => SUMMARIZE_TOOL_RESULTS_SECTION,
  ),
  // ... token_budget, brief if feature-flagged ...
]
```

**关键证据**：
1. 整个 `dynamicSections` 数组在 `BOUNDARY` **之后**（line 560-576 array literal 把它 spread 在 BOUNDARY 之后位置）
2. 只有 `mcp_instructions` 一个被 `DANGEROUS_uncachedSystemPromptSection` 标记
3. 字面 `_reason` 值：`'MCP servers connect/disconnect between turns'`

**v10 对照**：v10 PROMPT_SECTIONS_BEFORE_BOUNDARY/AFTER_BOUNDARY 分配跟工业不同（见 notes.md §3 解释）。v10 mcp_instructions 的 reason 字面就来自这里：`"MCP servers connect/disconnect between turns; instruction state may diverge from cached value"`（保留工业前缀 + 加教学解释后缀）。

## 6. splitSysPromptPrefix：BOUNDARY 切分 + cacheScope 标记

> `src/utils/api.ts:321-360`

```typescript
export function splitSysPromptPrefix(
  systemPrompt: SystemPrompt,
  options?: { skipGlobalCacheForSystemPrompt?: boolean },
): SystemPromptBlock[] {
  const useGlobalCacheFeature = shouldUseGlobalCacheScope()
  // ... 省略 fallback 分支 ...

  if (useGlobalCacheFeature) {
    const boundaryIndex = systemPrompt.findIndex(
      s => s === SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    )
    if (boundaryIndex !== -1) {
      // ... split by boundary index ...
      const result: SystemPromptBlock[] = []
      if (attributionHeader)
        result.push({ text: attributionHeader, cacheScope: null })
      if (systemPromptPrefix)
        result.push({ text: systemPromptPrefix, cacheScope: null })
      const staticJoined = staticBlocks.join('\n\n')
      if (staticJoined)
        result.push({ text: staticJoined, cacheScope: 'global' })
      const dynamicJoined = dynamicBlocks.join('\n\n')
      if (dynamicJoined) result.push({ text: dynamicJoined, cacheScope: null })
      return result
    }
  }
  // ...
}
```

**关键**：BOUNDARY 之前的 staticBlocks → `cacheScope: 'global'`（Anthropic prompt cache 跨组织共享）；BOUNDARY 之后的 dynamicBlocks → `cacheScope: null`（**不进 cache**，每轮 API 重传）。

**v10 对照**：v10 不实现 splitSysPromptPrefix 函数——assembleSystemPrompt 直接返回 `{ prefix, suffix }` 两段。v10 也不真发 `cache_control` 到 API（DeepSeek 端点未必支持）。仅在 audit 输出两段长度（`[BOUNDARY prefix=743_chars / suffix=98_chars]`）让学生眼见 cache 边界。

## 7. clearSystemPromptSections 在 compact 末尾的字面调用

> `src/services/compact/postCompactCleanup.ts:31-62`

```typescript
export function runPostCompactCleanup(querySource?: QuerySource): void {
  // ... other resets (apiState, classifier, speculative, etc.) ...
  clearSystemPromptSections()
  clearClassifierApprovals()
  clearSpeculativeChecks()
  // ...
}
```

**v10 对照**：v10 `maybeCompact()` 函数末尾调 `clearSystemPromptSections("compact")` 字面对应这里。工业还在另外 3 处调用同函数（worktree-enter / worktree-exit / undercover-mode-detect），v10 教学版只保留 compact 一个。

**为什么 compact 必须 clear？** Compact 后会话语义状态变化（早期 tool_result 内容被砍 / messages 数组重排），section compute fn 可能依赖旧上下文（如 `memory` section 可能根据近期对话内容动态生成）。cached value 瞬间 stale，必须强制重算。**这是语义因果链，不是缓存优化技巧**。
