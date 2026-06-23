# Artifact 15 · Mini Interactive Session Loop

## 它做什么

把 v14 的 agent（整个 `runRounds` 内循环）包进一层**有用户参与的交互式外循环**：你敲一句 → 跑一个 turn → 交还控制权 → 等下一句。一次性脚本变成持续对话的 REPL。

外循环解决真人交互的三个麻烦（用银行叫号大厅类比）：

- **忙时插话**：turn 跑到一半你又敲一句 → QueryGuard 闸门拒绝（tryStart 返回 null）→ 输入进消息队列（不丢）→ turn 结束后 drain → 处理排队的输入
- **中途中断**：Ctrl-C / 脚本 abort → signal 穿到内循环 → round 边界检查 signal.aborted 早退 → messages 完整保留（不回滚）→ 控制权交还
- **跨 turn 累积**：messages 是 module-scoped 数组，每个 turn push 一条 user message，model 能引用之前 turn 说过的内容

5 条核心论断逐条字面命中工业 claude-code（query.ts / QueryGuard.ts / messageQueueManager.ts / handlePromptSubmit.ts / REPL.tsx）。**第 9 次架构正交性**：v14 §1-§36 字面 0 修改（`diff | grep -c '^<'` = 0），外循环只在 v14 之上"接"不"改"。

## 怎么用

```bash
cd topics/agent-harness-engineering/artifacts/15-interactive-session-loop

# 需要本地 .api-config.json（含 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL / MODEL，git ignored）
# 注意：cc-switch 的 model 名 [1m] 后缀要 strip（glm-5.2[1m] → glm-5.2），否则端点报"模型不存在"

# 脚本模式（确定性 / 产 run-log）
bun agent-v15-interactive-loop.ts --script=multi-turn      # 3 turn 跨 turn 累积
bun agent-v15-interactive-loop.ts --script=enqueue-busy    # 忙时插话入队 + drain
bun agent-v15-interactive-loop.ts --script=interrupt       # round 中途中断

# 交互模式（真 readline）
bun agent-v15-interactive-loop.ts --interactive
# you> 记住我叫张三
# you> 我叫什么？（引用上一 turn）
# you> /interrupt   （中断当前 turn）
# you> /exit

# HTML notebook 视图（lesson.md + @include 代码/日志编织）
cd ../../../../..  # 回项目根
bun run tools/agent-notebook/server.ts topics/agent-harness-engineering/artifacts/15-interactive-session-loop
```

## 与其他组件的关系

v15 是 mini harness 的**第 15 个也是最后一个子系统**，把前 14 个"库函数零件"装进可交互 REPL 整机。外循环复用 v14 全部子函数（0 行新通道）：

| 复用子系统 | v15 用途 |
|-----------|---------|
| v1 dispatch + runRounds | runRoundsGen 镜像 runRounds 循环逻辑（callModel/dispatch） |
| v5 maybeCompact | runRoundsGen 每 round 后调 |
| v6 hooks | query() 末尾 emit Stop（触发 v14 §36 extraction） |
| v7 obs | tool dispatch 自动 cardinality 控制 |
| v10 assembleSystemPrompt | query() 每轮装配 system prompt |
| v11 buildInitialUserContent | runOneTurn 首轮 prepend skill_listing |
| v12 maybeInjectTodoReminder | runRoundsGen 每 round 注入 |
| v14 injectRelevantMemories | runRoundsGen 每 round 注入 relevant_memories |
| v4 runSwarm | query() 的 spawnFn（fork skill / Stop extraction 共用通道） |

v15 新增 5 段（§37-§41）：QueryGuard 三态闸门 / 消息队列（被动 + 优先级）/ query() async generator + runRoundsGen / 外循环 driver（handleInput + runOneTurn + drain）/ 中断接线（AbortController + 双跑模式）。

下一个里程碑：`assemble` 拼装 15 个 artifact 成 mini harness 毕业产物。
