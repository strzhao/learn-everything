# 12 · Mini TodoWrite System

## 它做什么

给 agent 加一个"待办清单"工具。神奇之处在于：这个工具的执行代码极薄（只是把清单存进一张表），但它要让 AI 表现出相当复杂的自律——**一次只专注一件事、做完立刻打勾、绝不谎报完成**。

这套纪律没有一行"强制检查"的代码。它全靠两样东西撑着：(1) 一段写给 AI 看的厚厚的协议说明（告诉它该怎么用清单）；(2) 三种节奏的"提醒"——每次用完钉一句"继续保持"、太久不用就跳出来喊一声、收尾时问一句"你验证了吗"。

它还有两个反直觉的特性：**不写任何文件**却能在重启后恢复清单（靠回放历史消息），以及**每个 AI（主 agent / 子 worker）各有一张互不干扰的清单**。

## 怎么用

```bash
# 1. 无文件持久化：构造一段"上个会话"的历史，倒扫还原清单（秒回，不打 API）
bun run agent-v12-todowrite.ts --demo=restore

# 2. per-agent 隔离：主 agent 和 swarm worker 各写各的清单
bun run agent-v12-todowrite.ts --demo=isolation

# 3. 完整生命周期（真实 LLM）：建清单 → 逐步推进 → 全完成触发"验证提醒"
bun run agent-v12-todowrite.ts --role=coordinator --mode=bypassPermissions --hooks=obs \
  --prompt="给设置页加深色模式开关，分3步：建组件/加状态/写样式。每步先 edit_file 再 TodoWrite 更新状态，全做完后总结。"

# 4. 缺席探测器：让 AI 只读文件不碰清单，把阈值压到 1 轮，看 reminder 被注入
bun run agent-v12-todowrite.ts --role=interactive --mode=bypassPermissions --todo-reminder-turns=1 \
  --prompt="依次读取 /tmp/a.txt /tmp/b.txt /tmp/c.txt，逐个总结，不要用任何待办工具。"
```

阅读交互式视图（推荐）：

```bash
bun run tools/agent-notebook/server.ts \
  topics/agent-harness-engineering/artifacts/12-todowrite
```

关键观察点：`[TODO write key=... in_progress=1 allDone=false]` 逐步推进 → `allDone=true → stored []`（全完成即清空）→ 紧跟 `VERIFY-NUDGE`；缺席场景里 `[TODO REMINDER injected sinceWrite=1→2→3]` 逐轮累加。

## 与其他组件的关系

v12 是在 [11-skill-system](../11-skill-system/) 之上的最小增量（§1-26 几乎字面不动），第 12 个子组件：

- **复用 [02-permission-gate](../02-permission-gate/) 起的 dispatch 同权管道**：TodoWrite 不享特权，跟普通 tool 一样过 permission gate / hook / obs（架构正交性第六次验证）。
- **per-agent 隔离与 [04-coordinator-swarm](../04-coordinator-swarm/) 同源**：`todoKey = agentId ?? sessionId` 正是 multi-agent context 二分（主/子 agent 各自状态空间）在 todo 层的体现。
- **无文件持久化与 [05-context-compactor](../05-context-compactor/) 同精神**："messages 数组即数据库"——restore 靠回放 transcript，不落盘。
- **软契约现象串起 [06-hook-engine](../06-hook-engine/)（必填 reason）、[10-system-prompt-assembly](../10-system-prompt-assembly/)（cacheBreak reason）**：约束放在 prompt/类型，而非 runtime 强制。
- **obs 自动 cardinality-control 复用 [07-observability](../07-observability/)**：obs 从不知道 TodoWrite 存在，却自动给它打 `tool_name=TodoWrite` 的 metric label。

`final/README.md` 拼装时通过相对路径 `../artifacts/12-todowrite/` 引用本组件，作为 mini harness "任务自我管理"能力的证明。它是集齐毕业产物的最后一块积木。
