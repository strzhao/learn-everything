# Task 05 Spec —— v5 Context Compactor

下发日期：2026-05-25
父 topic：agent-harness-engineering
前置 artifact：[`04-coordinator-swarm/`](../04-coordinator-swarm/)
对照源码：`/Users/stringzhao/workspace/claude-code/src/services/compact/{compact.ts,autoCompact.ts,microCompact.ts,prompt.ts,grouping.ts,postCompactCleanup.ts}`

---

## 任务定位

从 v4 的 "messages 数组单调增长" 问题，扩展到 v5 的 "context 双层压缩"（深度 microCompact + 广度 fullCompact）。

**核心交付是一份可运行的 v5 mini compactor**：在 v4 coordinator/swarm 架构基础上加 compaction 子系统，把 Lecture 05 的 4 条工业设计要点（round 是原子单位 / 事实≠原文 / 专用 LLM call / context 隔离原则跨维度延伸）落到 ≤ 350 行代码 + 4 份真实 run-log（含 compact 触发 + 前后 messages 对照）+ 教学叙事 lesson.md。

这是 create 层第二次巩固：**v4 给出广度问题 → v5 用 compaction 解决双层 context 压力**。两次巩固后准备进入 Lecture 06（hooks / MCP / observability 等下一维度）。

---

## 4 条核心设计要点（Socratic 06 已确认）

1. **round 是压缩原子单位**：tool_use 与 tool_result 协议捆绑，必须以 (assistant + 该 assistant 所有 tool_use + 下一轮拼回的所有 tool_result) 三元组为单位，不能拆开
2. **事实不等于原文**：tool_result 的"内容"在 model 后续 reasoning text 中已经被融入，原文可以替换为 `[Old tool result content cleared]`（microCompact 模式）
3. **专用 compaction LLM call**：compact 不在主 loop 内 inline，是 harness 主动调一次专门的 LLM call（专用 prompt 禁调任何工具，要求只输出 `<analysis> + <summary>` 文本），获得后插回 messages
4. **context 隔离原则跨维度延伸**：swarm 内部 compact 与 coordinator compact 独立，互不感知。swarm 完成后 coordinator 看到的还是 summary string，与 swarm 是否 compact 无关

---

## v5 必须实现的 2 种 compaction

| 变体 | 触发 | 粒度 | 替换形态 | 对照工业 |
|---|---|---|---|---|
| `microCompact` | tool_result 累积 > 阈值 / 同一 tool 重复调用 | 单个 tool_result 内容 | `[Old tool result content cleared]` | `microCompact.ts:40-50,253-421` |
| `fullCompact` | messages round 数 > 阈值 / estimated token > 阈值 | 一段 API rounds（保留 system + 最近 N round + boundary 后） | 单条 user message + `isCompactSummary=true` 标记 | `compact.ts:387-624` + `prompt.ts:1-50` |

**触发链**：每次 round 结束时检查 → 先试 microCompact（粒度小、成本低） → 未释放足够 → 上 fullCompact（粒度大、成本高，调一次 compaction LLM）

**压缩免疫**（hard-block 思想在 compact 层的复现）：
- system reminders（v5 用 system prompt 替代，全 round 不压）
- 最近 1-2 个 round（保留 ongoing context）
- tool_use/tool_result 配对必须同压同留（round 原子性）

---

## 步骤

### 步骤 0：源码定位（5 分钟）

```bash
ls /Users/stringzhao/workspace/claude-code/src/services/compact/
# compact.ts (1705)  autoCompact.ts (351)  microCompact.ts (530)
# sessionMemoryCompact.ts (630)  apiMicrocompact.ts (153)  prompt.ts (374)
# grouping.ts (63)  postCompactCleanup.ts (77)  ...
```

**重点读**：
- `grouping.ts` 全文（63 行短）—— API round 分组逻辑
- `prompt.ts:1-50` —— LLM compaction prompt 的 `NO_TOOLS_PREAMBLE`（强制纯文本响应）
- `microCompact.ts:40-50` —— `COMPACTABLE_TOOLS` 白名单
- `postCompactCleanup.ts:1-77` —— 全文，看 compact 后清哪 6 类缓存

把"我读懂了什么 / 工业 4 个 variant 各处理什么粒度"写在 notes.md 第 1 节。

### 步骤 1：写 v5 代码

按 §"v5 代码切段约束"组织。

### 步骤 2：跑 4 份真实 run-log

按 §"Run-log 约束"。

### 步骤 3：写 notes.md（4 条要点对照 + 压缩前后实测数据）

每条要点产出：
- **工业源码引用**（file:line）
- **v5 对应代码段**
- **推理链**：v5 实现是否完整体现要点、与工业实现的差异、差异背后的工程权衡

第 5 节"压缩实测数据"：
- 跑一份长 session，记录每次 microCompact / fullCompact 触发的时机
- 表格对照：compact 前 messages 行数 / token 估算 / round 数 → compact 后对应数字
- 至少证明：(a) tool_result 替换确实释放了字节；(b) fullCompact 后最近 N round 仍完整保留；(c) swarm 内部 compact 不影响 coordinator messages

第 6 节"compact 自身的失败模式"：列举 ≥ 2 个（compaction LLM call 自己消耗光预算 / compact 后 model 行为漂移 / 触发抖动）+ v5 如何处理 / 不处理。

第 7 节"写回 v4 的扩展点"：≥ 2 处具体改动。

### 步骤 4：写 lesson.md（agent-notebook 入口）

按 §"agent-notebook 高质量消费"，14-16 段叙事。

---

## v5 代码切段约束

`agent-v5-context-compactor.ts` 在 v4 基础上扩展。按教学叙事顺序切段，每段一个 `// ---------- N. <段名> ----------` 标记。建议 10 段：

1. `1. Role + Mode + Policy + Compact 配置`（继承 v4 + 新增 compact 阈值常量）
2. `2. Hard-block + Mode 矩阵`（v4 继承）
3. `3. Tools schema by role`（v4 继承）
4. `4. Ask 转发通道 + audit + token 估算 helper`（v4 + 新增 estimateTokens）
5. `5. Dispatch + execute + runRounds`（v4 + 在 runRounds 内部加 compact 触发点）
6. `6. groupByRound（messages 按 API round 三元组分组）`（v5 新增，对照 claude-code grouping.ts）
7. `7. microCompact（替换老 tool_result 内容）`（v5 新增）
8. `8. fullCompact（专用 LLM call + 插回 summary）`（v5 新增）
9. `9. runSwarm / runCoordinator / runInteractive`（v4 继承）
10. `10. 配置 + callModel + 启动入口`

每段独立可读。

---

## Run-log 约束

至少 **4 份真实运行日志**：

| 文件 | 场景 |
|---|---|
| `run-log-no-compact.txt` | 短 session 不触发任何 compact —— baseline，证明 v5 向下兼容 v4 |
| `run-log-micro-compact-triggered.txt` | session 跑到 tool_result 累积超阈值，看 microCompact 触发：日志可见 `[COMPACT micro] cleared old tool_result for round X tool_use_id=...` |
| `run-log-full-compact-triggered.txt` | session 跑到 round 数超阈值，看 fullCompact 触发：日志可见 `[COMPACT full] compacting rounds 1..N`、专用 LLM call 输出 `<analysis> + <summary>` 段、messages 数组从 X 条压到 Y 条 |
| `run-log-swarm-internal-compact.txt` | coordinator 派一个长任务 swarm（多轮 read + thinking），swarm 内部触发 compact，但 coordinator messages 保持隔离不变（grep coordinator FINAL MESSAGES 不含 swarm compact 痕迹） |

每份 run-log：
- `========== ROUND N stop_reason=X ==========` 切片（≥ 2 个 ROUND）
- `========== FINAL MESSAGES ==========` 段
- compact 触发时多一个 `========== COMPACT EVENT round=N type=X before=B after=A ==========` 段，方便 lesson.md 切片对照

audit + compact event 行打到 stderr，带 role 标签。

---

## agent-notebook 高质量消费（硬约束）

打开 http://localhost:3737/?task=05-context-compactor 应该能从开篇看到结尾独立讲完整个 v5 设计。**不能假定读者看过 README / notes.md**。

### lesson.md 16 段叙事

1. **开篇**（H1 + 段落）：从 v4 的两种 context 压力切入 —— "v4 给出广度问题，v5 用 compaction 解决双层"
2. **Compact 三个核心设计维度**（H2 + 列表）：WHEN / WHAT / HOW
3. **Round 是原子单位**：`@include(./agent-v5-context-compactor.ts, section=6)` + 解读 tool_use/tool_result 协议捆绑
4. **MicroCompact 实现**：`@include(./agent-v5-context-compactor.ts, section=7)` + 解读 "事实已融入 reasoning text"
5. **FullCompact 实现**：`@include(./agent-v5-context-compactor.ts, section=8)` + 解读专用 LLM call + prompt 禁工具
6. **Compact 在 runRounds 的触发点**：`@include(./agent-v5-context-compactor.ts, section=5)`（如果 v4 的 runRounds 段加了几行）+ 解读阈值检查时机
7. **场景 A：no compact baseline**：`@include(./run-log-no-compact.txt, round=1)` + 验证 v5 向下兼容 v4
8. **场景 B：microCompact 触发**：`@include(./run-log-micro-compact-triggered.txt, round=N)` + COMPACT EVENT 段
9. **场景 B 续：前后对照**：`@include(./run-log-micro-compact-triggered.txt, section="COMPACT EVENT round=N type=micro before=B after=A")`
10. **场景 C：fullCompact 触发**：`@include(./run-log-full-compact-triggered.txt, round=N)`
11. **场景 C 续：LLM 压缩输出**：`@include(./run-log-full-compact-triggered.txt, section="COMPACT EVENT round=N type=full before=B after=A")`
12. **场景 D：swarm 内部 compact + 隔离**：`@include(./run-log-swarm-internal-compact.txt, round=1)` + 强调 coordinator messages 不含 swarm compact
13. **压缩前后数据对照**（H2 + 表格）：messages 行数 / token 估算 / 各场景压缩率
14. **Compact 自身失败模式**（H2 + 列表）
15. **4 条要点对照工业实现**（H2 + 列表）
16. **写回 v4 的扩展点**（H2 + 列表）

完整 messages dump 段（可选第 17 段）：`@include(./run-log-full-compact-triggered.txt, section="FINAL MESSAGES")`

### Markdown 子集

H1-H3 / 段落 / 无序列表 / `inline code` / `**bold**` / GFM 表格 / fenced code block（agent-notebook 实际支持 —— 见 v4 lesson.md 已用）。不能用 mermaid。

---

## 交付清单

| 文件 | 角色 |
|---|---|
| `agent-v5-context-compactor.ts` | **核心产出**：v5 实现，≤ 350 行，严格切 10 段 |
| `lesson.md` | **核心产出**：agent-notebook 入口，16 段叙事 |
| `run-log-no-compact.txt` | baseline，无触发 |
| `run-log-micro-compact-triggered.txt` | microCompact 实战 |
| `run-log-full-compact-triggered.txt` | fullCompact 实战 + 专用 LLM call 输出可见 |
| `run-log-swarm-internal-compact.txt` | swarm 内部 compact + coordinator 隔离 |
| `notes.md` | 7 节深度分析（源码定位 / 4 要点对照 / mode 矩阵延展 / 实测数据 / 失败模式 / v4 改进 / 一句话总结）≥ 1000 字 |
| `excerpts.md` | claude-code compact 子系统 6+ 段源码引用带 file:line |
| `README.md` | 三段式：学到了什么 / 怎么读这份归档 / 在课程中的位置 |
| `spec.md` | 本文件 |

---

## 约束

- **必须真实运行**：4 份 run-log 都是 v5 真实跑出来的，不能手写。compact 必须真触发（不能 mock 阈值）
- 所有 destructive 工具仍 mock
- `agent-v5-context-compactor.ts` ≤ 350 行
- 用 `fetch` 直打 Anthropic 协议，不用 SDK
- 沿用 `~/.claude-dev/settings.json` deepseek endpoint
- compaction LLM call 用同一个 endpoint + 同一个 model（专用 prompt 即可），不需要换 model
- `microCompact` 替换字面量必须是 `[Old tool result content cleared]`（向工业实现致敬）
- `fullCompact` 插回的 summary user message 必须带特殊 marker（如 content 含 `[COMPACTED SUMMARY]` 前缀），方便 grep 验证
- swarm compact 必须真实独立：grep coordinator FINAL MESSAGES 不应含任何 swarm compact 痕迹
- 阈值常量在代码顶部定义（如 `MAX_TOOL_RESULT_KEEP=2` / `MAX_ROUNDS_BEFORE_COMPACT=5`），可用 env var 或 flag 覆盖
- compact event 写到 stderr 的格式：`[COMPACT type=micro|full role=<role> round=<N> before=<beforeBytes> after=<afterBytes>]`

---

## 验收标准

1. v5 严格切 10 段（`grep -c "^// ----------"` = 10）
2. 4 份 run-log 每份都有 ROUND + FINAL MESSAGES 段；compact 场景多 COMPACT EVENT 段
3. lesson.md 在 agent-notebook 打开后能从头看到尾、无红色错误块
4. microCompact 后能在 messages JSON 里 grep 到 `[Old tool result content cleared]` 字面量
5. fullCompact 后能在 messages JSON 里 grep 到 `[COMPACTED SUMMARY]` 字面量，且 messages 数组长度有明显下降
6. swarm-internal-compact run-log 中：swarm FINAL MESSAGES 段有 compact 痕迹，coordinator FINAL MESSAGES 段**完全没有** compact 痕迹（grep `COMPACTED SUMMARY` / `Old tool result` 应为 0）
7. notes.md 4 条要点全部判决 + 论证（≥ 1000 字）
8. notes.md 第 5 节有压缩前后实测数据对照表（至少 3 行：micro / full / swarm-internal）

---

## 完成后

- artifact_count: 4 → 5
- bloom_level 保持 `create`（巩固阶段）
- 更新 INDEX.md、写 journal accept 条
- 下一步：**Lecture 06** —— 维度方向二选一：(a) Hook 系统（PreToolUse / PostToolUse 链路 + user 自定义规则，对照 `src/hooks/`）；(b) Observability（OTel telemetry + audit log 结构化 + decision storage，对照 `src/hooks/toolPermission/permissionLogging.ts` 已经看到的多维度事件）

---

## 验证方法

- `wc -l artifacts/05-context-compactor/agent-v5-context-compactor.ts` ≤ 350
- `grep -c "^// ----------" artifacts/05-context-compactor/agent-v5-context-compactor.ts` = 10
- `ls artifacts/05-context-compactor/run-log-*.txt | wc -l` ≥ 4
- 每份 run-log: `grep -c "^========== ROUND" *.txt` ≥ 2，且各有 `========== FINAL MESSAGES ==========`
- compact 场景: `grep -c "^========== COMPACT EVENT" run-log-micro-compact-triggered.txt run-log-full-compact-triggered.txt` ≥ 2
- microCompact: `grep -c "Old tool result content cleared" run-log-micro-compact-triggered.txt` ≥ 1
- fullCompact: `grep -c "COMPACTED SUMMARY" run-log-full-compact-triggered.txt` ≥ 1
- swarm 隔离: `awk '/^========== FINAL MESSAGES/,EOF' run-log-swarm-internal-compact.txt | grep -c "COMPACTED SUMMARY\|Old tool result"` = 0
- `~/.bun/bin/bun run tools/agent-notebook/server.ts artifacts/05-context-compactor/` → 浏览器无红色错误块
