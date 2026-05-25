# Task 07 Spec —— v7 Mini Observability Sub-system

下发日期：2026-05-26
父 topic：agent-harness-engineering
前置 artifact：[`06-hook-engine/`](../06-hook-engine/)
对照源码：`/Users/stringzhao/workspace/claude-code/src/utils/telemetry/{events.ts (75 行),instrumentation.ts,sessionTracing.ts}` + `src/hooks/toolPermission/permissionLogging.ts:178-235` (fan-out 教科书范本)

---

## 任务定位

从 v6 的"hook 系统作为 cross-cutting 注入机制"升级到 v7 的"observability 子系统通过 hook 接入实现 3 形态 telemetry"。

**核心交付是一份可运行的 v7 mini observability sub-system**：把 Lecture 07 抽象的"三形态分工（logs/metrics/context map）+ 单一入口 fan-out + cardinality 控制 + privacy by default"，落到 ≤ 500 行代码 + 4 份真实 run-log + 教学叙事 lesson.md。

**关键约束**：不修改 v6 任何核心逻辑（dispatch / role / compact / hook engine 都不动）。observability 作为 hook handler 注册到 4 个 event 上 —— **这就是 v6 hook 系统"让 cross-cutting concerns 在 harness 外部声明性注册"的字面应用**。

这是 create 层第五次巩固：v6 把 hook 通用化 → v7 把 hook 系统当作 observability 的天然数据源使用。

---

## 4 条核心要点（Socratic 09 已确认）

1. **fan-out 单一入口必要性**（Q1）：在 1 个函数（`emitObservability`）内 fan-out 到 3 形态 sink，**保证语义一致性 + 字段标准化** —— 分散 fan-out 会导致 N 调用点字段不一致 / 漏写某个 sink / 新增 sink 改 N 处。对照 `permissionLogging.ts:181-235` 单一入口 fan-out 到 4 个 sink。

2. **cardinality 字段精确分类**（Q2）：
   - **metric label**（低基数，有限枚举）：`tool_name` / `role` / `decision` —— 可预测上限
   - **events only**（高基数）：`prompt_id` UUID / `file_path` 任意路径 —— 放 metric 会让 backend 时序段爆炸
   - 对照 events.ts:49 注释 *"Add prompt ID to events (but not metrics, where it would cause unbounded cardinality)"*

3. **privacy 必须在机制层**（Q3）：redact 函数封装在 sink 层（v7 的 `emitObservability` 内部），不在业务层（hook handler 调用方）。否则每个调用点都可能忘记 / 标准不一 / 新增 sink 时复制 N 份 —— **跟 task 02 v1 "靠 model 自觉" 同源失败模式**。对照 events.ts:17-19 `redactIfDisabled()`。

4. **context map vs sink 的根本区别**（Q4）：context map 是**同步 inspect 接口**（同进程下游代码立即查询 toolUseID → decision），logs/metrics 是**异步导出到外部系统**（事后分析）。三者消费时机不同，**production 必须三种并存**。对照 `permissionLogging.ts:220-228` `toolUseContext.toolDecisions Map.set(toolUseID, { source, decision, timestamp })`。

---

## v7 必须实现的 observability 子系统

### 三形态 mock sink

| 形态 | v7 实现 | 工业对照 | 消费时机 |
|---|---|---|---|
| **logs**（JSONL 文件）| 写 `/tmp/v7-obs-logs.jsonl`，每行 1 个 JSON event（带 timestamp + event_name + attributes）| `events.ts:71-74` `eventLogger.emit({body, attributes})` | 异步导出，事后调试 / SLO 定位 |
| **metrics**（in-memory counter Map）| `Map<metricName, Map<labelKey, number>>` 内存累积，跑完后 dump 一次 | `permissionLogging.ts:216` `getCodeEditToolDecisionCounter()?.add(1, attributes)` | 异步聚合，触发告警 / 趋势监控 |
| **context map**（in-process Map）| `Map<toolUseId, { event, decision, timestamp, ... }>` | `permissionLogging.ts:221-228` `toolUseContext.toolDecisions Map` | 同步 inspect，同进程下游立即查询 |

### 单一入口 fan-out 函数

```ts
function emitObservability(event: HookEvent, ctx: any): { ok: true } {
  const attrs = extractAttributes(event, ctx);   // 字段抽取 + redact
  obsSink.logs.write(event, attrs);              // sink 1
  obsSink.metrics.inc(event, lowCardLabels(attrs));  // sink 2 (cardinality 校验)
  obsSink.contextMap.set(ctx.tool_use_id, { event, decision: attrs.decision });  // sink 3
  return { ok: true };
}
```

被 v6 `hooks.register(event, { kind: "function", name: "obs-emit", fn: (ctx) => emitObservability(event, ctx) })` 注册到 PreToolUse / PostToolUse / PreCompact / PostCompact 4 个 event 上。

### cardinality 控制

`metrics.inc(metricName, labels)` 内部检查 labels 字段：

- **白名单字段**（可作 metric label）：`tool_name` / `role` / `decision` / `mode` / `event`
- **黑名单字段**（拒绝 + audit 警告）：`prompt_id` / `file_path` / `tool_use_id` / `session_id` / 任何非白名单字段

故意触发：在 v7 内部有一个 `metrics.inc("debug-cardinality-test", { file_path: "/tmp/a.txt" })` 调用 → 立即拒绝 + audit `[OBS REJECT cardinality: file_path]`。

### Privacy by default

`redactIfDisabled(content)` 函数：

```ts
const REDACTED = "<REDACTED>";
function redactIfDisabled(content: string): string {
  return process.env.OTEL_LOG_USER_PROMPTS === "1" ? content : REDACTED;
}
```

`extractAttributes()` 函数对 `ctx.input?.question` / `ctx.input?.content` / `ctx.user_prompt` 等敏感字段调用 `redactIfDisabled()`。**默认 env 不设 → 输出 `<REDACTED>`**；`OTEL_LOG_USER_PROMPTS=1` → 输出原文。

### Hook handler 注册

v6 `registerDefaultHooks(set)` 增加 `set === "obs"` 分支，注册 4 个 Function handler：

```ts
if (set === "obs" || set === "all") {
  for (const event of ["PreToolUse", "PostToolUse", "PreCompact", "PostCompact"] as HookEvent[]) {
    hooks.register(event, { kind: "function", name: `obs-${event}`,
      fn: async (ctx) => { emitObservability(event, ctx); return { ok: true }; } });
  }
}
```

---

## 步骤

### 步骤 0：源码定位（10 分钟，CLAUDE.md 0 假设原则）

```bash
ls /Users/stringzhao/workspace/claude-code/src/utils/telemetry/
# events.ts (2.2K, 75 行 - 重点全读)
# instrumentation.ts (26.1K, 825 行)
# sessionTracing.ts (27.3K, 927 行)
# perfettoTracing.ts (29.1K, 1120 行)
# bigqueryExporter.ts (7.6K, 252 行)
# pluginTelemetry.ts (10.2K, 289 行)
# betaSessionTracing.ts (15.5K, 491 行)
# skillLoadedEvent.ts (1.4K, 39 行)
# logger.ts (742B, 26 行)
```

**重点读**：
- `events.ts` 全文 75 行 —— 包含 `redactIfDisabled` (line 17-19) + `prompt.id only events` 注释 (line 49) + `workspaceDir only events` 注释 (line 56-61)
- `permissionLogging.ts:178-235` 全文 —— 单一入口 fan-out 4 sink 教科书范本

把"读懂的字面证据 + 我设计的 v7 简化版差异"写在 notes.md 第 1 节。

### 步骤 1：写 v7 代码

按 §"v7 代码切段约束"组织。

### 步骤 2：跑 4 份真实 run-log

按 §"Run-log 约束"。

### 步骤 3：写 notes.md（5 节深度分析）

每个核心要点产出：
- 工业源码引用（file:line + 字面量 quote）
- v7 对应代码段
- 推理链 + v7 简化 vs 工业版差异
- 第 5 节"三形态 sink 实测数据对比"：4 份 run-log 的 logs JSONL 文件大小 / metrics counter dump / context map 内容对照
- 第 6 节"v6 改进意见"：哪些 v6 audit 行可以重构为 observability event

### 步骤 4：写 lesson.md（agent-notebook 入口）

按 §"agent-notebook 高质量消费"，14 段叙事。

---

## v7 代码切段约束

`agent-v7-observability.ts` 在 v6 基础上新增 §12 (ObservabilitySink + emit) + §13 (cardinality 控制 + privacy redact)。建议 13 段（v6 是 11 段，新增 2 段）：

1-11. v6 全继承（Role/Mode/Compact 配置 / Hard-block / Tools schema / Ask 通道 / Dispatch+execute+runRounds / groupByRound+microCompact / fullCompact+maybeCompact / HookRegistry / Handler 形态 / 三个 runLoop / 配置+callModel+启动）—— **字面不动**
12. `12. ObservabilitySink: 三形态 mock sink (logs JSONL + metrics counter Map + context Map)`
13. `13. emitObservability fan-out 单一入口 + cardinality 控制 + privacy redact + obs hook 注册`

§11 启动入口的 `registerDefaultHooks` 加 `obs` / `all` 分支注册 4 个 obs handler。

---

## Run-log 约束

至少 **4 份真实运行日志**：

| 文件 | 场景 |
|---|---|
| `run-log-no-obs.txt` | `--hooks=none` baseline —— 0 obs event，证明 v7 向下兼容 v6 |
| `run-log-full-obs.txt` | `--hooks=obs --prompt=长任务` —— 4 个 event 全部 emit + 3 sink 全部有产出 |
| `run-log-cardinality-reject.txt` | v7 内部故意触发 `metrics.inc(name, { file_path: ... })` → sink 拒绝 + audit `[OBS REJECT cardinality]` |
| `run-log-privacy-redact.txt` | 两次跑同 prompt：env 不设默认 `<REDACTED>` / `OTEL_LOG_USER_PROMPTS=1` 时原文。对比 logs JSONL 文件内容 |

每份 run-log:
- `========== ROUND N stop_reason=X ==========` 切片
- `========== FINAL MESSAGES ==========` 段
- `[OBS event=X sink=Y ...]` audit 行（写到 stderr）
- full-obs 场景额外 dump `[OBS METRIC counter dump]` 在脚本结束时

---

## agent-notebook 高质量消费（硬约束）

### lesson.md 14 段叙事

1. **开篇**（H1 + 段落）：从 v6 hook 系统的"自然数据源"切入 —— v7 是 v6 hook 的消费者
2. **三形态分工总览**（H2 + 表格）：logs / metrics / context map 各自消费时机 + 不可互代
3. **单一入口 fan-out 必要性**（H2 + 段落）：分散 fan-out 的具体失败模式
4. **emitObservability fan-out 函数**：`@include(./agent-v7-observability.ts, section=13)` + 解读
5. **ObservabilitySink 三形态实现**：`@include(./agent-v7-observability.ts, section=12)` + 解读
6. **cardinality 控制内部检查**：focus 在 metrics.inc 函数 + 白名单 / 黑名单
7. **privacy by default 字面量**：`<REDACTED>` + `OTEL_LOG_USER_PROMPTS` env 致敬 events.ts:13-19
8. **作为 hook handler 注册**：v6 §11 registerDefaultHooks 加 obs 分支
9. **场景 A no-obs baseline**：`@include(./run-log-no-obs.txt, round=1)` 验证向下兼容
10. **场景 B full-obs 长任务**：`@include(./run-log-full-obs.txt, round=N)` + 3 sink 各自产出
11. **场景 C cardinality 拒绝实测**：`@include(./run-log-cardinality-reject.txt, round=1)` + audit `[OBS REJECT]`
12. **场景 D privacy redact 对比**：`@include(./run-log-privacy-redact.txt, round=1)` + 对比 redact / 原文
13. **4 条要点对照工业实现小结**
14. **写回 v6 改进意见 + 进入 Lecture 08 钩子**

### Markdown 子集

H1-H3 / 段落 / 无序列表 / `inline code` / `**bold**` / GFM 表格 / fenced code block。不能用 mermaid。

---

## 交付清单

| 文件 | 角色 |
|---|---|
| `agent-v7-observability.ts` | **核心产出**：v7 实现，≤ 500 行，严格切 13 段 |
| `lesson.md` | **核心产出**：agent-notebook 入口，14 段叙事 |
| `run-log-no-obs.txt` | baseline |
| `run-log-full-obs.txt` | 4 event + 3 sink 全部 emit |
| `run-log-cardinality-reject.txt` | cardinality 拒绝实测 |
| `run-log-privacy-redact.txt` | redact / 原文对比 |
| `notes.md` | 6 节深度分析（≥ 1500 字）|
| `excerpts.md` | claude-code telemetry 关键源码 6+ 段引用 |
| `README.md` | 三段式 |
| `spec.md` | 本文件 |

辅助产物（v7 跑出来）：
- `/tmp/v7-obs-logs.jsonl` —— logs sink JSONL 输出
- v7 进程结束时打印 `[OBS METRIC counter dump]` —— metrics counter 内容
- v7 进程结束时打印 `[OBS CONTEXT MAP dump]` —— context map 内容

---

## 约束

- **必须真实运行**：4 份 run-log 都是 v7 真实跑出来的
- v6 全部代码字面量不动（§1-11 完全继承）
- `agent-v7-observability.ts` ≤ 500 行
- emit 用 v6 已有的 `Promise.allSettled` 失败隔离 —— obs handler 失败永不阻断核心 dispatch
- cardinality 控制：metrics.inc 内部检查 labels 字段 vs 白名单，发现高基数字段立即拒绝 + audit
- privacy: `<REDACTED>` 字面量致敬工业版；`OTEL_LOG_USER_PROMPTS` env 字面量致敬工业版
- `emitObservability` 必须是 **同步函数**（用 Promise.resolve 包装为 async）—— 三 sink 都是 in-process，无 LLM call 无网络 I/O，零开销

---

## 验收标准

1. v7 严格切 13 段（`grep -c "^// ----------"` = 13）
2. v6 §1-11 字面量不变（diff agent-v6 agent-v7 §1-11 应该 0 差异，仅 §11 末尾 registerDefaultHooks 加 obs 分支）
3. 4 份 run-log 每份都有 ROUND + FINAL MESSAGES
4. `run-log-full-obs.txt` 含 `[OBS event=PreToolUse sink=logs` + `[OBS event=PostToolUse sink=metrics` + `[OBS event=PreCompact sink=contextMap` 字面量
5. `run-log-cardinality-reject.txt` 含 `[OBS REJECT cardinality:` 字面量 **且** ROUND 仍正常完成（核心未被阻断）
6. `run-log-privacy-redact.txt` 对比两次跑：一次含 `<REDACTED>` 一次含 prompt 原文
7. `/tmp/v7-obs-logs.jsonl` 跑完后存在且每行是合法 JSON
8. notes.md 4 条要点全部判决 + 论证（≥ 1500 字）
9. lesson.md 在 agent-notebook 打开后无红色错误块

---

## 完成后

- artifact_count: 6 → 7
- bloom_level 保持 `create`（第五次巩固完成）
- 更新 INDEX.md、写 journal accept 条
- 下一步：**Lecture 08** —— Streaming SSE（`query.ts:613` 增量 tool_use parsing）或 MCP 协议（`mcpServers` 配置 + tools/resources/prompts 三类 capability）

---

## 验证方法

- `wc -l artifacts/07-observability/agent-v7-observability.ts` ≤ 500
- `grep -c "^// ----------" artifacts/07-observability/agent-v7-observability.ts` = 13
- `ls artifacts/07-observability/run-log-*.txt | wc -l` ≥ 4
- `grep -E "OBS event=(PreToolUse|PostToolUse|PreCompact|PostCompact)" run-log-full-obs.txt | wc -l` ≥ 4
- `grep -c "OBS REJECT cardinality" run-log-cardinality-reject.txt` ≥ 1
- `grep -c "<REDACTED>" run-log-privacy-redact.txt` ≥ 1 **且** 另一次跑能 grep 到 prompt 原文片段
- `~/.bun/bin/bun run tools/agent-notebook/server.ts artifacts/07-observability/` → 浏览器无红色错误块
