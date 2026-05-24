# excerpts —— claude-code coordinator/swarm 关键源码

> 备查文档。所有片段来自本机 `/Users/stringzhao/workspace/claude-code/` 工作副本。
> notes.md 的 4 条洞察对照按需引用本文片段。

---

## §1. 三层 handler 分发：判决统一 / 执行多态（推论 1 + 4）

**文件**：`src/hooks/useCanUseTool.tsx:95-165`

```ts
case "ask":
  {
    if (appState.toolPermissionContext.awaitAutomatedChecksBeforeDialog) {
      const coordinatorDecision = await handleCoordinatorPermission({  // ← 判决统一：先跑 hook + classifier
        ctx,
        pendingClassifierCheck: result.pendingClassifierCheck,
        updatedInput: result.updatedInput,
        suggestions: result.suggestions,
        permissionMode: appState.toolPermissionContext.mode
      })
      if (coordinatorDecision) {
        resolve(coordinatorDecision)
        return
      }
    }

    const swarmDecision = await handleSwarmWorkerPermission({  // ← 多态执行 #1：swarm 上行路由
      ctx,
      description,
      pendingClassifierCheck: result.pendingClassifierCheck,
      updatedInput: result.updatedInput,
      suggestions: result.suggestions
    })
    if (swarmDecision) {
      resolve(swarmDecision)
      return
    }

    handleInteractivePermission({  // ← 多态执行 #2：interactive 弹 UI
      ctx,
      description,
      result,
      awaitAutomatedChecksBeforeDialog: appState.toolPermissionContext.awaitAutomatedChecksBeforeDialog,
      bridgeCallbacks: ...,
      channelCallbacks: ...
    }, resolve)
    return
  }
```

**关键**：三层 handler **共享同一个判决结果**（result.updatedInput / suggestions / pendingClassifierCheck 都来自统一判决）；差异**只在"如何把 ask 行为送达 user / 答案如何返回"**。这是 v4 `dispatch` 函数把 `askFn` 作为参数注入的工业版。

---

## §2. swarm 向 coordinator 上行路由：mailbox + Promise + callback registry（推论 2）

**文件**：`src/hooks/toolPermission/handlers/swarmWorkerHandler.ts:40-145`

```ts
async function handleSwarmWorkerPermission(
  params: SwarmWorkerPermissionParams,
): Promise<PermissionDecision | null> {
  if (!isAgentSwarmsEnabled() || !isSwarmWorker()) {
    return null
  }
  // ...
  // Forward permission request to the leader via mailbox
  const decision = await new Promise<PermissionDecision>(resolve => {
    const { resolve: resolveOnce, claim } = createResolveOnce(resolve)

    // Create the permission request
    const request = createPermissionRequest({
      toolName: ctx.tool.name,
      toolUseId: ctx.toolUseID,
      input: ctx.input,
      description,
      permissionSuggestions: suggestions,
    })

    // Register callback BEFORE sending the request to avoid race condition
    // where leader responds before callback is registered
    registerPermissionCallback({
      requestId: request.id,
      toolUseId: ctx.toolUseID,
      async onAllow(allowedInput, permissionUpdates, feedback, contentBlocks) {
        if (!claim()) return // atomic check-and-mark before await
        resolveOnce(await ctx.handleUserAllow(...))
      },
      onReject(feedback, contentBlocks) {
        if (!claim()) return
        resolveOnce(ctx.cancelAndAbort(feedback, undefined, contentBlocks))
      },
    })

    // Now that callback is registered, send the request to the leader
    void sendPermissionRequestViaMailbox(request)
    // ...
  })
  return decision
}
```

**关键设计**：
- **mailbox 作为通道**（不是直接函数调用）—— 跨进程友好
- **callback 注册先于发送**（注释明说避免 race condition：leader 答得太快时 callback 还没注册）
- **resolveOnce + claim 原子保证**——多种回调路径（onAllow / onReject / abort）竞争时只允许一个 resolve

v4 简化：单进程 + closure capture + Promise（`makeRoutedAsk` 函数）。但**接口语义完全一致**：包装请求 → 上行 → 等回传。**未来切换到跨进程只需替换 makeRoutedAsk 的实现，dispatch 不动**。

---

## §3. coordinator 端 handler：无自带 UI，只跑自动判决（推论 3）

**文件**：`src/hooks/toolPermission/handlers/coordinatorHandler.ts:26-61`

```ts
async function handleCoordinatorPermission(
  params: CoordinatorPermissionParams,
): Promise<PermissionDecision | null> {
  const { ctx, updatedInput, suggestions, permissionMode } = params

  try {
    // 1. Try permission hooks first (fast, local)
    const hookResult = await ctx.runHooks(
      permissionMode,
      suggestions,
      updatedInput,
    )
    if (hookResult) return hookResult

    // 2. Try classifier (slow, inference -- bash only)
    const classifierResult = feature('BASH_CLASSIFIER')
      ? await ctx.tryClassifier?.(params.pendingClassifierCheck, updatedInput)
      : null
    if (classifierResult) {
      return classifierResult
    }
  } catch (error) {
    logError(error)
  }

  // 3. Neither resolved (or checks failed) -- fall through to dialog below.
  return null
}
```

**关键**：`coordinatorHandler` 只跑 hook + classifier 自动判决。如果自动判决都不出结果，**返回 null** 让调用方走 interactive handler 弹本地 UI —— 也就是说 **coordinator 自己也是通过 interactive 的 UI 通道跟 user 交互**，没有"coordinator 专用 UI"。

v4 简化：跳过 hook + classifier 这一层（v3 已经把 mode + safetyCheck 当作判决依据），coordinator role 直接复用 `interactiveAsk`（同进程 readline）。设计精神一致：判决统一，coordinator 不需要另外发明 UI 通道，复用 interactive 的就行。

---

## §4. coordinator 系统提示明确指导"并行就是超能力"（推论 4）

**文件**：`src/coordinator/coordinatorMode.ts:213, 344-345`

```ts
**Parallelism is your superpower. Workers are async. Launch independent workers
concurrently whenever possible — don't serialize work that can run simultaneously
and look for opportunities to fan out. When doing research, cover multiple angles.
To launch workers in parallel, make multiple tool calls in a single message.**

### Example

Each "You:" block is a separate coordinator turn. The "User:" block is a `<task-notification>` delivered between turns.

You:
  Let me start some research on that.

  ${AGENT_TOOL_NAME}({ description: "Investigate auth bug", subagent_type: "worker", prompt: "..." })
  ${AGENT_TOOL_NAME}({ description: "Research secure token storage", subagent_type: "worker", prompt: "..." })

  Investigating both issues in parallel — I'll report back with findings.
```

**关键**：工业实现的"并行"**不是 harness 显式 `Promise.all`，而是 model 在同一轮 emit 多个 tool_use → query engine 隐式调度**。v4 完全复刻这个模式（`SPAWN_SWARM_TOOL.description` 也写了"Tip: fan out parallel work by emitting MULTIPLE spawn_swarm calls in ONE turn"），coordinator model 自动发出多个 spawn_swarm tool_use，`runRounds` 的 `Promise.all` 并发 dispatch。

---

## §5. spawn subagent：独立 messages 数组（context 隔离的物理证据）

**文件**：`src/tools/AgentTool/runAgent.ts:700-715`（位置可能因版本不同，关键字 `createSubagentContext`）

```ts
const agentToolUseContext = createSubagentContext(toolUseContext, {
  options: agentOptions,
  agentId,
  agentType: agentDefinition.agentType,
  messages: initialMessages,     // ← worker 自己的独立 [] 或最小 context
  readFileState: agentReadFileState,
  abortController: agentAbortController,
  getAppState: agentGetAppState,
  shareSetAppState: !isAsync,
  shareSetResponseLength: true,
  criticalSystemReminder_EXPERIMENTAL: agentDefinition.criticalSystemReminder_EXPERIMENTAL,
  contentReplacementState,
})
```

**关键**：每个 worker 拿到全新 `messages: initialMessages` 数组（独立内存），不共享父 context。v4 用 `const messages: any[] = [{ role: "user", content: task }]` 在 `runSwarm` 内部局部声明，**和 coordinator 的 messages 数组无任何引用关系** —— 同一物理隔离原则的最简体现。

---

## §6. coordinator 系统提示对 worker 行为的策略约束（推论 4 / 5）

**文件**：`src/coordinator/coordinatorMode.ts:113-126`

```ts
function getCoordinatorSystemPrompt(): string {
  const workerCapabilities = isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)
    ? 'Workers have access to Bash, Read, and Edit tools, plus MCP tools from configured MCP servers.'
    : 'Workers have access to standard tools, MCP tools from configured MCP servers, and project skills via the Skill tool.'

  return `You are Claude Code, an AI assistant that orchestrates software engineering tasks across multiple workers.
...
When calling ${AGENT_TOOL_NAME}:
- Do not use one worker to check on another. Workers will notify you when they are done.
- Do not use workers to trivially report file contents or run commands...
- Continue workers whose work is complete via ${SEND_MESSAGE_TOOL_NAME} to take advantage of their loaded context
...`
}
```

**关键**：工业 coordinator system prompt 显式教 coordinator：(a) 哪些任务该派 worker（值得隔离的、需要并行的）；(b) 哪些任务不该派（trivial report / 检查 worker 状态）；(c) 通过 SendMessage 复用 worker 已加载的 context。**这是把"agent-role 是物理维度"的设计经验显式传递给 model。** v4 的 system prompt 比这简单得多，只提示了"prefer fanning out"，是教学最小化。
