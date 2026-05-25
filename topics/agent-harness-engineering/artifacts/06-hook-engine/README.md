# Task 06：v6 Mini Hook Engine

> 把 Lecture 06 抽象的 hook 系统设计 + Socratic 07 内化的 4 条要点（hook ≠ sub-system / 叠加不替代 / 27 events / 3 种 handler 形态），落到 434 行 v6 代码 + 4 份真实 run-log（含失败 hook 不阻断核心实测），对照 claude-code `src/utils/hooks/` 子系统验证每一条。**核心约束**：不修改 v5 任何核心逻辑，只新增 §8 §9 两段 + 在 §5 §7 内部加 emit 调用点。

## 学到了什么

### 1. Hook ≠ sub-system（失败容忍是字面机制）

permission/compact 是 sub-system —— **失败必须有确定性后果**（拒绝执行 / 熔断重试）。audit/lint/notification 是 hook —— **失败只影响旁路观测**。v6 用 **Promise.allSettled + `.catch(() => [])` 双层保险**实现失败隔离。`run-log-failing-hook.txt` 实测：4 个 PreToolUse handler 中 1 个抛错 + 1 个超时 + 2 个正常，核心 dispatch 完全不受影响，ROUND 自然完成。对照 claude-code `AsyncHookRegistry.ts:144` `await Promise.allSettled(hooks.map(...))` 同手法。

### 2. sub-system 入口 vs hook emit point —— 叠加不替代

v5 `maybeCompact` 是 sub-system 入口（compact 真发生地）；v6 在它内部加 `PreCompact` / `PostCompact` emit 作为 hook event。**不是替换是叠加**：去掉 hook，compact 仍正常工作；去掉 maybeCompact，compact 完全不发生（hook 无能为力）。这解答了 v5 notes.md §7.2 "runRounds 加 hook 链" 的设计悬念 —— maybeCompact 结构本身就对，hook 是在它内部 emit 而非取代它。对照 claude-code `hooks.ts:3410-3477` `executePreToolHooks`/`executePostToolHooks` 是 async generator，调用方 yield 但可选择丢弃。

### 3. 27 个工业 HOOK_EVENTS（事实证据）

claude-code `entrypoints/sdk/coreTypes.ts:25-53` 字面量精确 27 项：工具周期（PreToolUse/PostToolUse/PostToolUseFailure）/ 用户交互 / 会话生命周期 / subagent / **PreCompact PostCompact** / permission / task / 配置文件 7 大类。v6 教学子集 4 项（PreToolUse/PostToolUse/PreCompact/PostCompact）足够覆盖"工具周期 + 子系统周期"两个核心维度。

### 4. 3 种 handler 执行形态

v6 §9 完整实现 Function / Prompt / Http 三种 `HookHandler` union type + `dispatchHandler` 多态分发。对照工业版：

- **Function**（v6 新增最简形态 - in-process JS function，无 LLM 成本）
- **Prompt** ↔ `execPromptHook.ts:21-30`（单轮 LLM JSON + 强制 `{ok, reason}` 返回 + 30s timeout）
- **Http** ↔ `execHttpHook.ts:123-150`（POST + SSRF guard + 10min timeout）
- (v6 未实现) ↔ `execAgentHook.ts:36-50`（多轮 agent + tools 访问权限 + 60s）

**SSRF guard 简化**：v6 用字面量正则前缀检查（`SSRF_BLOCKED = /^(localhost|127\.|10\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|0\.0\.0\.0)/`），工业 `ssrfGuard.ts:216-283` 在 DNS lookup 时校验 IP（防 DNS rebinding 攻击）。**production 必须像工业版那样在 DNS 层防护**。

## 怎么读这份归档

**推荐入口：交互式 notebook 视图**

```bash
~/.bun/bin/bun run /Users/stringzhao/workspace/learn-everything/tools/agent-notebook/server.ts \
  /Users/stringzhao/workspace/learn-everything/topics/agent-harness-engineering/artifacts/06-hook-engine/
```

打开 http://localhost:3737/，按 `[← 上一步] [下一步 →]` 单步推进。**13 段叙事**从 sub-system vs hook 边界切入 → 27 events + v6 教学子集 → HookRegistry 数据结构 → 3 种 handler 形态 → 2 个 emit 位置（dispatch wrapper + maybeCompact 内）→ 4 个实战场景（no-hooks baseline / PreToolUse+PostToolUse / PreCompact+PostCompact / **故障 hook 不阻断核心**）→ 边界判断准则 → 写回 v5 改进意见。

**文件导览**：

- `lesson.md` — **首读路径**。agent-notebook 入口，13 段叙事
- `agent-v6-hook-engine.ts` — v6 实现（434 行，11 段切片）。在 v5 基础上加 §8 HookRegistry + §9 Handler 形态 + §5 dispatch wrapper + §7 maybeCompact 内部 emit 调用点。`--role=` `--mode=` `--hooks=` `--prompt=` 4 flag 控制（hooks: none/tool/compact/all/fail）
- `notes.md` — 7 节深度分析。源码定位（命名陷阱：src/hooks/ 是 React UI hooks 不是 agent harness）/ 4 条要点逐条对照 / emit point 三层架构图 / **失败容忍实测数据** / hook vs sub-system 边界判断 3 准则 + 错误划分示例 / v5 改进意见 / 一句话总结
- `excerpts.md` — claude-code hook 系统 8 段源码引用（带 file:line）。备查文档
- `run-log-no-hooks.txt` — baseline，0 hook 注册
- `run-log-pre-post-tool.txt` — PreToolUse + PostToolUse 触发
- `run-log-pre-post-compact.txt` — PreCompact + PostCompact 触发（长任务 6 round + 3 COMPACT EVENT）
- `run-log-failing-hook.txt` — **教学黄金**：4 success + 4 non_blocking_error + 核心 ROUND 完整
- `spec.md` — Task 06 原始 spec

**手动跑（重现实验）**：

```bash
cd topics/agent-harness-engineering/artifacts/06-hook-engine

# 场景 A: no-hooks baseline（验证向下兼容）
~/.bun/bin/bun run agent-v6-hook-engine.ts --role=interactive --mode=bypassPermissions --hooks=none \
  --prompt='请删除 /tmp/test.txt。'

# 场景 B: PreToolUse + PostToolUse 触发
~/.bun/bin/bun run agent-v6-hook-engine.ts --role=interactive --mode=bypassPermissions --hooks=tool \
  --prompt='请依次读取 /tmp/a.txt /tmp/b.txt 这 2 个文件，每个读完用一句话总结。'

# 场景 C: 全 hook 注册 + 长任务触发 compact
~/.bun/bin/bun run agent-v6-hook-engine.ts --role=interactive --mode=bypassPermissions --hooks=all \
  --prompt='请依次读取 /tmp/a.txt /tmp/b.txt /tmp/c.txt /tmp/d.txt /tmp/e.txt 这 5 个文件...'

# 场景 D: 故障 hook 不阻断核心（教学黄金）
~/.bun/bin/bun run agent-v6-hook-engine.ts --role=interactive --mode=bypassPermissions --hooks=fail \
  --prompt='请依次读取 /tmp/a.txt /tmp/b.txt 这 2 个文件，每个读完用一句话总结。'
```

**前置**：`~/.claude-dev/settings.json` 含 deepseek endpoint（task 03 已配，沿用）。

## 与其他组件的关系（在课程中的位置）

- **依赖于**：[`01-minimal-agent-loop`](../01-minimal-agent-loop/) → [`02-permission-gate`](../02-permission-gate/) → [`03-mode-matrix-agent`](../03-mode-matrix-agent/) → [`04-coordinator-swarm`](../04-coordinator-swarm/) → [`05-context-compactor`](../05-context-compactor/)
- **本任务做了什么**：在 v5 基础上加 hook 系统作为 cross-cutting concern 注入机制。**不动 v5 dispatch / role / compact 任何核心逻辑**，只新增 §8 HookRegistry / §9 Handler 形态两段 + 在 §5 dispatch 用 wrapper 模式包 inner / §7 maybeCompact 内部加 PreCompact-PostCompact emit。新增维度：27 events 字面量子集 4 项 / 3 种 handler 形态 / Promise.allSettled 失败隔离 / 简化 SSRF guard
- **对照源码**：`/Users/stringzhao/workspace/claude-code/src/utils/hooks/` 18 文件 + `src/utils/hooks.ts` 5022 行 + `src/types/hooks.ts` 290 行 + `src/entrypoints/sdk/coreTypes.ts:25-53` HOOK_EVENTS 字面量。**遵守 CLAUDE.md 0 假设原则**：所有 file:line 都是实际 grep/Read 验证过的，不凭命名推断（task 05 apiMicrocompact 反例已警示）
- **下一个**：**Lecture 07** Observability —— audit / metrics / tracing 都是 hook 的典型应用场景。把结构化的 PostToolUse / PostCompact event 输出到 OpenTelemetry / Sentry / 自定义日志聚合器。对照工业 `permissionLogging.ts:181-235` 多维度结构化事件
- **后续衍生**：v6 暴露了 3 个失败模式（hook 抛错 / hook 超时 / handler 多形态错误），全部用 `outcome: "non_blocking_error"` 字段统一表达 —— 这是 Lecture 07 audit 数据模型的天然入口

## 关键对照表

| 维度 | v1 (ask) | v2 (gate) | v3 (mode) | v4 (multi) | v5 (compact) | v6 (hook) |
|---|---|---|---|---|---|---|
| Cross-cutting 注入点 | — | dispatch 单层 | + mode 矩阵 | + role 维度 | + maybeCompact 单点钩子 | **+ 通用 emit/registry/handler 三层** |
| 失败容忍策略 | injection 绕过 | is_error 反馈 | + audit 可观测 | + role 隔离 | + compact 熔断 | **+ Promise.allSettled 单 hook 失败不阻断** |
| 行数 | 94 | 88 | 196 | 284 | 330 | **434** |
| 对应工业组件 | AskUserQuestion | hasPermissionsToUseToolInner | + 完整 if 链 | + handlers + spawn_swarm | + compact/ 子系统 | **+ hooks/ 18 文件 9000+ 行** |

## 给学习者的提示

1. **先跑场景 D**：`bun run ... --hooks=fail` 是最具教学冲击的场景 —— 4 个 PreToolUse handler 故意 1 抛错 + 1 超时 + 2 正常 + 1 PostToolUse 正常，看 5 行 audit 同时出现且核心 dispatch 完全无影响。**Socratic 07 Q1 "hook 可失败 / sub-system 必须可靠" 的字面实证**
2. **再跑场景 C**：`--hooks=all --prompt='长任务...'` 看 PreCompact / PostCompact 在 fullCompact 前后各 fire 一次，验证 "sub-system 入口 + hook emit 叠加"
3. **想深挖 hook vs sub-system 边界**：notes.md §5 的 3 准则 + 错误划分示例（permission/compact 必须 sub-system；audit/lint/notification 必须 hook）
4. **想做扩展练习**：(a) 加第 4 种 handler 形态 `kind: "agent"`，对照工业 `execAgentHook.ts` 实现多轮 agent；(b) 加 `PostToolUseFailure` event（27 events 之一），在 dispatch 内部 result.is_error=true 时 emit；(c) 把 SSRF guard 升级为 DNS lookup 校验（对照 `ssrfGuard.ts:216-283`）

## 0 假设原则的实战收益

CLAUDE.md 新增的 0 假设原则在 v6 实战中带来了直接收益：

1. **命名陷阱避免**：`src/hooks/` 看起来像 agent harness hook 系统，**实际是 React UI custom hooks**。如果凭命名推断会立刻设计错（找错 emit point 位置）。state.md 已记录这个发现，v6 spec 从一开始就指向真实位置 `src/utils/hooks/`
2. **失败处理细节准确**：之前可能猜"hook 失败用 try-catch 包一下就行"，但工业实际用 **Promise.allSettled + runHandler 内 Promise.race + dispatchHandler 内 try-catch + 调用方 .catch** 四层防御。读源码才发现这种"精致"
3. **27 events 字面量精确**：状态 md 写 "27 种"是基于 `coreTypes.ts:25-53` 实际计数（v6 数过 line 26-52 = 27 个），不是估算
4. **3 种 handler timeout 各异**：execAgentHook 60s / execHttpHook 10min / execPromptHook 30s —— 这种细节凭直觉很难猜对，读源码才知道
