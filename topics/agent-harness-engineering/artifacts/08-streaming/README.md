# v8 Mini Streaming Agent

## 它做什么

把 agent 的 tool dispatch 从"回合制"（等 model 说完再 batch 执行所有 tool）升级到"流水线"（model 边说边执行 tool）。用 async generator + Promise.race 实现流式 yield，验证 4 个核心概念：pipelining 收益、yield order ≠ concat order、hook 必须立刻决定、协议层 id 配对让顺序自由。

## 怎么用

```bash
cd artifacts/08-streaming/

# Batch 模式（v7 兼容）
bun run agent-v8-streaming.ts --stream=false --mode=bypassPermissions --hooks=obs \
  --prompt="读取 /tmp/a.txt"

# Streaming 模式（v8 新增）
bun run agent-v8-streaming.ts --stream=true --mode=bypassPermissions --hooks=obs \
  --prompt="同时读取 /tmp/a.txt /tmp/b.txt /tmp/c.txt /tmp/d.txt /tmp/e.txt（一个回合内并行调用）"

# 带模拟延迟（验证 yield order ≠ concat order）
bun run agent-v8-streaming.ts --stream=true --sim-delay --hooks=obs \
  --prompt="同时读取 /tmp/a.txt /tmp/b.txt /tmp/c.txt /tmp/d.txt /tmp/e.txt（一个回合内并行调用）"
```

配置文件 `.api-config.json` 包含 API 认证（DeepSeek 兼容 Anthropic 协议）。

## 与其他组件的关系

| 组件 | 关系 |
|------|------|
| [`../07-observability/`](../07-observability/) | v8 §1-13 完全继承 v7（dispatch/hook/obs 全部复用） |
| [`../06-hook-engine/`](../06-hook-engine/) | v8 streaming 下 PreToolUse/PostToolUse 仍然触发，验证 hook 并发触发是天然能力 |
| [`../05-context-compactor/`](../05-context-compactor/) | compact sub-system 在 streaming 模式下零修改可用（maybeCompact 在每轮末尾调用） |
| [`../04-coordinator-swarm/`](../04-coordinator-swarm/) | streaming 分支仅影响 runRounds 入口，swarm/coordinator 调用链不受影响 |

v8 是 create 层第六次巩固：v7 把 observability 通用化 → v8 把 dispatch 入口从 batch 变 streaming，验证"v7 各 sub-system 在新维度下零修改可用"的架构红利。

## 关键文件

- `agent-v8-streaming.ts`：593 行 / 15 段 / §14-15 是 streaming 新增
- `run-log-no-stream-baseline.txt`：batch baseline，与 v7 行为一致
- `run-log-stream-5-tools.txt`：5 tool 并发流式
- `run-log-yield-order-proof.txt`：模拟延迟证明完成顺序 ≠ enqueue 顺序
- `run-log-batch-vs-stream-wallclock.txt`：两种模式 wallclock 对比
- `notes.md`：6 节深度分析
- `excerpts.md`：7 段源码引用
- `lesson.md`：14 段教学叙事（agent-notebook 入口）
