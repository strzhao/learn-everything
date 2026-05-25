# Task 07：v7 mini observability sub-system —— v6 hook 的天然消费者

> v6 把 hook 系统通用化了，但 hook 只是注入机制 —— production 还需要"被注入的 cross-cutting concern 实际做什么"。observability 是最典型的消费实例：所有 PreToolUse / PostToolUse / PreCompact / PostCompact event 都应该流向 logs / metrics / context map 三形态 sink，让 SRE 能告警、调试、查询。本任务把 Lecture 07 抽象的"三形态分工 + fan-out 单一入口 + cardinality 控制 + privacy by default"，落到 545 行 v7 代码 + 4 份真实 run-log（含 cardinality 拒绝 + privacy redact 对比实测），对照 claude-code `src/utils/telemetry/` 子系统验证每一条。看完你应该能说清：(1) 为什么 fan-out 必须在单一入口而不是每个 emit 调用方各自调 3 sink；(2) 哪些字段可以 metric label，哪些只能 events attribute；(3) 为什么 redact 必须在 sink 包装层而不是业务层；(4) context map 跟 logs/metrics 的根本区别（同步 inspect vs 异步导出）。

## 是什么

v6 hook 系统作为 cross-cutting 注入机制证明了"在 critical path 关键点旁路广播 event"是正确架构。但 v6 只演示了 hook 的**机制**，没演示 hook 的**典型消费**。

production 中最重要的 hook 消费者是 **observability**：

- **logs**（详细 attributes）—— 异步导出到外部系统，事后调试 / SLO 定位
- **metrics**（聚合 counter）—— 异步聚合到 backend，触发告警 / 趋势监控
- **context map**（同进程 Map）—— 同步 inspect 接口，下游代码立即查询 toolUseID → decision

v7 把这三种形态作为 v6 hook 的消费者实现：

- `emitObservability(event, ctx)` 单一入口 fan-out 到 3 sink
- 注册为 4 个 Function handler 到 PreToolUse / PostToolUse / PreCompact / PostCompact event 上
- **不修改 v6 任何核心逻辑** —— 这就是 v6 "cross-cutting concerns 在外部声明性注册"原则的字面应用

## §1. 三形态分工总览

| 形态 | 数据形态 | 消费时机 | 消费者 | 典型用途 |
|---|---|---|---|---|
| **logs** | 详细 attributes，含高基数字段 | 异步导出 | logs backend（OTel / ELK / Loki）| 事后追溯 / SLO 定位 / 单事件查询 |
| **metrics** | 低基数 label + counter | 异步聚合 | metric backend（Prometheus / OTLP）| 告警阈值 / 趋势监控 / 仪表盘 |
| **context map** | 同进程 Map<id, decision> | 同步 inspect | 同进程下游代码 | runtime 决策回查 / 不跨进程 |

**消费时机不同 → 三者必须并存**（Socratic 08 Q2 + Socratic 09 Q4 内化）。production 不是"用哪个好"，是三种都要。

claude-code `instrumentation.ts:14-26` 同时 import `@opentelemetry/sdk-logs` + `@opentelemetry/sdk-metrics` + `@opentelemetry/sdk-trace-base` 三类 sdk —— **三模型并存是工业事实**。

## §2. fan-out 单一入口的必要性

**问题**：为什么必须 1 个 `emitObservability` 函数 fan-out 到 3 sink，而不是每个 emit 调用方（v6 dispatch / maybeCompact）各自调 3 sink？

**Socratic 09 Q1 答案**：单一入口保证语义一致性 + 字段标准化。

- **字段标准化**：所有 event 经过同一个 `extractAttributes()` 抽取字段 —— `tool_name` 永远不会写成 `toolName`；`role` 永远不会漏写
- **新增 sink 改 1 处**：未来加 Sentry exporter 只需在 `emitObservability` 内部加一行 `Sentry.captureEvent(...)`；如果分散 fan-out，要改 N 个调用点
- **失败兜底统一**：单一入口 try-catch 包裹所有 sink；分散调用方各自 catch 容易漏

**v6 hook handler 调用方分散 vs v7 fan-out 集中**：

```ts
// 反例：每个 hook handler 各自调 3 sink（分散 fan-out）
hooks.register("PreToolUse", { kind: "function", name: "log-pre-tool", fn: async (ctx) => {
  logs.write("PreToolUse", { tool: ctx.tool, ... });
  metrics.inc("preToolUse", { tool: ctx.tool, ... });
  contextMap.set(ctx.id, { tool: ctx.tool, ... });
  return { ok: true };
}});
// 缺点：3 个 PreCompact / PostToolUse / PostCompact handler 都要重复这 3 行 → 12 处重复

// v7 实际做法：4 个 handler 都调同一个 emitObservability（集中 fan-out）
hooks.register("PreToolUse", { kind: "function", name: "obs-PreToolUse",
  fn: async (ctx) => { emitObservability("PreToolUse", ctx); return { ok: true }; } });
hooks.register("PostToolUse", { kind: "function", name: "obs-PostToolUse",
  fn: async (ctx) => { emitObservability("PostToolUse", ctx); return { ok: true }; } });
// PreCompact / PostCompact 同形态
```

## §3. emitObservability fan-out 函数

@include(./agent-v7-observability.ts, section=12)

**关键设计**：

- `extractAttributes(event, ctx)` 抽取字段时**统一应用 redact**（line `redactIfDisabled(String(ctx.input.question))`）
- `metricLabels` 严格只取白名单字段（tool_name / role / mode / event / is_error）
- `logAttrs` 是 `metricLabels` 的超集，**额外含**高基数字段（file_path / user_question / edit_content）+ 已 redacted 的敏感字段
- 单一入口 try-catch 包裹整个 fan-out —— 任何 sink 失败不阻断其他 sink，更不阻断 v6 hook system 调用方

## §4. ObservabilitySink 三形态实现

@include(./agent-v7-observability.ts, section=11)

**3 个 sink 严格独立**：

- `static logs(eventName, attributes)` —— 写 JSONL 文件，**接受所有字段**（含高基数）
- `static metrics(metricName, labels)` —— 内存 counter Map，**白名单检查 + 拒绝高基数**
- `static contextMap(toolUseId, eventName, attributes)` —— 同进程 Map，**接受所有字段同 logs**，但消费方式是同步 inspect

**对照工业版**：

- logs ↔ `events.ts:71-74` `eventLogger.emit({body, attributes})`
- metrics ↔ `permissionLogging.ts:216` `getCodeEditToolDecisionCounter()?.add(1, attributes)`
- context map ↔ `permissionLogging.ts:221-228` `toolUseContext.toolDecisions.set(toolUseID, ...)`

## §5. cardinality 控制：白名单 + runtime 检查

`metrics.inc(metricName, labels)` 内部检查每个 label key 是否在白名单 `{tool_name, role, decision, mode, event, is_error}`。任何超出白名单的字段 → 立即 `[OBS REJECT cardinality: field=X not in whitelist=...]` audit + 拒绝整次 inc（不只是 silently drop label）。

**为什么 cardinality 控制不能依赖 metric backend**：

- Prometheus / OTLP 接受任何 label，但每个唯一 label 组合都创建一个新时序段
- 100 万 user × 1000 文件路径 = 10 亿时序段 = backend 内存爆 / 查询不可用
- backend 拒绝高基数是事后现象（运维痛苦）；**应用层主动拒绝是预防**

**对照工业版**：`events.ts:49` 注释字面量 *"Add prompt ID to events (but not metrics, where it would cause unbounded cardinality)"* + line 56-58 *"filesystem paths are too high-cardinality for metric dimensions"*。工业用"代码约定 + code review"实施，v7 教学版加强为 **runtime 白名单强制**（更显式）。

## §6. privacy by default：redact 在 sink 包装层

v7 `redactIfDisabled` 字面量致敬工业 `events.ts:17-19`：

```ts
const REDACTED = "<REDACTED>";
const isUserPromptLoggingEnabled = () => process.env.OTEL_LOG_USER_PROMPTS === "1";
const redactIfDisabled = (content: string): string => isUserPromptLoggingEnabled() ? content : REDACTED;
```

**v7 vs 工业版字面量完全一致**：

- `OTEL_LOG_USER_PROMPTS` env 字面量
- `'<REDACTED>'` 字符串字面量

**Socratic 09 Q3 内化的核心论断**：

> redact 必须在 sink 包装层（机制层 1 处），不能在业务层 N 处。否则每个调用点都可能忘记 / redact 标准不一 / 新增 sink 时复制 N 份 —— **与 task 02 v1 "靠 model 自觉" 同源失败模式**。

`extractAttributes()` 在 fan-out 入口统一调 `redactIfDisabled` —— 业务层（hook handler 调用方）永远拿不到原文。env 切换无需改业务代码。

## §7. 作为 v6 hook handler 注册

v7 不修改 v6 任何核心逻辑。obs handler 通过 `hooks.register()` 接入 4 个 event：

```ts
function registerObsHooks(): void {
  for (const event of ["PreToolUse", "PostToolUse", "PreCompact", "PostCompact"] as HookEvent[]) {
    hooks.register(event, { kind: "function", name: `obs-${event}`,
      fn: async (ctx) => { emitObservability(event, ctx); return { ok: true, reason: "obs emitted" }; } });
  }
}
```

启动入口 `--hooks=obs` 时调一次 `registerObsHooks()`。**v6 hook 系统作为 observability 的天然数据源** —— hook 是 cross-cutting 注入机制，obs 是 cross-cutting 消费实例。

## §8. 场景 A：no-obs baseline（验证向下兼容）

User prompt：`请删除 /tmp/test.txt。`

启动：`--hooks=none`

@include(./run-log-no-obs.txt, round=1)

@include(./run-log-no-obs.txt, round=2)

**关键观察**：grep `OBS event=` 返回 0 个。0 obs handler 注册 → emit 不发生 → 三 sink 无产出 → JSONL 文件可能仍是空（因为启动时 `writeFileSync(OBS_LOGS_PATH, "")` 清空）。**v7 行为完全等同 v6**。验证了"observability 不打扰短任务"。

## §9. 场景 B：full-obs 长任务（4 个 event + 3 sink 全部 emit）

User prompt：`请依次读取 /tmp/a.txt /tmp/b.txt /tmp/c.txt /tmp/d.txt /tmp/e.txt 这 5 个文件...`

启动：`--hooks=obs`

@include(./run-log-full-obs.txt, round=5)

ROUND 5 是关键：长任务触发 fullCompact，PreCompact + PostCompact 两个 obs event 同时 fire（被 v6 maybeCompact 内部 emit point 触发）。

**完整产出验证**（实测数据）：

- **PreToolUse event**: 10 次（5 次 read_file × 2 round per file 模式）
- **PostToolUse event**: 10 次
- **PreCompact event**: 2 次（触发了 2 次 fullCompact）
- **PostCompact event**: 2 次
- **24 个 obs event 全部 fan-out 到 3 sink**

三 sink 各自产出在脚本结束时 dump 出来。看 `========== OBS METRIC counter dump ==========` 段：所有 metric label 严格只含白名单字段。看 `========== OBS CONTEXT MAP dump ==========` 段：每个 toolUseId 都映射到 event + attributes。看 `/tmp/v7-obs-logs.jsonl` 文件：每行一个合法 JSON event 含完整 attributes（含高基数 file_path）。

## §10. 场景 C：cardinality 拒绝实测

启动：`--hooks=cardinality-test`（v7 内部 `runCardinalityRejectTest()` 故意 push `file_path` 和 `prompt_id` 进 metric counter）

@include(./run-log-cardinality-reject.txt, round=1)

**关键 audit 行**：

```
[AUDIT] [OBS TEST] cardinality reject test —— intentionally passing file_path to metric counter
[AUDIT] [OBS REJECT cardinality: field=file_path not in whitelist={tool_name,role,decision,mode,event,is_error}]
[AUDIT] [OBS REJECT cardinality: field=prompt_id not in whitelist={tool_name,role,decision,mode,event,is_error}]
[AUDIT] [OBS TEST] cardinality reject test —— both attempts should have been rejected above
```

2 次 `OBS REJECT` —— sink 内部白名单检查准确拦截 `file_path` 和 `prompt_id` 两个高基数字段。

然后正常 agent 跑 1 个 delete_file，**白名单字段（tool_name / role / decision / mode）正常 emit**：

```
[AUDIT] [OBS event=PreToolUse sink=metrics labels=event=PreToolUse,mode=bypassPermissions,role=interactive,tool_name=delete_file count=1]
```

**核心观察**：cardinality 拒绝不影响正常 emit。被拒绝的只是 metric label，logs 和 context map 仍然接受高基数字段（events only 允许）。这是"cardinality 字段精确分类"在代码上的字面体现。

## §11. 场景 D：privacy redact 对比实测（教学黄金）

两次跑同 prompt：`请把 /tmp/foo.txt 内容改成 "我的秘密密码 secret-token-12345 confidential"，用 edit_file。`

**Run 1（env 不设默认）**：

@include(./run-log-privacy-redact.txt, round=1)

logs JSONL Run 1 后内容（dump 在 run-log 里）：

```json
{"timestamp":"...","event_name":"PreToolUse","attributes":{"event":"PreToolUse","tool_name":"edit_file","role":"interactive","mode":"bypassPermissions","file_path":"/tmp/foo.txt","edit_content":"<REDACTED>"}}
```

**`edit_content: "<REDACTED>"`** —— 用户秘密未泄露 ✅

**Run 2（`OTEL_LOG_USER_PROMPTS=1`）**：

（run-log-privacy-redact.txt 内 Run 2 ROUND 输出形态与 Run 1 同形，只是 attributes 内 `edit_content` 字段值不同；完整两次 logs JSONL dump 都在 run-log 文件内）

logs JSONL Run 2 后内容：

```json
{"timestamp":"...","event_name":"PreToolUse","attributes":{...,"edit_content":"我的秘密密码 secret-token-12345 confidential"}}
```

**`edit_content: "我的秘密密码 secret-token-12345 confidential"`** —— 显式启用 env 后原文 ✅

**关键观察**：

- **env 切换无需改业务代码** —— redact 在 `extractAttributes()` 1 处实现，所有 sink + 所有调用点统一受 env 控制
- **业务层（v6 hook handler 调用方）永远拿不到原文** —— `emitObservability(event, ctx)` 内部 `redactIfDisabled` 在 attribute 抽取时就应用了
- **跟 task 02 v1 "靠 model 自觉" 同源失败模式** —— 如果让业务代码自己 redact，每个调用点都可能忘记，新增 sink 时要复制 N 份

## §12. 4 条要点对照工业实现（小结）

- **要点 1 fan-out 单一入口** ✅ 命中 — v7 §12 `emitObservability` ↔ 工业 `permissionLogging.ts:181-235` `logPermissionDecision` 单一入口 fan-out 4 sink，**注释字面量 "Single entry point for all permission decision logging"**
- **要点 2 cardinality 字段精确分类** ✅ 命中 — v7 §11 `METRIC_LABEL_WHITELIST` runtime 检查 ↔ 工业 `events.ts:49,56-58` 注释字面量 *"prompt ID to events but not metrics"* + *"filesystem paths too high-cardinality"*
- **要点 3 privacy 在机制层** ✅ 命中 — v7 §12 `redactIfDisabled` + `<REDACTED>` 字面量 ↔ 工业 `events.ts:13-19` 字面量完全一致
- **要点 4 context map ≠ sink** ✅ 命中 — v7 §11 三 sink 严格分类 ↔ 工业 `permissionLogging.ts:220-228` 注释 *"Persist decision on the context so downstream code can inspect what happened"*

完整对照见 [notes.md §2](./notes.md)。

## §13. observability 的边界判断准则

什么应该走 observability hook，什么不应该：

| 关注点 | 走 observability hook? | 理由 |
|---|---|---|
| audit log（记录所有 tool 调用）| ✅ | 失败只影响观测，解耦 critical path |
| metrics（趋势 / 告警）| ✅ | 同上 |
| permission gate 决策日志 | ✅（事后追溯）| 决策本身是 sub-system，日志是 obs |
| permission gate 拦截动作 | ❌ | sub-system 必须可靠，不走 hook |
| compact 触发决策 | ❌ | sub-system 必须可靠 |
| compact 前后状态 obs | ✅ | PreCompact/PostCompact event 是 obs |

**底线**：observability 是 v6 hook 的消费实例 —— 失败容忍 + 旁路广播。所有 critical path 的决策本身仍是 sub-system，**obs 只观察不决策**。

完整划分见 [notes.md §5](./notes.md)（含 v6 改进建议）。

## §14. 写回 v6 改进意见 + 进入 Lecture 08 钩子

3 处 v6 改进点：

1. **v6 `audit()` 重构为 obs handler** —— 把 hard-block audit / auto-allow audit / routed-up audit 全部通过 obs 系统 emit，自动获得 logs/metrics/context map 三 sink + cardinality 控制 + redact
2. **hook 失败 audit 加 metric** —— `hook_failure_total{event, handler, reason}` counter 监控 hook 失败率突增
3. **v5 compact audit 升级为 obs event** —— v5 `[AUDIT] COMPACT type=micro role=...` free-form text 替换为结构化 PreCompact/PostCompact event

**Lecture 08 入口**：Streaming（`query.ts:613` SSE 增量 tool_use parsing）或 MCP 协议（`mcpServers` 配置 + tools/resources/prompts 三类 capability）。**两者都可以通过 hook 接入 obs**，自动获得三 sink 可观测性。

完整改进建议见 [notes.md §5](./notes.md)。

## 下一步

回到 `learn-everything/topics/agent-harness-engineering/` 让课程验收这次交付。v7 把 v6 hook 系统作为 cross-cutting concern 消费实例使用，下一步 **Lecture 08** —— 选 Streaming 或 MCP 维度都行。两者都能复用 v6 hook + v7 obs 形成"任何新维度 → 自动可观测"的架构红利。
