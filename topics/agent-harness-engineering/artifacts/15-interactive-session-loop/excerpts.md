# Excerpts 15 · 工业源码锚点

> 实读 `/Users/stringzhao/workspace_sync/personal_projects/claude-code/src/`。lesson.md 的论断逐条回到这里核实。0 假设原则：以下片段全部来自实际 Read，非命名推断。

## 1. query.ts —— async generator（论断 1 边界）

### query() 外层 generator（:219-239）

```ts
// query.ts:219
export async function* query(
  params: QueryParams,
): AsyncGenerator<StreamEvent | RequestStartEvent | Message | ..., Terminal> {
  const consumedCommandUuids: string[] = []
  const terminal = yield* queryLoop(params, consumedCommandUuids)   // :230 委托内循环
  for (const uuid of consumedCommandUuids) {
    notifyCommandLifecycle(uuid, 'completed')
  }
  return terminal
}
```

### queryLoop() while(true) + memory prefetch（:241-307）

```ts
// query.ts:301 —— once per user turn（不是每 round）
using pendingMemoryPrefetch = startRelevantMemoryPrefetch(
  state.messages, state.toolUseContext,
)
// query.ts:307
while (true) {
  let { toolUseContext } = state
  ...
}
```

**关键**：memory prefetch 锚在 queryLoop 入口（:301），不是每 round。这印证 spec"once per user turn"。

### 中断检查（:664, :1015, :1046）

```ts
// query.ts:664 —— signal 穿入 toolUseContext
signal: toolUseContext.abortController.signal

// query.ts:1015 —— round 边界检查
if (toolUseContext.abortController.signal.aborted) {
  ... yield createUserInterruptionMessage();
  return { reason: 'aborted_streaming' }
}

// query.ts:1046 —— reason 区分
if (toolUseContext.abortController.signal.reason !== 'interrupt') { ... }
```

## 2. QueryGuard.ts —— 三态闸门（论断 2，实读全文 121 行）

```ts
// QueryGuard.ts:30
private _status: 'idle' | 'dispatching' | 'running' = 'idle'
private _generation = 0

// QueryGuard.ts:38-43 idle→dispatching
reserve(): boolean {
  if (this._status !== 'idle') return false
  this._status = 'dispatching'; return true
}
// QueryGuard.ts:61-67 →running
tryStart(): number | null {
  if (this._status === 'running') return null
  this._status = 'running'; ++this._generation; return this._generation
}
// QueryGuard.ts:74-80 generation 检查防 stale finally
end(generation: number): boolean {
  if (this._generation !== generation) return false
  if (this._status !== 'running') return false
  this._status = 'idle'; return true
}
// QueryGuard.ts:99-101
get isActive(): boolean { return this._status !== 'idle' }
```

**三态转换**（注释 :5-16）：`idle → dispatching (reserve)` / `dispatching → running (tryStart)` / `idle → running (tryStart 直接提交)` / `running → idle (end/forceEnd)` / `dispatching → idle (cancelReservation)`。`isActive` 对 dispatching+running 都 true（:17-18 注释："preventing re-entry from the queue processor during the async gap"）。

## 3. REPL.tsx —— 外循环消费链（论断 1/2/4/5）

### for await 消费（:2793-2803）

```ts
// REPL.tsx:2793
for await (const event of query({
  messages: messagesIncludingNewMessages,
  systemPrompt, userContext, systemContext, canUseTool, toolUseContext,
  querySource: getQuerySourceForREPL()
})) {
  onQueryEvent(event);
}
```

### onQuery tryStart 分流 + 跨 turn 累积（:2869-2891）

```ts
// REPL.tsx:2869
const thisGeneration = queryGuard.tryStart();
if (thisGeneration === null) {                                     // :2870 busy
  newMessages.filter(...).forEach((msg) => {
    enqueue({ value: msg, mode: 'prompt' });                      // :2877 改道入队
  });
  return;
}
try {
  setMessages(oldMessages => [...oldMessages, ...newMessages]);   // :2891 跨 turn 累积
  await onQueryImpl(...);
} finally {
  if (queryGuard.end(thisGeneration)) {                            // :2923 generation 检查
    await mrOnTurnComplete(messagesRef.current, abortController.signal.aborted);  // :2930
  }
}
```

### abort（:2147）

```ts
// REPL.tsx:2147
abortController?.abort('user-cancel');
```

## 4. messageQueueManager.ts —— 被动队列（论断 3）

```ts
// messageQueueManager.ts:53
const commandQueue: QueuedCommand[] = []

// :128 enqueue（默认 next）
export function enqueue(command: QueuedCommand): void {
  commandQueue.push({ ...command, priority: command.priority ?? 'next' })
  notifySubscribers()
}
// :142 系统通知（默认 later / 不饿死 user input）
export function enqueuePendingNotification(command: QueuedCommand): void {
  commandQueue.push({ ...command, priority: command.priority ?? 'later' })
}
// :151
const PRIORITY_ORDER: Record<QueuePriority, number> = { now: 0, next: 1, later: 2 }
// :167 dequeue（最高优先级 FIFO / 可选 filter）
export function dequeue(filter?: (cmd) => boolean): QueuedCommand | undefined {
  ...  // 遍历找 priority 最小（最高优先级）的，splice 取出
}
```

**关键**：队列是纯数组（:53），enqueue/dequeue 是普通读写，**无 run-loop / 无锁**。driven by useQueueProcessor effect。

## 5. useQueueProcessor.ts —— drain effect（论断 3 外部驱动）

```ts
// useQueueProcessor.ts:35-38 订阅闸门
const isQueryActive = useSyncExternalStore(queryGuard.subscribe, queryGuard.getSnapshot)
// :43-46 订阅队列
const queueSnapshot = useSyncExternalStore(subscribeToCommandQueue, getCommandQueueSnapshot)

// :48-60 drain effect（三条件全满足才 drain）
useEffect(() => {
  if (isQueryActive) return           // 闸门忙 → 不 drain
  if (hasActiveLocalJsxUI) return     // 有 JSX UI 阻塞 → 不 drain
  if (queueSnapshot.length === 0) return  // 队列空 → 不 drain
  processQueueIfReady({ executeInput: executeQueuedInput })
}, [queueSnapshot, isQueryActive, executeQueuedInput, hasActiveLocalJsxUI, queryGuard])
```

**闸门 idle 信号（isQueryActive false）是 drain 的必要条件**——印证"队列不防并发，闸门才防"。

## 6. handlePromptSubmit.ts —— 两输入路径（论断 4）

### 队列路径（drain 出来的命令直接执行，跳过验证）（:150-172）

```ts
// handlePromptSubmit.ts:150
if (queuedCommands?.length) {
  await executeUserInput({ queuedCommands, messages, ..., onQuery, queryGuard, ... });  // :152
  return
}
```

### 忙时路径（闸门 active → enqueue + 可能 interrupt）（:313-334）

```ts
// handlePromptSubmit.ts:313
if (queryGuard.isActive || isExternalLoading) {
  if (params.hasInterruptibleToolInProgress) {
    params.abortController?.abort('interrupt')   // :331 新输入中断旧 turn（reason='interrupt'）
  }
  // enqueue ...（:334+）
}
```

**两路径汇合点**：executeUserInput 最终调 `onQuery` → `tryStart`。空闲新输入过完整验证后也进 executeUserInput；忙时输入**不进** executeUserInput，直接 enqueue。所以 tryStart 是所有"真正启动 turn"路径的汇合点——反证队列不防并发（若队列防并发，tryStart 分流就没意义）。
