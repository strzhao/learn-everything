# Excerpts —— claude-code streaming 关键源码引用

## 1. StreamingToolExecutor class 定义（StreamingToolExecutor.ts:40-62）

```ts
export class StreamingToolExecutor {
  private tools: TrackedTool[] = []
  private toolUseContext: ToolUseContext
  private hasErrored = false
  private erroredToolDescription = ''
  private siblingAbortController: AbortController
  private discarded = false
  private progressAvailableResolve?: () => void

  constructor(
    private readonly toolDefinitions: Tools,
    private readonly canUseTool: CanUseToolFn,
    toolUseContext: ToolUseContext,
  ) {
    this.toolUseContext = toolUseContext
    this.siblingAbortController = createChildAbortController(
      toolUseContext.abortController,
    )
  }
```

**要点**：executor 持有 `tools: TrackedTool[]` 数组 + `siblingAbortController`（Bash error 时 abort 兄弟 tool）+ `discarded` 标志（streaming fallback 时丢弃所有 pending）。

## 2. addTool 立即启动（StreamingToolExecutor.ts:76-124）

```ts
addTool(block: ToolUseBlock, assistantMessage: AssistantMessage): void {
  // ... 找 toolDefinition、判 isConcurrencySafe ...
  this.tools.push({
    id: block.id, block, assistantMessage,
    status: 'queued', isConcurrencySafe, pendingProgress: [],
  })
  void this.processQueue()  // ← 立即启动执行（不等 stop_reason）
}
```

**要点**：`void this.processQueue()` —— 调 addTool 时就开始执行，不是等所有 tool_use 收齐才 batch dispatch。这是 pipelining 的物理起点。

## 3. processQueue 并发控制（StreamingToolExecutor.ts:140-151）

```ts
private async processQueue(): Promise<void> {
  for (const tool of this.tools) {
    if (tool.status !== 'queued') continue
    if (this.canExecuteTool(tool.isConcurrencySafe)) {
      await this.executeTool(tool)
    } else {
      if (!tool.isConcurrencySafe) break  // 非并发安全的 tool 必须独占
    }
  }
}
```

**要点**：`isConcurrencySafe` 区分可并行 vs 必须独占。Bash tool 失败后 `siblingAbortController.abort('sibling_error')` 取消所有兄弟（因为 Bash 命令有隐式依赖链）。

## 4. getCompletedResults 同步 poll（StreamingToolExecutor.ts:412-439）

```ts
*getCompletedResults(): Generator<MessageUpdate, void> {
  for (const tool of this.tools) {
    while (tool.pendingProgress.length > 0) {
      yield { message: tool.pendingProgress.shift()! }
    }
    if (tool.status === 'yielded') continue
    if (tool.status === 'completed' && tool.results) {
      tool.status = 'yielded'
      for (const message of tool.results) {
        yield { message, newContext: this.toolUseContext }
      }
    } else if (tool.status === 'executing' && !tool.isConcurrencySafe) {
      break  // 非并发安全的 tool 还没完成 → 后面的都不能 yield
    }
  }
}
```

**要点**：工业版按**注册顺序** yield（维护 tool_result 在 messages 中的位置一致性）。非并发安全的 tool 在 executing 状态时阻塞后续 yield —— 保证顺序语义。

## 5. query.ts streaming loop（query.ts:838-862）

```ts
if (streamingToolExecutor && !toolUseContext.abortController.signal.aborted) {
  for (const toolBlock of msgToolUseBlocks) {
    streamingToolExecutor.addTool(toolBlock, message)  // ← model 还在流 → tool 已启动
  }
}
if (streamingToolExecutor && !toolUseContext.abortController.signal.aborted) {
  for (const result of streamingToolExecutor.getCompletedResults()) {
    if (result.message) {
      yield result.message
      toolResults.push(...normalizeMessagesForAPI([result.message], ...))
    }
  }
}
```

**要点**：streaming loop 中，每收到一个 assistant message（含 tool_use blocks）就 addTool → 紧接着 getCompletedResults poll 已完成的 → yield 给调用方。这实现了"model 输出与 tool 执行时间重叠"。

## 6. grouping.ts "yield order, not concat order"（grouping.ts:29-31）

```ts
// normalizeMessages yields one AssistantMessage per content block, and
// StreamingToolExecutor interleaves tool_results between chunks live
// (yield order, not concat order — see query.ts:613). The id check
// correctly keeps `[tu_A(id=X), result_A, tu_B(id=X)]` in one group.
let lastAssistantId: string | undefined
```

**要点**：这是 streaming 下消息组边界判定的核心注释 —— streaming 模式下 tool_result 按完成顺序 interleave 进 messages 数组，所以 grouping 必须用 `message.id`（assistant 边界）而非位置来判断 round 归属。

## 7. query.ts abort 后 drain（query.ts:1011-1023）

```ts
// When using streamingToolExecutor, we must consume getRemainingResults() so the
// executor can generate synthetic tool_result blocks for queued/in-progress tools.
// Without this, tool_use blocks would lack matching tool_result blocks.
if (toolUseContext.abortController.signal.aborted) {
  if (streamingToolExecutor) {
    for await (const update of streamingToolExecutor.getRemainingResults()) {
      if (update.message) { yield update.message }
    }
  }
}
```

**要点**：abort 后必须 drain executor —— 为仍在 executing/queued 的 tool 生成 synthetic error tool_result，否则 API 发送时 tool_use 没有配对 tool_result 会报错。这是协议层"每个 tool_use 必须有 tool_result 配对"约束在 streaming abort 场景的工程体现。
