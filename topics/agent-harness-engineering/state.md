---
topic: 构建 AI Agent Harness（以 Claude Code 为参照系，从 0 到 1）
slug: agent-harness-engineering
status: active
stuck_count: 0
created_at: 2026-05-21T06:50:43+00:00
updated_at: 2026-05-26T05:00:00+00:00
bloom_level: create
artifact_count: 7
---

## 当前位置

bloom: create | 已覆盖: harness≠APIcall, agent loop 三角骨架, 观察→反馈→决策闭环, stop_reason 开关, 协议约束塑造行为, Tool 三件套(schema+executor+permission), production 双层 permission(harness gate 正交 ask tool), prompt injection 证伪 v1, is_error 字段下 model 自适应, bypassPermissions 5 条推测全部对照工业源码验证, permission mode = (tool×mode)→policy 矩阵, mode 矩阵物理承载 = 有序 if 链 + 早返回 + decisionReason 多维传出, dispatch+is_error 是判决+反馈两层职责, sandbox+permission 双层防御针对不同攻击向量, policy 是 runtime 行为/config 是行为参数化输入, hard-block 防 user 误开/与 sandbox 正交, 三层 handler 工厂模式分离 policy 决定 vs ask 执行, 工业 mode 不止 3 种(acceptEdits/auto/bypassPermissions/default/dontAsk/plan), multi-agent 必要性(单 agent context 爆/思考链断/责任模糊), coordinator/worker 二分, 三种 worker 形态(interactive/swarm/coordinator-as-subagent), swarm worker 无 ask_user 是物理约束(不是任务限制), policy 矩阵加 agent-role 维度变 (tool×mode×agent-role), multi-agent 把 context 问题从深度变广度, **swarm worker 的 ask 实际是路由到 leader (mailbox + permission callback)，不是 deny —— 工业实现 swarmWorkerHandler 不做 policy 转换，转发给 leader 决定 allow/reject，fallback 到 interactive handler**, **context 压力两种形态(深度爆/广度爆) 同源同解**, **token 经济本质 = messages 每轮重传线性成本 + prompt cache 失效**, **三种 compaction 策略(naive truncation/summarization/hybrid) 各有边界**, **lossy 不可避免 — messages 是 model 记忆**, **策略边界 = 成本收益匹配 (CLI 短任务用 naive，长任务用 hybrid)**, **compaction 是独立 sub-system 不是 agent 自身职责 (跟 permission 同源 cross-cutting concern)**, **src/hooks/ 是 React UI custom hooks 不是 agent harness hook 系统 (命名陷阱)**, **真实 hook 系统位置 = src/types/hooks.ts + src/utils/hooks.ts (5022 行) + src/utils/hooks/ (18 文件 9000 行) + src/entrypoints/sdk/coreTypes.ts:25-53 HOOK_EVENTS 字面量**, **真实 hook 事件枚举 = 27 种 (工具周期/用户交互/会话生命周期/subagent 生命周期/PreCompact PostCompact/permission 周期/工作流外部) 不是 3-4 种简化版**, **hook 系统 = 事件总线 + callback 注册中心 (pub/sub) 不是 before/after 函数链硬编码**, **3 种 hook handler 执行形态 (execAgentHook 用 LLM agent / execHttpHook 用 HTTP endpoint + SSRF guard / execPromptHook 用 user prompt)**, **hook ≠ sub-system 替代品 — 核心 sub-system 是 in-process production-critical path (permission gate 安全/compact 决策可靠) hook 是 cross-cutting 旁路广播 (可失败/可超时/可不在线)**, **sub-system 入口 ≠ hook emit point — maybeCompact 是 sub-system 入口 PreCompact/PostCompact 是 sub-system 内部 emit 给 hook 系统的 event 两者叠加不替代**, **hook 系统让 cross-cutting concerns 在 harness 外部声明性注册 (settings.json/plugin/skill) — agent loop 代码不改就能扩展行为**, **真实 observability 子系统位置 = src/utils/telemetry/ 9 文件 ~110KB (instrumentation.ts 26K / sessionTracing.ts 27K / perfettoTracing.ts 29K / events.ts 75 行 / bigqueryExporter.ts 7.6K) + src/hooks/toolPermission/permissionLogging.ts 237 行 (fan-out 范本)**, **三种 telemetry 形态分工 = logs (诊断单次) / metrics (聚合趋势) / traces (跨服务延迟) — production 三种都要 不是哪个好的取舍**, **单一入口 + 多渠道 fan-out (permissionLogging.ts:178-235 logPermissionDecision 是教科书范本) = analytics event + OTel metric counter + in-process context map + OTel logs event 4 渠道**, **cardinality 控制 = events 高基数 OK / metrics 必须低基数 (不可数字符串如 path/prompt/sessionId 放 metric 必爆) / events.ts 注释明说 prompt.id 只加 events 不加 metrics**, **privacy by default = OTEL_LOG_USER_PROMPTS env 默认 false 用户原文 <REDACTED> (保护层在机制层不在调用层 — 跟 task 02 同源)**, **三形态 SLO 分工 = metrics 给宏观信号触发告警 / logs 给详细 attributes 定位 / context map 给同进程查询接口 (production SLO 强迫三层并存)**, **in-process context map (toolUseContext.toolDecisions Map) ≠ telemetry sink — 是给同进程下游代码 inspect 用的 = v6 audit log outcome 字段的 production 升级版**, **streaming = pipelining (model 输出与 tool 执行时间重叠 / v1-v7 串行总和 → streaming 最慢路径 / 类比 CPU Tomasulo 指令级并行)**, **yield order ≠ concat order (grouping.ts:29-30 字面证据 / 完成顺序 ≠ 启动顺序 ≠ 执行耗时 / 下游 compact 用 message.id 边界 + tool_use_id 配对 而非位置)**, **streaming 下 hook 必须立刻决定 (Promise.allSettled 并发启动 + 等全 settle + handler 互不感知 / 延迟到 stop_reason = tool 已跑完决定为时已晚)**, **协议层 id 配对让顺序自由 (API 按 tool_use_id 配对 tool_result / 顺序约束放松后下游必须用 id 而非位置 / 这是 streaming 能存在的协议前提)**

**Socratic 05 评分**：Q1（naive truncation 反而比 hybrid 更合适的场景）学生选"CLI 短任务"——抓住了 hybrid 隐藏成本（额外 model call + 延迟）；Q2（compaction 该由谁负责）学生选"harness 层独立 sub-system"——跟工业 `src/services/compact/` 完全一致。两题全对无需补丁，create 层稳定。

**Source-reading 自我修正记录**：在 lecture 04 后讨论中，学生质疑我"swarm 自动 deny"论断，主动用 Explore 读 `src/hooks/toolPermission/handlers/swarmWorkerHandler.ts` 验证。源码证据推翻了 instructor 论断 —— swarm 的 ask 实际是通过 mailbox 路由到 leader，由 leader 决定 allow/reject。学生 v4 makeRoutedAsk 设计反而跟工业 mailbox + permission callback **同精神**，是工业实现的 in-process 简化版。这次自我修正是 create 层"拒绝接受未经源码验证的论断"判断力的高光。

**Socratic 06 评分**（Lecture 05 细化版后置，task 05 入口前置）：Q1（压缩最小单元）选"整个 messages 数组原子压" ❌ → 收紧 "messages[i] vs messages[i+1] 协议捆绑" 场景题答对 ✅；Q2（压缩免疫集）选"所有 tool_result 不可压" ❌ → 收紧 "10KB 原文已被 round 7 model reasoning 融入" 场景题答对 ✅；Q3（压缩执行者）选"专用 compaction LLM call" ✅ 一次到位；Q4（multi-agent compact 原则）选"swarm 短不需要 compact" ❌ → 收紧 "30 轮 + 80K tokens 长任务 swarm" 场景题答对 ✅。三错共性：协议约束忽略 + 应该有等同于原文必留 + 任务驱动而非架构驱动 —— 收紧场景题逼出三层盲区。补丁要点：create 层"看具体场景验证抽象"判断力进一步强化。

## 下一步建议

**Task 05 验收**：v5 context compactor 全套交付（330 行 / 10 段 / 严格不动 v4 dispatch / 4 份 run-log 含 micro+full+swarm-internal 实测）+ notes.md 20KB 8 节 + excerpts.md 7 段源码 + lesson.md 17KB 13 段（agent-notebook 28 blocks 全命中）+ context 隔离实测强证（coordinator FINAL 段 2078 chars 完全不含 COMPACTED SUMMARY / Old tool result content cleared / swarm-worker）。4 条要点全部 ✅ 命中工业实现。v5 第一版 fullCompact 因悬空 tool_result 被 API 报错 → 修复加 firstValid 跳过逻辑，这条 bug 与修复本身已沉淀为要点 1 "round 原子单位" 的工程实证。bloom 保持 create（第三次巩固完成）。

## 下一步建议

**Socratic 07 评分**（Lecture 06 后置 / task 06 入口前置）：Q1（hook 替代 permission/compact 的隐患）选 "Hook handler 不可靠" ✅ —— 抓住核心 distinction：sub-system 是 in-process critical path 必须可控，hook 是 cross-cutting 旁路广播可以失败。跟 task 02 sandbox+permission 双层防御针对不同攻击向量同源。Q2（v5 maybeCompact 对应哪个 hook event）选 "两者都不是" ✅ —— 揭示 sub-system 入口 vs hook emit point 的精确层次：maybeCompact 是 sub-system 入口，PreCompact/PostCompact 是 sub-system 内部 emit 的 event，两者叠加不替代。也回答了 v5 notes.md §7.2 设计悬念：工业 runRounds 加 hook 链不是替代 maybeCompact 而是在其内部 emit 标准 event。两题全对无补丁，create 层稳固巩固。

**Task 06 验收**：v6 mini hook engine 全套交付（434 行 / 11 段 / v5 任何核心不动 / 4 份 run-log 含 failing-hook 实测核心未被阻断）+ notes.md 18.8KB 7 节 + excerpts.md 8 段源码引用 + lesson.md 15.2KB 13 段（agent-notebook 20 blocks 全命中）。4 条要点全部 ✅ 命中工业实现。**CLAUDE.md 0 假设原则严格执行**：所有 file:line 都来自 Explore agent 全扫源码后验证（HOOK_EVENTS 27 项 coreTypes.ts:25-53 / Promise.allSettled AsyncHookRegistry.ts:144 / 3 handler 60s/10min/30s timeout 各异 / ssrfGuard.ts:5-40 IP block 列表含云元数据 169.254.169.254）—— 与 task 05 apiMicrocompact 凭命名猜错反例完全不同。bloom 保持 create（第四次巩固完成）。

## 下一步建议

**Socratic 08 评分**（Lecture 07 后置 / task 07 入口前置）：Q1（哪个字段必须 events 不能 metrics）选 "tool_input.path 任意文件路径" ✅ —— 抓住"不可数高基数 = metric 死敌"工程直觉，正确排除 30 个工具名干扰项（30 个时序对 metric backend OK，关键是可预测上限）。Q2（SLO 30 秒定位 cause 的 telemetry 配置）选 "logs+metrics+context map 三层组合" ✅ —— 精准对应 SLO 三种隐含需求：metrics 触发告警 / logs 定位细节 / context map 同进程查询。lecture 07 三形态分工核心论断的具体应用。两题全对无补丁，create 层第五次巩固完成。

**Socratic 09 评分**（task 07 入口前置细化版）：4 题深入 v7 实现 4 个具体决策点。Q1（fan-out 单一入口必要性）选"语义一致性 + 字段标准化 / 分散导致 N 调用点不一致" ✅；Q2（5 字段 cardinality 精确划分）选"metric label = tool_name+role+decision；events only = prompt_id+file_path" ✅ 精确对应 events.ts:49,56-61 注释；Q3（privacy 实现层）选"机制层 1 处 vs 业务层 N 处 / **与 task 02 v1 同源失败模式**" ✅ 主动联想；Q4（context map vs sink）选"同步 inspect vs 异步导出 / 消费时机不同决定三者必须并存" ✅。**4 题全对一次通过 + 主动联想 task 02 同源** —— create 层第五次巩固稳。

**Task 07 验收**：v7 mini observability sub-system 全套交付（545 行 / 13 段 / v6 §1-10 字面量不动 / 4 份 run-log 含 cardinality 拒绝 + privacy redact 对比实测）+ notes.md 19KB 6 节 + excerpts.md 7 段源码（含 permissionLogging.ts:178-235 fan-out 教科书 + events.ts:13-19 redact 字面量 + :49 cardinality 注释）+ lesson.md 15.9KB 14 段（agent-notebook 14 blocks 全命中）。**修复关键 bug**：`Bun.file().writer()` truncate 改 `appendFileSync` —— sink 内部必须 append。**CLAUDE.md 0 假设原则深化执行**：所有字面量证据（OTEL_LOG_USER_PROMPTS / <REDACTED> / "Single entry point" / "filesystem paths too high-cardinality"）来自实际 Read 验证。4 条要点全部 ✅ 命中工业实现。bloom 保持 create（第五次巩固完成）。

**Socratic 10 评分**（Lecture 08 后置 / task 08 入口前置）：Q1（yield order ≠ concat order 实战陷阱）选"A 比 C 慢因为 Post{A} 在 Pre{C} 之后"❌ 推断错误 ✅（学生正确识别这是错误推断，完成顺序 ≠ 执行耗时，需 wallclock）；Q3（streaming 核心延迟收益）选"pipelining" ✅ 一次到位，正确排除 SSE multiplexing / async generator / 多 tool 并发三个干扰项；Q2（streaming 下 hook 假设）选"不能假设上一个 handler 已返回"❌ → 真正错的是 D"可以等到 stop_reason 后再决定"。盲区：把 hook 并发触发误判为危险 / 把延迟决策误判为可行。收紧 Q2 场景题"v6 Promise.allSettled 实际行为"选"3 handler 并发触发 + dispatch 等所有 settle + 互不感知" ✅ 一次到位 —— Promise.allSettled 语义内化。**create 层第六次巩固完成**。

## 下一步建议

预判: **Task 08** —— 在 v7 之上加 mini streaming agent（artifacts/08-streaming/）。**核心约束**：(1) 用 async generator (`async function*` + `for await...of`) 重构 v7 dispatch 入口，从"等 stop_reason 后 batch dispatch"变"流式 yield tool_use → 立即 dispatch"；(2) **保留 v7 §1-13 所有核心字面量不动**（Role / Mode / Compact / Hard-block / Tools schema / Ask 通道 / Hook engine / ObservabilitySink / emit fan-out），只在 §5 dispatch 入口新增 streaming 模式分支（`callModelStreaming` vs `callModelBatch`）；(3) **yield order vs concat order 实测**：跑 5 个 read_file 并发，证明 JSONL 中 PreToolUse/PostToolUse 顺序不严格相邻 / metric counter + context map 不受顺序影响（验证 socratic 10 Q1）；(4) **hook 并发触发实测**：3 个 PreToolUse handler 几乎同时触发，log Promise.allSettled wallclock 证明并发启动而非串行；(5) **延迟收益实测**：同任务 batch 模式 vs streaming 模式跑两次，对比 wallclock 总时间，量化 pipelining 收益；(6) 4 份 run-log：no-stream baseline / stream-5-tools / yield-order-proof / batch-vs-stream-wallclock。| 备选: Lecture 09 推进 MCP 协议（mcpServers + tools/resources/prompts 三类 capability + 跨进程 stdio JSON-RPC）

## 卡点记录

（暂无卡点）
