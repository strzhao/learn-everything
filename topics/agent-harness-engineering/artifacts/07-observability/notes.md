# notes.md —— Task 07 对照报告

> Lecture 07 + Socratic 08 + Socratic 09 抽象出的 4 条 observability 设计要点 ↔ v7 代码 ↔ claude-code `src/utils/telemetry/` 子系统的对照报告。
>
> 4 条要点源自 Socratic 09 全对一次通过的内化：(1) fan-out 单一入口（语义一致性）；(2) cardinality 字段精确分类（白名单 metric label / 高基数 events only）；(3) privacy 必须在机制层（sink 包装函数 vs 业务层 N 处）；(4) context map ≠ sink（同步 inspect vs 异步导出）。v7 的 545 行代码不是凭空设计 —— 它是这 4 条要点的代码物理化 + v6 hook 系统的天然消费实例。
>
> **遵守 CLAUDE.md 0 假设原则**：所有 file:line 都来自 Explore agent + 直接 Read 验证，不凭命名推断。

---

## §1. 源码定位（步骤 0）

**结论**：claude-code observability 子系统真实位置 = `src/utils/telemetry/` 9 文件 ~110KB + `src/hooks/toolPermission/permissionLogging.ts` 239 行（fan-out 教科书范本）+ `src/entrypoints/sdk/coreTypes.ts:25-53` HOOK_EVENTS 27 项。这跟 state.md 描述完全一致 —— **0 假设地读源码验证通过**。

### 关键文件清单

| 文件 | 大小 / 行数 | 角色 |
|---|---|---|
| `src/utils/telemetry/events.ts` | 2.2K / 75 行 | 顶层 `logOTelEvent` + `redactIfDisabled` + cardinality 注释字面量 |
| `src/utils/telemetry/instrumentation.ts` | 26.1K / 825 行 | OTel SDK 三模型初始化（logs/metrics/traces）+ 多协议 exporter |
| `src/utils/telemetry/sessionTracing.ts` | 27.3K / 927 行 | session 级 trace span |
| `src/utils/telemetry/perfettoTracing.ts` | 29.1K / 1120 行 | Perfetto trace format 转换 |
| `src/utils/telemetry/betaSessionTracing.ts` | 15.5K / 491 行 | session tracing beta variant |
| `src/utils/telemetry/pluginTelemetry.ts` | 10.2K / 289 行 | plugin telemetry |
| `src/utils/telemetry/bigqueryExporter.ts` | 7.6K / 252 行 | BigQuery exporter |
| `src/utils/telemetry/skillLoadedEvent.ts` | 1.4K / 39 行 | skill 加载事件 |
| `src/utils/telemetry/logger.ts` | 742B / 26 行 | logger getter |
| `src/hooks/toolPermission/permissionLogging.ts` | 7.1K / 239 行 | **fan-out 4 sink 教科书范本** |

### 关键 grep 命中（v7 直接对照）

- `redactIfDisabled` 字面量 + `<REDACTED>` —— `events.ts:17-19`（[excerpts.md §2](./excerpts.md)）
- `OTEL_LOG_USER_PROMPTS` env 字面量 —— `events.ts:13-15`
- `'Add prompt ID to events (but not metrics, where it would cause unbounded cardinality)'` 注释字面量 —— `events.ts:49`（[excerpts.md §3](./excerpts.md)）
- `'filesystem paths are too high-cardinality for metric dimensions'` 注释字面量 —— `events.ts:56-58`
- `logPermissionDecision` 单一入口 fan-out 4 sink —— `permissionLogging.ts:178-235`（[excerpts.md §1](./excerpts.md)）
- 3 类 OTel SDK 同时 import —— `instrumentation.ts:14-26`（[excerpts.md §6](./excerpts.md)）

完整源码片段在 [excerpts.md](./excerpts.md)。

---

## §2. 4 条要点逐条对照

### 要点 1：fan-out 单一入口必要性

**判定**：✅ **命中**

**v7 代码体现**：`agent-v7-observability.ts §12` `emitObservability` 函数：

```ts
function emitObservability(event: string, ctx: any): { ok: boolean } {
  try {
    const { metricLabels, logAttrs, toolUseId } = extractAttributes(event, ctx);
    ObservabilitySink.logs(event, logAttrs);                  // sink 1
    ObservabilitySink.metrics(`harness.${event}`, metricLabels);  // sink 2 (cardinality 校验)
    ObservabilitySink.contextMap(toolUseId, event, logAttrs);    // sink 3
    return { ok: true };
  } catch (e) { audit(`[OBS ERROR] ${String(e).slice(0, 100)}`); return { ok: false }; }
}
```

**工业版**：[excerpts.md §1](./excerpts.md) `permissionLogging.ts:178-235` `logPermissionDecision` 在 1 个函数内 fan-out 4 个 sink：

1. analytics event (`logEvent(...)`)
2. OTel metric counter (`getCodeEditToolDecisionCounter()?.add(1, attributes)`)
3. context map (`toolUseContext.toolDecisions.set(toolUseID, ...)`)
4. OTel logs event (`logOTelEvent('tool_decision', ...)`)

**注释字面量**："*Single entry point for all permission decision logging*"。

**Socratic 09 Q1 内化**：如果不是单一入口，分散在每个 permission handler 各自 fan-out：

- 每个调用点字段不一致（A 处写 `tool_name` / B 处写 `toolName` / C 处漏写 `decision`）
- 新增 sink（如加 Datadog exporter）要改 N 个调用点而不是 1 个
- 失败模式：忘记同步 4 个 sink 时的 fan-out 字段标准化

**v7 实测验证**：run-log-full-obs.txt 中 10 个 PreToolUse + 10 个 PostToolUse + 2 个 PreCompact + 2 个 PostCompact 全部 24 个 event 都自动 fan-out 到 3 sink，零差异 —— **因为只有 1 个入口函数控制 fan-out**。

---

### 要点 2：cardinality 字段精确分类

**判定**：✅ **命中**

**v7 代码体现**：§11 `ObservabilitySink.metrics` 内部白名单检查：

```ts
static readonly METRIC_LABEL_WHITELIST = new Set(["tool_name", "role", "decision", "mode", "event", "is_error"]);
static metrics(metricName: string, labels: Record<string, string>): void {
  for (const k of Object.keys(labels)) {
    if (!this.METRIC_LABEL_WHITELIST.has(k)) {
      audit(`[OBS REJECT cardinality: field=${k} not in whitelist=...]`);
      return; // 拒绝整次 inc
    }
  }
  // ...
}
```

**工业版**：[excerpts.md §3](./excerpts.md) `events.ts:49,56-58` 注释字面量：

- *"Add prompt ID to events (but not metrics, where it would cause unbounded cardinality)"*
- *"filesystem paths are too high-cardinality for metric dimensions, and the BQ metrics pipeline must never see them"*

工业版用"代码组织约定 + 注释 + code review"实施 cardinality 控制 —— 没有 runtime 白名单检查（v7 教学版加强为 runtime 强制）。

**Socratic 09 Q2 精确分类**：

| 字段 | 性质 | metric label OK? | events only? |
|---|---|---|---|
| `tool_name` | 有限枚举 ~30 项 | ✅ | — |
| `role` | 3 种枚举 | ✅ | — |
| `decision` | accept/reject 二元 | ✅ | — |
| `prompt_id` | UUID 每次唯一 | ❌ 高基数 | ✅ |
| `file_path` | 任意文件路径 | ❌ 高基数 | ✅ |

**v7 实测验证**：run-log-cardinality-reject.txt 故意触发 `metrics.inc("cardinality-test", { tool_name: "delete_file", file_path: "/tmp/test.txt" })` —— sink 内部检查发现 `file_path` 不在白名单，立即 `[OBS REJECT cardinality: field=file_path not in whitelist=...]` + 拒绝整次 inc。**`prompt_id` 同样被拒绝**。

**为什么 cardinality 控制不能依赖 metric backend**：

- Prometheus / OTLP backend 接收任何 label，但每个唯一 label 组合都创建一个新时序段
- 100 万用户 × 1000 个文件路径 = 10 亿时序段 = backend 内存爆 / 查询不可用
- backend 拒绝高基数是事后现象（运维痛苦）；**应用层主动拒绝是预防**

---

### 要点 3：privacy 必须在机制层（sink 包装函数）

**判定**：✅ **命中**

**v7 代码体现**：§12 顶部统一 `redactIfDisabled` 函数：

```ts
const REDACTED = "<REDACTED>";
const isUserPromptLoggingEnabled = () => process.env.OTEL_LOG_USER_PROMPTS === "1";
const redactIfDisabled = (content: string): string => isUserPromptLoggingEnabled() ? content : REDACTED;

// extractAttributes: redact 在抽取时统一应用，业务层永远拿不到原文
function extractAttributes(event: string, ctx: any): ... {
  // ...
  if (ctx?.input?.question) logAttrs.user_question = redactIfDisabled(String(ctx.input.question));
  if (ctx?.input?.content) logAttrs.edit_content = redactIfDisabled(String(ctx.input.content).slice(0, 200));
  // ...
}
```

**工业版**：[excerpts.md §2](./excerpts.md) `events.ts:13-19`：

```ts
function isUserPromptLoggingEnabled() {
  return isEnvTruthy(process.env.OTEL_LOG_USER_PROMPTS)
}

export function redactIfDisabled(content: string): string {
  return isUserPromptLoggingEnabled() ? content : '<REDACTED>'
}
```

**字面量完全一致**：v7 致敬工业版 `OTEL_LOG_USER_PROMPTS` env 字面量 + `'<REDACTED>'` 字面量。

**Socratic 09 Q3 内化**：

- **机制层 1 处实现**：redact 在 telemetry 包装函数里。所有 emit 调用都自动 redact —— **业务层永远拿不到原文**
- **业务层 N 处实现（反例）**：每个 emit 调用方自己写 `logOTelEvent('user_prompt', { content: redact(prompt) })`
  - 风险 A：每个调用点都可能忘记 redact
  - 风险 B：redact 标准不一（有的截断 200 / 有的 50 / 有的不截断）
  - 风险 C：新增 sink 时 redact 逻辑要复制 N 份
  - **与 task 02 v1 "靠 model 自觉" 同源失败模式** —— cross-cutting concern 业务层实现不可靠

**v7 实测验证**：run-log-privacy-redact.txt 两次跑同 prompt `'请把 /tmp/foo.txt 内容改成 "我的秘密密码 secret-token-12345 confidential"'`：

- Run 1（env 不设默认）：JSONL 文件含 `"edit_content":"<REDACTED>"` —— 用户秘密未泄露 ✅
- Run 2（`OTEL_LOG_USER_PROMPTS=1`）：JSONL 文件含 `"edit_content":"我的秘密密码 secret-token-12345 confidential"` —— 显式启用后原文 ✅

env 切换无需改业务代码，redact 一处实现影响所有 sink + 所有调用点。

---

### 要点 4：context map ≠ sink（同步 inspect vs 异步导出）

**判定**：✅ **命中**

**v7 代码体现**：§11 三形态 sink 严格分类：

```ts
class ObservabilitySink {
  static logs(eventName, attributes) {
    // 异步导出：写 JSONL 文件（事后调试 / SLO 定位）
    appendFileSync(OBS_LOGS_PATH, JSON.stringify(...) + "\n");
  }
  static metrics(metricName, labels) {
    // 异步聚合：内存 counter Map（触发告警 / 趋势监控）
    obsMetricCounters.get(metricName).set(labelKey, (...) + 1);
  }
  static contextMap(toolUseId, eventName, attributes) {
    // 同步 inspect：同进程 Map（下游代码立即查询 toolUseID → event/attrs）
    obsContextMap.set(toolUseId, { event, timestamp, attributes });
  }
}
```

**工业版**：[excerpts.md §1](./excerpts.md) `permissionLogging.ts:220-228`：

```ts
// Persist decision on the context so downstream code can inspect what happened
if (!toolUseContext.toolDecisions) {
  toolUseContext.toolDecisions = new Map()
}
toolUseContext.toolDecisions.set(toolUseID, {
  source: sourceString,
  decision,
  timestamp: Date.now(),
})
```

**注释字面量**：*"Persist decision on the context so downstream code can inspect what happened"* —— "context map 是给下游代码 inspect 的"，**不是 telemetry sink**。

**Socratic 09 Q4 内化**：

| 形态 | 消费时机 | 消费者 | 典型用途 |
|---|---|---|---|
| **metrics** | 异步聚合 | metric backend → 告警系统 | "PreToolUse{tool=delete_file} 计数突增 → PagerDuty" |
| **logs** | 异步导出 | logs backend → 事后查询 | "Q3 周二 14:00 哪个 user 删了文件？" |
| **context map** | 同步 inspect | 同进程下游代码 | "本次 dispatch 决策 source 是 user_temporary 还是 user_permanent？" |

**消费时机不同 → 三者必须并存**：

- 用 metrics 替代 context map：metrics 是 backend 异步聚合，**当前进程拿不到**实时决策细节
- 用 logs 替代 context map：logs 写文件后**当前进程**要再读文件 inspect？延迟 + 不必要 I/O
- 用 context map 替代 metrics / logs：context map 进程结束就丢，**无法跨 session 趋势分析**

**v7 实测验证**：run-log-full-obs.txt 跑完后 dump 段：

```
========== OBS METRIC counter dump ==========
  harness.PreToolUse{event=PreToolUse,mode=bypassPermissions,role=interactive,tool_name=delete_file} = 1
  harness.PostToolUse{event=PostToolUse,is_error=false,mode=bypassPermissions,role=interactive,tool_name=delete_file} = 1
  ...

========== OBS CONTEXT MAP dump ==========
  PreToolUse-1779726495649 → event=PreToolUse attrs={...}
  ...
```

三种 sink 在同一次跑中各自产出，对应消费路径不同。

---

## §3. emit point 物理承载结构图（v7 四层架构）

```
                +-------------------------------------+
                |  agent loop / dispatch / compact    |
                |  (in-process critical path, v6 不动)|
                +-------------------------------------+
                                 |
                                 v
                  +--------------+------------+
                  | v6 HookRegistry.emit()    |
                  | Promise.allSettled        |
                  | (失败隔离 + 永不阻断核心)  |
                  +--------------+------------+
                                 |
                  4 个 obs handler 各自 fire
                                 |
                                 v
              +------------------+-----------------+
              | emitObservability(event, ctx)      | ← Socratic 09 Q1 单一入口
              +------------------+-----------------+
                                 |
                                 v
              +------------------+-----------------+
              | extractAttributes(event, ctx)      | ← Socratic 09 Q3 redact 统一应用
              | - metricLabels (白名单字段)         |
              | - logAttrs (含 redacted user data) |
              | - toolUseId                        |
              +------------------+-----------------+
                                 |
                                 v
        +------------------------+------------------------+
        |       fan-out 3 sink (Socratic 09 Q1)            |
        +-----------+--------------+----------------------+
                    |              |                      |
                    v              v                      v
         logs (JSONL 文件)    metrics (内存 counter)    context map (同进程 Map)
         异步导出             异步聚合 + cardinality      同步 inspect
         ↓ 事后调试           检查 (Socratic 09 Q2)       ↓ 下游代码立即查询
         SLO 定位             ↓ 告警                       toolUseID → decision
                              触发
```

**关键架构原则**：

- 单一入口 → 字段标准化 + 失败一处兜底
- redact 在 extractAttributes 统一应用 → 业务层永远拿不到原文
- 3 sink 在 fan-out 内部各自处理 → 消费路径独立
- v6 hook 系统作为 obs 数据源 → observability 不修改 v6 任何核心逻辑

---

## §4. 三形态 sink 实测数据对照

### 数据采集

| run-log | 触发场景 | PreToolUse | PostToolUse | PreCompact | PostCompact | OBS REJECT | REDACTED |
|---|---|---|---|---|---|---|---|
| `run-log-no-obs.txt` | --hooks=none baseline | 0 | 0 | 0 | 0 | 0 | 0 |
| `run-log-full-obs.txt` | --hooks=obs 长任务 6 round | 10 | 10 | 2 | 2 | 0 | 0 |
| `run-log-cardinality-reject.txt` | cardinality test + 正常 agent | 2 | 2 | 0 | 0 | 2 | 0 |
| `run-log-privacy-redact.txt` | 两次跑同 prompt + env 切换 | 8 | 8 | 0 | 0 | 0 | 2 |

### 三形态 sink 各自验证

**logs sink** (`/tmp/v7-obs-logs.jsonl`)：

每次跑结束后 cat 文件，每行是合法 JSON event：

```json
{"timestamp":"2026-05-25T16:29:31.216Z","event_name":"PreToolUse","attributes":{"event":"PreToolUse","tool_name":"read_file","role":"interactive","mode":"bypassPermissions","file_path":"/tmp/test.txt"}}
```

注意 attributes 含 `file_path`（高基数字段）—— **logs 接受所有字段**（包括高基数）。

**metrics sink** (内存 counter Map dump)：

run-log-full-obs.txt 进程结束时：

```
========== OBS METRIC counter dump ==========
  harness.PreToolUse{event=PreToolUse,mode=bypassPermissions,role=interactive,tool_name=read_file} = 5
  harness.PreToolUse{event=PreToolUse,mode=bypassPermissions,role=interactive,tool_name=...} = ...
  harness.PostToolUse{event=PostToolUse,is_error=false,mode=bypassPermissions,role=interactive,tool_name=read_file} = 5
  ...
```

注意 label 严格只含**白名单字段**（tool_name / role / mode / event / is_error）—— **metrics 拒绝高基数字段**。

**context map** (内存 Map dump)：

```
========== OBS CONTEXT MAP dump ==========
  PreToolUse-1779726495649 → event=PreToolUse attrs={"event":"PreToolUse","tool_name":"read_file","role":...}
  PostToolUse-1779726495650 → event=PostToolUse attrs={"event":"PostToolUse","tool_name":"read_file","is_error":"false"...}
  ...
```

注意 attributes 含**全部字段**（含 file_path 高基数）—— **context map 与 logs 同处理（事件全保留），区别在消费时机（同步 inspect vs 异步导出）**。

### 字节释放 / 体积对照

| run-log | 文件 size | logs JSONL line 数 | metric counter 段 | context map 条目 |
|---|---|---|---|---|
| no-obs | 2069 B | 0 | 0 | 0 |
| full-obs | 17292 B | 24 | ~10 唯一 label 组合 | 24 |
| cardinality-reject | 4422 B | 4 | 2（白名单字段正常） | 4 |
| privacy-redact (合并 2 次) | 16295 B | 16（8+8） | 4 | 16 |

---

## §5. v6 改进意见

### 5.1 v6 audit() 可以重构为 obs handler

v6 §4 `audit = (msg) => console.error('[AUDIT] ' + msg)` 是硬编码 stderr 输出。v7 已经把 PreToolUse / PostToolUse audit 行重构为 obs event —— 但 v6 `[AUDIT] role=interactive hard-block tool=...` 这种 hard-block audit 仍然是硬编码。

**改进**：把 v6 audit 也通过 obs 系统 emit（新增 `HardBlock` event 进 27 events 列表的扩展集）。这样所有 audit 走同一 fan-out 路径，自动获得 logs/metrics/context map 三 sink + cardinality 控制 + redact。

### 5.2 v6 hook handler 失败 audit 应该有 metric

v6 hook 失败时打 `[AUDIT] [HOOK event=X handler=Y outcome=non_blocking_error]` —— 这是 logs 形态。**production 应该同时计数 metric**：`hook_failure_total{event=X, handler=Y, reason=...}` —— 让告警系统监控 hook 失败率突增。v7 obs 系统已有这个能力（只需把 v6 hook 失败时也调一次 `emitObservability("HookFailure", ctx)`），v6 没接入。

### 5.3 v5 compact event 应该带更结构化 attributes

v5 `[AUDIT] COMPACT type=micro role=interactive cleared=1_tool_results freed=94b` 是 free-form text。v7 PreCompact/PostCompact event 已经把这些字段结构化（`{ role, rounds, bytes, before, after }`）—— v5 audit 字符串可以全部替换为 v7 event emit。

---

## §6. 一句话总结

4 条 Lecture 07 + Socratic 09 要点全部命中工业实现。最大学习：

> **observability 不是"加 console.log"。它是一个有严格架构原则的 cross-cutting sub-system：(a) fan-out 单一入口保证语义一致性；(b) cardinality 控制白名单 / 黑名单字段精确分类；(c) privacy 在 sink 包装层 1 处实现（与 task 02 cross-cutting concern 机制层原则同源）；(d) logs/metrics/context map 三形态消费时机不同必须并存。v7 把 v6 hook 系统作为 obs 数据源 —— hook 是 cross-cutting 注入机制，obs 是 cross-cutting 消费实例 —— observability 维度自然延伸 hook 抽象。**

v7 + 这 4 条要点 + v6 hook 系统是进入 Lecture 08 的基础：**Streaming（query.ts:613 增量 tool_use parsing）或 MCP 协议（mcpServers 配置 + tools/resources/prompts 三类 capability）—— harness 剩余维度都可以通过 hook 接入 obs，三 sink 自动获得跨维度可观测性**。
