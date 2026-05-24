---
topic: 构建 AI Agent Harness（以 Claude Code 为参照系，从 0 到 1）
slug: agent-harness-engineering
status: active
stuck_count: 0
created_at: 2026-05-21T06:50:43+00:00
updated_at: 2026-05-25T05:00:00+00:00
bloom_level: create
artifact_count: 5
---

## 当前位置

bloom: create | 已覆盖: harness≠APIcall, agent loop 三角骨架, 观察→反馈→决策闭环, stop_reason 开关, 协议约束塑造行为, Tool 三件套(schema+executor+permission), production 双层 permission(harness gate 正交 ask tool), prompt injection 证伪 v1, is_error 字段下 model 自适应, bypassPermissions 5 条推测全部对照工业源码验证, permission mode = (tool×mode)→policy 矩阵, mode 矩阵物理承载 = 有序 if 链 + 早返回 + decisionReason 多维传出, dispatch+is_error 是判决+反馈两层职责, sandbox+permission 双层防御针对不同攻击向量, policy 是 runtime 行为/config 是行为参数化输入, hard-block 防 user 误开/与 sandbox 正交, 三层 handler 工厂模式分离 policy 决定 vs ask 执行, 工业 mode 不止 3 种(acceptEdits/auto/bypassPermissions/default/dontAsk/plan), multi-agent 必要性(单 agent context 爆/思考链断/责任模糊), coordinator/worker 二分, 三种 worker 形态(interactive/swarm/coordinator-as-subagent), swarm worker 无 ask_user 是物理约束(不是任务限制), policy 矩阵加 agent-role 维度变 (tool×mode×agent-role), multi-agent 把 context 问题从深度变广度, **swarm worker 的 ask 实际是路由到 leader (mailbox + permission callback)，不是 deny —— 工业实现 swarmWorkerHandler 不做 policy 转换，转发给 leader 决定 allow/reject，fallback 到 interactive handler**, **context 压力两种形态(深度爆/广度爆) 同源同解**, **token 经济本质 = messages 每轮重传线性成本 + prompt cache 失效**, **三种 compaction 策略(naive truncation/summarization/hybrid) 各有边界**, **lossy 不可避免 — messages 是 model 记忆**, **策略边界 = 成本收益匹配 (CLI 短任务用 naive，长任务用 hybrid)**, **compaction 是独立 sub-system 不是 agent 自身职责 (跟 permission 同源 cross-cutting concern)**

**Socratic 05 评分**：Q1（naive truncation 反而比 hybrid 更合适的场景）学生选"CLI 短任务"——抓住了 hybrid 隐藏成本（额外 model call + 延迟）；Q2（compaction 该由谁负责）学生选"harness 层独立 sub-system"——跟工业 `src/services/compact/` 完全一致。两题全对无需补丁，create 层稳定。

**Source-reading 自我修正记录**：在 lecture 04 后讨论中，学生质疑我"swarm 自动 deny"论断，主动用 Explore 读 `src/hooks/toolPermission/handlers/swarmWorkerHandler.ts` 验证。源码证据推翻了 instructor 论断 —— swarm 的 ask 实际是通过 mailbox 路由到 leader，由 leader 决定 allow/reject。学生 v4 makeRoutedAsk 设计反而跟工业 mailbox + permission callback **同精神**，是工业实现的 in-process 简化版。这次自我修正是 create 层"拒绝接受未经源码验证的论断"判断力的高光。

**Socratic 06 评分**（Lecture 05 细化版后置，task 05 入口前置）：Q1（压缩最小单元）选"整个 messages 数组原子压" ❌ → 收紧 "messages[i] vs messages[i+1] 协议捆绑" 场景题答对 ✅；Q2（压缩免疫集）选"所有 tool_result 不可压" ❌ → 收紧 "10KB 原文已被 round 7 model reasoning 融入" 场景题答对 ✅；Q3（压缩执行者）选"专用 compaction LLM call" ✅ 一次到位；Q4（multi-agent compact 原则）选"swarm 短不需要 compact" ❌ → 收紧 "30 轮 + 80K tokens 长任务 swarm" 场景题答对 ✅。三错共性：协议约束忽略 + 应该有等同于原文必留 + 任务驱动而非架构驱动 —— 收紧场景题逼出三层盲区。补丁要点：create 层"看具体场景验证抽象"判断力进一步强化。

## 下一步建议

**Task 05 验收**：v5 context compactor 全套交付（330 行 / 10 段 / 严格不动 v4 dispatch / 4 份 run-log 含 micro+full+swarm-internal 实测）+ notes.md 20KB 8 节 + excerpts.md 7 段源码 + lesson.md 17KB 13 段（agent-notebook 28 blocks 全命中）+ context 隔离实测强证（coordinator FINAL 段 2078 chars 完全不含 COMPACTED SUMMARY / Old tool result content cleared / swarm-worker）。4 条要点全部 ✅ 命中工业实现。v5 第一版 fullCompact 因悬空 tool_result 被 API 报错 → 修复加 firstValid 跳过逻辑，这条 bug 与修复本身已沉淀为要点 1 "round 原子单位" 的工程实证。bloom 保持 create（第三次巩固完成）。

## 下一步建议

预判: **Lecture 06** —— 维度方向二选一：(a) **Hook 系统通用化**（PreToolUse / PostToolUse / afterRound 钩子链，让 permission / compact / audit / observability 等所有 cross-cutting concerns 走同一机制 —— v5 maybeCompact 钩子是 hook 系统的第一种实例化，自然延伸）；(b) **Observability**（OTel telemetry + 结构化 audit log + decision storage，对照 permissionLogging.ts 已见多维度事件）。建议优先 (a)，因为 v5 已经留下了"runRounds 加 hook 链"的明显接口扩展点。| 备选: Task 06 直接做 mini hook engine 把 v5 的 maybeCompact 重构为 hook 注册形态，同时加 PreToolUse hook 演示 cross-cutting 抽象

## 卡点记录

（暂无卡点）
