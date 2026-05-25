# Task 06：v6 mini hook engine —— cross-cutting 旁路广播

> v5 把 compact 做成独立 sub-system + 单点钩子。这是对的，但 production 不只 compact 这一个 cross-cutting concern —— audit / observability / 自定义 lint / 通知 / 第三方 plugin 等都需要"在 critical path 关键点注入旁路行为"。本任务把 Lecture 06 抽象的 hook 系统设计 + Socratic 07 内化的 4 条要点（hook ≠ sub-system / 两者叠加 / 27 events / 3 种 handler 形态），落到 434 行 v6 代码 + 4 份真实 run-log（含失败 hook 不阻断核心实测），对照 claude-code `src/utils/hooks/` 子系统验证每一条。看完你应该能说清：(1) 为什么 permission/compact 是 sub-system 而 audit 是 hook；(2) `Promise.allSettled` 在 hook 失败隔离中的具体作用；(3) v5 `maybeCompact` 入口 vs v6 `PreCompact/PostCompact` event 的"叠加不替代"关系；(4) 简化 SSRF guard 与工业 DNS lookup 防护的差距。

## 是什么

v5 的 `maybeCompact` 钩子证明了 cross-cutting concern 可以与 critical path 解耦。但它是**硬编码的单一钩子**，加新的 cross-cutting concern（audit / metrics / 第三方 lint hook）需要继续在 dispatch / runRounds / maybeCompact 内部加调用 —— 不可扩展。

v6 把这种"内部硬钩"通用化为**统一 hook 系统**：

- **HookRegistry**（§8）—— Map<event, handler[]> 注册中心
- **emit point**（§5 §7 内部）—— `await hooks.emit(event, ctx).catch(() => [])` 一行加在 critical path 关键位置
- **3 种 handler 形态**（§9）—— Function / Prompt / Http 各自语义不同
- **Promise.allSettled 失败隔离**（§8）—— 单 handler 失败永不影响其他 + 永不阻断核心

**核心约束**：不修改 v5 任何核心逻辑。v6 在 v5 基础上加 §8 §9 两段新 + 在 §5 dispatch / §7 maybeCompact 内部加 emit 调用点。这是 Socratic 07 Q2 内化的 "hook 是叠加不是替代" 的代码物理体现。

## §1. Sub-system vs hook 边界

四类 cross-cutting concern 应该走哪个机制？

| 关注点 | 失败的确定性需求 | 调用方对结果的依赖 | 扩展频率 | 划分 |
|---|---|---|---|---|
| permission gate | 必须确定性拒绝 | 紧耦合 dispatch | 低 | **sub-system** |
| context compact | 必须熔断 / 重试 | 紧耦合 runRounds | 低 | **sub-system** |
| audit log | 失败只影响观测 | 解耦 | 高 | **hook** |
| 自定义 lint | 失败 ≠ 阻断 commit | 解耦 | 高 | **hook** |

**判断准则**：失败必须导致核心行为改变 → sub-system；失败只影响"旁路观察" → hook。错用 hook 替代 sub-system 会引入不可靠的安全 / 数据完整性问题。

完整准则与错误划分例子见 [notes.md §5](./notes.md)。

## §2. 27 个工业 HOOK_EVENTS

claude-code `entrypoints/sdk/coreTypes.ts:25-53` 字面量：

```ts
export const HOOK_EVENTS = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'Notification', 'UserPromptSubmit',
  'SessionStart', 'SessionEnd', 'Stop', 'StopFailure',
  'SubagentStart', 'SubagentStop',
  'PreCompact', 'PostCompact',
  'PermissionRequest', 'PermissionDenied',
  'Setup', 'TeammateIdle', 'TaskCreated', 'TaskCompleted',
  'Elicitation', 'ElicitationResult',
  'ConfigChange', 'WorktreeCreate', 'WorktreeRemove',
  'InstructionsLoaded', 'CwdChanged', 'FileChanged',
] as const
```

精确 27 项。覆盖：工具周期 / 用户交互 / 会话生命周期 / subagent / **compact** / permission / task / 配置文件等 7 大类。v6 选 4 项（PreToolUse / PostToolUse / PreCompact / PostCompact）作为教学子集。

## §3. HookRegistry 数据结构

@include(./agent-v6-hook-engine.ts, section=8)

**关键**：

- `private map = new Map<HookEvent, HookHandler[]>()` —— 按 event 分类的 handler 列表
- `register(event, handler)` —— 简单 push 到对应 event 的列表
- `emit(event, ctx)` —— **核心是 `Promise.allSettled(handlers.map(runHandler))`**：单 handler 失败不影响其他 / emit 调用方永不 throw

对照工业 `AsyncHookRegistry.ts:28` 的 `Map<string, PendingAsyncHook>` —— 工业版用 processId 为 key（因为 hook 是异步 shell command 形态，每次 emit 启动独立 process），v6 简化为 in-process 直跑。**接口语义一致**：注册 + 触发 + 失败隔离三层结构。

完整源码对照见 [excerpts.md §2 §3](./excerpts.md)。

## §4. 3 种 Handler 形态

@include(./agent-v6-hook-engine.ts, section=9)

**对照工业版**：

| v6 | 工业版 | 共同点 |
|---|---|---|
| **Function** | (v6 新增最简形态) | in-process JS function / 无 LLM 成本 / 最快 |
| **Prompt** | `execPromptHook.ts:21-30` | 单轮 LLM JSON / 30s timeout / 强制 `{ok, reason}` 返回 |
| **Http** | `execHttpHook.ts:123-150` | POST + SSRF guard / 默认 10min |
| (v6 未实现) | `execAgentHook.ts:36-50` | 多轮 LLM + 有 tools 访问权限 / 60s timeout |

**关键设计**：

- `runHandler` 用 `Promise.race([dispatchHandler(...), timeoutPromise])` —— 每 handler 30s 默认 timeout，超时返回 `non_blocking_error`
- `dispatchHandler` 是 multimethod：按 `h.kind` 分发到 function / prompt / http 三个分支
- **Prompt handler 复用 v5 的 callModel** —— 同一个 deepseek endpoint，但传**空 tools 数组 + 强制 JSON 返回 system prompt** —— 双层禁工具保险（同 v5 fullCompact 的 `NO_TOOLS_PREAMBLE` 设计模式）
- **Http handler 简化 SSRF guard** —— 字面量正则前缀检查（`SSRF_BLOCKED = /^(localhost|127\.|10\.|169\.254\.|...)/`）。**production 必须像工业 ssrfGuard.ts:216-283 那样在 DNS lookup 时校验**，防 DNS rebinding 攻击（hostname 第一次解析合法 IP，第二次解析内网 IP）

完整源码对照见 [excerpts.md §4 §5 §6 §7](./excerpts.md)。

## §5. PreToolUse / PostToolUse emit 位置（§5 dispatch wrapper）

@include(./agent-v6-hook-engine.ts, section=5)

**关键设计：dispatch wrapper 模式**：

```ts
async function dispatch(...) {
  await hooks.emit("PreToolUse", { tool, input, mode, role }).catch(() => []);
  const result = await dispatchInner(...);  // ← v5 原 dispatch 逻辑
  await hooks.emit("PostToolUse", { tool, input, result, mode, role }).catch(() => []);
  return result;
}
```

**3 个细节**：

1. **wrapper 提取**：v5 单一 dispatch → v6 dispatch + dispatchInner。wrapper 让 emit 调用点显式可见
2. **`.catch(() => [])` 双重保险**：emit 内部已用 Promise.allSettled 不会 reject，但加这层让调用方代码**显式表达 "永不被 hook 影响" 的意图**
3. **emit 是 fire-and-forget**：dispatch 不消费 emit 返回值（只丢弃），核心 dispatch 决策完全不依赖 hook 结果

对照工业 `hooks.ts:3410-3477` `executePreToolHooks` / `executePostToolHooks` —— async generator，调用方 `yield*` 取结果但可以选择丢弃。**同精神**。详见 [excerpts.md §8](./excerpts.md)。

## §6. PreCompact / PostCompact emit 位置（§7 maybeCompact 内部）

@include(./agent-v6-hook-engine.ts, section=7)

**注意 emit 调用点位置**：

```ts
if (rounds.length > MAX_ROUNDS_BEFORE_FULL_COMPACT) {
  await hooks.emit("PreCompact", { role, rounds, bytes }).catch(() => []);
  const result = await fullCompact(messages, role, system);  // ← sub-system 入口（compact 真发生）
  await hooks.emit("PostCompact", { role, before, after, rounds }).catch(() => []);
}
```

**Socratic 07 Q2 设计悬念的解答**：v5 notes.md §7.2 写"runRounds 加 hook 链" 看起来好像要把 maybeCompact **替换**为 hook。但 v6 实证：**maybeCompact 不动，在它内部 emit 标准 hook event**。

- `maybeCompact` 是 **sub-system 入口** — compact 真发生地，失败必须熔断 / 重试
- `PreCompact` / `PostCompact` 是 **hook event** — 旁路广播，failed hook 不影响 compact

两者叠加：去掉 hook，compact 仍正常工作；去掉 maybeCompact，compact 完全不发生（hook 无能为力）。

## §7. 场景 A：no-hooks baseline（验证向下兼容）

User prompt：`请删除 /tmp/test.txt。`

启动：`--hooks=none`

@include(./run-log-no-hooks.txt, round=1)

@include(./run-log-no-hooks.txt, round=2)

**关键观察**：grep `HOOK event=` 返回 0 个。0 hook 注册时 emit 立刻返回（`handlers.length === 0 → return []`），**v6 行为完全等同 v5**。这验证了 hook 系统的"不打扰短任务"特性 —— 注册中心为空时 zero overhead。

## §8. 场景 B：PreToolUse + PostToolUse 触发

User prompt：`请依次读取 /tmp/a.txt /tmp/b.txt 这 2 个文件，每个读完用一句话总结。`

启动：`--hooks=tool` 注册 1 个 PreToolUse function handler + 1 个 PostToolUse function handler

@include(./run-log-pre-post-tool.txt, round=1)

注意 ROUND 1 model 调一次 read_file（tool_use），dispatch wrapper 触发：

- `[AUDIT] [HOOK event=PreToolUse handler=log-pre-tool kind=function outcome=success ok=true reason=pre tool=read_file input={"path":"/tmp/a.txt"}]`
- 然后 dispatchInner 跑 → `[AUDIT] role=interactive auto-allow ...`
- 然后 `[AUDIT] [HOOK event=PostToolUse handler=log-post-tool kind=function outcome=success ok=true reason=post tool=read_file is_error=false]`

**emit 顺序**：Pre 在 dispatchInner 之前；Post 在 dispatchInner 之后。这是 wrapper 模式的字面体现。

## §9. 场景 C：PreCompact + PostCompact 触发（长任务）

User prompt：`请依次读取 /tmp/a.txt /tmp/b.txt /tmp/c.txt /tmp/d.txt /tmp/e.txt 这 5 个文件...`

启动：`--hooks=all` 同时注册 4 个 hook（2 个 tool 周期 + 2 个 compact 周期）

@include(./run-log-pre-post-compact.txt, round=5)

ROUND 5 触发 compact：

- microCompact 先尝试（前几 round 累积）
- fullCompact 触发条件命中 → **`[AUDIT] [HOOK event=PreCompact ...]` fire**
- fullCompact 跑专用 LLM call 压缩 messages
- **`[AUDIT] [HOOK event=PostCompact ...]` fire**

这是 "sub-system 入口 + hook emit 叠加" 的完整链路实测。

@include(./run-log-pre-post-compact.txt, round=6)

ROUND 6 model 在压缩后的 messages 上继续干活，自然 end_turn —— **hook fired 不影响 compact 实际执行，也不影响 model 后续推理**。

## §10. 场景 D：故障 hook 不阻断核心（教学黄金）

User prompt：`请依次读取 /tmp/a.txt /tmp/b.txt 这 2 个文件，每个读完用一句话总结。`

启动：`--hooks=fail` 在 PreToolUse 上注册 5 个 handler：
- log-pre-tool（正常）
- throws-immediately（故意 `throw new Error("intentional hook failure")`）
- slow-loris（`setTimeout(5000)` 模拟挂起，handler timeout 300ms）
- still-running（正常，但前面有 peer 失败）
- log-post-tool（PostToolUse 正常）

@include(./run-log-failing-hook.txt, round=1)

ROUND 1 model 调 read_file，dispatch wrapper 触发：

```
[AUDIT] [HOOK event=PreToolUse handler=log-pre-tool kind=function outcome=success ...]
[AUDIT] [HOOK event=PreToolUse handler=still-running kind=function outcome=success reason=peer hooks failed but I still ran for tool=read_file]
[AUDIT] [HOOK event=PreToolUse handler=throws-immediately kind=function outcome=non_blocking_error error=intentional hook failure]
[AUDIT] [HOOK event=PreToolUse handler=slow-loris kind=function outcome=non_blocking_error error=timeout after 300ms]
[AUDIT] role=interactive auto-allow tool=read_file mode=bypassPermissions input=/tmp/a.txt
[AUDIT] [HOOK event=PostToolUse handler=log-post-tool kind=function outcome=success ...]
```

**5 行黄金证据**：

1. log-pre-tool ✅ success
2. still-running ✅ success（**且 reason 字段显式说："peer hooks failed but I still ran"**）
3. throws-immediately ❌ non_blocking_error（`error=intentional hook failure`）
4. slow-loris ❌ non_blocking_error（`error=timeout after 300ms`）
5. **核心 dispatch 完全不受影响** —— `auto-allow tool=read_file` 仍然执行

**Socratic 07 Q1 "hook 可失败 / sub-system 必须可靠" 的字面实证**：

- Promise.allSettled 隔离：单 handler 失败 → `status="rejected"` → outcome="non_blocking_error"，emit 自己永不 throw
- runHandler 内 Promise.race + 300ms timeout：挂起 5s 的 handler 被 300ms 拦截
- emit 调用方 `.catch(() => [])` 双重保险
- core dispatch 完整执行，ROUND 自然完成

完整失败容忍实测数据见 [notes.md §4](./notes.md)。

## §11. 4 条要点对照工业实现（小结）

- **要点 1 hook ≠ sub-system** ✅ 命中 — Promise.allSettled + .catch 双层保险（v6 §8 ↔ `AsyncHookRegistry.ts:144`）。run-log-failing-hook.txt 实测 4 个失败 + 8 个成功 + 核心 ROUND 完整完成
- **要点 2 叠加不替代** ✅ 命中 — v5 maybeCompact 不动 + v6 内部加 PreCompact/PostCompact emit（v6 §7 ↔ `hooks.ts:3410-3477` async generator）。run-log-pre-post-compact.txt 实测
- **要点 3 27 events** ✅ 命中（事实证据）— `coreTypes.ts:25-53` 字面量 27 项，v6 教学子集 4 项
- **要点 4 3 种 handler 形态** ✅ 命中 — v6 §9 Function / Prompt / Http ↔ 工业 execAgentHook / execHttpHook / execPromptHook（差异：v6 缺多轮 agent 形态、SSRF guard 简化为字面量正则）

完整对照见 [notes.md §2](./notes.md)。

## §12. Hook vs sub-system 边界判断准则（实战版）

判断该用 hook 还是 sub-system 的 3 个准则：

- **失败的确定性需求**：sub-system 失败必须有确定性后果；hook 失败 = "记录但 critical path 不在乎"
- **调用方对结果的依赖度**：sub-system 调用方需要 await + 用结果做决策；hook 调用方"emit 完就走"
- **扩展频率**：sub-system 扩展低频（年级别）；hook 扩展高频（user / plugin 注册）

**错误划分示例**：

| 场景 | 应该用 | 为什么 |
|---|---|---|
| permission gate | sub-system | 失败必须拒绝 + 紧耦合 dispatch |
| context compact | sub-system | 失败需要熔断 + 紧耦合 runRounds |
| audit log | hook | 失败只影响观测 + 解耦 + 高频 |
| 自定义 lint hook | hook | 失败 ≠ 阻断 + 解耦 + 高频 |

完整判定准则与错误划分例子见 [notes.md §5](./notes.md)。

## §13. 写回 v5 的扩展点 + 进入 Lecture 07 的钩子

3 处 v5 改进点：

1. **maybeCompact 已是完美 sub-system 入口**（v5 设计意外正确）—— v6 不需要改结构，只在内部加 emit
2. **dispatch 用 wrapper 模式**（dispatch + dispatchInner）—— 让 emit 调用点显式可见，便于未来加 around-style hook
3. **audit() 可以做成 hook 注册**（如 `hooks.register("PostToolUse", logToOTel)`）—— 让 audit 从"硬编码 console.error" 变成"标准 hook 之一"

**Lecture 07 入口**：Observability 维度自然延伸 —— audit / metrics / tracing 都是 hook 的典型应用场景。结构化的 PostToolUse / PostCompact event 可以输出到 OpenTelemetry / Sentry / 自定义日志聚合器。对照工业 `permissionLogging.ts:181-235` `logPermissionDecision` 多维度结构化事件（v5 已见 source / decision / waiting_ms 等字段），可以重构为 hook handler 形态。

完整改进建议见 [notes.md §6](./notes.md)。

## 下一步

回到 `learn-everything/topics/agent-harness-engineering/` 让课程验收这次交付。v6 把 cross-cutting concern 的注入机制完全通用化了，下一步 **Lecture 07 Observability**：把 audit / metrics / tracing 通过 PostToolUse / PostCompact 等 hook event 输出到结构化 telemetry pipeline，让 production harness 具备可观测性。
