# Lesson 15 · Interactive Session Loop —— 把 harness 从"库函数"变成"可交互 REPL"

> v15 在 v14 外面套一层外循环：用户敲一句 → 跑一个 turn → 交还控制权 → 等下一句。一次性脚本变成持续对话，并解决真人交互的三个麻烦：忙时插话、中途中断、跨 turn 状态累积。

## 这是什么 + 为什么现在学

v1–v14 你攒齐了 mini harness 的 14 个子系统——dispatch、permission、compact、hook、obs、streaming、MCP、system-prompt、skill、todo、memory——但它们都是**被动等调用**的库函数：`runRounds(messages, ...)` 跑完一个 turn 就返回，没有人能"再说一句"。

真实 agent 是**持续对话**：你敲一句、agent 跑一轮、你插嘴、agent 中断、你继续。这要求在 runRounds 外面套一层**有用户参与的外循环**。这一节把你的 harness 从"跑一次就退出"变成"持续对话直到用户离开"——也是从零件到整机的最后一步。

为什么现在学：v1-v14 每个 artifact 都假设"messages 已知 / 跑完即止"。v15 第一次让 messages **在 turn 之间累积**、让用户**在 turn 跑到一半时还能插话**、让中断**不丢历史**。这是 agent 从"批处理脚本"到"交互式 REPL"的分水岭。

## 怎么跑（物理锚点）

```bash
cd topics/agent-harness-engineering/artifacts/15-interactive-session-loop

# 脚本模式（确定性 / 产 run-log）
bun agent-v15-interactive-loop.ts --script=multi-turn      # 跨 turn 累积
bun agent-v15-interactive-loop.ts --script=enqueue-busy    # 忙时插话入队
bun agent-v15-interactive-loop.ts --script=interrupt       # 中途中断

# 交互模式（真 readline / 手动多轮）
bun agent-v15-interactive-loop.ts --interactive
```

预期输出：`[BOOT]` → `v15 INTERACTIVE SESSION LOOP boot` → 按 scenario 注入输入，看到 `SESSION TURN N` / `[GUARD]` / `[QUEUE]` / `[event] ABORTED` 标记。

## 银行叫号大厅：外循环的心智模型

把整个外循环想象成**银行叫号大厅**：

- **大厅本身** = 外循环（持续接待，不关门）—— 用户随时进来，agent 持续响应
- **叫号窗口** = QueryGuard（一次只服务一个客户）—— 窗口忙时新客户不能闯，得排队
- **排队机** = 消息队列（被动 / 优先级）—— VIP（now）插队、普通（next）按序、系统通知（later）垫底，但**排队机自己不会叫号**，要等窗口空了外部触发
- **客户中途离开** = abort（协作式取消）—— 办到一半走了，**已办的业务不回滚**（已读的文件、已答的话都保留），窗口立刻接待下一个
- **客户档案** = messages（跨 turn 累积）—— 每个客户办完档案留在柜面，下个客户来时柜员能看到全部历史

这个类比最易糊的张力：**排队机 ≠ 叫号窗口**。排队机只是个**被动账本**（记谁在等），真正"一次一个"是窗口（QueryGuard）强制的。把两者糊成"队列管并发"会让你建错模型——下面论断 3 会展开。

## 论断 1：内/外循环二分，边界是 async generator

外循环消费 `query()`，`query()` 是 async generator（`async function*`），yield 事件流；外循环 `for await` 消费。一次 `query()` 调用 = 一个会话 turn（可能含多 round）。下面是 §39 `query()` 完整实现（**100% v15 新增 / v14 无此段**），点击片段可在抽屉查看完整源文件上下文：

@include(./agent-v15-interactive-loop.ts, section=39)

工业对照：`query.ts:219 export async function* query` + `:230 yield* queryLoop` + `REPL.tsx:2793 for await (event of query(...))`。

**核心张力与解法**：v14 的 `runRounds`（§10）是普通 async function（return void / 不 yield / 内部 console.log）。物理上 async function 不能改成 generator 又保持字面不变。所以 v15 **字面保留 v14 runRounds**（历史参照），新写 `runRoundsGen`——镜像 runRounds 的循环逻辑（复用 v14 的 callModel/dispatch/maybeCompact/injectRelevantMemories/maybeInjectTodoReminder/systemAssembler），但加 yield + signal。这是"逻辑镜像、物理重写"，v14 runRounds 一行不改（diff 证明）。

## 论断 2-4：QueryGuard 闸门 ⊥ 消息队列（职责分离第三次显形）

这是本课最容易建错模型的地方，分三层讲清楚。

**QueryGuard 是一把锁**（三态机 idle/dispatching/running），站在所有输入路径的汇合点。running 时 tryStart 返回 null，第二个 turn 被改道去排队（**100% v15 新增 / 对照 QueryGuard.ts:29-121**）：

@include(./agent-v15-interactive-loop.ts, section=37)

**消息队列是被动账本**（enqueue/dequeue/peek + 优先级 now/next/later），**没有 run-loop**。"一次一个 + 自动下一个"由外部驱动：turn 结束的 finally 调 drainQueue，检查闸门 idle + 队列非空才 dequeue。

**为什么必须分开**（朴素方案的死法）：如果把防并发塞进队列，队列就变成有 run-loop 的主动调度器，既要存输入又要调度输入，职责糊化。工业方案的洞察是——**防并发是闸门的活，接住被挡输入是队列的活**，两者正交。这是本课第三次职责分离显形（同 v2 permission-gate⊥ask-tool、v12 主agent自律⊥系统兜底）。

turn 1 round 1 model 调 read_file（dispatch 穿过 v14 全管道 / tool_use）：

@include(./run-log-enqueue-while-busy.txt, round=1)

turn 1 的收尾 round（end_turn）证明 turn 正常跑完：

@include(./run-log-enqueue-while-busy.txt, round=2)

而"turn 跑一半注入第二句 → 入队 → drain"的完整链路在 round 2 之后（被 Stop hook 的 extraction swarm 分隔），摘录关键三行：

```
[GUARD] busy (status=running gen=1) → enqueue priority=next queue.len=1: "插队：读完前三个后，也顺便读 /tmp/d.txt。"
... (turn 1 跑完 end_turn + extraction swarm 收尾) ...
[GUARD] end gen=1 → idle (status=idle)
[QUEUE] drain → start next turn priority=next: "插队：读完前三个后，也顺便读 /tmp/d.txt。" | remaining: (empty)
```

观察：busy 时输入被 enqueue（不丢）→ turn 1 end_turn 后闸门 idle → drain 把队列里的输入取出当下一个 turn。队列没主动"叫号"，是闸门 idle 这个信号触发 drain——对照 `useQueueProcessor.ts:48 if (isQueryActive) return`。

turn 2（drain 出来的插队输入被处理 / 控制权经 drain 交还）：

@include(./run-log-enqueue-while-busy.txt, round=3)

## 论断 5：中断 = 协作式取消，messages 完整

中断信号 → `abortController.abort('user-cancel')` → signal 经 query() 穿到 runRoundsGen → **在 round 边界检查** signal.aborted 早退。已 emit 的消息保留完整（不回滚）。round 边界检查在 `runRoundsGen` 循环体开头（**100% v15 新增**），点击片段可在抽屉查看完整 runRoundsGen 上下文：

@include(./agent-v15-interactive-loop.ts, section=38)

注意"协作式"：callModel 本身**不检查** signal（v14 callModel 没 signal 参数）。abort 不会打断正在 await 的 model call——它要等当前 round 的 callModel 返回，**下一个 round 开头**才检查。这是 round 原子性（同 v5）。工业对照 `query.ts:1015 if (signal.aborted)` + `:1046 signal.reason !== 'interrupt'`。

@include(./run-log-interrupt-mid-round.txt, round=1)

观察 round 1 正常完成（tool_use 读文件），下一个 round 边界 `[event] ABORTED atRound=2 reason=user-cancel` → turn 早退。摘录中断后的收尾：

```
========== TURN 1 COMPLETE aborted=true lastRound=1 messages.len=4 ==========
... (turn 1 中断 / 4 条消息完整保留 / turn 2 在此基础上继续) ...
========== SESSION TURN 2 (guard gen=2 priority=now messages.len=4) ==========
```

`messages.len=4` 证明中断后**消息完整保留**（user + assistant round1 + tool_result + ...），turn 2 在 4 条基础上累积。不回滚、不清空——对照 `REPL.tsx:2891 setMessages(old => [...old, ...newMessages])`。

turn 2（中断后继续 / 控制权交还后用户重新提问）：

@include(./run-log-interrupt-mid-round.txt, round=3)

## 跨 turn 累积：messages 是外循环的账本

sessionMessages 是 module-scoped 数组，每个 turn push 一条 user message，query() 拿全量历史。这是"agent 记得之前说过什么"的物理基础。

@include(./run-log-multi-turn-session.txt, round=1)

turn 1 round 1 model 收到"记住代号 ALPHA-7"，round 2 确认记住：

@include(./run-log-multi-turn-session.txt, round=2)

后续 turn 2 引用（messages 跨 turn 累积，每次 query() 拿全量历史）：

@include(./run-log-multi-turn-session.txt, round=3)

session 结束的全量 messages 账本是跨 turn 累积的物理证据（每 turn 的 user + assistant + tool_result 全在 / buildRuns extractFinalMessages 用它拿真实 tool_result 而非占位）：

@include(./run-log-multi-turn-session.txt, section="FINAL MESSAGES")

## 第 9 次架构正交性 + 字面 0 修改

v15 不碰 v14 任何业务逻辑行。`diff v14 v15 | grep -c '^<'` = **0**（无 v14 行被 modify/delete），只有 2 段 add（§37-§41 新增 323 行 + main 拦截分支 12 行）。v15 = v14 1933 行 + 新增 335 行 ≈ 2268 行。

| 论断 | v15 物理实现 | 工业锚点 |
|------|-------------|---------|
| 内/外循环二分 | §39 query() async generator + runRoundsGen | query.ts:219/230/241/307 |
| QueryGuard 闸门 | §37 三态机 + generation | QueryGuard.ts:29-121, REPL.tsx:2869 |
| 队列被动不防并发 | §38 enqueue/dequeue/peek + 优先级 now/next/later | messageQueueManager.ts:53/128/142/151/167 |
| 两路径汇合于闸门 | §40 handleInput tryStart 分流 | handlePromptSubmit.ts:152/313 |
| 协作式取消 | §39 round 边界 signal 检查 + §41 AbortController | query.ts:664/1015/1046, REPL.tsx:2147 |

外循环复用 v14 全部子函数（callModel/dispatch/maybeCompact/injectRelevantMemories/maybeInjectTodoReminder/assembleSystemPrompt/getToolsForRole/runSwarm/hooks.emit），0 行新通道。第 9 次正交性：**外循环没碰内循环一行**。

## 工业偏离合规清单

| 偏离 | 教学版 | 工业版 | 理由 |
|------|-------|-------|------|
| UI 层 | readline / stdout | Ink/React + useSyncExternalStore | 无 React 依赖 |
| 闸门订阅 | runOneTurn finally 直接 drain | useQueueProcessor effect 响应式 re-render | 无 React |
| 三态机 dispatching | 两态 idle/running（注释说明 dispatching 必要性） | idle/dispatching/running 完整 race 闭合 | mini 抓主干，dispatching 作 stretch |
| 输入来源 | readline + 脚本注入 | PromptInput + bridge/remote/tick 多来源 | 聚焦主路径 |
| 中断触发 | Ctrl-C / 脚本 abort | ESC + 多 abort reason | 终端简化 |
| runRoundsGen vs runRounds | 新写 generator 版（v14 runRounds 字面保留作历史参照） | query/queryLoop 单一 generator 链 | 教学要"字面 0 修改"硬约束 |
| drain 时机 | runOneTurn finally 同步调 drain | useQueueProcessor effect 异步驱动 | 同步更易读，不影响论断 |
| round 编号 | 全局递增（跨 turn 累计 / ROUND 标记跨 turn 唯一） | 每 turn 从 1 重置 | run-replay 兼容（agent-notebook buildRuns sort 需唯一 round 号）/ 不影响 turn≠round 语义 |

## 下一步

回到 `/learn` 让课程验收 task 15。v15 是 mini harness 的最后一个子系统——把 14 个"库函数零件"装进可交互 REPL 整机。15 个 artifact 齐备后将触发 assemble 拼装毕业产物。
