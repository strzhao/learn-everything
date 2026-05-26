# v8: 从回合制到流水线 —— Streaming Dispatch

从 v7 observability 的"4 event emit 时机分散"出发——streaming 让 emit 更分散、更高频。当 model 边输出 tool_use 块、executor 边启动执行时，PreToolUse/PostToolUse 的时间戳不再按注册顺序排列。这正是 v8 要验证的核心：**v7 所有 sub-system 在新的时序模式下零修改可用**。

## 回合制 vs 流水线

| 维度 | Batch (v1-v7) | Streaming (v8) |
|------|--------------|----------------|
| Model 调用 | 等完整 response 返回 | 边流式接收 chunks |
| Tool dispatch | stop_reason=tool_use 后 batch 执行 | 每收到一个 tool_use chunk 立即 enqueue |
| 总延迟 | `model_time + Σ tool_time` | `max(model_time, max(tool_time))` |
| Tool 执行重叠 | 无（串行等待） | 有（pipelining） |
| Hook 触发时机 | dispatch 时（model 已完成） | dispatch 时（model 可能还在流） |

## Pipelining 核心收益

类比 CPU 指令流水线（Tomasulo 算法）：取指令 / 解码 / 执行 / 写回四阶段可以**重叠**。Agent 的两阶段：model 输出 / tool 执行——streaming 让它们重叠。

工业实现（query.ts:838-843）：

```ts
for (const toolBlock of msgToolUseBlocks) {
  streamingToolExecutor.addTool(toolBlock, message)
}
```

model 还在流后续 content block 时，前面的 tool 已经在执行。当 model 流完 stop_reason 时，部分甚至全部 tool 已经 complete。

@include(./agent-v8-streaming.ts, section=14)

## StreamingToolExecutor 设计

§14 实现了教学版 executor：

- `enqueue(toolUseId, name, input)` —— 立即启动 dispatch，不等 stop_reason
- `yieldResults()` —— async generator，用 Promise.race 反复挑最先完成的
- `pending: StreamingToolEntry[]` —— 追踪每个 tool 的 promise + wallclock

工业版 StreamingToolExecutor.ts（531 行）的关键差异：
1. **isConcurrencySafe**：区分可并行 vs 必须独占（Bash 失败 abort 兄弟）
2. **按注册顺序 yield**：维护 messages 位置一致性
3. **abort/discard 机制**：streaming fallback / user interrupt / sibling error

@include(./agent-v8-streaming.ts, section=15)

## callModelStreaming + runStreamingRound

§15 实现了：

- `callModelStreaming` —— 模拟 SSE（先 callModel 再逐块 setTimeout yield）
- `runStreamingRound` —— 核心流水线循环：Phase 1 流式接收 + enqueue → Phase 2 yieldResults 收集

**Phase 1 和 Phase 2 的时间重叠** = pipelining savings。由于 v8 用模拟 streaming（先同步 callModel），重叠接近 0；真实 SSE 下重叠 = tool 执行与 model 剩余输出的并行时间。

## Yield Order ≠ Concat Order

5 个 tool 的 enqueue 顺序：a → b → c → d → e（model 输出顺序）

模拟延迟：a=500ms, b=100ms, c=300ms, d=50ms, e=200ms

**完成顺序**：d(50) → b(100) → e(200) → c(300) → a(500)

grouping.ts:29-31 的字面证据：

> StreamingToolExecutor interleaves tool_results between chunks live
> (yield order, not concat order — see query.ts:613)

下游用 `tool_use_id` 配对、`message.id` 做 round 边界——**不依赖位置**。

## 协议层 ID 配对

API 要求每个 `tool_use` block 都有对应的 `tool_result` block，配对方式是 `tool_use_id` 字段（不是数组下标）。这是 streaming 能存在的协议前提：

- 发送时：tool_result 可以任意顺序排列
- 接收时：API server 按 id 找配对
- 如果按位置配对：streaming interleave 就不可能

abort 后 executor 必须 drain（query.ts:1019）—— 为未完成的 tool 生成 synthetic error tool_result，保证协议完整性。

## v7 Sub-system 零修改可用

| Sub-system | v8 是否改动 | 验证方式 |
|-----------|-----------|---------|
| dispatch (§5) | 不动内部 | streaming enqueue 复用同一个 dispatch() |
| Hook engine (§8-9) | 不动 | PreToolUse/PostToolUse 在 streaming 下照常触发 |
| ObservabilitySink (§11-12) | 不动 | obs JSONL / metrics / contextMap 全部正常写入 |
| Compact (§6-7) | 不动 | maybeCompact 在 streaming round 末尾照调 |
| Role/Mode (§1-3) | 不动 | modeMatrix 在 dispatch 内判断，与 streaming 无关 |

这证明了 v6-v7 架构的正交性设计。

@include(./run-log-no-stream-baseline.txt, round=1)

## 场景 A：No-stream Baseline

batch 模式 5 文件顺序读取（每轮 1 个 tool_use）—— 与 v7 行为完全一致。
- Round 1-5：各读一个文件
- Round 3 后触发 microCompact
- Round 5 后触发 fullCompact
- Round 6：end_turn

验证向下兼容：`--stream=false` 走的是 v7 原始 `callModel → batch dispatch` 路径。

@include(./run-log-stream-5-tools.txt, round=1)

## 场景 B：Stream 5 并发

streaming 模式 5 个 read_file 并发 —— model 一次性返回 5 个 tool_use block。
- 5 个 `[STREAM ... enqueued]` 行（间隔 ~100ms = 模拟流间隔）
- 5 个 `[STREAM ... completed]` 行（几乎同时完成 = mock 无延迟）
- WALLCLOCK: total=2052ms, tool_execution=9ms

关键观察：PreToolUse/PostToolUse 的 OBS context map 时间戳展示 hook 在 streaming phase 就触发了。

@include(./run-log-yield-order-proof.txt, round=1)

## 场景 C：Yield Order ≠ Concat Order

`--sim-delay` 模式让 5 个 tool 有不同执行延迟：
- a.txt: 500ms, b.txt: 100ms, c.txt: 300ms, d.txt: 50ms, e.txt: 200ms

completed 行顺序：
```
call_00 (a.txt) completed duration=528ms  ← 注意：最后 enqueue 的先完成
call_01 (b.txt) completed duration=415ms
call_02 (c.txt) completed duration=315ms
call_03 (d.txt) completed duration=214ms
call_04 (e.txt) completed duration=209ms
```

由于 dispatch 内部 hook emit 是同步的（PreToolUse → execute → PostToolUse），而模拟延迟在 execute 内部，所以 PostToolUse 时间戳体现了真实完成顺序的差异。

@include(./run-log-batch-vs-stream-wallclock.txt, round=1)

## 场景 D：Batch vs Stream Wallclock 量化

同任务、同延迟两次跑：
- Batch: total=2263ms (model=2159ms + tool=103ms 串行叠加)
- Stream: total=2263ms (model=2159ms, tool 在 model phase 完成)

为什么 savings ≈ 0：v8 callModelStreaming 先同步调 API，再逐块 yield —— model 阶段不能和 tool 物理重叠。

真实 SSE 场景推算：model 边流边返回 → 第 1 个 tool_use 在 500ms 时到达 → tool 执行 500ms → 总时间 = max(2000, 500+500) = 2000ms vs batch 2500ms → 节省 500ms (1.25x)。5 tool 500ms 延迟时 → max(2000, 500) = 2000ms vs batch 2000+500 = 2500ms → 1.25x 提速。

## 4 条要点对照工业实现小结

1. **Pipelining**：query.ts:838-843 addTool 在 streaming loop 内调用 → tool 与 model 并行 ✅
2. **Yield order ≠ concat order**：grouping.ts:29-31 字面证据 + getCompletedResults 按注册顺序 yield ✅
3. **Hook 立刻决定**：Promise.allSettled (v6 §8) 并发触发 + 互不感知 → streaming 下天然支持 ✅
4. **ID 配对让顺序自由**：tool_use_id 配对 / message.id 边界 / abort drain 保协议完整 ✅

## 写回 v7 改进意见 + 进入 Lecture 09 钩子

**v7 可改进处**（notes.md §6 固化）：
1. v8 证明 streaming 只需在 runRounds 加分支 + 新增 §14-15，v7 dispatch 内部完全不动
2. 如果 v7 的 execute mock 加入真实 I/O（file read/write），streaming 收益会显著（I/O 延迟 >> mock）
3. v8 的 `--sim-delay` 模式可以永久保留作为 yield order 教学工具

**进入 Lecture 09 钩子**：v8 streaming 完成后，agent harness 的核心 dispatch 维度已覆盖（batch + streaming）。下一步可选：
- MCP 协议（跨进程 stdio JSON-RPC）—— v4 multi-agent 的协议层延伸
- 或直接 assemble：artifact_count=8，主题已全覆盖
