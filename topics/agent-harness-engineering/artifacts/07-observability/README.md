# Task 07：v7 Mini Observability Sub-system

> 把 Lecture 07 抽象的 observability 设计 + Socratic 09 内化的 4 条要点（fan-out 单一入口 / cardinality 字段精确分类 / privacy 在机制层 / context map ≠ sink），落到 545 行 v7 代码 + 4 份真实 run-log（含 cardinality 拒绝 + privacy redact 对比实测），对照 claude-code `src/utils/telemetry/` 子系统验证每一条。**核心约束**：不修改 v6 任何核心逻辑，observability 作为 hook handler 注册到 4 个 event 上。

## 学到了什么

### 1. fan-out 单一入口：语义一致性 + 字段标准化

`emitObservability(event, ctx)` 1 个函数 fan-out 到 3 sink（logs / metrics / context map）。**字段抽取 + redact + cardinality 检查全部在 1 处**。如果让每个 hook handler 各自调 3 sink → 4 handler × 3 sink = 12 处重复，字段不一致 / 漏写 / 新增 sink 改 12 处。对照工业 `permissionLogging.ts:181-235` `logPermissionDecision` 在 1 个函数内 fan-out 4 sink（analytics event / OTel metric counter / context map / OTel logs event），注释字面量 *"Single entry point for all permission decision logging"*。

### 2. cardinality 字段精确分类：白名单 + runtime 检查

`ObservabilitySink.metrics` 内部 `METRIC_LABEL_WHITELIST = {tool_name, role, decision, mode, event, is_error}` 严格检查。任何超白名单字段（`file_path` / `prompt_id` / `tool_use_id` / `session_id` 等高基数）→ 立即 `[OBS REJECT cardinality: field=X not in whitelist=...]` 拒绝。run-log-cardinality-reject.txt 实测：`file_path` + `prompt_id` 都被拒。对照工业 `events.ts:49` 注释 *"prompt ID to events but not metrics, where it would cause unbounded cardinality"* + line 56-58 *"filesystem paths too high-cardinality for metric dimensions, BQ metrics pipeline must never see them"*。工业用代码约定 + code review 实施，v7 教学版加强为 runtime 强制（更显式）。

### 3. privacy by default：redact 在 sink 包装层（不是业务层）

v7 `redactIfDisabled(content)` 字面量致敬工业 `events.ts:17-19`：

```ts
const REDACTED = "<REDACTED>";
const isUserPromptLoggingEnabled = () => process.env.OTEL_LOG_USER_PROMPTS === "1";
const redactIfDisabled = (content) => isUserPromptLoggingEnabled() ? content : REDACTED;
```

**`OTEL_LOG_USER_PROMPTS` env + `<REDACTED>` 字符串**字面量与工业版完全一致。

**Socratic 09 Q3 内化的核心论断**：redact 必须在 sink 包装层（机制层 1 处）。如果让业务代码自己 redact，每个调用点都可能忘记 / redact 标准不一 / 新增 sink 复制 N 份 —— **与 task 02 v1 "靠 model 自觉" 同源失败模式**。run-log-privacy-redact.txt 实测：Run 1（env 不设）`edit_content: "<REDACTED>"`；Run 2（`OTEL_LOG_USER_PROMPTS=1`）`edit_content: "我的秘密密码 secret-token-12345 confidential"`。

### 4. context map ≠ sink：同步 inspect vs 异步导出

`toolUseContext.toolDecisions` Map 不是 telemetry sink，而是**同进程下游代码 inspect 接口**。对照工业 `permissionLogging.ts:221-228` 注释 *"Persist decision on the context so downstream code can inspect what happened"*。

**消费时机不同 → 三形态必须并存**：

- **metrics**: 异步聚合 → metric backend → 告警系统（"PreToolUse{tool=delete_file} 突增 → PagerDuty"）
- **logs**: 异步导出 → logs backend → 事后查询（"Q3 周二 14:00 哪个 user 删了文件？"）
- **context map**: 同步 inspect → 同进程下游代码（"本次 dispatch 决策 source 是 user_temporary 还是 user_permanent？"）

三种消费路径不可互代。production 必须三种并存。

## 怎么读这份归档

**推荐入口：交互式 notebook 视图**

```bash
~/.bun/bin/bun run /Users/stringzhao/workspace/learn-everything/tools/agent-notebook/server.ts \
  /Users/stringzhao/workspace/learn-everything/topics/agent-harness-engineering/artifacts/07-observability/
```

打开 http://localhost:3737/，按 `[← 上一步] [下一步 →]` 单步推进。**14 段叙事**从 v6 hook 的天然消费者切入 → 三形态分工总览 → fan-out 单一入口必要性 → ObservabilitySink 三形态实现 → cardinality 控制 → privacy by default → 4 个实战场景（baseline / 长任务 4 event 全 emit / cardinality 拒绝 / privacy redact 对比）→ 边界判断准则 → 写回 v6 改进意见。

**文件导览**：

- `lesson.md` — **首读路径**。agent-notebook 入口，14 段叙事
- `agent-v7-observability.ts` — v7 实现（545 行，13 段切片）。在 v6 基础上加 §11 ObservabilitySink + §12 emit fan-out。v6 §1-10 完全不动，§13 启动入口仅扩展 obs 注册 + dump。`--hooks=` 控制 `none | tool | compact | obs | all | fail | cardinality-test`
- `notes.md` — 6 节深度分析。源码定位 / 4 条要点逐条对照 / fan-out 四层架构图 / 三形态 sink 实测数据 / v6 改进建议 / 一句话总结
- `excerpts.md` — claude-code telemetry 7 段源码引用带 file:line（含 `permissionLogging.ts:178-235` 完整 fan-out 范本 + `events.ts:13-19,49,56-61` 关键字面量注释）
- `run-log-no-obs.txt` — baseline，0 obs event
- `run-log-full-obs.txt` — 长任务 4 event × 3 sink 全 emit（24 个 OBS event + 3 sink dump）
- `run-log-cardinality-reject.txt` — cardinality 拒绝实测（2 次 REJECT + 正常 agent 跑 4 个正常 OBS event）
- `run-log-privacy-redact.txt` — 同 prompt 两次跑 env 切换对比（2 个 `<REDACTED>` vs 18 个「秘密密码」原文）
- `spec.md` — Task 07 原始 spec

**手动跑（重现实验）**：

```bash
cd topics/agent-harness-engineering/artifacts/07-observability

# 场景 A: no-obs baseline
~/.bun/bin/bun run agent-v7-observability.ts --role=interactive --mode=bypassPermissions --hooks=none \
  --prompt='请删除 /tmp/test.txt。'

# 场景 B: full-obs 长任务（4 event + 3 sink 全 emit）
~/.bun/bin/bun run agent-v7-observability.ts --role=interactive --mode=bypassPermissions --hooks=obs \
  --prompt='请依次读取 /tmp/a.txt /tmp/b.txt /tmp/c.txt /tmp/d.txt /tmp/e.txt 这 5 个文件...'

# 场景 C: cardinality 拒绝实测
~/.bun/bin/bun run agent-v7-observability.ts --hooks=cardinality-test

# 场景 D: privacy redact 对比（教学黄金）
# Run 1: 默认 REDACTED
~/.bun/bin/bun run agent-v7-observability.ts --role=interactive --mode=bypassPermissions --hooks=obs \
  --prompt='请把 /tmp/foo.txt 内容改成 "我的秘密密码 secret-token-12345"，用 edit_file。'
cat /tmp/v7-obs-logs.jsonl | grep edit_content
# 输出: "edit_content":"<REDACTED>"

# Run 2: OTEL_LOG_USER_PROMPTS=1 启用原文
OTEL_LOG_USER_PROMPTS=1 ~/.bun/bin/bun run agent-v7-observability.ts --role=interactive --mode=bypassPermissions --hooks=obs \
  --prompt='请把 /tmp/foo.txt 内容改成 "我的秘密密码 secret-token-12345"，用 edit_file。'
cat /tmp/v7-obs-logs.jsonl | grep edit_content
# 输出: "edit_content":"我的秘密密码 secret-token-12345"
```

**前置**：`~/.claude-dev/settings.json` 含 deepseek endpoint（task 03 已配，沿用）。

## 与其他组件的关系（在课程中的位置）

- **依赖于**：[`01-minimal-agent-loop`](../01-minimal-agent-loop/) → ... → [`06-hook-engine/`](../06-hook-engine/)
- **本任务做了什么**：在 v6 基础上加 observability 子系统作为 hook 的消费实例。**v6 §1-10 字面量完全不动**，新增 §11 ObservabilitySink + §12 emit fan-out + §13 启动入口扩展 obs 注册 + 跑完 dump。新增维度：三形态 sink（logs/metrics/context map）/ fan-out 单一入口 / cardinality 白名单 runtime 检查 / privacy redact 在机制层
- **对照源码**：`/Users/stringzhao/workspace/claude-code/src/utils/telemetry/` 9 文件 ~110KB + `src/hooks/toolPermission/permissionLogging.ts:178-235` (fan-out 教科书范本) + `src/utils/telemetry/events.ts:13-19,49,56-61` (privacy + cardinality 字面量证据)。**遵守 CLAUDE.md 0 假设原则**：所有 file:line 实际 Read 验证，不凭命名推断
- **下一个**：**Lecture 08** —— Streaming（`query.ts:613` SSE 增量 tool_use parsing）或 MCP 协议（`mcpServers` 配置 + tools/resources/prompts 三类 capability）。两者都可通过 hook 接入 obs，自动获得三 sink 可观测性

## 关键对照表

| 维度 | v1-v5 | v6 (hook) | v7 (obs) |
|---|---|---|---|
| Cross-cutting 形态 | sub-system 单点钩子 | **通用注入机制** | **典型消费实例** |
| 失败容忍 | 各 sub-system 自己处理 | Promise.allSettled 隔离 | sink 内部 try-catch + 永不阻断 |
| 行数 | 88-330 | 434 | 545 |
| v5/v6/v7 差异 | — | v5 不动 + §8/§9 / §5 §7 内 emit | **v6 不动** + §11/§12 / §13 启动扩展 |
| 对应工业组件 | sub-systems 各自 | `src/utils/hooks/` 18 文件 | `src/utils/telemetry/` 9 文件 + `permissionLogging.ts` |

## 给学习者的提示

1. **先跑场景 D（privacy redact）**：两次跑同 prompt + env 切换对比 —— **教学黄金**。同一行代码（emit 调用），同一段 JSONL 文件，env 控制下用户秘密 vs 原文截然不同。**这是 redact 在机制层而非业务层的字面证据**
2. **再跑场景 C（cardinality 拒绝）**：故意 push 高基数字段到 metric counter，看 sink 内部白名单检查 + 立即拒绝。对照 logs sink（接受所有字段）vs metrics sink（白名单 only）—— **同一个 event，3 sink 处理方式不同**
3. **场景 B 长任务**：4 个 event × 多次触发 + 3 sink 全 emit + 进程结束时 dump metric counter + context map。**这是 production observability 的完整数据形态**
4. **想深挖 fan-out 单一入口必要性**：notes.md §2 要点 1 + excerpts.md §1 `permissionLogging.ts` 完整源码片段
5. **想做扩展练习**：(a) 加第 4 形态 sink（如 Sentry exporter）到 `emitObservability` 内 —— 验证"新增 sink 改 1 处"；(b) 加 `HookFailure` 新 event（在 v6 emit 内 catch 块里），让 hook 失败也走 obs；(c) 把 cardinality 白名单扩展为 per-event 不同（PreToolUse 允许 `tool_name`，PreCompact 允许 `compact_type`）

## CLAUDE.md 0 假设原则的实战收益

Task 07 严格执行 0 假设原则，避免了 task 05 apiMicrocompact 凭命名猜错的反例：

1. **`events.ts` 全文 75 行直接 Read**：line 13-19 `redactIfDisabled` + `<REDACTED>` 字面量；line 49 `prompt.id only events` 注释；line 56-58 `filesystem paths too high-cardinality`。三个字面量证据，不是估算
2. **`permissionLogging.ts` 完整 239 行验证 fan-out 4 sink**：line 178-235 single function with 4 sink calls，注释字面量 *"Single entry point for all permission decision logging"*。**这条注释直接驱动 v7 §12 设计**
3. **`instrumentation.ts:1-30` 三模型 SDK import 字面证据**：`sdk-logs` + `sdk-metrics` + `sdk-trace-base` 同时 import —— Lecture 07 抽象的"三形态并存"不是猜测，是工业字面事实
4. **`OTEL_LOG_USER_PROMPTS` env 字面量 + `<REDACTED>` 字符串字面量**：v7 致敬同字面量，避免发明新的命名习惯
