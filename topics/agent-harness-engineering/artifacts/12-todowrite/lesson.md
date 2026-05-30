# v12 · Mini TodoWrite System

> 一个 115 行的工具，却配了 184 行 prompt。这节课让你看清：**agent 的"自律"行为到底住在哪里——不在执行代码里，在 prompt 协议里。**

## 这是什么 + 为什么现在学

到 v11 你已经搭出了 7 大子系统：agent loop、permission、multi-agent、compaction、hook、observability、streaming、MCP、system-prompt、skill。它们都有一个共同点：**行为由 runtime 代码强制**——permission gate 真的拦截，compaction 真的删消息，hook 真的并发触发。

v12 引入的 TodoWrite 是第一个**反例**：它的执行体几乎什么都不做（只把 todos 存进一张表），可它要 model 表现出"一次只做一件事、做完立刻打勾、绝不谎报完成"的复杂自律。这套纪律一行 runtime 校验都没有——**全靠 184 行 prompt 喊话 + 三层"提醒节奏"把 model 钉在轨道上**。这就是 LLM agent 工程独有的"软契约"（soft contract）现象，也是你升 create 层后最该看穿的一类设计。

为什么现在学：你在 v6（hook 必填 reason）、v10（cacheBreak DANGEROUS）、v11（INLINE_PATTERN）里已经反复撞见"约束写在 prompt/类型而非 runtime"的影子。TodoWrite 是这个现象最纯粹、最完整的工业样本——把它讲透，前面那些零散的影子就连成一条线。

## 怎么跑（物理锚点）

三条命令分别点亮三组机制，先跑确定性的（不打 API、秒回）建立手感：

```bash
bun run agent-v12-todowrite.ts --demo=restore      # 无文件持久化：倒扫 transcript 还原 todo
bun run agent-v12-todowrite.ts --demo=isolation    # per-agent 隔离：主 agent 与 swarm 各自一张表
# 真实 LLM 跑完整生命周期（建表→推进→全完成触发 verify nudge）：
bun run agent-v12-todowrite.ts --role=coordinator --mode=bypassPermissions --hooks=obs --prompt="..."
```

你会看到的关键现象：`[TODO write key=... in_progress=1 allDone=false]` 一行行推进，直到 `allDone=true → stored []`（全完成即清空），紧跟一条 `VERIFY-NUDGE`。

## 一个类比：私教的训练白板

把 TodoWrite 想成健身房里那块**训练白板**：

1. **白板本身是"哑"的**——它只负责被写上"深蹲 3×10"，不会阻止你同时标五个动作"进行中"，也不会因为你谎报"做完了"而报警。这就是 `executeTodoWrite`：只存取，零判断。
2. **训练纪律不在白板上，在私教嘴里**——"一次只专注一个动作"、"做完才打勾"、"测试没过不算完成"。这些规矩写在私教的话术（prompt）里，白板一个字都不强制。
3. **私教用三种节奏提醒你**——白板角上贴的便利贴"记得实时更新"（每次都在）、每节课开头一句"上次那组你还没勾啊"（你偷懒不写时才出现）、还有"你说全做完了？那核心动作验过没"（特定时刻才触发）。

这三种提醒，正是工业 TodoWrite 的三层 reinforcement schedule。下面逐一对到代码。

## 论断 1+2：极简 tool + 厚 prompt，不变量是软契约

先看执行体。注意它有多"哑"：

@include(./agent-v12-todowrite.ts, section=27)

观察三件事：

- **`call()` 零 validation**：函数里没有任何 `if (in_progress > 1) throw`。`inProgressCount > 1` 时只 `audit` 记一笔，照常写入——这是论断 2 的物理证据。"最多一个 in_progress" 这条不变量，runtime 根本不强制（对照工业 `TodoWriteTool.ts:65-103` 的 `call()`，以及 `types.ts` 里 `TodoListSchema = z.array(...)` **没有 list-level refinement**）。
- **`allDone → stored []`**：全部 completed 就把表清空（工业 `TodoWriteTool.ts:69-70` 字面一致）。
- **行为全在 description**：mini harness 没有独立的 tool prompt 通道，所以那 184 行协议（浓缩版）塞进了 `TODO_WRITE_TOOL.description`——model 唯一能看到的地方。tool 越薄，prompt 越厚，行为越"住在 prompt 里"。

## 论断 3：三层 reinforcement schedule

| 层 | 触发时机 | 物理载体 | 对抗什么 |
|---|---|---|---|
| continuous | **每次** TodoWrite 被调用 | tool_result 里钉 "Ensure that you continue to use the todo list" | 即时跑偏 |
| fixed-interval | TodoWrite **连续 N 轮没被调用** | 注入 `<system-reminder>` 到下一条 user 消息 | 长程**遗忘**（缺席） |
| event-triggered | 收尾 3+ 项且无 verification step | tool_result 追加 verify nudge | 谎报完成 / 跳过验证 |

[三种理论同源详见 notes.md §3] —— continuous 对应 Skinner 连续强化、fixed-interval 对应固定间隔强化、event 对应 Vygotsky 元认知脚手架。

关键区分（socratic Q2 的核心）：**continuous"调用才触发"，fixed-interval"缺席才触发"**。model 跑了几十轮渐渐不碰 TodoWrite 时，continuous 层结构上根本不会 fire（没调用就没 tool_result），只有 fixed-interval 这个缺席探测器还在巡检：

@include(./agent-v12-todowrite.ts, section=28)

`getTodoReminderTurnCounts` 倒扫 messages 数"距上次 TodoWrite 多少个 assistant 轮"，够久才注入。工业阈值是 `TURNS_SINCE_WRITE:10 / TURNS_BETWEEN_REMINDERS:10`（`attachments.ts:254-257`）。

## run-log 1：完整生命周期 + verify nudge 真的触发

让 coordinator 自动跑"加深色模式开关"的 3 步任务。看 Round 7——model 把三项全标 completed 的那一刻：

@include(./run-log-lifecycle.txt, round=7)

盯住那行 audit：`allDone=true → stored [] VERIFY-NUDGE`。两件事同时发生：表被清空（completed 即清空），且因为"收尾 3+ 项且无 verification step"，event-triggered nudge 被点燃。

下一轮，model 收到了 nudge——注意它不是被 runtime 强行拦截，而是在 tool_result 里读到一句话，然后**自己决定**照做（spawn 一个验证 worker）：

@include(./run-log-lifecycle.txt, round=8)

这正是软契约的精髓：**保留 model 的 agency，用文字引导而非代码强制**，model 还能从这句话里"学到为什么"。（与 v6 hook 必填 reason、v10 cacheBreak reason 同源。）

## run-log 2：缺席探测器 fire

这次让 model 只读文件、绝不碰 TodoWrite，并把阈值压到 `--todo-reminder-turns=1`，好在 8 轮内看见缺席被探测：

@include(./run-log-fixed-interval.txt, round=2)

audit 里 `[TODO REMINDER injected sinceWrite=1 → 2 → 3]` 一轮轮累加——TodoWrite 一直缺席，计数器一直涨，`<system-reminder>` 一遍遍补注。注意 model 最后**没有**因此去建 todo（任务确实不需要），印证 reminder 是"gentle reminder, ignore if not applicable"——提醒不是命令。

## run-log 3：无文件持久化 + per-agent 隔离

这两个机制跨会话、跨进程，用确定性 demo 比靠 LLM 触发更精确。`--demo=restore` 构造一段"上个会话"的 transcript（TodoWrite 之后还故意放了 read_file 噪声），证明 `extractTodosFromTranscript` 能倒扫跳过尾部、命中最后一次 TodoWrite：

@include(./run-log-restore-isolation.txt, section="RESTORE DEMO")

没读任何 `.json`——**messages 数组本身就是数据库**（论断 5，与 v5 compaction "messages 即真相" 同精神）。

`--demo=isolation` 则证明 `todoKey = agentId ?? sessionId` 把每个 agent 的 todo 分进独立 bucket：

@include(./run-log-restore-isolation.txt, section="ISOLATION DEMO")

主 agent 和 swarm worker 各写各的，互不可见（论断 4，与 v4 multi-agent context 二分同源）。

> 踩坑实录：第一版 live 跑 swarm 时，worker 的 todo 错误地落在主 agent 的 key 上。根因是 dispatch 的 **auto-allow 路径漏传了 agentId**（`replace_all` 只改到了 ask 路径）。run-log 把它当场抓出来，修一行后 `key=swarm[0]` 才正确。[详见 notes.md §5]

## 论断 6：架构正交性第六次验证

整个 v12，dispatch / permission / hook / observability / compaction **一行核心都没改**。证据全在 run-log 1 里：obs 从不知道 TodoWrite 存在，却自动给它打上 `tool_name=TodoWrite` 的 metric label 并通过 cardinality 白名单；compaction 也照常把早期的 TodoWrite tool_result 清成 `[Old tool result content cleared]`。TodoWrite 只是又一个穿过同一套管道的普通 tool——这是 v3 起就埋下的 dispatch 同权设计第六次自动兑现。

## 下一步

回到对话里让我验收这个 artifact。验收后 11→12 个子组件，mini harness 的工具层补齐了"任务自我管理"这一块——你已经集齐了拼 final 毕业产物的全部积木，下一步就是 assemble。
