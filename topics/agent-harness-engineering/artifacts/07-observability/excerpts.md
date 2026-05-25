# excerpts —— claude-code observability 子系统关键源码

> 备查文档。所有片段来自本机 `/Users/stringzhao/workspace/claude-code/` 工作副本。
> notes.md 4 条要点对照按需引用。**遵守 CLAUDE.md 0 假设原则**：每条都带 file:line + 字面量 quote，不凭命名推断。

---

## §1. fan-out 单一入口教科书范本（推论 1：Socratic 09 Q1）

**文件**：`src/hooks/toolPermission/permissionLogging.ts:178-235`

```ts
// Single entry point for all permission decision logging. Called by permission
// handlers after every approve/reject. Fans out to: analytics events, OTel
// telemetry, code-edit OTel counters, and toolUseContext decision storage.
function logPermissionDecision(
  ctx: PermissionLogContext,
  args: PermissionDecisionArgs,
  permissionPromptStartTimeMs?: number,
): void {
  const { tool, input, toolUseContext, messageId, toolUseID } = ctx
  const { decision, source } = args

  const waiting_for_user_permission_ms =
    permissionPromptStartTimeMs !== undefined
      ? Date.now() - permissionPromptStartTimeMs
      : undefined

  // Log the analytics event (sink 1)
  if (args.decision === 'accept') {
    logApprovalEvent(tool, messageId, args.source, waiting_for_user_permission_ms)
  } else {
    logRejectionEvent(tool, messageId, args.source, waiting_for_user_permission_ms)
  }

  const sourceString = source === 'config' ? 'config' : sourceToString(source)

  // Track code editing tool metrics (sink 2)
  if (isCodeEditingTool(tool.name)) {
    void buildCodeEditToolAttributes(tool, input, decision, sourceString).then(
      attributes => getCodeEditToolDecisionCounter()?.add(1, attributes),
    )
  }

  // Persist decision on the context so downstream code can inspect what happened (sink 3)
  if (!toolUseContext.toolDecisions) {
    toolUseContext.toolDecisions = new Map()
  }
  toolUseContext.toolDecisions.set(toolUseID, {
    source: sourceString,
    decision,
    timestamp: Date.now(),
  })

  // OTel logs event (sink 4)
  void logOTelEvent('tool_decision', {
    decision,
    source: sourceString,
    tool_name: sanitizeToolNameForAnalytics(tool.name),
  })
}
```

**关键**：1 个函数 fan-out 到 **4 个 sink**：(1) analytics event (logEvent)；(2) OTel metrics counter (`getCodeEditToolDecisionCounter()?.add(1, attributes)`)；(3) in-process context map (`toolUseContext.toolDecisions.set(...)`)；(4) OTel logs event (`logOTelEvent('tool_decision', ...)`)。

**注释字面量**："*Single entry point for all permission decision logging*" + "*Fans out to: analytics events, OTel telemetry, code-edit OTel counters, and toolUseContext decision storage*" —— 工业实现明说这是单一入口 fan-out 设计。

v7 的 `emitObservability` 是这个范本的 in-process mock 简化版（3 sink 而非 4 sink，跳过 analytics 第三方层）。

---

## §2. privacy by default：redactIfDisabled 包装函数（推论 3：Socratic 09 Q3）

**文件**：`src/utils/telemetry/events.ts:13-19`

```ts
function isUserPromptLoggingEnabled() {
  return isEnvTruthy(process.env.OTEL_LOG_USER_PROMPTS)
}

export function redactIfDisabled(content: string): string {
  return isUserPromptLoggingEnabled() ? content : '<REDACTED>'
}
```

**关键**：

- **`OTEL_LOG_USER_PROMPTS` env 字面量** —— v7 致敬同一字面量
- **`'<REDACTED>'` 字面量** —— v7 致敬同一字面量
- **redact 函数是 telemetry 包装层封装** —— 不是调用方业务代码自己 redact

为什么必须在 sink 包装层（Socratic 09 Q3 内化）：如果让业务代码自己 redact，每个调用点都可能忘记 / 标准不一 / 新增 sink 时复制 N 份 —— **隐私防护从"机制层 1 处"变成"业务层 N 处"**，与 task 02 v1 "靠 model 自觉" 同源失败模式。

v7 §12 的 `redactIfDisabled()` + `extractAttributes()` 在 fan-out 入口统一应用 —— 业务层（hook handler 调用方）永远拿不到原文。

---

## §3. cardinality 控制注释字面量（推论 2：Socratic 09 Q2）

**文件**：`src/utils/telemetry/events.ts:49-61`

```ts
// Add prompt ID to events (but not metrics, where it would cause unbounded cardinality)
const promptId = getPromptId()
if (promptId) {
  attributes['prompt.id'] = promptId
}

// Workspace directory from the desktop app (host path). Events only —
// filesystem paths are too high-cardinality for metric dimensions, and
// the BQ metrics pipeline must never see them.
const workspaceDir = process.env.CLAUDE_CODE_WORKSPACE_HOST_PATHS
if (workspaceDir) {
  attributes['workspace.host_paths'] = workspaceDir.split('|')
}
```

**关键注释字面量**：

- line 49: *"Add prompt ID to events (but not metrics, where it would cause unbounded cardinality)"* —— prompt_id 是高基数字段，**events 可以 / metrics 必须拒绝**
- line 56-58: *"filesystem paths are too high-cardinality for metric dimensions, and the BQ metrics pipeline must never see them"* —— file_path 同理

**v7 cardinality 控制实测对照**：

```ts
// v7 §11 ObservabilitySink.metrics
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

run-log-cardinality-reject.txt 实测：`file_path` 和 `prompt_id` 都被拒绝 + audit 写出 `[OBS REJECT cardinality: field=X not in whitelist=...]`。**v7 教学版用"白名单 + 运行时检查"**，工业版用"代码组织约定"（events.ts 注释 + code review）—— 二者都是策略实现，不是 backend 强制。

---

## §4. logOTelEvent：logs sink 实际形态（推论 1）

**文件**：`src/utils/telemetry/events.ts:21-75`

```ts
export async function logOTelEvent(
  eventName: string,
  metadata: { [key: string]: string | undefined } = {},
): Promise<void> {
  const eventLogger = getEventLogger()
  if (!eventLogger) {
    if (!hasWarnedNoEventLogger) {
      hasWarnedNoEventLogger = true
      logForDebugging(
        `[3P telemetry] Event dropped (no event logger initialized): ${eventName}`,
        { level: 'warn' },
      )
    }
    return
  }

  // Skip logging in test environment
  if (process.env.NODE_ENV === 'test') {
    return
  }

  const attributes: Attributes = {
    ...getTelemetryAttributes(),
    'event.name': eventName,
    'event.timestamp': new Date().toISOString(),
    'event.sequence': eventSequence++,
  }

  // Add prompt ID to events (but not metrics, ...)
  const promptId = getPromptId()
  if (promptId) {
    attributes['prompt.id'] = promptId
  }
  // ...

  // Emit log record as an event
  eventLogger.emit({
    body: `claude_code.${eventName}`,
    attributes,
  })
}
```

**关键**：

- **`eventLogger.emit({ body, attributes })`** —— logs sink 的实际形态（OTel SDK 抽象）
- **`event.sequence` 单调递增 counter** —— 单 session 内事件顺序追溯
- **`getEventLogger() === null` 静默 drop + 一次性 warn** —— 失败容忍，sink 不可用不阻断业务
- **`NODE_ENV === 'test'` 跳过日志** —— 测试环境不污染遥测

**对照 v7**：v7 §11 `ObservabilitySink.logs` 用 `appendFileSync` 写 JSONL 文件（mock OTel logs sink）。两者接口语义一致：传 eventName + attributes，sink 内部处理 timestamp / sequence / persistence。

---

## §5. 工业 telemetry 子系统总览

**目录**：`src/utils/telemetry/` 9 文件 ~110KB

| 文件 | 大小 | 行数 | 角色 |
|---|---|---|---|
| `instrumentation.ts` | 26.1K | 825 | OTel SDK 初始化 + 多协议 exporter（OTLP / Prometheus / Console）+ MeterProvider / LoggerProvider / TracerProvider 三模型并存 |
| `sessionTracing.ts` | 27.3K | 927 | session 级 trace span（startSpan / endSpan + attributes 注入）|
| `perfettoTracing.ts` | 29.1K | 1120 | Perfetto trace format 转换（性能 trace UI 兼容）|
| `betaSessionTracing.ts` | 15.5K | 491 | session tracing beta variant |
| `pluginTelemetry.ts` | 10.2K | 289 | plugin 加载 / 卸载 / 错误事件 telemetry |
| `bigqueryExporter.ts` | 7.6K | 252 | BigQuery exporter（注：events.ts 注释说 "BQ metrics pipeline must never see filesystem paths"）|
| `events.ts` | 2.2K | 75 | 顶层 `logOTelEvent` + `redactIfDisabled` 公共 API |
| `skillLoadedEvent.ts` | 1.4K | 39 | skill 加载事件专用 |
| `logger.ts` | 742B | 26 | logger getter helper |

**关键洞察**：

1. **logs / metrics / traces 三模型并存**（instrumentation.ts:14-26 import 三类 sdk-logs / sdk-metrics / sdk-trace-base）—— 对应 Socratic 08 Q2 内化的"production SLO 三层并存"
2. **多协议 exporter**（OTLP / Prometheus / Console）—— 一套 instrumentation 不绑定特定 telemetry backend
3. **BigQuery 专门 exporter**（bigqueryExporter.ts）—— 数据仓库分析用，独立于 OTel 实时 pipeline
4. **`/* dynamic imports for exporter */`**（instrumentation.ts:3-5 注释）—— 6 个 exporter 共 ~1.2MB 不全部 static import，启动时按 protocol 动态导入

---

## §6. instrumentation.ts 顶部 imports：三模型 sdk 字面证据

**文件**：`src/utils/telemetry/instrumentation.ts:1-30`

```ts
import { DiagLogLevel, diag, trace } from '@opentelemetry/api'
import { logs } from '@opentelemetry/api-logs'
// OTLP/Prometheus exporters are dynamically imported inside the protocol
// switch statements below. A process uses at most one protocol variant per
// signal, but static imports would load all 6 (~1.2MB) on every startup.
import {
  envDetector,
  hostDetector,
  osDetector,
  resourceFromAttributes,
} from '@opentelemetry/resources'
import {
  BatchLogRecordProcessor,
  ConsoleLogRecordExporter,
  LoggerProvider,
} from '@opentelemetry/sdk-logs'
import {
  ConsoleMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics'
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  ConsoleSpanExporter,
} from '@opentelemetry/sdk-trace-base'
```

**关键**：3 类 OTel SDK 同时 import：

- `@opentelemetry/sdk-logs` (LoggerProvider) → logs 模型
- `@opentelemetry/sdk-metrics` (MeterProvider) → metrics 模型
- `@opentelemetry/sdk-trace-base` (BasicTracerProvider) → traces 模型

**3 种 telemetry 形态在工业 production 实际并存** —— 不是"哪个好的取舍"。这对应 Lecture 07 抽象的"logs/metrics/traces 三形态分工"在 v7 §11 ObservabilitySink 的体现（v7 简化 traces 为 context map）。

---

## §7. 失败容忍：`getEventLogger() === null` 静默 drop（推论 1 边界）

**文件**：`src/utils/telemetry/events.ts:25-35`

```ts
const eventLogger = getEventLogger()
if (!eventLogger) {
  if (!hasWarnedNoEventLogger) {
    hasWarnedNoEventLogger = true
    logForDebugging(
      `[3P telemetry] Event dropped (no event logger initialized): ${eventName}`,
      { level: 'warn' },
    )
  }
  return
}
```

**关键**：

- **`if (!eventLogger) return`** —— sink 未初始化时静默丢弃事件，不抛错不阻断业务
- **`hasWarnedNoEventLogger` 单 boolean**：一次性 warn 防止刷屏
- 与 v6 hook 失败容忍同精神：**观测 / 旁路系统失败永不阻断 critical path**

**v7 对应**：v7 §11 `ObservabilitySink.logs` 用 `try { appendFileSync... } catch { /* sink 失败永不抛 */ }`，同精神。**这是 Socratic 07 Q1 "hook 可失败 / sub-system 必须可靠" 原则在 observability 维度的延伸**。
