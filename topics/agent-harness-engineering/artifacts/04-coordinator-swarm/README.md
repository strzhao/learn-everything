# Task 04：v4 Coordinator + Swarm Worker Harness

> 把 Lecture 04 抽象出的 4 条 multi-agent 洞察（agent-role 是物理维度 / swarm 上行路由 / context 从深度变广度 / 判决统一-执行多态）落到 284 行 v4 代码 + 4 份真实 run-log + 教学叙事 lesson.md，对照 claude-code 工业实现验证每一条。

## 学到了什么

### 1. agent-role 是物理约束维度（不是软约束）

swarm 跑在并行 / 远程 / 无 stdin 环境下，**物理上**没有弹 readline 的能力。这不是"建议 model 不用 ask_user"，而是 schema 里根本没挂这个工具。看 run-log-coordinator-3-swarms.txt 里 swarm LIFECYCLE 段打印的工具列表：`tools: read_file,edit_file,delete_file` —— 三字面量无 ask_user / spawn_swarm。工业实现也用同样思路（`createSubagentContext` + 工具裁剪），用代码物理阻断而不是依靠 model 行为约束。

### 2. swarm 上行路由：in-process Promise ≅ 工业 mailbox

v4 用 `makeRoutedAsk(swarmId, parentAsk)` 包装 swarm 的 ask 请求 → 调 parent 的 askFn → 等 Promise resolve。run-log-swarm-ask-routed-up.txt 完整可见：dispatch 判决 ask → ROUTED-UP audit → coordinator 进程内弹 readline（前缀 `[from swarm[0]]`）→ user 输入 y → answer 回传 → swarm 继续执行。**接口语义跟 claude-code `swarmWorkerHandler.ts` 的 mailbox + callback registry 完全一致**，未来跨进程只需替换 makeRoutedAsk 的实现，dispatch 和 swarm runLoop 不动。

### 3. Context 从深度变广度（实测数据强证据）

run-log-coordinator-3-swarms.txt 437 行总输出，coordinator FINAL MESSAGES 段 **85 行**，**不含**任何 read_file / `<mocked content>` / swarm 内部 tool_use。3 个 swarm 各自跑 2-3 轮 read + thinking，messages 都在自己作用域消化（80/81/64 行），coordinator 只看 summary string。**深度增长不影响 coordinator**：如果 swarm 内部从 3 轮涨到 30 轮，coordinator messages 增量 ≈ 0。这是 multi-agent 最强工程价值的物理体现，也是 Lecture 05 context compaction 的自然入口（广度问题：coordinator 随 swarm 数量线性增长）。

### 4. 判决统一 / 执行多态在三维下不退化

`modeMatrix(tool, input, mode, _role)` 的 `_role` 下划线意味着 **role 参数当前不参与 policy 计算**，这是有意的：体现"判决统一"。同样 (tool, mode) 在不同 role 下产出**同样的 policy**，差异在执行层 —— `dispatch(...askFn...)` 按 role 注入不同 askFn（interactive 用 readline，swarm 用 makeRoutedAsk）。对照 claude-code `useCanUseTool.tsx:95-165` case "ask" 三层 handler 串行 try：完全同一精神。

## 怎么读这份归档

**推荐入口：交互式 notebook 视图**

```bash
~/.bun/bin/bun run /Users/stringzhao/workspace/learn-everything/tools/agent-notebook/server.ts \
  /Users/stringzhao/workspace/learn-everything/topics/agent-harness-engineering/artifacts/04-coordinator-swarm/
```

打开 http://localhost:3737/，按 `[← 上一步] [下一步 →]` 单步推进。**14 段叙事**从 v3 局限切入 → 三维矩阵 → 三个 role 工具表分化 → ask 上行路由设计 → 三个实战场景（interactive 退化 / coordinator 派 3 swarm / swarm ask 路由）→ context 实测数据 → 4 条洞察对照小结。右侧 messages 状态侧栏跟随每个 round 更新，能看清 spawn_swarm tool_use 在 coordinator messages 数组里的形态，以及 swarm[i] FINAL MESSAGES 段里独立的 messages 数组（context 隔离的可视化证据）。

**文件导览**：

- `lesson.md` — **首读路径**。agent-notebook 入口，14 段叙事
- `agent-v4-coordinator-swarm.ts` — v4 实现（284 行，9 段切片）。3 种 role 用 `--role=<name>` 切换，3 种 mode 用 `--mode=<name>` 切换
- `notes.md` — 7 节深度分析。源码定位 / 4 条洞察逐条对照 / 三维矩阵物理承载结构图 / context 实测数据 v3-v4 对照表 / multi-agent 新增的失败模式 / v3 改进意见 / 一句话总结
- `excerpts.md` — claude-code 6 个关键源码片段（带 file:line）。备查文档
- `run-log-interactive.txt` — interactive role 退化测试（≈ v3 行为）
- `run-log-coordinator-no-swarm.txt` — coordinator 决定不派 swarm，自己干
- `run-log-coordinator-3-swarms.txt` — **典型场景**：派 3 swarm 并行 + 综合
- `run-log-swarm-ask-routed-up.txt` — swarm ask 向上路由全链可见
- `spec.md` — Task 04 原始 spec

**手动跑（如果你想重现实验）**：

```bash
cd topics/agent-harness-engineering/artifacts/04-coordinator-swarm

# 场景 A: interactive 退化（弹 readline）
printf 'N\ny\n' | ~/.bun/bin/bun run agent-v4-coordinator-swarm.ts --role=interactive --mode=default \
  --prompt='请删除 /tmp/test1.txt 和 /tmp/test2.txt。'

# 场景 B: coordinator 派 3 swarm（无交互，bypass）
~/.bun/bin/bun run agent-v4-coordinator-swarm.ts --role=coordinator --mode=bypassPermissions \
  --prompt='请并行读取 /tmp/a.txt, /tmp/b.txt, /tmp/c.txt 三个文件，每个用一个独立的 swarm 处理。每个 swarm 读完后用一句话总结文件内容。最后你综合 3 个 swarm 的总结成一份最终报告。'

# 场景 C: swarm ask 向上路由（输 y 允许 swarm 删）
echo "y" | ~/.bun/bin/bun run agent-v4-coordinator-swarm.ts --role=coordinator --mode=default \
  --prompt='请派一个 swarm worker 删除 /tmp/old.log 这个旧日志文件。swarm 跑完后告诉我结果。'

# 场景 D: 直接跑 swarm（看物理约束）
~/.bun/bin/bun run agent-v4-coordinator-swarm.ts --role=swarm-worker --mode=bypassPermissions \
  --prompt='读取 /tmp/foo.txt 然后总结。'
```

**前置**：`~/.claude-dev/settings.json` 含 deepseek endpoint（task 03 已配，沿用）。

## 与其他组件的关系（在课程中的位置）

- **依赖于**：[`01-minimal-agent-loop`](../01-minimal-agent-loop/)（agent loop 骨架） + [`02-permission-gate`](../02-permission-gate/)（dispatch + is_error） + [`03-mode-matrix-agent`](../03-mode-matrix-agent/)（mode 矩阵 + 有序 if 链）
- **本任务做了什么**：把 v3 的 `(tool × mode) → policy` **二维矩阵**扩展为 `(tool × mode × agent-role) → policy` **三维矩阵** + 引入 coordinator/swarm 二分架构。新增维度：role / spawn_swarm 工具 / ask 上行路由通道 / context 隔离的物理实现
- **对照源码**：`/Users/stringzhao/workspace/claude-code/src/coordinator/coordinatorMode.ts` (18.6K) + `src/hooks/toolPermission/handlers/{coordinator,swarmWorker,interactive}Handler.ts` 三层分离 + `src/hooks/useCanUseTool.tsx:95-165` 三层 handler 分发入口 + `src/tools/AgentTool/runAgent.ts` `createSubagentContext`
- **下一个**：**Lecture 05 context compaction** —— multi-agent 把 context 问题从深度变广度后，深度压缩（单 agent 历史压缩）和广度压缩（coordinator spawn_swarm 历史压缩）成为下一个工程维度
- **后续衍生**：v4 暴露了 3 个失败模式（swarm 死锁等 coordinator、单 swarm 失败拖累整体、context 隔离阻碍 worker 协作）—— Lecture 05 / Task 05 可以选择性处理这些

## 关键对照表

| 维度 | v1 (ask_user 工具) | v2 (harness gate) | v3 (mode matrix) | v4 (coordinator + swarm) |
|---|---|---|---|---|
| Permission 物理位置 | model 层 | dispatch 单层 | dispatch + mode 矩阵 + hard-block | dispatch + 三维矩阵 + 三个 role-specific askFn |
| 新增维度 | — | dispatch + is_error | mode 字符串 + 矩阵 + audit + hard-block | role 维度 + spawn_swarm + ask 上行通道 + context 隔离 |
| 行数 | 94 | 88 | 196 | 284 |
| Context 形态 | 单 messages | 单 messages | 单 messages | **多 messages（coordinator + N 个 swarm，各自独立）** |
| 失败模式 | injection 绕过 | is_error 反馈 | is_error + audit 可观测 | **swarm 死锁 / 单 swarm 失败 / worker 间协作受限** |
| 对应工业组件 | AskUserQuestion | hasPermissionsToUseToolInner 单分支 | hasPermissionsToUseToolInner 完整 10+ 步 if 链 | + coordinatorMode + 三层 handler + createSubagentContext + mailbox |

## 给学习者的提示

1. **先跑场景 B**：`bun run agent-v4-coordinator-swarm.ts --role=coordinator --mode=bypassPermissions` 是最直观的入口（无交互），看 coordinator 怎么自主选择并行 spawn 3 swarm，swarm 怎么独立跑
2. **再读 lesson.md 的交互视图**：单步推进，特别注意 §10（并行真实乱序执行）和 §11（context 隔离实测）两段
3. **想深挖 ask 上行路由**：去 lesson.md §12 看 routed-up 全链 audit，再去 notes.md §2 看跟工业 mailbox 的对照
4. **想做扩展练习**：试在 v4 上加 `--role=swarm-worker` 直接跑（绕过 coordinator），看 makeRoutedAsk 缺 parentAsk 时怎么 fallback —— 当前代码在 swarm-worker role 下直接传 interactiveAsk 作 parentAsk，行为退化为本地 readline，跟正经 coordinator 派的不同
