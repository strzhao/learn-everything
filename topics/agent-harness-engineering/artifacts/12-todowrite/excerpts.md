# v12 工业源码引用（excerpts）

所有引用均来自 `../claude-code/src/`，出题/实现前已亲自 `Read` 验证（CLAUDE.md 0 假设原则）。

---

## 1. `tools/TodoWriteTool/TodoWriteTool.ts:65-103` —— call() 零 validation + completed→clear + verification nudge

```ts
async call({ todos }, context) {
  const appState = context.getAppState()
  const todoKey = context.agentId ?? getSessionId()
  const oldTodos = appState.todos[todoKey] ?? []
  const allDone = todos.every(_ => _.status === 'completed')
  const newTodos = allDone ? [] : todos

  // Structural nudge: if the main-thread agent is closing out a 3+ item
  // list and none of those items was a verification step, append a reminder
  // to the tool result. Fires at the exact loop-exit moment where skips
  // happen ("when the last task closed, the loop exited").
  let verificationNudgeNeeded = false
  if (
    feature('VERIFICATION_AGENT') &&
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_hive_evidence', false) &&
    !context.agentId &&
    allDone &&
    todos.length >= 3 &&
    !todos.some(t => /verif/i.test(t.content))
  ) {
    verificationNudgeNeeded = true
  }

  context.setAppState(prev => ({
    ...prev,
    todos: { ...prev.todos, [todoKey]: newTodos },
  }))

  return { data: { oldTodos, newTodos: todos, verificationNudgeNeeded } }
}
```

**要点**：(1) `todoKey = context.agentId ?? getSessionId()` —— v12 §27 `agentId ?? SESSION_ID` 1:1。(2) `allDone ? [] : todos` 存空表但返回 `newTodos: todos`（未清空的原表）。(3) `!context.agentId` = 仅主 agent 触发 verify nudge —— v12 用 `todoKey === SESSION_ID` 等价。(4) 整个 `call()` **没有一行**校验 "exactly one in_progress"。

---

## 2. `tools/TodoWriteTool/TodoWriteTool.ts:104-113` —— continuous nudge（每次 tool_result）

```ts
mapToolResultToToolResultBlockParam({ verificationNudgeNeeded }, toolUseID) {
  const base = `Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable`
  const nudge = verificationNudgeNeeded
    ? `\n\nNOTE: You just closed out 3+ tasks and none of them was a verification step. Before writing your final summary, spawn the verification agent (subagent_type="${VERIFICATION_AGENT_TYPE}"). You cannot self-assign PARTIAL by listing caveats in your summary — only the verifier issues a verdict.`
    : ''
  return { tool_use_id: toolUseID, type: 'tool_result', content: base + nudge }
}
```

**要点**：`base` 在**每次** TodoWrite 调用的 tool_result 里出现（continuous 层）；`nudge` 仅 `verificationNudgeNeeded` 时追加（event-triggered 层）。v12 `executeTodoWrite` 把这两段合进返回的 `content`。

---

## 3. `utils/todo/types.ts` —— schema 无 list-level refinement（不变量 = 软契约的 schema 证据）

```ts
export const TodoItemSchema = lazySchema(() =>
  z.object({
    content: z.string().min(1, 'Content cannot be empty'),
    status: TodoStatusSchema(),               // z.enum(['pending','in_progress','completed'])
    activeForm: z.string().min(1, 'Active form cannot be empty'),
  }),
)
export const TodoListSchema = lazySchema(() => z.array(TodoItemSchema()))
```

**要点**：只有 item 级校验（content/activeForm 非空、status 枚举）。`TodoListSchema` 就是裸 `z.array(...)`，**没有** `.refine(list => list.filter(in_progress).length <= 1)`。schema 层和 call() 层都不挡 —— "最多一个 in_progress" 唯一的存在处是 prompt 字面。

---

## 4. `tools/TodoWriteTool/prompt.ts:144-160` —— 不变量住在 prompt 里

```
## Task States and Management
1. **Task States**: pending / in_progress (limit to ONE task at a time) / completed
2. **Task Management**:
   - Update task status in real-time as you work
   - Mark tasks complete IMMEDIATELY after finishing (don't batch completions)
   - Exactly ONE task must be in_progress at any time (not less, not more)   ← :158
   - Complete current tasks before starting new ones
```

**要点**：`prompt.ts:158` 是 "exactly ONE in_progress" 的唯一权威源。整个 184 行 prompt 是行为协议；tool 执行体只有 115 行 → 论断 1。

---

## 5. `utils/attachments.ts:254-257 + 3296-3314` —— fixed-interval 缺席探测器

```ts
export const TODO_REMINDER_CONFIG = {
  TURNS_SINCE_WRITE: 10,
  TURNS_BETWEEN_REMINDERS: 10,
} as const
```

```ts
const { turnsSinceLastTodoWrite, turnsSinceLastReminder } =
  getTodoReminderTurnCounts(messages)
if (
  turnsSinceLastTodoWrite >= TODO_REMINDER_CONFIG.TURNS_SINCE_WRITE &&
  turnsSinceLastReminder >= TODO_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS
) {
  const todoKey = toolUseContext.agentId ?? getSessionId()
  const appState = toolUseContext.getAppState()
  const todos = appState.todos[todoKey] ?? []
  return [{ type: 'todo_reminder', content: todos, itemCount: todos.length }]
}
return []
```

**要点**：两个独立阈值，都满足才注入。"sinceWrite >= 10" 是缺席条件（调用沉默够久）；v12 教学版用单一 `TODO_REMINDER_TURNS` 合并了两者（见 notes.md §5 偏离）。`getTodoReminderTurnCounts`（:3212-3263）倒扫 messages 数 assistant 轮 —— v12 §28 同结构。

---

## 6. `utils/messages.ts:3663-3679` —— todo_reminder 渲染成 system-reminder

```ts
case 'todo_reminder': {
  const todoItems = attachment.content
    .map((todo, index) => `${index + 1}. [${todo.status}] ${todo.content}`)
    .join('\n')
  let message = `The TodoWrite tool hasn't been used recently. ... This is just a gentle reminder - ignore if not applicable. Make sure that you NEVER mention this reminder to the user\n`
  if (todoItems.length > 0) {
    message += `\n\nHere are the existing contents of your todo list:\n\n[${todoItems}]`
  }
  return wrapMessagesInSystemReminder([
    createUserMessage({ content: message, isMeta: true }),
  ])
}
```

**要点**：reminder 是 `isMeta: true` 的独立 **user-role** message，外面包 `<system-reminder>`。v12 §28 教学简化为 piggyback 到上一条 user 消息的 content（避免连续两条 user message），文案字面照抄（含 sentinel "The TodoWrite tool hasn't been used recently"）。

---

## 7. `utils/sessionRestore.ts:77-93` —— 无文件持久化（倒扫 transcript）

```ts
/**
 * Scan the transcript for the last TodoWrite tool_use block and return its todos.
 * Used to hydrate AppState.todos on SDK --resume so the model's todo list
 * survives session restarts without file persistence.
 */
function extractTodosFromTranscript(messages: Message[]): TodoList {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.type !== 'assistant') continue
    const toolUse = msg.message.content.find(
      block => block.type === 'tool_use' && block.name === TODO_WRITE_TOOL_NAME,
    )
    if (!toolUse || toolUse.type !== 'tool_use') continue
    const input = toolUse.input
    if (input === null || typeof input !== 'object') return []
    const parsed = TodoListSchema().safeParse((input as Record<string, unknown>).todos)
    return parsed.success ? parsed.data : []
  }
  return []
}
```

**要点**：注释字面 "survives session restarts **without file persistence**"。倒扫 messages（`i = length-1; i>=0; i--`）找最后一个 TodoWrite tool_use 反序列化 `input.todos`。v12 §29 `extractTodosFromTranscript` 同结构（去掉 SDK 的 Message 类型层）。restore 时用 `getSessionId()` 作 key（:143），故只 hydrate 主会话。
