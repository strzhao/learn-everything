# Task 04 Spec —— v4 Coordinator + Subagent Fork（原 "Swarm Worker Harness"）

下发日期：2026-05-24（命名修订 2026-05-30：原叫 coordinator-swarm，已改名 subagent-fork——工业 swarm/team 是多进程协作系统/lesson 13 主题，v4 实际是 fork sub-agent ≈ 工业 AgentTool）
父 topic：agent-harness-engineering
前置 artifact：[`03-mode-matrix-agent/`](../03-mode-matrix-agent/)
对照源码：`/Users/stringzhao/workspace/claude-code/src/coordinator/coordinatorMode.ts` (18.6K) + `src/hooks/toolPermission/handlers/{coordinatorHandler,swarmWorkerHandler,interactiveHandler}.ts`

---

## 任务定位

从 v3 的 `(tool × mode) → policy` **二维矩阵**，扩展到 v4 的 `(tool × mode × agent-role) → policy` **三维矩阵** + coordinator/swarm 二分架构。

**核心交付是一份可运行的 v4 mini coordinator/swarm harness**：把 Lecture 04 抽象的 4 条核心洞察（agent-role 是物理维度 / swarm 物理约束本质 / context 从深度变广度 / 判决-执行三维分层），落到 ≤ 300 行可运行代码 + 4 份真实 run-log + 教学叙事 lesson.md。

这是 create 层巩固：从"扩展二维矩阵"到"加新维度时仍能保持判决与执行解耦"。

---

## 4 条核心洞察（Socratic 04 已确认）

1. **agent-role 是物理约束维度，不是软约束**：swarm 跑在并行 / 无 stdin / 远程环境下，根本没有 ask user 的物理通道
2. **swarm 物理约束的正确做法**：把 ask 请求向上路由到 coordinator，由 coordinator 弹 readline 后回传 —— 保留矩阵判决，改变执行通道
3. **context 从深度变广度**：swarm 内部 context 在自己作用域消化（深度问题被分割），coordinator 增量 ≈ 5 个 swarm 汇总之和（随 swarm 数量线性广度增长，但不拿 swarm 完整历史）
4. **判决-执行分层在三维下不退化**：matrix 加 role 参数后仍只输出 policy；变的是执行层 —— 同样 ask 判决，interactive role 弹 readline / swarm role 转发 coordinator

---

## v4 必须实现的三种 agent-role

| role | 工具集 | ask 执行通道 | 备注 |
|---|---|---|---|
| `interactive` | 含 `ask_user`、含 destructive 工具 | 弹 readline（v3 同款） | 单 agent 场景，退化到 v3 |
| `coordinator` | 含 `ask_user`、含 destructive、**含 `spawn_swarm` 工具** | 弹 readline | 可派 swarm，可自己干 |
| `swarm-worker` | **物理上无 `ask_user`** + 含 destructive 工具 | ask 请求**向上转发 coordinator**，coordinator 弹 readline + 回传结果 | schema 层就移除 ask_user，不只是"建议不用" |

**关键约束**：swarm 工具 schema 必须**字面量不含 `ask_user`** —— 这是物理约束的代码体现，不是 model 的训练分布约束。

---

## 步骤

### 步骤 0：源码定位（5 分钟）

```bash
ls /Users/stringzhao/workspace/claude-code/src/coordinator/
# coordinatorMode.ts  18.6K  ← coordinator 调度核心

ls /Users/stringzhao/workspace/claude-code/src/hooks/toolPermission/handlers/
# coordinatorHandler.ts   2.3K
# swarmWorkerHandler.ts   5.4K   ← 重点读
# interactiveHandler.ts  19.7K
```

读 `swarmWorkerHandler.ts` 全文（仅 5.4K）+ `coordinatorHandler.ts` 全文（2.3K）+ `coordinatorMode.ts` 顶部 100 行。

把"swarm 怎么向 coordinator 转发 ask 请求"的工业实现机制（轮询？async channel？事件总线？）写在 notes.md 第 1 节。

### 步骤 1：写 v4 代码

按 §"v4 代码切段约束"组织。

### 步骤 2：跑 4 份真实 run-log

按 §"Run-log 约束"。

### 步骤 3：写 notes.md（4 条洞察对照 + context 数据观察）

每条洞察产出：
- **工业源码引用**（file:line）
- **v4 对应代码段**
- **推理链**：v4 实现是否完整体现洞察、与工业实现的差异、差异背后的工程权衡

第 5 节"context 实测数据"：跑 v4 跟跑 v3 同等任务，对比 coordinator context 大小 vs v3 单 agent context 大小（用 messages 长度或 token 估算）。这是"深度→广度"的实测验证。

第 6 节"多 agent 的失败模式"：列举至少 2 个 v4 比 v3 新增的失败模式（例如 swarm 死锁等 coordinator / coordinator 自己 ask 时 swarm 等待超时 / 一个 swarm 失败拖累全局），简述 v4 怎么处理 / 不处理（如果没处理，标⬛说明 production 会怎么补）。

第 7 节"写回 v3 的扩展点"：≥ 2 处具体改动建议。

### 步骤 4：写 lesson.md（agent-notebook 入口）

按 §"agent-notebook 高质量消费"，12-14 段叙事。

---

## v4 代码切段约束

`agent-v4-coordinator-swarm.ts` 按**教学叙事顺序**切段，每段一个 `// ---------- N. <段名> ----------` 标记。建议 9 段：

1. `1. Role 枚举 + 三维矩阵函数`（matrix 加 role 参数；保留 v3 的有序 if 链 + hard-block）
2. `2. Hard-block 列表`（继承 v3，role-无关）
3. `3. Tools schema（按 role 分化：swarm 物理上无 ask_user，coordinator 多 spawn_swarm）`
4. `4. Ask 转发通道（swarm → coordinator 的 in-process queue / Promise）`
5. `5. Dispatch 入口（按 role 多态执行：interactive 弹 readline / swarm 向上转发 / coordinator 弹 readline）`
6. `6. Swarm worker runLoop（独立 messages 数组，独立 system prompt）`
7. `7. Coordinator runLoop（含 spawn_swarm executor）`
8. `8. Role 切换 + 启动入口`
9. `9. Audit log helper（同 v3，全 role 通用）`

每段独立可读。

---

## Run-log 约束

至少 **4 份真实运行日志**：

| 文件 | 场景 |
|---|---|
| `run-log-interactive.txt` | role=interactive，退化为 v3 行为，演示三维矩阵兼容 v3 用例（行为完全一致） |
| `run-log-coordinator-no-swarm.txt` | role=coordinator，任务简单到 coordinator 决定不派 swarm，直接自己干 |
| `run-log-coordinator-3-swarms.txt` | **典型场景**：coordinator 派 3 个 swarm 并行处理 3 个文件 + coordinator 综合结果 |
| `run-log-swarm-ask-routed-up.txt` | 某 swarm 试图调 destructive，dispatch 判决 ask → 向 coordinator 转发 → coordinator 弹 readline → 回传结果 → swarm 继续 |

每份 run-log：
- `========== ROUND N stop_reason=X ==========` 切片（至少 2 个 ROUND，coordinator 多 swarm 场景至少 3-5 ROUND）
- `========== FINAL MESSAGES ==========` 段，包含 coordinator messages 数组
- 多 swarm 场景再加 `========== SWARM[i] FINAL MESSAGES ==========` 段，方便对照 coordinator 看不到 swarm 完整历史这件事

audit 行打到 stderr，带 role 标签：`[AUDIT role=swarm-worker tool=delete_file path=... mode=default → ROUTED-UP]`

---

## agent-notebook 高质量消费（硬约束）

打开 http://localhost:3737/?task=04-coordinator-swarm 应该能从开篇看到结尾独立讲完 v4 设计。**不能假定读者看过 README / notes.md**。

### lesson.md 14 段叙事

1. **开篇**（H1 + 段落）：从 v3 的局限切入 —— "v3 解决了 mode 维度，但没解决 agent-role 维度。production 需要 coordinator 派 swarm 并行处理"
2. **Role 枚举介绍**：`@include(./agent-v4-coordinator-swarm.ts, section=1)`
3. **三维矩阵函数**：`@include(./agent-v4-coordinator-swarm.ts, section=1)` 同段，重点讲新增 role 参数怎么 fold 进 v3 的有序 if 链
4. **Tools schema 按 role 分化（物理约束）**：`@include(./agent-v4-coordinator-swarm.ts, section=3)` + 解读"swarm 工具表里没有 ask_user 是物理事实"
5. **Ask 转发通道**：`@include(./agent-v4-coordinator-swarm.ts, section=4)` + 解读"in-process Promise / queue 模拟跨进程消息传递"
6. **Dispatch 入口的 role 多态**：`@include(./agent-v4-coordinator-swarm.ts, section=5)` + 解读"判决统一 / 执行多态 = handlers/ 三层分离的精神"
7. **Coordinator runLoop**：`@include(./agent-v4-coordinator-swarm.ts, section=7)` + spawn_swarm 工具如何 fork 出 swarm
8. **场景 A：interactive role 退化测试**：`@include(./run-log-interactive.txt, round=1)` + 验证三维矩阵兼容 v3 行为
9. **场景 B：coordinator 派 3 swarm**：`@include(./run-log-coordinator-3-swarms.txt, round=1)` + 解读"swarm 内部 context 隔离"
10. **场景 B 继续**：`@include(./run-log-coordinator-3-swarms.txt, section="SWARM[0] FINAL MESSAGES")` 对照 coordinator 看不到 swarm 完整历史
11. **场景 C：swarm ask 向上路由**：`@include(./run-log-swarm-ask-routed-up.txt, round=1)` 看 audit 行的 `→ ROUTED-UP` 标记
12. **场景 C 继续**：`@include(./run-log-swarm-ask-routed-up.txt, round=2)` 看 coordinator 弹 readline 后 swarm 收到结果继续
13. **context 数据对照**（H2 + 列表）：v3 单 agent context 大小 vs v4 coordinator context 大小，体现"深度→广度"
14. **4 条洞察对照 + 写回 v3 的改进意见**（H2 + 列表）

完整 messages dump 段落（可选第 15 段）：`@include(./run-log-coordinator-3-swarms.txt, section="FINAL MESSAGES")`

### Markdown 子集

只能用：H1-H3 标题、段落、无序列表、`inline code`、`**bold**`、GFM 表格、fenced code block（agent-notebook v1.3 实际支持，见 `tools/agent-notebook/lib/render-markdown.ts`）。不能用 mermaid。

---

## 交付清单

| 文件 | 角色 |
|---|---|
| `agent-v4-coordinator-swarm.ts` | **核心产出**：v4 实现，≤ 300 行，严格切 9 段 |
| `lesson.md` | **核心产出**：agent-notebook 入口，14 段叙事 |
| `run-log-interactive.txt` | interactive role 退化测试 |
| `run-log-coordinator-no-swarm.txt` | coordinator 单干 |
| `run-log-coordinator-3-swarms.txt` | **典型场景**：派 3 swarm + 综合 |
| `run-log-swarm-ask-routed-up.txt` | swarm ask 向上路由 |
| `notes.md` | 4 条洞察对照 + context 实测 + 失败模式 + v3 改进意见（≥ 800 字）|
| `excerpts.md` | 源码片段引用（coordinator/ + handlers/ + 必要的 mode 矩阵延续片段）|
| `README.md` | 三段式：学到了什么 / 怎么读这份归档 / 在课程中的位置 |
| `spec.md` | 本文件 |

---

## 约束

- **必须真实运行**：4 份 run-log 都是 v4 真实跑出来的，不能手写
- 所有 destructive 工具仍 mock（不真删 / 不真写）
- `agent-v4-coordinator-swarm.ts` ≤ 300 行
- swarm 与 coordinator 在同一进程内即可（in-process Promise 模拟跨进程通信）；不需要真实 IPC / network / 多进程
- 用 `fetch` 直打 Anthropic 协议，不用 SDK
- 沿用 `~/.claude-dev/settings.json` 与 deepseek endpoint（不再硬编码 model id）
- swarm 与 coordinator 各自独立 `messages: []` 数组，证明 context 隔离
- 4 条洞察在 notes.md 必须逐条有判决 + 论证（不是简单 ✅）
- ask 转发用 in-process 实现，但**接口设计要预留未来跨进程的可能**（注释说明"如果跨进程需要换成什么"）

---

## 验收标准

1. v4 严格切 9 段（`grep -c "^// ----------"` = 9）
2. 4 份 run-log 每份都有 ROUND 切片 + FINAL MESSAGES 段；多 swarm 场景还要有 `SWARM[i] FINAL MESSAGES` 段
3. lesson.md 在 agent-notebook 打开后能从头看到尾、无红色错误块
4. swarm 工具 schema 字面量不含 `ask_user`（`grep "ask_user" agent-v4*.ts` 不出现在 swarm tools 数组里）
5. coordinator messages 数组**不包含**任何 swarm 内部 tool_use / tool_result（只含 spawn_swarm 工具的 final result）—— 这是 context 隔离的代码可验证证据
6. swarm ask 向上路由 run-log 能看到 audit 行带 `→ ROUTED-UP` 标记 + coordinator 弹 readline + swarm 在下一轮收到结果继续
7. notes.md 4 条洞察全部判决 + 论证（≥ 800 字）
8. notes.md 第 5 节有 v3 与 v4 的 context 实测数据对照（messages 数组长度或 token 估算）

---

## 完成后

- artifact_count: 3 → 4
- bloom_level 保持 `create`（已经在 create 层，本次是巩固而非新跨越）
- 更新 INDEX.md、写 journal accept 条
- 下一步：**Lecture 05** —— context compaction（multi-agent 的"广度"问题暴露后，深度压缩自然成为下一维度）

---

## 验证方法

- `wc -l artifacts/04-coordinator-swarm/agent-v4-coordinator-swarm.ts` ≤ 300
- `grep -c "^// ----------" artifacts/04-coordinator-swarm/agent-v4-coordinator-swarm.ts` = 9
- `grep -l "ask_user" artifacts/04-coordinator-swarm/agent-v4*.ts` —— 文件中可以出现 ask_user 字符串（比如 interactive/coordinator 工具表），但 grep `swarm.*tools` 上下文里不应该出现 ask_user
- `ls artifacts/04-coordinator-swarm/run-log-*.txt | wc -l` ≥ 4
- 每份 run-log: `grep -c "^========== ROUND" run-log-*.txt` ≥ 2，且各有 `========== FINAL MESSAGES ==========`
- 多 swarm run-log: `grep -c "^========== SWARM\[" run-log-coordinator-3-swarms.txt` ≥ 3
- `~/.bun/bin/bun run tools/agent-notebook/server.ts artifacts/04-coordinator-swarm/` → 浏览器打开 03→04 切换无红色错误块
