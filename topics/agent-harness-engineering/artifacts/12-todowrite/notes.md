# v12 notes —— 工业细节、理论同源、踩坑、偏离

> lesson.md 负责认知流；本文负责完整性。所有 file:line 见 excerpts.md。

## §1 改动统计（v11 → v12）

v11 1101 行 → v12 1334 行（+233）。继承 §1-26 几乎字面不动，最小侵入 4 处 + 新增 3 段：

| 位置 | 改动 | 行数级别 |
|---|---|---|
| §1 | `SESSION_ID` 常量（主 agent 的 todoKey 兜底） | +2 |
| §3 | `TODO_WRITE_PROMPT`/`DESCRIPTION`/`TODO_WRITE_TOOL` + getToolsForRole 三 role 各 +TodoWrite | ~+40 |
| §5 | dispatch/dispatchInner/execute 各 +`agentId` 形参；execute 加 `if (name==="TodoWrite")` 分支 | +6 |
| §10 | runRounds +`agentId` 形参 + 每轮 callModel 前调 `maybeInjectTodoReminder`；StreamingToolExecutor +agentId；runSwarm 传 swarmId | +8 |
| §27 | TodoWrite 执行体（state map + continuous + verification + clear） | ~+45 |
| §28 | fixed-interval reminder（缺席探测 + render + inject） | ~+55 |
| §29 | transcript restore + restore/isolation 确定性 demo | ~+75 |

**架构正交性第六次验证**：dispatch 主链路（policy 判定）、permission（modeMatrix）、hook（PreToolUse/PostToolUse emit）、obs（registerObsHooks 的 fan-out）、compaction（micro/full）**核心逻辑零修改**。agentId 的穿透是"加形参"而非"改逻辑"——TodoWrite 走的还是那条所有 tool 共用的 dispatch 管道。

## §2 六论断逐条对照工业

| 论断 | v12 实现 | 工业 file:line |
|---|---|---|
| 1 极简 tool + 厚 prompt | executeTodoWrite ~25 行只存取 / description 含浓缩协议 | TodoWriteTool.ts 115 行 + prompt.ts 184 行 |
| 2 不变量是软契约 | call() 零 validation + schema 无 refinement，in_progress>1 只 audit | TodoWriteTool.ts:65-103 + types.ts + prompt.ts:158 |
| 3 三层 reinforcement | continuous(base) / fixed-interval(§28) / event(verificationNudge) | :104-113 + attachments.ts:254-257,3296-3314 |
| 4 per-agent 隔离 | todoKey = agentId ?? SESSION_ID，appStateTodos map | :67 todoKey = context.agentId ?? getSessionId() |
| 5 无文件持久化 | extractTodosFromTranscript 倒扫 messages | sessionRestore.ts:77-93 |
| 6 架构正交第六次 | obs 自动打 tool_name=TodoWrite label + compaction 照常清 tool_result | run-log-lifecycle OBS METRIC dump |

## §3 三层 reinforcement 的三种理论同源

工业把行为心理学/教育学的三种机制各落地成一层（这是 TodoWrite 设计最深的地方）：

1. **continuous（连续强化 / Skinner）**：每个正确动作（调用 TodoWrite）立刻给反馈（"继续保持"）。最稳但成本最高——好在 tool_result 本来就要返回，搭便车零额外开销。
2. **fixed-interval（固定间隔强化 / Skinner schedules）**：不盯每个动作，定时巡检。专治"消退"（extinction）——model 久不调用就遗忘工具存在。注意它是**缺席驱动**：调用沉默 N 轮才 fire，调用活跃时它静默。
3. **event-triggered（元认知脚手架 / Vygotsky）**：在"最近发展区"的关键节点（收尾时）插一句"你验证了吗"，把 model 还不会自发做的元认知（self-verification）外部脚手架化。

另有一层社会学视角——**stigmergy（Grassé 共识主动性）**：todo 列表是 model 留给"未来的自己"和用户的环境痕迹，下一步动作被环境状态（当前 todo）而非中央指令驱动。这解释了为什么 todo 要**持久化进 messages**（§29）：痕迹必须留在环境里才能引导后续行为。

## §4 软契约现象：为什么不用 runtime validation 强制不变量

这是 v12 最该内化的工程判断。明明能在 call() 里 `if (inProgress > 1) throw`，工业为什么偏不？三个理由：

1. **保留 model agency**：硬拦截会让 model 收到一个突兀的 error，打断它的推理链；软契约让 model 自己调整，对话更连贯。
2. **让 model 学到"为什么"**：prompt 里写明 "exactly ONE ... so the user can see what you're focused on"，model 理解意图后能**类推到 prompt 没覆盖的新场景**；runtime 校验只教会它"别触发报错"。
3. **不变量本身是软的**：极短瞬间出现两个 in_progress（正切换）未必是 bug。硬校验会把合理的过渡态也判死。

这条判断与前面几个 artifact 同源：v6 hook handler 必填 `reason`（类型层强制 self-audit，runtime 不消费）、v10 `cacheBreak` 的 `_reason`、v11 `INLINE_PATTERN` 的放宽——都是"约束放在 review-time/prompt-time，而非 runtime-enforce"。**LLM agent 工程里，prompt 是一等的控制面**。

## §5 踩坑修正（2 处实测）

1. **auto-allow 路径漏传 agentId（live swarm 隔离失效）**：用 `replace_all` 给 dispatchInner 的 `execute(...)` 调用补 agentId 时，只命中了 `if (policy==="ask")` 分支那一处，**漏了末尾 auto-allow 的 `return execute(...)`**。后果：bypassPermissions 模式（demo 默认）下所有 tool 走 auto-allow，swarm worker 的 TodoWrite 拿到 `undefined` → 回退 SESSION_ID → 落到主 agent 的 key 上。`--demo=isolation` 是确定性的没暴露（它直接传 key 调 executeTodoWrite，不走 dispatch），是 **live swarm run-log** 把 `key=session-xxx` 抓了现行。修一行后 `key=swarm[0]` 正确。教训：`replace_all` 看似命中"所有"，但要确认每处语境一致；run-log 的真实路径覆盖 > 确定性 demo。

2. **单一阈值 vs 工业双阈值**：v12 把 `TURNS_SINCE_WRITE` 和 `TURNS_BETWEEN_REMINDERS` 合并成一个 `TODO_REMINDER_TURNS`。后果：threshold=1 的 demo 里 reminder 几乎每轮 re-fire（sinceReminder 也总是 1≥1）。工业用两个 10 是为了"缺席很久才提醒一次，提醒后安静 10 轮"。教学版为让缺席在 8 轮内可见做了简化，notes 显式标注，不当成工业行为。

## §6 教学偏离 disclaimer（区分"事实 vs 教学化简"）

- **协议放 description 而非独立 prompt 通道**：工业 tool 有 `prompt()` 注入 system prompt；mini harness 无此通道，故塞进 `tools[].description`。本质都是"让 model 看到协议"，但物理位置不同。
- **184 行浓缩到 ~45 行**：保留核心协议 + 不变量字面，删去 8 个 examples。完整版见 prompt.ts。
- **reminder piggyback 而非独立 isMeta message**：工业是独立 user-role isMeta message（messages.ts:3673）；教学版附到上一条 user 的 content array，避免连续两条 user message 触发 API role-alternation 报错。
- **verificationNudge 引导 spawn_swarm 而非 VERIFICATION_AGENT_TYPE**：mini harness 没有专门的 verification agent type，改引导 spawn_swarm 跑验证子任务，精神同构。
- **feature flag 略去**：工业 verify nudge 受 `feature('VERIFICATION_AGENT')` + growthbook 开关门控；教学版直接按结构条件（主 agent + allDone + ≥3 + 无 verif）触发。
- **TodoV2 file-backed 路径不做**：工业交互模式用 file-backed v2 tasks（`isTodoV2Enabled()`），v12 只实现 v1 transcript-derived 路径（SDK/非交互）。

## §7 工业对照速查

- 工具名常量：`TODO_WRITE_TOOL_NAME = 'TodoWrite'`（constants.ts，整个文件就这一行）。
- `shouldDefer: true`：TodoWrite 是 deferred tool（schema 按需加载），与本课无关但说明它在工业里是"低优先级常驻工具"。
- `maxResultSizeChars: 100_000`：tool_result 上限。
- `userFacingName() { return '' }`：UI 不显示 TodoWrite 调用名（它是 model 的内部记事，不是给用户看的动作）。
- restore 仅 `!isTodoV2Enabled()` 时跑（sessionRestore.ts:140），且用 `getSessionId()` 作 key —— sub-agent 的 todo 不靠 transcript restore 跨会话恢复（它们是会话内临时的）。
