# v15 Task Spec · Mini Interactive Session Loop（有用户参与的多轮会话）

> instructor 下发 / 0 假设原则：本 spec 所有 file:line 来自实读 `../../../../claude-code/src/` 源码，非命名推断。学生实现时若发现偏离，先回源码核实再 push back。

---

## 0. 一句话目标

把 v14 的 agent（整个 `runRounds`）当作**内循环引擎**，在它外面套一层**有用户参与的交互式外循环**：用户敲一句 → 跑一个 turn → 交还控制权 → 等下一句。并解决真人带来的三个麻烦：**忙时插话、中途中断、跨 turn 状态累积**。

**v14 §1–§36 字面 0 修改**——这是第 9 次架构正交性验证的硬约束。外循环只能在 v14 之上"接"，不能"改"。

---

## 1. 核心心智模型（必须先内化）

### 1.1 内循环 vs 外循环（边界 = async generator）

```
┌─────────────── 外循环 v15 新增（REPL）───────────────┐
│  while (用户还在):                                    │
│    input = await readUserInput()                      │
│    if (guard.busy) → enqueue(input); continue         │
│    messages.push(userMsg(input))                      │
│    for await (const ev of query({messages, signal}))  │ ← 边界：消费内层 yield
│      render(ev)                                       │
│    onTurnComplete(messages, aborted)                  │
│    drainQueueIfAny()                                   │
└───────────────────────────────────────────────────────┘
            │ query() 是 async function*
┌───────────┴──── 内循环 v1 原封不动（v14 runRounds）────┐
│  while (true):                                         │
│    msg = await callModel(...)                          │
│    if (signal.aborted) break        ← round 边界检查    │
│    if (stop_reason !== tool_use) return  ← turn 结束    │
│    results = await runTools(...)                       │
│    messages.push(...); continue                        │
└─────────────────────────────────────────────────────────┘
```

**工业锚点**：
- 外循环消费点：`REPL.tsx:2793` `for await (const event of query({...})) { onQueryEvent(event) }`
- `query()` 是 async generator：`query.ts:219` `export async function* query(...)` → `yield* queryLoop(...)`（:230）
- 内循环本体：`queryLoop` 的 `while (true)`（`query.ts:241/307`）
- **一次 `query()` 调用 = 一个会话 turn = 整个 v1 loop**

### 1.2 术语前缀限定（规则 6，本课最易糊）

| 词 | 精确含义 | 锚点 |
|---|---|---|
| **会话 turn** | 用户↔assistant 一次往返 = 一次 `query()` 调用 | memory prefetch 注释 "once per user turn" query.ts:297-301 |
| **round** | `query.ts` while 内一圈 = 一次 model call + tool 执行 | `query.ts:213` 的 `turnCount` 变量数的其实是这个，命名易混 |
| **session** | 整个 REPL 进程生命周期 = 外循环反复调 query() 的总和 | — |

实现里不准出现裸 `turn`——注释/变量名一律 `sessionTurn` / `round` 区分。

---

## 2. 五条核心论断（验收时逐条对照工业）

### 论断 1：内/外循环二分，边界是 async generator
`query()` 必须是 `async function*`，yield 流事件（至少 `request_start` / `assistant_text` / `tool_use` / `tool_result`）；外循环用 `for await` 消费。一次调用跑完一个完整会话 turn（含多 round）。
- 锚点：query.ts:219/230/241/307 + REPL.tsx:2793

### 论断 2：并发闸门 QueryGuard = 一次一个 turn
实现一个 `QueryGuard` 状态机，`tryStart()` 原子地把 idle→running，**running 时返回 null 拒绝第二个 turn**。这是把锁，不是队列。
- 锚点：REPL.tsx:2869 `queryGuard.tryStart()` + :2870 `if (thisGeneration === null) { enqueue; return }` + QueryGuard.ts:61-67
- **进阶（stretch）**：三态机 `idle → dispatching → running`。`dispatching` 焊死"effect 决定 dequeue"到"onQuery 调 tryStart"之间的 async race window，`isActive` 对 dispatching+running 都返回 true。QueryGuard.ts:17,38-43。mini 版可先做两态，注释里说明三态的必要性即可。

### 论断 3：消息队列让用户参与不被丢弃（且不防并发）
模块级**被动**队列：`enqueue/dequeue/peek`，无 run-loop。优先级 `now > next > later`，**系统通知默认 later，永不饿死 user input**。"一次一个 + 自动下一个"由**外部驱动**（闸门 idle 信号唤醒 drain），不是队列自己跑。
- 锚点：messageQueueManager.ts:53（commandQueue 数组）/:128 enqueue 默认 next /:142 通知默认 later /:151 PRIORITY_ORDER /:167 dequeue 取最高优先级 FIFO
- drain 驱动：useQueueProcessor.ts:48-60 `if (isQueryActive) return` + 闸门 idle 跃迁触发 re-run

### 论断 4：输入两条路径汇合于闸门
空闲时输入**直冲** onQuery 绕过队列；只有忙时才 enqueue。闸门站在所有路径的汇合点（onQuery→tryStart），才能串行化全部入口——这反证队列不可能是防并发的那个。
- 锚点：handlePromptSubmit.ts:152 `executeUserInput`（直接路径）vs :313 `if (queryGuard.isActive) enqueue`（忙时路径）

### 论断 5：中断 = 协作式取消，messages 完整
ESC/中断信号 → `abort('user-cancel')`；signal 经上下文穿到 model call；**在 round 边界检查 `signal.aborted` 后早退**，已 emit 的消息保留完整（不回滚、不清空）；`signal.reason` 区分 `interrupt`/`user-cancel`/`background`。
- 锚点：REPL.tsx:2147 `abortController?.abort('user-cancel')` + query.ts:664 `signal: toolUseContext.abortController.signal` + :1015 `if (signal.aborted)` + :1046 `signal.reason !== 'interrupt'` + REPL.tsx:2930 `onTurnComplete(messages, signal.aborted)`

### 贯穿：第 9 次正交性 + 跨 turn 累积
messages 经追加累积，每次 query() 拿全量历史；memory prefetch "once per user turn" 锚在外循环这一层（query.ts:301）；**外循环 0 行改动内循环**。
- 锚点：REPL.tsx:2891 `setMessages(old => [...old, ...newMessages])`

---

## 3. 实现要求

### 3.1 文件
- `agent-v15-interactive-loop.ts`：v14 全继承 + 新增外循环子系统（§37+）。新增段用 Rule 9 的 `⬇⬇⬇ v15 新增 ⬆⬆⬆` marker 包围。
- 新增段建议划分：
  - §37 `QueryGuard`（状态机 class：tryStart/end/isActive，+generation 防 stale finally）
  - §38 消息队列（enqueue/dequeue/peek + 优先级 now/next/later，被动数据结构）
  - §39 `query()` async generator（把 v14 runRounds 包成 yield 事件流；signal 穿入）
  - §40 外循环 driver（readUserInput → guard 分流 → for await 消费 → onTurnComplete → drain）
  - §41 中断接线（AbortController + signal.aborted 在 round 边界检查 + reason 区分）

### 3.2 双跑模式（为 run-log 可复现）
- **交互模式** `--interactive`：真 readline，手动敲多轮，体验"忙时输入被排队 / Ctrl-C 中断"。
- **脚本模式** `--script=scenario`：预设带时间戳的输入序列 + 注入式 abort，喂给同一个外循环，产出确定性 run-log。用 v8 的 `--sim-delay` 思路制造"turn 正忙"的窗口，好让插话落进 enqueue 分支。

### 3.3 三份 run-log（验收硬性）
1. `run-log-multi-turn-session.txt`：≥3 个连续会话 turn，messages 跨 turn 累积可见（第 2 turn 能引用第 1 turn 的内容）。
2. `run-log-enqueue-while-busy.txt`：turn 跑到一半注入第二句输入 → `[GUARD] busy, enqueue` → 当前 turn 结束 → `[QUEUE] drain → start next turn` → 第二句被处理。打印队列优先级。
3. `run-log-interrupt-mid-round.txt`：某 round 跑到一半触发 abort → `[ABORT] signal=user-cancel at round boundary` → 外循环捕获 → 打印中断后的 messages 数组**仍完整**（已完成的 round 消息都在）→ 控制权交还、可继续下一 turn。

### 3.4 其他交付物
- `lesson.md`：套全部 lesson 规范 + Rule 9（显式声明 §37–§41 100% v15 新增）。开头钩子回答"这是什么+为什么现在学"，银行叫号大厅类比，怎么跑物理锚点，@include 三明治，认知流优先。
- `notes.md`：工业细节（三态机 race window 完整推导 / 两条输入路径 / useQueueProcessor effect 依赖 / reserve-cancelReservation / 与 print.ts headless 路径的对比）。
- `excerpts.md`：关键工业源码片段引用（带 file:line）。
- `README.md`：三段式（它做什么 / 怎么用 / 与其他组件的关系）。

---

## 4. 验收标准

1. 5 条论断逐条字面命中工业实现（file:line 可核对）。
2. v14 §1–§36 **字面 0 修改**（diff 证明）。
3. 三份 run-log 各自证明对应现象（多轮累积 / 忙时入队+drain / 中断后 messages 完整）。
4. lesson.md 通过 agent-notebook（所有 @include 锚点命中）。
5. 第 9 次正交性显式陈述：外循环没碰内循环一行。
6. 所有教学偏离工业处显式 disclaimer 标注。

---

## 5. 工业偏离合规清单（预期）

| 偏离 | 教学版 | 工业版 | 理由 |
|------|-------|-------|------|
| UI 层 | readline / stdout 打印 | Ink/React + useSyncExternalStore | 无 React 依赖 |
| 闸门订阅 | 直接函数调用驱动 drain | useSyncExternalStore 响应式 re-render | 无 React |
| 输入来源 | readline + 脚本注入 | PromptInput 组件 + 多来源（bridge/remote/tick） | 教学聚焦主路径 |
| 三态机 | 可先两态 idle/running | idle/dispatching/running | mini 先抓主干，dispatching 作 stretch |
| 中断触发 | Ctrl-C / 脚本注入 | ESC 键 + 多种 abort reason | 终端简化 |

---

## 6. Out of Scope（本次不做）

- **headless / stdin streaming 模式**（print.ts 的 `while((cmd=dequeue()))` + structuredInput 路径）——那是另一条消费者通道，本课只做交互式 REPL 外循环。
- **popAllEditable**（UP/ESC 把排队消息拉回输入框编辑，messageQueueManager.ts:428）——纯 UX 细节。
- **dispatching 完整 race 闭合**——作 stretch，mini 版注释说明即可。

---

## 7. 起手锚点速查（开工前再读一遍源码）

```
REPL.tsx:2793   for await (event of query(...))    ← 外循环消费点
REPL.tsx:2855   onQuery（tryStart 分流入口）
REPL.tsx:2869   queryGuard.tryStart()
REPL.tsx:2877   enqueue（忙时改道）
REPL.tsx:2891   setMessages 累积
REPL.tsx:2147   abort('user-cancel')
REPL.tsx:2930   onTurnComplete(messages, aborted)
query.ts:219    export async function* query
query.ts:230    yield* queryLoop
query.ts:307    while (true)  内循环
query.ts:664    signal: toolUseContext.abortController.signal
query.ts:1015   if (signal.aborted)
query.ts:301    startRelevantMemoryPrefetch（once per turn）
messageQueueManager.ts:53/142/151/167  队列本体
useQueueProcessor.ts:48-60   drain effect（if isQueryActive return）
QueryGuard.ts:38-67   reserve/cancelReservation/tryStart/end 三态机
handlePromptSubmit.ts:152/313   两条输入路径
```
