# Task 08 Spec —— v8 Mini Streaming Agent

下发日期：2026-05-26
父 topic：agent-harness-engineering
前置 artifact：[`07-observability/`](../07-observability/)
对照源码：
- `/Users/stringzhao/workspace/claude-code/src/services/tools/StreamingToolExecutor.ts` (530 行，主体实现)
- `src/query.ts:96` (import) / `:563, :735, :914` (三处实例化)
- `src/services/compact/grouping.ts:29-31` (**"yield order, not concat order"** 字面证据)

---

## 任务定位

从 v7 的"回合制 dispatch（等 stop_reason → batch run tools → 下一轮）"升级到 v8 的"流式 dispatch（model 流式 yield tool_use → 立即并发执行）"。

**核心交付是一份可运行的 v8 mini streaming agent**：把 Lecture 08 抽象的"pipelining / yield order ≠ concat order / hook 必须立刻决定 / 协议 id 配对"，落到 ≤ 600 行代码 + 4 份真实 run-log + 教学叙事 lesson.md。

**关键约束**：不修改 v7 任何核心 sub-system（dispatch 内部 / role / compactor / hook engine / observability sink 都不动）。仅在 §5 dispatch 入口新增 streaming 模式分支，让"流式 enqueue"复用 v7 现有的 dispatch 内部逻辑。

这是 create 层第六次巩固：v7 把 observability 通用化 → v8 把 dispatch 入口从 batch 变 streaming，验证"v7 各 sub-system 在新维度下零修改可用"的架构红利。

---

## 4 条核心要点（Socratic 10 已确认）

1. **pipelining 是核心收益**（Q3）：model 输出与 tool 执行**时间重叠** = 串行总和变最慢路径。v1-v7 等 model 全部流完才 dispatch；v8 第 1 个 tool_use chunk yield 时就立刻并发执行。**对照 query.ts:563/735/914 三处实例化**说明 streaming 已是 production critical path。

2. **yield order ≠ concat order 的实战陷阱**（Q1）：完成顺序（post 行号）≠ 启动顺序 ≠ 执行耗时。下游不能用"位置"做任何推断，必须用 `tool_use_id` 配对 + `message.id` 做 round 边界。**对照 grouping.ts:29-31 字面证据**："StreamingToolExecutor interleaves tool_results between chunks live (yield order, not concat order — see query.ts:613). The id check correctly keeps `[tu_A(id=X), result_A, tu_B(id=X)]` in one group."

3. **hook 必须立刻决定**（Q2 收紧）：streaming 下 hook handler 不能延迟到 stop_reason —— 那时 tool 已经跑完决定为时已晚。Promise.allSettled 语义：**并发启动 + 等所有 settle + handler 互不感知彼此状态**。v6 hook 系统的 Promise.allSettled 并发触发不是 bug 而是 streaming 模式的必备前提。

4. **协议层 id 配对让顺序自由**（lecture 08 关键架构事实）：API 按 `tool_use_id` 配对 `tool_result`，不按出现顺序。这是 streaming 能存在的协议前提 —— 下游 normalizeMessages 可以按 yield 顺序写 messages 数组，API 重发时按 id 找 result 而非按位置。

---

## v8 必须实现的 streaming 升级

### Streaming Tool Executor

```ts
// 类比 claude-code/src/services/tools/StreamingToolExecutor.ts
class StreamingToolExecutor {
  private pending = new Map<string, Promise<any>>(); // tool_use_id → 执行 promise

  // 接收一个 tool_use chunk，立即 dispatch（不等 stop_reason）
  enqueue(toolUseId: string, name: string, input: any, role: string, mode: string): void {
    const p = dispatch(name, input, role, mode); // 复用 v7 §5 dispatch（不动）
    this.pending.set(toolUseId, p);
  }

  // 异步收集所有结果（yield order，调用方按 id 配对）
  async *yieldResults(): AsyncGenerator<{ toolUseId: string; result: any }> {
    const entries = Array.from(this.pending.entries());
    const promises = entries.map(async ([id, p]) => ({ toolUseId: id, result: await p }));
    // Promise.race 反复挑出最先完成的（实现真正的 yield 顺序）
    while (promises.length > 0) {
      const winner = await Promise.race(promises.map((p, i) => p.then(r => ({ r, i }))));
      yield winner.r;
      promises.splice(winner.i, 1);
    }
  }
}
```

### Model Streaming Adapter

由于真实 SSE 需要 fetch + ReadableStream + EventSource parsing 较重，v8 用**模拟 streaming**：
- 用 `async function*` 包装 `callModel` 返回值
- 把一次性的 model response 拆成多个 chunk（thinking → tool_use_1 → tool_use_2 → ... → stop_reason）按 setTimeout 延迟 yield
- 这样能验证流水线行为而不引入真实 SSE 解析复杂度

```ts
async function* callModelStreaming(messages, system, tools): AsyncGenerator<Chunk> {
  const response = await callModel(messages, system, tools); // 复用 v7（不动）
  // 模拟逐块流出：thinking → 第 1 个 tool_use（延迟 100ms）→ 第 2 个（延迟 200ms）→ stop
  for (const block of response.content) {
    yield { type: block.type, ...block };
    await new Promise(r => setTimeout(r, 100)); // 模拟流间隔
  }
  yield { type: "stop", stop_reason: response.stop_reason };
}
```

### Streaming dispatch loop

```ts
async function runStreamingRound(messages, system, tools, role, mode) {
  const executor = new StreamingToolExecutor();
  const collectedAssistant: any[] = [];

  // 流式接收 model chunk + 流式 enqueue tool_use
  for await (const chunk of callModelStreaming(messages, system, tools)) {
    if (chunk.type === "tool_use") {
      executor.enqueue(chunk.id, chunk.name, chunk.input, role, mode);
      collectedAssistant.push(chunk);
    } else if (chunk.type === "thinking" || chunk.type === "text") {
      collectedAssistant.push(chunk);
    } else if (chunk.type === "stop") {
      // model 流完了，但 tool 可能还在跑
      break;
    }
  }

  // 收集所有 tool 结果（按完成顺序 yield —— interleaves）
  const toolResults: any[] = [];
  for await (const { toolUseId, result } of executor.yieldResults()) {
    toolResults.push({ type: "tool_result", tool_use_id: toolUseId, content: result });
  }

  return { assistant: collectedAssistant, toolResults };
}
```

### 配置开关

`agent-v8-streaming.ts` 启动时支持 `--stream` 标志：
- `--stream=false`（默认）：跑 v7 batch 模式（向下兼容）
- `--stream=true`：跑 v8 streaming 模式

这样能在同一份代码里做 batch vs streaming 对比测试。

---

## 步骤

### 步骤 0：源码定位（10 分钟，CLAUDE.md 0 假设原则）

```bash
wc -l /Users/stringzhao/workspace/claude-code/src/services/tools/StreamingToolExecutor.ts  # 530
sed -n '40,80p' /Users/stringzhao/workspace/claude-code/src/services/tools/StreamingToolExecutor.ts  # class StreamingToolExecutor 起始
sed -n '25,32p' /Users/stringzhao/workspace/claude-code/src/services/compact/grouping.ts  # yield order 字面证据
grep -n "StreamingToolExecutor" /Users/stringzhao/workspace/claude-code/src/query.ts  # 三处实例化
```

把"读懂的字面证据 + v8 简化版差异"写在 notes.md 第 1 节。

### 步骤 1：写 v8 代码

按 §"v8 代码切段约束"组织。

### 步骤 2：跑 4 份真实 run-log

按 §"Run-log 约束"。

### 步骤 3：写 notes.md（6 节深度分析）

每个核心要点产出：
- 工业源码引用（file:line + 字面量 quote）
- v8 对应代码段
- 推理链 + v8 简化 vs 工业版差异
- 第 5 节"batch vs streaming wallclock 量化"：4 份 run-log 对比数据
- 第 6 节"v7 sub-system 零修改可用证明"：列出 v7 §1-13 哪些段落字面不动、哪些段落（仅 §5 dispatch 入口扩展）有改动

### 步骤 4：写 lesson.md（agent-notebook 入口）

按 §"agent-notebook 高质量消费"，14 段叙事。

---

## v8 代码切段约束

`agent-v8-streaming.ts` 在 v7 基础上新增 §14 (StreamingToolExecutor) + §15 (callModelStreaming + runStreamingRound)。建议 15 段（v7 是 13 段，新增 2 段）：

1-13. v7 全继承（**字面不动**）—— 仅 §5 dispatch 内部不动，但 §10 runLoop 增加 streaming 模式分支
14. `14. StreamingToolExecutor: async generator + Promise.race yield 顺序 + pending Map<id, Promise>`
15. `15. callModelStreaming + runStreamingRound + --stream 配置开关`

§10 runLoop 内部增加 `if (process.argv.includes("--stream=true")) await runStreamingRound(...) else 走 v7 原路径` —— **是 v7 §10 runLoop 的唯一扩展点**。

---

## Run-log 约束

至少 **4 份真实运行日志**：

| 文件 | 场景 |
|---|---|
| `run-log-no-stream-baseline.txt` | `--stream=false` baseline —— 与 v7 行为一致，证明向下兼容 |
| `run-log-stream-5-tools.txt` | `--stream=true` + prompt 触发 5 个 read_file 并发 —— JSONL 显示 PreToolUse/PostToolUse 顺序不严格相邻 |
| `run-log-yield-order-proof.txt` | 同任务 batch vs streaming 跑两次 —— logs JSONL 对比，证明 yield order ≠ concat order |
| `run-log-batch-vs-stream-wallclock.txt` | 同 prompt 两次跑 —— batch 模式 wallclock vs streaming 模式 wallclock，量化 pipelining 收益（应 ≥ 1.5x 提速） |

每份 run-log:
- `========== ROUND N stop_reason=X ==========` 切片
- `========== FINAL MESSAGES ==========` 段
- `[STREAM tool_use_id=X enqueued at t=N ms]` audit 行
- `[STREAM tool_use_id=X completed at t=M ms duration=K ms]` audit 行
- streaming 场景额外 dump `========== WALLCLOCK SUMMARY ==========` 含 total / model_streaming / tool_execution_overlap 三个数值

---

## agent-notebook 高质量消费（硬约束）

### lesson.md 14 段叙事

1. **开篇**（H1 + 段落）：从 v7 obs 的"4 event emit 时机分散"切入 —— streaming 让 emit 更分散
2. **回合制 vs 流水线总览**（H2 + 表格）：batch 串行总和 vs streaming 最慢路径
3. **pipelining 核心收益**（H2 + 段落）：model 输出 / tool 执行时间重叠
4. **StreamingToolExecutor 设计**：`@include(./agent-v8-streaming.ts, section=14)` + 解读
5. **callModelStreaming 模拟 SSE**：`@include(./agent-v8-streaming.ts, section=15)` + 解读
6. **yield order ≠ concat order**：focus 在 Promise.race 反复挑选最快完成的
7. **协议层 id 配对**：tool_use_id 让顺序自由 / message.id 做 round 边界（grouping.ts:25-31）
8. **v7 sub-system 零修改可用**：列举 v7 §1-13 哪些段落字面不动（dispatch / role / compactor / hook engine / obs）
9. **场景 A no-stream baseline**：`@include(./run-log-no-stream-baseline.txt, round=1)` 验证向下兼容
10. **场景 B stream 5 并发**：`@include(./run-log-stream-5-tools.txt, round=1)` + 顺序乱序证据
11. **场景 C yield order ≠ concat order**：`@include(./run-log-yield-order-proof.txt, round=1)` + 同任务两次对比
12. **场景 D wallclock 量化**：`@include(./run-log-batch-vs-stream-wallclock.txt, round=1)` + pipelining 收益数字
13. **4 条要点对照工业实现小结**
14. **写回 v7 改进意见 + 进入 Lecture 09 钩子**

### Markdown 子集

H1-H3 / 段落 / 无序列表 / `inline code` / `**bold**` / GFM 表格 / fenced code block。不能用 mermaid。

---

## 交付清单

| 文件 | 角色 |
|---|---|
| `agent-v8-streaming.ts` | **核心产出**：v8 实现，≤ 600 行，严格切 15 段 |
| `lesson.md` | **核心产出**：agent-notebook 入口，14 段叙事 |
| `run-log-no-stream-baseline.txt` | baseline |
| `run-log-stream-5-tools.txt` | 5 tool 并发流式 |
| `run-log-yield-order-proof.txt` | yield order ≠ concat order 强证 |
| `run-log-batch-vs-stream-wallclock.txt` | pipelining 收益量化 |
| `notes.md` | 6 节深度分析（≥ 1500 字）|
| `excerpts.md` | claude-code streaming 关键源码 6+ 段引用 |
| `README.md` | 三段式（学到了什么 / 怎么读这份归档 / 与其他组件的关系）|
| `spec.md` | 本文件 |

---

## 约束

- **必须真实运行**：4 份 run-log 都是 v8 真实跑出来的
- v7 全部代码字面量不动（§1-13 完全继承，仅 §10 runLoop 加 streaming 模式分支）
- `agent-v8-streaming.ts` ≤ 600 行
- StreamingToolExecutor 用 v6 `Promise.allSettled` 失败隔离 —— streaming tool 失败永不阻断核心 dispatch
- yield 顺序验证：run-log-yield-order-proof.txt 必须有 batch 顺序与 stream 顺序对比段
- wallclock 量化：streaming 模式 ≥ 1.5x batch 模式（5 tool 并发，每个 100ms 模拟延迟）
- callModelStreaming 用 `async function*` —— 不引入真实 SSE / EventSource / ReadableStream 解析
- v7 hook engine 必须能直接复用 —— PreToolUse / PostToolUse 在 streaming 模式下仍然触发，验证 hook 并发触发是天然能力

---

## 验收标准

1. v8 严格切 15 段（`grep -c "^// ----------"` = 15）
2. v7 §1-9, §11-13 字面量不变（diff agent-v7 agent-v8 §1-9 + §11-13 应该 0 差异，仅 §10 runLoop 加 streaming 分支）
3. 4 份 run-log 每份都有 ROUND + FINAL MESSAGES
4. `run-log-stream-5-tools.txt` 含 `[STREAM tool_use_id=` 字面量 ≥ 5 次（5 个 tool 各自的 enqueue + completed）
5. `run-log-stream-5-tools.txt` JSONL 顺序：PreToolUse 与 PostToolUse 不严格相邻（grep 行号验证）
6. `run-log-yield-order-proof.txt` 含 batch 顺序段 + stream 顺序段对比
7. `run-log-batch-vs-stream-wallclock.txt` 含 `WALLCLOCK SUMMARY` + batch wallclock + stream wallclock 数值
8. notes.md 4 条要点全部判决 + 论证（≥ 1500 字）
9. lesson.md 在 agent-notebook 打开后无红色错误块

---

## 完成后

- artifact_count: 7 → 8
- bloom_level 保持 `create`（第六次巩固完成）
- 更新 INDEX.md、写 journal accept 条
- 下一步：**Lecture 09** —— MCP 协议（`mcpServers` 配置 + tools/resources/prompts 三类 capability + 跨进程 stdio JSON-RPC），是 v4 multi-agent + v6 hook 的协议层延伸；或 Topic 整体进入 assemble 阶段（artifact_count 已 8，主题覆盖完整）

---

## 验证方法

- `wc -l artifacts/08-streaming/agent-v8-streaming.ts` ≤ 600
- `grep -c "^// ----------" artifacts/08-streaming/agent-v8-streaming.ts` = 15
- `ls artifacts/08-streaming/run-log-*.txt | wc -l` ≥ 4
- `grep -c "STREAM tool_use_id=" run-log-stream-5-tools.txt` ≥ 10（5 tool × enqueue + completed）
- `grep -c "WALLCLOCK SUMMARY" run-log-batch-vs-stream-wallclock.txt` ≥ 1
- `~/.bun/bin/bun run tools/agent-notebook/server.ts artifacts/08-streaming/` → 浏览器无红色错误块
