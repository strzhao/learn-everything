# Notes 15 · 工业细节深度反思

> lesson.md 只保留 1 张对照表 + 核心推理，工业细节的完整推理链在这里。lesson 是"读完就懂"，notes 是"为什么是这样"。

## 1. 三态机 dispatching 的 race window（完整推导）

mini 版 QueryGuard 用两态（idle/running），工业用三态（idle/dispatching/running）。dispatching 中间态不是装饰，是焊死一个真实的 async race window。

**race 场景**：
1. turn A 在跑（running）
2. turn A 完成，useQueueProcessor effect 被唤醒（isQueryActive → false）
3. effect 调 processQueueIfReady → dequeue 命令 B → executeQueuedInput → handlePromptSubmit
4. handlePromptSubmit **第一个 await 之前**调 `queryGuard.reserve()`（idle→dispatching）
5. handlePromptSubmit 进入 processUserInput（含 await，如解析 pastedContents）
6. **就在这个 await 期间**，另一个用户输入 C 到，触发新的 handlePromptSubmit
7. C 检查 `queryGuard.isActive` —— 此时是 dispatching，isActive=true → C 进 enqueue 分支

**两态够不够挡？** 步骤 4 如果直接 tryStart（idle→running），步骤 6 的 C 查 isActive（running）也 true → 也 enqueue。看似两态够。

**dispatching 真正的价值在错误路径**：reserve（dispatching）后，若 processUserInput 抛错或跳过 onQuery，finally 的 `cancelReservation`（dispatching→idle）释放预约。若直接 tryStart（running）后出错，running 状态泄漏（没人 end），**队列永久阻塞**。dispatching 是"预约但未确认"的中间态，cancelReservation 是它的安全网。

mini 两态简化掉这个（runOneTurn 同步进 tryStart，handleInput 到 tryStart 之间无 async gap），注释说明即可。工业锚点：`QueryGuard.ts:38-43 reserve` + `:49-53 cancelReservation` + `handlePromptSubmit.ts:437 reserve` / `:603 cancelReservation（finally）`。

## 2. 两输入路径的精确层次（实际是三条）

论断 4 说"两路径汇合于闸门"，但工业实际有**三条**路径：

1. **空闲新输入**：用户提交 → handlePromptSubmit（无 queuedCommands）→ processUserInput（验证/解析）→ executeUserInput → onQuery → tryStart
2. **队列 drain**：useQueueProcessor effect → processQueueIfReady → executeQueuedInput → handlePromptSubmit（有 queuedCommands）→ executeUserInput（:150 跳过验证）→ onQuery → tryStart
3. **忙时输入**：用户提交 → handlePromptSubmit → `if (queryGuard.isActive)` → enqueue（**不进** executeUserInput）

路径 1 和 2 都过 executeUserInput → onQuery → tryStart（汇合点）。路径 3 改道 enqueue。

**executeUserInput 内部的 reserve（:437）**：在 processUserInput 第一个 await 前 reserve（idle→dispatching），封住"executeUserInput 开始"到"onQuery tryStart"之间的 async gap。这是 dispatching 的用武之地（见 §1）。

mini 把路径 1 和 2 合并成 handleInput（tryStart 分流），路径 3 是 tryStart 返回 null 的分支。简化掉了 executeUserInput 的 reserve 层（mini 的 runOneTurn 同步进 tryStart，无 async gap）。

## 3. useQueueProcessor effect 的三条件 + 触发链

工业 drain effect（useQueueProcessor.ts:48-60）有三个 return 条件：

```ts
if (isQueryActive) return           // 条件 1：闸门忙
if (hasActiveLocalJsxUI) return     // 条件 2：有 JSX UI 阻塞（如 permission prompt 开着）
if (queueSnapshot.length === 0) return  // 条件 3：队列空
```

条件 1 是核心（闸门 idle 才 drain）。条件 2 是 UI 层（permission/补全 UI 开着时不抢）。条件 3 显然。mini 的 drainQueue 只检查条件 1 和 3（无 React UI）。

**effect 依赖数组**（:61-67）：`[queueSnapshot, isQueryActive, executeQueuedInput, hasActiveLocalJsxUI, queryGuard]`。任一变化重跑 effect。闸门状态变化（end/forceEnd 触发 `_changed.emit()`）→ isQueryActive false → effect 重跑 → drain。这是"闸门 idle 唤醒 drain"的物理链——drain 的触发权在闸门，不在队列。

## 4. runRoundsGen vs runRounds：为什么不能直接改 runRounds

v14 runRounds（§10）是 `async function` return void，内部 console.log + mutate messages。v15 要 yield 事件流 + signal 检查。三条路：

- **A. 直接改 runRounds 成 generator**：违反"字面 0 修改"硬约束（diff 会出现 `<` 行）。否决。
- **B. runRounds 加 eventSink 回调参数**：改签名（违反字面 0 修改）。否决。
- **C. 新写 runRoundsGen，镜像 runRounds 逻辑**：v14 runRounds 字面保留（历史参照），v15 runRoundsGen 复用 v14 子函数（callModel/dispatch/maybeCompact/injectRelevantMemories/maybeInjectTodoReminder/systemAssembler）。✅

选 C。代价：runRoundsGen 和 runRounds 循环结构重复（~50 行）。这是"字面 0 修改"的教学代价——v14 runRounds 作为"非 generator 参照"留在文件里，证明没被改过。

工业 claude-code 没这个代价（query/queryLoop 从一开始就是 generator 链）。mini 的代价源于 v1-v14 累积的"async function runRounds"历史包袱。这是 lesson 偏离清单的一项。

## 5. dispatching stretch + abort reason 三态

**dispatching**：mini 两态（idle/running），注释说明三态必要性（见 §1）。作 stretch——学生若要完整 race 闭合，可加 reserve/cancelReservation + handleInput 的 async gap。

**abort reason 三态**（工业）：
- `'user-cancel'`：用户 ESC（REPL.tsx:2147）
- `'interrupt'`：新输入中断旧 turn（handlePromptSubmit.ts:331）
- `undefined` / background：其他（timeout 等）

mini 只做 `'user-cancel'`（脚本 abort）。`'interrupt'`（新输入中断旧 turn）没做——因为 mini 的 tryStart 分流是"忙时 enqueue"（不中断旧 turn），工业有"忙时 enqueue + 若 interruptible tool 则 abort 旧 turn 'interrupt'"的双行为。这是偏离清单的一项。

## 6. drain 在 Stop swarm 之后（run-log 结构细节）

multi-turn / enqueue-busy run-log 里，`[QUEUE] drain` 在 turn 1 的 Stop hook extraction swarm **之后**。原因：query() 执行顺序是 `yield* runRoundsGen` → `hooks.emit("Stop")`（v14 §36 swarm 跑）→ query return → runOneTurn finally → drainQueue。

所以 drain 在 swarm 输出之后。这让 `@include round=N`（round 标记到下个 `=====` divider）取不到 drain——drain 在 swarm（divider）之后。lesson 用 round=N 展示 round 内容，drain 用摘录。这是 run-log 结构的客观限制（agent-notebook slice.ts 的 divider 截断逻辑）。

## 7. 脚本模式 fire-and-forget + waitForIdle（mini 并发模拟）

交互式 REPL 的"turn 跑一半用户插话"在 readline 阻塞模型下做不到（readline await 时无法并发收输入）。脚本模式用**事件注入**模拟：

```ts
// runScriptMode：input op 是 fire-and-forget handleInput
handleInput(op.text!, op.priority).catch(...);  // 不 await，让 turn 后台跑
await sleep(30);  // 让 handleInput 进入 tryStart + for await
```

handleInput 是 async，不 await → runOneTurn 在后台跑。后续 op（delay/input/abort）在 turn 跑的同时注入。`waitForIdle`（`while (pendingTurns > 0 || queueLength > 0 || isActive)`）等所有 turn 完成。

这让"turn 1 在跑 → 注入 input B → tryStart null → enqueue"可确定性地发生。delay 控制注入时机（turn 1 callModel 在 await 时 = busy 窗口）。

## 8. 运行时配置：GLM 端点 model 名 [1m] 后缀

本地 cc-switch 配置的 model 名带 `[1m]` 后缀（如 `glm-5.2[1m]`），是 1M-context 提示。Claude Code 客户端发请求时 strip 掉，但我们的 callModel 直打 API 不 strip → GLM 端点报 1211 "模型不存在"。

解决：`.api-config.json`（git ignored 本地配置）的 MODEL 字段 strip `[1m]`（`glm-5.2`）。这是运行时配置细节，不影响 v15 代码或论断。curl 实测确认：`glm-5.2` / `glm-4.6` / `glm-4.5-air` 全部 ✅，`glm-5.2[1m]` ❌（1211）。

## 9. run-replay 兼容性修复（A+B+C）

agent-notebook 的 `buildRuns`（messages-replay.ts）重建 snapshots 序列（每 round 的 messages 快照），让 HTML 视图能回放 agent 决策链演化。v15 初版 **runs=0**（run-replay 不工作），根因 + 三轮修复：

**修复 A（assistant content JSON 数组 / 根因）**：buildRuns 的 `extractRoundContentArray`（messages-replay.ts:25-48）从 round 段找 assistant content 的 JSON 数组（`[{type:text,...},{type:tool_use,...}]`）。v14 `runRounds:308 console.log(JSON.stringify(res.content, null, 2))` 产生这块。v15 runRoundsGen 初版只 yield `assistant_text` event（renderEvent 打印纯文本 `[event] assistant_text: ...`），无 JSON 数组 → extractRoundContentArray 找第一个 `[` 命中 `[event]` 的 `[` → `JSON.parse("[event]...")` 失败 → snapshots 空 → runs=0。修复：runRoundsGen ROUND 标记后加 `console.log(JSON.stringify(res.content, null, 2))`（对照 v14:308）。

**修复 B（round 全局递增 / 多 turn 排序）**：v15 多 turn，每 turn round 从 1 重置 → run-log 里 round 号重复（1,2,1,1）。`buildSnapshotsForRun` 的 `sort((a,b)=>a.round-b.round)` 乱序。修复：runRoundsGen 用 module-scoped `sessionRoundCounter` 全局递增，ROUND 标记跨 turn 唯一 → sort 正确。**代价**：round 号不再每 turn 重置（但仍是"while 一圈"语义，spec 1.2 turn≠round 区分不受影响，只是编号跨 turn 累计）。

**修复 C（FINAL MESSAGES / 真实 tool_result）**：buildRuns 的 `extractFinalMessages` 拿初始 user message + 全量 tool_result（否则 `fakeToolResult` 占位 `<tool result>`）。v14 `runInteractive:519-520` 打印 FINAL MESSAGES。v15 runSessionLoop 初版没打印。修复：runSessionLoop 结束打印 `========== FINAL MESSAGES ==========` + `JSON.stringify(sessionMessages)`（对照 v14:519-520）。lesson @include section="FINAL MESSAGES" 让 buildRuns 拿到（multi-turn 桶真实 tool_result，其他桶仍占位）。

**验证**：修复后 runs=3，snapshots 演化 multi-turn `[3,4,5,8]` / enqueue-busy `[2,3,5]` / interrupt `[2,4]`（messages 每 round 增长，决策链可回放）。9 个 @include 锚点全命中（slice.ts 验证 9 OK / 0 FAIL）。

**启示**：agent-notebook 的 buildRuns 隐含假设"run-log round 段含 assistant content JSON 数组 + round 号唯一递增 + 有 FINAL MESSAGES section"。这是 v1-v14 单 turn run-log 的格式约定。v15 多 turn + event 格式破了这三条假设，需三轮修复对齐。这也是"教学版偏离工业格式"的隐藏代价——run-replay 工具绑定 v1-v14 的 run-log 约定，v15 要么遵守约定（A+B+C）要么改工具。选前者（不动工具，v15 代码对齐约定）。
