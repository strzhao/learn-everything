# Task 04：coordinator + swarm worker —— 把 multi-agent 落到代码

> v3 解决了 `(tool × mode)` 二维矩阵问题，但 production 还有一个被压住的维度：**agent-role**。当 coordinator 需要派 swarm 并行处理时，swarm 既没有 ask user 的物理通道，也不能把内部上下文全部带回 coordinator。本任务把 Lecture 04 抽象出的 4 条 multi-agent 洞察落到 284 行 v4 代码 + 4 份真实 run-log，对照 claude-code 工业实现验证每一条。看完你应该能说清三件事：(1) agent-role 为什么是物理约束维度（不是软约束）；(2) swarm 上行路由的 in-process Promise 与工业 mailbox 在语义上为什么等价；(3) "context 从深度变广度" 的实测数据形态是什么。

## 是什么

Task 03 的 v3 给我们一个 `(tool × mode) → policy` 矩阵 + dispatch 多态执行。但 v3 假定整个 harness 只有"一个 agent + 一个 user"。production 不是这样的：

- coordinator 派 swarm 并行处理子任务，**3-30 个 swarm 同时跑很常见**
- swarm 可能在远程 / 并行 / 无 stdin 环境下运行 —— 物理上**没有弹 readline 的能力**
- coordinator 没法把 30 个 swarm 的完整 messages 都拿回来综合 —— **context 会爆**

v4 用三种 agent-role 表达这些约束：

- **interactive**：单 agent，含 ask_user，弹 readline（≈ v3 退化兼容）
- **coordinator**：含 ask_user + `spawn_swarm` 工具，自己弹 readline，可派 swarm
- **swarm-worker**：**工具 schema 物理上无 ask_user / 无 spawn_swarm**，ask 请求向上路由到 coordinator

三种 role **共享同一个 modeMatrix 判决函数**（判决统一），只在执行层分化（**多态执行**）。

## §1. Role 枚举 + 三维矩阵函数

mode 是 union string（v3 留下），role 也是。policy 仍是 `auto-allow | ask | hard-block`。

注意 modeMatrix 签名加了 `_role` 参数，但 underscore 前缀意味着 **role 参数当前不参与 policy 计算**。这是有意的：体现"判决统一" —— 同样的 (tool × mode) 在不同 role 下产出**同样的 policy**，差异在执行层。

@include(./agent-v4-coordinator-swarm.ts, section=1)

这跟 claude-code `permissions.ts` 的 `hasPermissionsToUseToolInner` 完全一致：role 在那里也不影响 policy，只影响 handler 选择（`useCanUseTool.tsx:95-165` 三层 handler 串行 try）。

## §2. Hard-block 列表（v3 继承，与 mode/role 都正交）

完全沿用 v3 的 HARD_BLOCK_PATHS。"hard-block 是 user 兜底"在 multi-agent 场景下变得更重要 —— swarm 在 bypass mode 下并行跑 100 个，user 不可能为每个动作再确认，hard-block 就是这种场景下的最后防线。

@include(./agent-v4-coordinator-swarm.ts, section=2)

对照 claude-code `permissions.ts:1252-1260` 的 safetyCheck：bypass 越不过 `.git/` / `.claude/` / `.vscode/` 等敏感路径。设计精神在 multi-agent 场景下完全一致。

## §3. Tools schema 按 role 分化（物理约束的代码体现）

这是 Socratic 05 Q2 内化的"swarm 无 ask_user 是物理约束"在代码里的字面量体现：

@include(./agent-v4-coordinator-swarm.ts, section=3)

关键看 `getToolsForRole(role)` 三个分支：

- **swarm-worker** 返回 `BASE_TOOLS` —— **完全没有 ask_user，也没有 spawn_swarm**
- **coordinator** 加了 ASK_USER_TOOL 和 SPAWN_SWARM_TOOL —— 能问 user，能派 swarm
- **interactive** 加了 ASK_USER_TOOL（无 spawn_swarm）—— 单 agent 模式

这不是"建议 model 不要用 ask_user"，是 **schema 里根本没挂这个工具，model 即使训练分布里想调 ask_user 也调不到**。对照 claude-code `createSubagentContext` 同精神（[excerpts.md §5](./excerpts.md)）。

## §4. Ask 转发通道：v4 简化 vs 工业 mailbox

swarm 的 ask 通道是 v4 最关键的设计。看 §4：

@include(./agent-v4-coordinator-swarm.ts, section=4)

**核心抽象**：`AskFn = (question, ctx) => Promise<answer>`。

- `interactiveAsk`：直接调 `prompt()`（Bun 内置 readline），同进程同步
- `makeRoutedAsk(swarmId, parentAsk)`：包装 swarm 的 ask 请求 → 加 audit ROUTED-UP 标记 → 调 parentAsk（继承 coordinator 的 interactiveAsk）→ 拿到 answer 再 audit → 返回

v4 实现 in-process Promise + closure capture。**工业版用 mailbox + callback registry 实现同样语义**：

```ts
// src/hooks/toolPermission/handlers/swarmWorkerHandler.ts:67-123
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

工业版多出来的复杂度都在解决跨进程相关问题：

- **mailbox**：跨进程通道（v4 单进程，用 closure 替代）
- **createResolveOnce + claim**：多回调路径竞争原子保证（onAllow / onReject / abort 谁先到谁赢）
- **callback 注册先于发送**：race condition 修复（leader 答得太快时 callback 还没注册）

**接口语义完全一致**。v4 现在 in-process，**未来切换到跨进程只需替换 `makeRoutedAsk` 的实现，dispatch 函数与 swarm runLoop 完全不动**。这是 v4 设计的关键扩展点。

## §5. Dispatch 入口：判决统一 + askFn 多态注入

这是 v4 设计精髓汇合的段：

@include(./agent-v4-coordinator-swarm.ts, section=5)

三个分支处理三种 policy。注意 `policy === "ask"` 分支里：

```ts
const ans = (await askFn(`mode=${mode} Allow ${name} on ${pp(input)}? [y/N]`, { tool: name, input, role })).toLowerCase();
```

**askFn 不是 dispatch 内部决定的，是参数注入的**。interactive role 下传入 `interactiveAsk`，swarm role 下传入 `makeRoutedAsk(swarmId, parentAsk)`。**判决统一在 modeMatrix，执行多态在 askFn**。

对照 claude-code `useCanUseTool.tsx:95-165`：

```ts
case "ask": {
  const coordinatorDecision = await handleCoordinatorPermission({ ... });  // 判决
  if (coordinatorDecision) { resolve(coordinatorDecision); return; }
  const swarmDecision = await handleSwarmWorkerPermission({ ... });         // swarm 执行
  if (swarmDecision) { resolve(swarmDecision); return; }
  handleInteractivePermission({ ... }, resolve);                            // interactive 执行
}
```

三层 handler 串行 try，每层各自实现"如何送达 user / 答案如何返回"。v4 用 `askFn` 参数注入做了同样的事（更简化）。

## §6. Swarm worker runLoop（独立 messages 数组 = context 隔离）

@include(./agent-v4-coordinator-swarm.ts, section=6)

关键看：

- `const messages: any[] = [{ role: "user", content: task }]` —— **swarm 内部 messages 数组是局部声明**，与 coordinator messages **无任何引用关系**
- `getToolsForRole("swarm-worker")` —— 工具表物理上无 ask_user / spawn_swarm
- `makeRoutedAsk(swarmId, parentAsk)` —— ask 通道注入
- 完成后**只返回 summary string**（提取最后一条 assistant text 的 text blocks），coordinator 看不到 swarm 内部 round / tool_use / tool_result

对照 claude-code `createSubagentContext({ messages: initialMessages, ... })`：同形态。每个 worker 独立 messages 数组是 context 隔离的物理基础。

## §7. Coordinator runLoop（spawn_swarm + 多 swarm 并行）

@include(./agent-v4-coordinator-swarm.ts, section=7)

关键设计：

- `const spawnFn = (task, swarmMode) => runSwarm(task, swarmMode, interactiveAsk)` —— spawn 时 coordinator 把自己的 `interactiveAsk` 作为 swarm 的 parentAsk 传下去（**ask 链路构造**）
- runRounds 内部 `Promise.all(...tool_use.map(dispatch))` —— **多 swarm 并行 = 同一轮多个 spawn_swarm tool_use → Promise.all 并发 dispatch**

这跟 claude-code coordinatorMode.ts:213 完全一致：*"Parallelism is your superpower. To launch workers in parallel, make multiple tool calls in a single message."* —— 并行不是 harness 显式 Promise.all，是 **model 在同一轮 emit 多个 spawn_swarm**，runRounds 的 Promise.all 自然并发。

## §8. 场景 A：interactive role 退化兼容（v3 行为完全保留）

User prompt：`请删除 /tmp/test1.txt 和 /tmp/test2.txt。`

User 输入：第一个 `N`，第二个 `y`。

@include(./run-log-interactive.txt, round=1)

Round 1 model 调 2 个 delete_file，dispatch 弹 2 个 readline。第一个 N → `is_error: true`，第二个 y → mock 删除。

@include(./run-log-interactive.txt, round=2)

Round 2 model 看到 is_error 后自适应（同 v3 现象，证明三维矩阵向下兼容）。

注意 audit 行带 `role=interactive` 标签（如果 mode 触发 audit 的话）。这里 default mode 下 ask policy 不打 audit，跟 v3 行为一致。

## §9. 场景 B：coordinator 派 3 swarm 并行处理

User prompt：`请并行读取 /tmp/a.txt, /tmp/b.txt, /tmp/c.txt 三个文件，每个用一个独立的 swarm 处理。每个 swarm 读完后用一句话总结文件内容。最后你综合 3 个 swarm 的总结成一份最终报告。`

模式：bypassPermissions（避开 readline 干扰）。

@include(./run-log-coordinator-3-swarms.txt, round=1)

Round 1 coordinator 发出 3 个 `spawn_swarm` tool_use（**model 自主选择并行**）。这之后 3 个 swarm 同时启动 LIFECYCLE。

## §10. 多 swarm 并行：真正乱序执行的物理证据

3 个 swarm 同时启动后跑各自内部 round。看实际打印顺序（行号截图）：

```
51:---------- swarm[2] ROUND 1  stop_reason=tool_use ----------
68:---------- swarm[0] ROUND 1  stop_reason=tool_use ----------
85:---------- swarm[1] ROUND 1  stop_reason=tool_use ----------
102:---------- swarm[2] ROUND 2  stop_reason=end_turn ----------
166:---------- swarm[1] ROUND 2  stop_reason=end_turn ----------
230:---------- swarm[0] ROUND 2  stop_reason=tool_use ----------
247:---------- swarm[0] ROUND 3  stop_reason=end_turn ----------
```

注意启动顺序是 0→1→2，但 ROUND 1 完成顺序是 **2→0→1**（network/model 随机抖动），ROUND 2 完成顺序是 **2→1→0**，且 swarm[0] 多跑了一轮（model 个性化行为）。**这是真正的并发**：每个 swarm 在自己的 Promise 里独立跑，谁先到 model 谁先打印。

看 swarm[0] 的完整 messages 数组：

@include(./run-log-coordinator-3-swarms.txt, section="swarm[0] FINAL MESSAGES")

swarm[0] 内部 4 条 messages：user prompt + assistant (read_file tool_use) + user (tool_result `<mocked content>`) + assistant (final text 总结)。**完全独立的小循环**。

## §11. Context 隔离：coordinator 看到的 messages 形态

现在看 coordinator 自己的最终 messages 数组：

@include(./run-log-coordinator-3-swarms.txt, section="FINAL MESSAGES")

**关键观察**：

- coordinator messages 数组里**完全没有任何 `read_file` tool_use**
- coordinator messages 数组里**完全没有任何 `<mocked content>`**
- coordinator 只看到 3 个 `spawn_swarm` tool_use 和 3 个 tool_result（每个 tool_result content 是 `[swarm[i]] summary: ...` 字符串）

**这就是 context 从深度变广度的实测形态**：

- 深度（v3 单 agent 同等任务）：3 个 read_file + 3 个 tool_result + final 综合 = 单 messages 数组里 ~150-200 行
- 广度（v4）：coordinator 85 行（只含 spawn_swarm 元信息）+ 3 个 swarm 各自 64-81 行（深度被分割到各自作用域）

**深度增长不影响 coordinator**：如果 swarm 内部从 3 轮涨到 30 轮，coordinator messages 增量 ≈ 0（只看 summary string）。**这就是 context 隔离最强的工程价值**。

## §12. 场景 C：swarm ask 向上路由（routed-up）

User prompt：`请派一个 swarm worker 删除 /tmp/old.log 这个旧日志文件。swarm 跑完后告诉我结果。`

模式：default（让 swarm 触发 ask policy → 向上路由）。

User 输入：`y`

@include(./run-log-swarm-ask-routed-up.txt, round=1)

Round 1 coordinator 发出 1 个 spawn_swarm。swarm[0] 启动，调 delete_file。dispatch 在 swarm role + default mode 下判决 ask，调 `makeRoutedAsk` 包装的 askFn。

**关键日志链（stderr 输出）**：

```
[AUDIT] role=swarm-worker swarm=swarm[0] ROUTED-UP tool=delete_file q="mode=default Allow delete_file on /tmp/old.log? [y/N]"
[from swarm[0]] mode=default Allow delete_file on /tmp/old.log? [y/N] [AUDIT] role=swarm-worker swarm=swarm[0] ROUTED-UP answer="y"
[MOCK] would rm -rf /tmp/old.log
```

5 步可见：

1. swarm[0] 的 dispatch 判决 ask
2. makeRoutedAsk 打 `ROUTED-UP tool=delete_file q="..."`（请求上行）
3. parentAsk (interactiveAsk) 在 coordinator 进程内弹 readline，提示词带 `[from swarm[0]]` 前缀
4. user 输入 y → answer 回传，makeRoutedAsk 打 `ROUTED-UP answer="y"`
5. swarm[0] 继续 execute delete_file，mock 删除

**v4 用 in-process Promise + closure 实现了工业 mailbox + callback registry 的语义**。如果未来 swarm 跑在远程进程，只需把 makeRoutedAsk 改成 IPC / RPC / mailbox，dispatch 与 swarm runLoop 不变。

@include(./run-log-swarm-ask-routed-up.txt, round=2)

Round 2 coordinator 收到 swarm 的 summary tool_result → 综合 → 告诉 user 结果。整个链路闭合。

## §13. 4 条洞察对照工业实现（小结）

**1. agent-role 是物理约束维度** ✅ 命中
- v4: `getToolsForRole(role)` 三个分支，swarm-worker 工具 schema 字面量无 ask_user / spawn_swarm
- 工业版: `createSubagentContext({ ... })` + 工具裁剪

**2. swarm 物理约束 = 向上路由** ✅ 命中
- v4: `makeRoutedAsk(swarmId, parentAsk)` 包装请求 + audit ROUTED-UP + 等回传
- 工业版: `swarmWorkerHandler.ts:67-123` mailbox + Promise + callback registry

**3. context 从深度变广度** ✅ 命中（实测数据）
- v4 实测: coordinator FINAL 85 行**不含**任何 read_file / `<mocked content>` / swarm 内部 tool_use
- 工业版: `createSubagentContext({ messages: initialMessages, ... })` 同物理隔离

**4. 判决统一 / 执行多态** ✅ 命中
- v4: `modeMatrix(tool, input, mode, _role)` 判决统一（role 不参与）；`dispatch(...askFn...)` 按 role 注入不同 askFn
- 工业版: `useCanUseTool.tsx:95-165` 三层 handler 串行 try，共享判决结果，各自执行

完整对照与推理见 [notes.md §2](./notes.md)。

## §14. 写回 v3 的 3 处改进意见

1. **dispatch 加 role 参数**（即使当前不用）—— 未来扩展不破坏签名
2. **askFn 作为参数注入** —— 不在 dispatch 内硬编码 `prompt()`，支持 mock / 跨进程 / multi-role
3. **execute 函数从 dispatch 拆出来** —— 判决 / askFn / execute 三者完全解耦

完整改进建议与对应工业实现见 [notes.md §6](./notes.md)。

## 下一步

回到 `learn-everything/topics/agent-harness-engineering/` 让课程验收这次交付。v4 的 "context 从深度变广度" 暴露了下一个问题：coordinator messages 随 swarm 数量线性增长。**Lecture 05 context compaction** 自然接入 —— 单 agent 深度爆掉 vs coordinator 收 swarm 太多，是同一问题在不同维度的两种形态。
