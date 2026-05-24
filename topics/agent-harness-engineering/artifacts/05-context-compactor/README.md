# Task 05：v5 Context Compactor

> 把 Lecture 05 抽象出的 3 个核心维度（WHEN / WHAT / HOW）+ Socratic 06 内化的 4 条要点（round 是原子单位 / 事实≠原文 / 专用 LLM call / 隔离原则跨维度延伸）落到 321 行 v5 代码 + 4 份真实 run-log，对照 claude-code `src/services/compact/` 子系统验证每一条。**核心约束**：compactor 是独立 sub-system，不修改 v4 dispatch/role 逻辑。

## 学到了什么

### 1. Round 是原子单位（v5 第一版 bug 即证据）

`tool_use` 与 `tool_result` 由 `tool_use_id` 字段指针绑定，压缩边界必须以 round 为单位。v5 第一版 fullCompact 没考虑跨边界的"悬空 tool_result"（对应 tool_use 已被压走）→ 立刻 API 报错 `unexpected tool_use_id found in tool_result blocks`。修复加 `firstValid` 跳过逻辑。**这条 bug 与修复本身就是要点 1 的最直接工程验证**。对照 claude-code `grouping.ts:22-63` 注释明说 *"the API contract guarantees every tool_use is resolved before the next assistant turn"*。

### 2. 事实 ≠ 原文（model reasoning 消化后原文可释放）

`microCompact` 把老 tool_result 内容替换为 `[Old tool result content cleared]` —— 保留 tool_use_id 占位让 model 知道"调用过"，但释放原文字节。v5 实测：model 在后续 round 看到 cleared 标记**没有 confused**，能从自己的 reasoning text 里恢复信息。**字面量直接引用工业版 `microCompact.ts:36` `TIME_BASED_MC_CLEARED_MESSAGE`**，一字不差。

### 3. 专用 compaction LLM call（双层禁工具保险）

`fullCompact` 不在主 loop 内做，是 harness 主动调一次专用 LLM call：传 `NO_TOOLS_PREAMBLE` system prompt（强制 text-only）+ 传空 tools 数组（物理移除）—— 双层保险。v5 实测：deepseek 在 `NO_TOOLS_PREAMBLE` + 空 tools 下严格输出 `<analysis>+<summary>` 双段文本，messages 从 2335 bytes 压到 1854 bytes（-20.6%）。对照工业 `prompt.ts:19-26` 注释承认即使 maxTurns=1 model 仍可能尝试调工具浪费这次机会 —— 双层防御是踩过坑的产物。

### 4. Context 隔离原则跨维度延伸（swarm compact 不影响 coordinator）

v5 实测 `run-log-swarm-internal-compact.txt`：swarm[0] 内部触发 3 次 compact（2 micro + 1 full），swarm[0] FINAL MESSAGES 含 `[COMPACTED SUMMARY]` 字面量；**coordinator FINAL MESSAGES 段完全不含任何 compact 字面量**（grep `COMPACTED SUMMARY` = 0、grep `Old tool result content cleared` = 0、grep `swarm-worker` = 0）。Task 04 的 context 隔离原则在 compact 维度完美延伸 —— 不只 swarm 内部 messages 不外泄，swarm 内部 compact 事件也不外泄。对照工业 `postCompactCleanup.ts:31-39` 按 `isMainThreadCompact` 分级清理 —— 同精神。

## 怎么读这份归档

**推荐入口：交互式 notebook 视图**

```bash
~/.bun/bin/bun run /Users/stringzhao/workspace/learn-everything/tools/agent-notebook/server.ts \
  /Users/stringzhao/workspace/learn-everything/topics/agent-harness-engineering/artifacts/05-context-compactor/
```

打开 http://localhost:3737/，按 `[← 上一步] [下一步 →]` 单步推进。**13 段叙事**从 v4 留下的两种 context 压力切入 → 3 个核心维度（WHEN/WHAT/HOW）→ 4 条要点逐条对照（含 v5 第一版 bug + 修复）→ 4 个实战场景（no-compact baseline / micro 触发 / full 触发 / swarm 内部 compact 隔离）→ 压缩前后数据对照表 → compact 自身失败模式 → 写回 v4 改进意见。右侧 messages 状态侧栏跟随每 round 更新，能看清 `[COMPACTED SUMMARY]` 字面量在 messages 数组里的位置、coordinator vs swarm 段的 compact 痕迹差异（隔离的可视化证据）。

**文件导览**：

- `lesson.md` — **首读路径**。agent-notebook 入口，13 段叙事
- `agent-v5-context-compactor.ts` — v5 实现（321 行，10 段切片）。在 v4 基础上加 §6 groupByRound / §7 microCompact / §8 fullCompact + maybeCompact，runRounds 末加 1 行钩子。`--role=` `--mode=` `--prompt=` 三 flag 控制
- `notes.md` — 8 节深度分析。源码定位 / 4 条要点逐条对照 / mode 矩阵 + compact 钩子物理承载结构图 / 推论之外的发现 / 压缩前后实测数据表 / compact 自身失败模式 / v4 改进意见 / 一句话总结
- `excerpts.md` — claude-code compact 子系统 7 段源码引用（带 file:line）。备查文档
- `run-log-no-compact.txt` — baseline，短任务无触发
- `run-log-micro-compact-triggered.txt` — microCompact 触发（4 round / 释放 4.3%）
- `run-log-full-compact-triggered.txt` — fullCompact 触发（6 round / 含专用 LLM call 输出 / 释放 20.6%）
- `run-log-swarm-internal-compact.txt` — **隔离关键证据**：swarm 内 3 次 compact，coordinator messages 完全不感知
- `spec.md` — Task 05 原始 spec

**手动跑（重现实验）**：

```bash
cd topics/agent-harness-engineering/artifacts/05-context-compactor

# 场景 A: no-compact baseline
~/.bun/bin/bun run agent-v5-context-compactor.ts --role=interactive --mode=bypassPermissions \
  --prompt='请读取 /tmp/a.txt 这个文件并总结。'

# 场景 B: microCompact 触发
~/.bun/bin/bun run agent-v5-context-compactor.ts --role=interactive --mode=bypassPermissions \
  --prompt='请依次读取 /tmp/a.txt /tmp/b.txt /tmp/c.txt 这 3 个文件，每个读完用一句话告诉我大致内容再读下一个。'

# 场景 C: fullCompact 触发（最教学化）
~/.bun/bin/bun run agent-v5-context-compactor.ts --role=interactive --mode=bypassPermissions \
  --prompt='请依次读取 /tmp/a.txt /tmp/b.txt /tmp/c.txt /tmp/d.txt /tmp/e.txt 这 5 个文件。每次只读一个，每读完一个用一句话告诉我大致内容再读下一个。'

# 场景 D: swarm 内部 compact + coordinator 隔离
~/.bun/bin/bun run agent-v5-context-compactor.ts --role=coordinator --mode=bypassPermissions \
  --prompt='请派一个 swarm worker 依次读取 /tmp/a.txt /tmp/b.txt /tmp/c.txt /tmp/d.txt /tmp/e.txt 这 5 个文件，每读完一个用一句话总结，然后 swarm 把整理给你，你转给我。只派 1 个 swarm。'
```

**前置**：`~/.claude-dev/settings.json` 含 deepseek endpoint（task 03 已配，沿用）。

## 与其他组件的关系（在课程中的位置）

- **依赖于**：[`01-minimal-agent-loop`](../01-minimal-agent-loop/) → [`02-permission-gate`](../02-permission-gate/) → [`03-mode-matrix-agent`](../03-mode-matrix-agent/) → [`04-coordinator-swarm`](../04-coordinator-swarm/)
- **本任务做了什么**：在 v4 基础上加 compaction sub-system。**不动 dispatch / role / askFn 任何 v4 逻辑**，只新增 §6/7/8 三段 + 在 §5 runRounds 末尾加一行 `await maybeCompact(...)` 钩子。新增维度：`groupByRound` 按 API round 分组 / `microCompact` 替换老 tool_result / `fullCompact` 专用 LLM call + summary 插回 / `[Old tool result content cleared]` 与 `[COMPACTED SUMMARY]` 两个 marker 字面量
- **对照源码**：`/Users/stringzhao/workspace/claude-code/src/services/compact/` 8 个文件 4000+ 行，重点对照 `grouping.ts:22-63` `microCompact.ts:36,40-50` `prompt.ts:19-26` `autoCompact.ts:62-90` `postCompactCleanup.ts:31-39`
- **下一个**：**Lecture 06** —— 维度方向二选一：(a) Hook 系统通用化（PreToolUse / PostToolUse / afterRound 钩子链，让 permission / compact / audit / observability 等所有 cross-cutting concerns 走同一机制）；(b) Observability（OTel telemetry + 结构化 audit log + decision storage）

## 关键对照表

| 维度 | v1 (ask_user) | v2 (harness gate) | v3 (mode matrix) | v4 (coord+swarm) | v5 (compactor) |
|---|---|---|---|---|---|
| Permission 位置 | model 层 | dispatch 单层 | dispatch + mode 矩阵 | dispatch + 三维矩阵 | v4 继承不动 |
| Context 形态 | 单 messages | 单 messages | 单 messages | 多 messages 隔离 | **多 messages 隔离 + 双层 compact** |
| 新增维度 | — | dispatch + is_error | mode 字符串 + 矩阵 + audit + hard-block | role 维度 + spawn_swarm + ask 上行 + context 隔离 | **compact sub-system + round 原子单位 + 专用 LLM call + 隔离跨维度** |
| 行数 | 94 | 88 | 196 | 284 | **321** |
| 失败模式 | injection 绕过 | is_error 反馈 | is_error + audit | swarm 死锁 / 单 swarm 失败 | **compact LLM 自身预算 / model 行为漂移 / 触发抖动** |
| 对应工业组件 | AskUserQuestion | hasPermissionsToUseToolInner | + 完整 10+ 步 if 链 | + coordinator + handlers + createSubagentContext | **+ compact/ 子系统 8 文件 4000 行** |

## 给学习者的提示

1. **先跑场景 A**：`bun run ... --prompt='请读取 /tmp/a.txt 并总结。'` 是最简入口（2 round / 0 compact），验证 v5 完全等同 v4 行为
2. **再跑场景 C**：长 5 文件任务，6 round 触发 micro + full —— **这是教学最完整的场景**，能看清整个优先级链
3. **看 lesson.md §9（swarm 内部 compact + coordinator 隔离）**：4 条要点中隔离原则跨维度延伸最有 "production aha-moment" 的实测证据
4. **想深挖 v5 第一版 bug**：去 notes.md §4.1 看 "悬空 tool_result" 的成因和 fullCompact 的修复逻辑 —— **要点 1 round 原子性最直接的工程教学价值**
5. **想做扩展练习**：试在 v5 上加第 3 种 compact 变体（如 `sessionMemoryCompact` —— 持久化跨 session 的 summary 到磁盘，下次启动复用），对照 claude-code `sessionMemoryCompact.ts:44-100` 的设计
