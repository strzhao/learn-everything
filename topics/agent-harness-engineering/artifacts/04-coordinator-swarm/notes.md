# notes.md —— Task 04 对照报告

> Lecture 04 抽象出的 4 条 multi-agent 洞察 ↔ v4 代码 ↔ claude-code 工业实现的对照报告。
>
> 4 条洞察源自 Socratic 05 全对一次通过的内化：(1) agent-role 是物理约束维度；(2) swarm 物理约束本质 = 没有 ask user 的物理通道；(3) context 从深度变广度；(4) 判决与执行分层在三维下不退化。
>
> v4 的 284 行代码不是凭空设计 —— 它是这 4 条洞察的代码物理化。本文档证明每一行 v4 都对应某条洞察 + 工业实现的某段源码。

---

## §1. 源码定位（步骤 0）

**结论**：claude-code 的 multi-agent 子系统有清晰可读源码，4 条洞察都能逐条对应。

### 关键文件

| 文件 | 大小 | 角色 |
|---|---|---|
| `src/coordinator/coordinatorMode.ts` | 18.6K | coordinator 调度核心、worker 派发策略、并行原则 system prompt |
| `src/hooks/toolPermission/handlers/coordinatorHandler.ts` | 2.3K | coordinator 端 permission handler（只跑 hook + classifier 自动判决，无自带 UI） |
| `src/hooks/toolPermission/handlers/swarmWorkerHandler.ts` | 5.4K | swarm 端 permission handler（mailbox + callback + Promise 上行路由） |
| `src/hooks/toolPermission/handlers/interactiveHandler.ts` | 19.7K | interactive 端 permission handler（React queue + UI） |
| `src/hooks/useCanUseTool.tsx` | 39.3K | 三层 handler 分发入口（line 95-165 case "ask"） |
| `src/tools/AgentTool/runAgent.ts` | 大 | spawn worker 入口，`createSubagentContext` 决定 messages 隔离 |

### 关键 grep 命中

- `bypassPermissions` / `acceptEdits` / `PermissionMode` 枚举：v3 时已定位 `sdk-tools.d.ts:337` 完整 6 种
- `handleSwarmWorkerPermission` / `sendPermissionRequestViaMailbox` / `registerPermissionCallback`：`swarmWorkerHandler.ts:40-145`
- `handleCoordinatorPermission`：`coordinatorHandler.ts:26-61`
- `createSubagentContext`：`AgentTool/runAgent.ts` 多处

完整源码片段汇总在 [excerpts.md](./excerpts.md)，下文按需引用。

---

## §2. 4 条洞察逐条对照

### 洞察 1：agent-role 是物理约束维度（不是软约束）

**判定**：✅ **命中**

**v4 代码体现**：`agent-v4-coordinator-swarm.ts` §3 的 `getToolsForRole(role)`

```ts
function getToolsForRole(role: Role): any[] {
  if (role === "swarm-worker") return BASE_TOOLS;                            // 物理上无 ask_user / spawn_swarm
  if (role === "coordinator") return [...BASE_TOOLS, ASK_USER_TOOL, SPAWN_SWARM_TOOL];
  return [...BASE_TOOLS, ASK_USER_TOOL];                                      // interactive
}
```

**工业版**：claude-code `createSubagentContext()`（[excerpts.md §5](./excerpts.md)）传给 worker 的 `messages: initialMessages` + 工具 schema 不含 AskUserQuestion。

**实测验证**：跑 `run-log-coordinator-3-swarms.txt`，看 swarm[i] LIFECYCLE 段：

```
========== swarm[0] LIFECYCLE ==========
task: 请读取 /tmp/a.txt ... | mode: default | tools: read_file,edit_file,delete_file
```

**`tools: read_file,edit_file,delete_file`** —— 三字面量打印出来，**无 ask_user / spawn_swarm**。这不是"model 训练分布上不爱用 ask_user"，是"schema 里物理上没有这个工具，model 即使想调也调不到"。Socratic 05 Q1 已确认：物理约束 ≠ 软约束。

---

### 洞察 2：swarm 物理约束 = 没有 ask user 的物理通道 → 必须向上路由

**判定**：✅ **命中**（v4 简化版与工业版语义一致）

**工业版**：[excerpts.md §2](./excerpts.md) — `swarmWorkerHandler.ts:40-145`

```ts
const decision = await new Promise<PermissionDecision>(resolve => {
  const { resolve: resolveOnce, claim } = createResolveOnce(resolve)
  const request = createPermissionRequest({ ... })
  registerPermissionCallback({
    requestId: request.id,
    async onAllow(...) { if (!claim()) return; resolveOnce(await ctx.handleUserAllow(...)) },
    onReject(...) { if (!claim()) return; resolveOnce(ctx.cancelAndAbort(...)) },
  })
  void sendPermissionRequestViaMailbox(request)
})
```

三个关键设计：(a) **mailbox 作为通道**（跨进程友好）；(b) **callback 注册先于发送**（避免 race condition）；(c) **resolveOnce + claim 原子性**（多回调路径竞争时只允许一次 resolve）。

**v4 代码体现**：`agent-v4-coordinator-swarm.ts` §4 的 `makeRoutedAsk`

```ts
function makeRoutedAsk(swarmId: string, parentAsk: AskFn): AskFn {
  return async (question, ctx) => {
    audit(`role=swarm-worker swarm=${swarmId} ROUTED-UP tool=${ctx.tool} q=${JSON.stringify(question)}`);
    const answer = await parentAsk(`[from ${swarmId}] ${question}`, ctx);
    audit(`role=swarm-worker swarm=${swarmId} ROUTED-UP answer=${JSON.stringify(answer)}`);
    return answer;
  };
}
```

v4 用 in-process Promise + closure capture，工业用 mailbox + callback registry。**接口语义一致**（包装请求 → 上行 → 等回传），未来跨进程只需替换 `makeRoutedAsk` 的实现，dispatch 函数与 swarm runLoop 完全不动。

**实测验证**：`run-log-swarm-ask-routed-up.txt` 的 audit 行：

```
[AUDIT] role=swarm-worker swarm=swarm[0] ROUTED-UP tool=delete_file q="mode=default Allow delete_file on /tmp/old.log? [y/N]"
[from swarm[0]] mode=default Allow delete_file on /tmp/old.log? [y/N] [AUDIT] role=swarm-worker swarm=swarm[0] ROUTED-UP answer="y"
[MOCK] would rm -rf /tmp/old.log
```

完整链路可见：swarm 判决 ask → audit ROUTED-UP → parentAsk 在 coordinator 进程内弹 readline（前缀 `[from swarm[0]]`）→ user 输入 y → answer 回传 → audit ROUTED-UP answer → swarm 继续 execute。

---

### 洞察 3：context 从深度变广度

**判定**：✅ **命中**（实测数据强证据）

**v4 代码体现**：每个 `runSwarm` 内部 `const messages: any[] = [{ role: "user", content: task }]` 是局部声明，与 coordinator messages 数组**无任何引用关系**（context 物理隔离）。swarm 完成后只返回 `summary: string` 给 coordinator。

**工业版**：[excerpts.md §5](./excerpts.md) — `createSubagentContext({ messages: initialMessages, ... })` 同形态。

**实测数据（来自 `run-log-coordinator-3-swarms.txt` 437 行总输出）**：

| 段 | 行数 | 说明 |
|---|---|---|
| coordinator ROUND 1（spawn 3 swarm） | 40 | coordinator 派工指令 |
| swarm[2] LIFECYCLE（含 3 swarm 内部 round 交错） | 67 | swarm 们 deep 工作 |
| swarm[2] FINAL MESSAGES | 64 | swarm 2 完整 messages dump |
| swarm[1] FINAL MESSAGES | 81 | swarm 1 完整 messages dump |
| swarm[0] FINAL MESSAGES | 80 | swarm 0 完整 messages dump |
| coordinator ROUND 2（综合） | 13 | coordinator 看 summary 合成最终 |
| **coordinator FINAL MESSAGES** | **85** | coordinator 看到的全部 context |

**关键验证（grep coordinator FINAL MESSAGES 段）**：

- `read_file` tool_use ↔ **0 次出现** ❌
- `<mocked content>` ↔ **0 次出现** ❌

也就是说 **3 个 swarm 各自跑了 2-3 轮 read_file + thinking，coordinator messages 数组里看不到任何这些操作**。coordinator 只看到 3 个 spawn_swarm 工具的 summary string。

**深度→广度的量化**：

- v3 单 agent 等价任务（猜想）：3 个 read_file + 3 轮 think + 综合 → 单 messages 数组里 ~150-200 行（**深度增长**：所有操作累积）
- v4：coordinator 85 行 + 3 swarm 各 ~80 行（**深度被分割成 3 个浅 + 1 个广**：coordinator 只随 swarm 数量线性增长，不随每 swarm 内部深度增长）

如果 swarm 内部从 3 轮涨到 30 轮，coordinator 增量 ≈ 0（只看 summary）。**这就是 context 隔离最强的工程价值：单 swarm 深度爆掉不影响 coordinator**。

---

### 洞察 4：判决与执行分层在三维下不退化

**判定**：✅ **命中**

**v4 代码体现**：
- 判决：`agent-v4-coordinator-swarm.ts` §1 的 `modeMatrix(tool, input, mode, _role)` —— **role 参数当前不参与 policy 计算**（注释明说 `_role` underscore 表示有意忽略）
- 执行多态：§5 的 `dispatch(name, input, mode, role, askFn, spawnFn)` —— policy 判决统一调 modeMatrix，但 `askFn` 在不同 role 下注入不同实现（interactive/coordinator 用 `interactiveAsk`，swarm 用 `makeRoutedAsk(swarmId, parentAsk)`）

**工业版**：[excerpts.md §1](./excerpts.md) — `useCanUseTool.tsx:95-165` case "ask"：

```ts
case "ask": {
  const coordinatorDecision = await handleCoordinatorPermission({ ... });   // 判决：自动 hook + classifier
  if (coordinatorDecision) { resolve(coordinatorDecision); return; }
  const swarmDecision = await handleSwarmWorkerPermission({ ... });          // 多态执行 #1: swarm 上行路由
  if (swarmDecision) { resolve(swarmDecision); return; }
  handleInteractivePermission({ ... }, resolve);                             // 多态执行 #2: interactive UI
}
```

三层 handler 串行尝试，每层各自实现"如何送达 user / 答案如何返回"，但**共享同一个判决结果**（result.updatedInput / suggestions / pendingClassifierCheck）。

**反例：如果不分层（错误设计）**：
- 给每个 role 单独写一个 dispatch 函数 → 判决逻辑会重复 3 份 → 维护一致性困难
- role 直接影响 policy → 同一 (tool, mode) 在不同 role 下行为不一致 → 用户难以建立心智模型

v4 与工业版都明确避免了这两种错误。

---

## §3. mode 矩阵物理承载结构图（v4 三维版）

```
                  +----------------------------------+
                  |  dispatch(name, input,           |
                  |           mode, role,            |
                  |           askFn, spawnFn?)       |
                  +----------------------------------+
                                 |
                                 v
              +------------------+------------------+
              |  modeMatrix(tool, input, mode,      |
              |             _role)                  |
              |  -- 有序 if 链，role 不参与判决 --   |
              +---+----+----+----+----+-------------+
                  |    |    |    |    |
                  v    v    v    v    v
              hard  meta  read  bypass acceptEdits
              block tool  like  any?  & edit_like
                                                       |
                                                       v
                                                  ELSE: "ask"
                                                       |
                                                       v
                  +------------------+------------------+
                  |  按 policy 分支                     |
                  +---+--------------+-----------------++
                      |              |                  |
            policy="hard-block"   policy="ask"     policy="auto-allow"
                      |              |                  |
                      v              v                  v
            audit + is_error      askFn(...)         execute()
                                     |
                                     v
                  +------------------+------------------+
                  |    askFn 多态（按 role）            |
                  +--------+--------+-------------------+
                           |        |
                           v        v
                    interactiveAsk   makeRoutedAsk
                    (本地 readline)  (向上转发 parentAsk)
                                          |
                                          v
                                    parent's askFn
                                    (在 coordinator 进程内
                                     最终也是 readline)
```

**对照工业实现**：
- modeMatrix 有序 if 链 ↔ `permissions.ts:1158-1310` `hasPermissionsToUseToolInner` 10+ 步 if 链
- askFn 多态 ↔ `useCanUseTool.tsx:95-165` 三层 handler 串行 try
- interactiveAsk ↔ `interactiveHandler.ts` React queue + UI
- makeRoutedAsk + parentAsk ↔ `swarmWorkerHandler.ts` mailbox + callback registry
- spawnFn ↔ `AgentTool/runAgent.ts` `createSubagentContext`

---

## §4. context 实测数据（v3 vs v4 同等任务对照）

> Spec 要求第 5 节有 v3 与 v4 的 context 实测数据对照。

### 任务

"读 3 个文件 + 综合成一份总结"。v3 用单 agent + 3 次 read_file 完成；v4 用 coordinator + 3 swarm 并行完成。

### v3 估算（依据 v3 已有 run-log 同样任务的形态外推）

v3 单 agent 跑此任务：
- ROUND 1: model 调 3 个 read_file（tool_use × 3）
- ROUND 2: model 收到 3 个 tool_result + 输出综合 text → end_turn
- **messages 数组**：1 user prompt + 1 assistant (3 tool_use) + 1 user (3 tool_result) + 1 assistant (final text) = 4 条
- **每条 assistant 含 thinking + text + 多个 tool_use blocks**：估算 70-120 行 JSON dump

### v4 实测（来自 `run-log-coordinator-3-swarms.txt`）

| 数组 | 行数 | 内容 |
|---|---|---|
| coordinator messages | 85 | 1 user + 1 assistant (3 spawn_swarm) + 1 user (3 tool_result = summary string × 3) + 1 assistant (final 综合) = 4 条 |
| swarm[0] messages | 80 | 1 user + 1 assistant (1 read_file) + 1 user (1 tool_result) + 1 assistant (think + final summary text) = 4 条 |
| swarm[1] messages | 81 | 类似 swarm[0] |
| swarm[2] messages | 64 | 类似 swarm[0]（model 没多 think 一轮所以略短） |

### 关键对照

| 维度 | v3 单 agent | v4 coordinator | 差异 |
|---|---|---|---|
| 跑此任务后 model 后续轮次能看到的 context | 全部 ~70-120 行 | **只 85 行 coordinator messages** | v4 coordinator 看不到任何 read_file / `<mocked content>` |
| 总 token 消耗 | 1 份完整历史 | coordinator + 3 swarm 历史，**但 swarm 历史不会进未来 model 调用** | v4 总 token 高（4 份 messages），但 coordinator 后续轮次 token 低 |
| swarm 内部深度增长的影响 | 每多 1 轮都进 messages | **每多 1 轮只影响 swarm，coordinator 不变** | v4 在长任务下 coordinator 增长慢 |

**结论**（Socratic 05 Q3 内化的实测验证）：

- **深度问题被分割**：每个 swarm 在自己作用域消化深度，v4 把 1 个 "可能爆掉的深度上下文" 分割成 3 个独立的、互不影响的浅度上下文
- **广度问题新增**：coordinator messages 随 swarm 数量线性增长（spawn 1 个 swarm → coordinator messages 多 1 条 tool_use + 1 条 tool_result）。**这就是 Lecture 05 要解决的下一个问题：context compaction 在广度场景下变成"对 coordinator messages 的 spawn_swarm 历史做压缩"**

---

## §5. 多 agent 比单 agent 新增的失败模式

v4 比 v3 引入的新失败模式（≥ 2 个）：

### 失败模式 A：swarm 死锁等 coordinator

**场景**：swarm 在 default mode 调 delete_file → makeRoutedAsk 包装 → await parentAsk（弹 readline）。但 coordinator 自己在同时执行另一个 spawn_swarm 的 await（多个并发 spawn_swarm），readline 队列可能错乱。

**v4 当前处理**：⬛ 未处理。`Promise.all(...spawn_swarm...)` 并发，如果同时多个 swarm 弹 readline，readline 会按 stdin 行序读 —— **user 看到第一个 question 但不知道答的是哪个 swarm**（虽然 question 字符串带 `[from swarm[i]]` 前缀，但 stdin 是单线程，user 答错顺序很容易）。

**production 补救**：claude-code 的 mailbox + callback registry + per-request id 设计专门处理这个 —— 每个 request 有 id，answer 按 id 路由回正确的 promise。即使 user 答错顺序，callback 也能正确 dispatch。

### 失败模式 B：一个 swarm 失败拖累整体

**场景**：3 个并发 swarm，其中 1 个 fetch 报错（network / 401 / model max_tokens 截断）。

**v4 当前处理**：⬛ 未处理。`Promise.all` 在任一 promise reject 时整体 reject，coordinator runRounds 直接 throw 退出。

**production 补救**：Claude code 用 `Promise.allSettled` + per-worker error 包装，单个 swarm 失败时 coordinator 收到 `is_error: true` 的 summary，可以决定重试 / 跳过 / 用 user 介入。

### 失败模式 C：context 隔离反过来阻碍 worker 之间协作

**场景**：swarm[0] 处理 /tmp/a.txt 发现需要查 /tmp/b.txt 的内容才能继续，但 swarm[1] 正在处理 /tmp/b.txt。

**v4 当前处理**：⬛ 未处理。swarm 之间 messages 完全隔离，无法直接通信。

**production 补救**：claude-code 的 coordinator 系统提示明说 *"Do not use one worker to check on another. Workers will notify you when they are done"*（[excerpts.md §6](./excerpts.md)）—— **设计上禁止 worker 间直接通信**，必须通过 coordinator 中转。这把多 agent 协作简化为"星型拓扑"（所有 agent 只跟 coordinator 说话），避免 N×N 的复杂度。

---

## §6. 写回 v3 的 3 处改进意见

### 改进 1：dispatch 加 role 参数（即使当前不用）

v3 的 `dispatch(name, input, mode)` 没有 role 维度。改进：加 `role: Role` 参数（即使当前都是 "interactive"）。好处：扩展到 multi-agent 时不需要改 dispatch 签名，只需要在调用点传不同 role + askFn。

v4 已经这样做了：`dispatch(name, input, mode, role, askFn, spawnFn)`。signature 一开始就预留 role 维度，未来扩展不破坏调用方代码。

### 改进 2：askFn 作为参数注入，而不是硬编码 prompt()

v3 在 dispatch 内部直接调 `prompt(...)`。改进：把"如何 ask user"做成一个 `AskFn` 参数注入。

好处：(a) interactive 时用 readline；(b) swarm 时换成 makeRoutedAsk；(c) 测试时换成 mock；(d) 未来跨进程时换成 IPC。**dispatch 函数完全不动**。

v4 已经这样做了：`AskFn` 类型 + `interactiveAsk` / `makeRoutedAsk` 两种实现。

### 改进 3：execute 函数从 dispatch 拆出来

v3 在 dispatch 内部既做判决又做执行（policy 决定后直接 inline 跑 readline + tool）。改进：拆 `decide()` + `execute()`，更接近 claude-code 的"判决统一 / 执行多态"分层。

v4 的 dispatch 内部用 `if (policy === "ask") askFn(...); ...; return execute(...)` —— `execute()` 已经独立函数，可被测试。决定（modeMatrix）+ askFn 注入 + execute 三者完全解耦。

---

## §7. 一句话总结

4 条 Lecture 04 洞察全部验证为工业实现的精神。最大学习：

> **multi-agent 的本质不是"任务并行化"，而是"用 agent-role 维度把 context 的深度问题分割成多个浅度 + 一个广度问题"。判决统一保证 (tool × mode) 的策略一致性，执行多态保证 ask 在不同 role 下能正确送达 user。这是 v3 的"判决与执行分离"在 multi-agent 场景下的自然扩展。**

广度问题是 Lecture 05 context compaction 的自然入口：单 agent 深度爆掉 vs coordinator 收 swarm 太多 —— 是同一问题在不同维度的两种形态。
