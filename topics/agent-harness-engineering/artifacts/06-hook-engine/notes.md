# notes.md —— Task 06 对照报告

> Lecture 06 + Socratic 07 抽象出的 4 条 hook 系统设计要点 ↔ v6 代码 ↔ claude-code `src/utils/hooks/` 子系统的对照报告。
>
> 4 条要点源自 Socratic 07 全对一次通过的内化：(1) hook 替代 sub-system 的隐患（sub-system in-process critical / hook 旁路可失败）；(2) sub-system 入口 vs hook emit point（叠加不替代）；(3) 27 个工业 HOOK_EVENTS；(4) 3 种 handler 执行形态。v6 的 434 行代码不是凭空设计 —— 它是这 4 条要点的代码物理化。
>
> **遵守 CLAUDE.md 0 假设原则**：所有 file:line 都来自实际源码 grep / Read，不凭命名推断。

---

## §1. 源码定位（步骤 0）

**结论**：claude-code hook 系统真实位置 = `src/types/hooks.ts` (290 行) + `src/utils/hooks.ts` (5022 行) + `src/utils/hooks/` (18 文件 9000+ 行) + `src/entrypoints/sdk/coreTypes.ts:25-53` HOOK_EVENTS 字面量。**这跟 state.md 描述完全一致 —— 0 假设地读源码验证通过**。

### 命名陷阱

`src/hooks/` 目录存在但**是 React UI custom hooks（不是 agent harness hook 系统）**。Lecture 06 时 state.md 已记录这个命名陷阱 —— **不读源码凭命名推断会立刻踩坑**。

### 关键文件清单

| 文件 | 大小 | 角色 |
|---|---|---|
| `src/utils/hooks.ts` | 5022 行 / 155.7K | 主入口 / `executePreToolHooks` `executePostToolHooks` 等顶层 emit 函数 |
| `src/utils/hooks/AsyncHookRegistry.ts` | 8.7K | 注册中心 Map<processId, PendingAsyncHook> + Promise.allSettled |
| `src/utils/hooks/execAgentHook.ts` | 12.2K | 多轮 LLM agent handler（60s timeout）|
| `src/utils/hooks/execHttpHook.ts` | 8.7K | HTTP POST handler（10min timeout + SSRF guard）|
| `src/utils/hooks/execPromptHook.ts` | 6.7K | 单轮 LLM query handler（30s timeout + JSON 返回）|
| `src/utils/hooks/ssrfGuard.ts` | 8.5K | DNS lookup 时 IP block 列表防护 |
| `src/utils/hooks/hooksConfigManager.ts` | 17.1K | hooks settings.json / plugin 配置加载 |
| `src/utils/hooks/sessionHooks.ts` | 11.8K | SessionStart/SessionEnd 等会话生命周期 hook |
| `src/types/hooks.ts` | 290 行 | 类型定义（HookEvent / HookResult / HookHandler 等）|
| `src/entrypoints/sdk/coreTypes.ts:25-53` | 27 行 | HOOK_EVENTS 字面量数组（27 项）|

### 关键 grep 命中（v6 直接对照）

- `HOOK_EVENTS` 27 项 — `coreTypes.ts:25-53`（[excerpts.md §1](./excerpts.md)）
- `Map<string, PendingAsyncHook>` — `AsyncHookRegistry.ts:28`（[§2](./excerpts.md)）
- `await Promise.allSettled` — `AsyncHookRegistry.ts:144`（[§3](./excerpts.md)）
- `execAgentHook(...)` / `execHttpHook(...)` / `execPromptHook(...)` — 3 文件主 export（[§4 §5 §7](./excerpts.md)）
- `ssrfGuardedLookup` IP block 列表 — `ssrfGuard.ts:5-40,216-283`（[§6](./excerpts.md)）
- `executePreToolHooks` / `executePostToolHooks` async generator — `hooks.ts:3410-3477`（[§8](./excerpts.md)）

完整源码片段在 [excerpts.md](./excerpts.md)。

---

## §2. 4 条要点逐条对照

### 要点 1：Hook 替代 sub-system 的隐患

**判定**：✅ **命中**（v6 与工业实现都通过"hook 失败不阻断核心"的字面机制证明 sub-system 和 hook 是不同职责）

**v6 代码体现**：`agent-v6-hook-engine.ts §5 + §8` 共同表达：

```ts
// §5 dispatch wrapper
async function dispatch(...) {
  await hooks.emit("PreToolUse", { ... }).catch(() => []);  // hook 失败 → 空数组
  const result = await dispatchInner(...);                   // sub-system 该跑就跑
  await hooks.emit("PostToolUse", { ... }).catch(() => []);
  return result;
}

// §8 emit 内部用 Promise.allSettled
async emit(event, ctx) {
  const results = await Promise.allSettled(handlers.map(h => runHandler(h, event, ctx)));
  // 单 handler 失败 → status="rejected" → outcome="non_blocking_error"
  // 但 emit 自己永不 throw
}
```

**工业版**：[excerpts.md §3](./excerpts.md) `AsyncHookRegistry.ts:144` `await Promise.allSettled(hooks.map(...))` —— 同手法。

**run-log-failing-hook.txt 实测黄金证据**：

```
[AUDIT] [HOOK event=PreToolUse handler=log-pre-tool kind=function outcome=success ...]
[AUDIT] [HOOK event=PreToolUse handler=still-running kind=function outcome=success ...]
[AUDIT] [HOOK event=PreToolUse handler=throws-immediately kind=function outcome=non_blocking_error error=intentional hook failure]
[AUDIT] [HOOK event=PreToolUse handler=slow-loris kind=function outcome=non_blocking_error error=timeout after 300ms]
[AUDIT] role=interactive auto-allow tool=delete_file mode=bypassPermissions input=/tmp/test.txt
[MOCK] would rm -rf /tmp/test.txt
```

4 个 PreToolUse handler 并发：2 个成功 + 1 个抛错 + 1 个超时 → 核心 dispatch **完全不受影响**继续 auto-allow + MOCK rm + 后续 PostToolUse + ROUND 自然完成。**这就是 Socratic 07 Q1 "hook 可失败 / sub-system 必须可靠" 的实战证明**。

**反例（教学）**：如果用 `Promise.all` 代替 `Promise.allSettled`，单个 handler reject 会让整批 reject，emit 调用方 await 处会 throw —— 即使加 `.catch(() => [])`，handler 失败的副作用（部分 handler 已经执行了一半）也无法回滚。这就是 sub-system 不能用 hook 替代的根本原因：sub-system 的失败需要确定性的失败模式（permission gate 失败 → 拒绝；compact 失败 → 重试 / 熔断 / 抛错），而 hook 是 best-effort broadcast。

---

### 要点 2：sub-system 入口 vs hook emit point —— 叠加不替代

**判定**：✅ **命中**

**v6 代码体现**：§7 `maybeCompact` 函数体清楚体现：

```ts
async function maybeCompact(messages, role, system) {
  // ... microCompact 检查 ...
  if (rounds.length > MAX_ROUNDS_BEFORE_FULL_COMPACT) {
    await hooks.emit("PreCompact", { role, rounds, bytes }).catch(() => []);  // 旁路广播
    const result = await fullCompact(messages, role, system);                  // sub-system 入口（真发生）
    await hooks.emit("PostCompact", { role, before, after, rounds }).catch(() => []);
  }
}
```

**关键观察**：

- `maybeCompact` 本身是 **sub-system 入口** —— compact 真正发生在这里（`fullCompact` 调一次 LLM call，改写 `messages` 数组）
- `PreCompact` / `PostCompact` emit 是 **hook 旁路广播** —— 让外部观察者知道"compact 即将发生 / 已经发生"
- **两者叠加而不替代**：去掉 hook emit，compact 仍能正常工作；去掉 maybeCompact，compact 完全不发生（即使有 hook 也无济于事）

**工业版**：[excerpts.md §8](./excerpts.md) `hooks.ts:3410-3477` 的 `executePreToolHooks` / `executePostToolHooks` 是 async generator，调用方 `yield*` 取结果 —— **emit 不阻塞 critical path**。同精神。

**Socratic 07 Q2 解决的设计悬念**：v5 notes.md §7.2 写"runRounds 加 hook 链" —— 看起来好像要把 maybeCompact **替换**成 hook。Socratic 07 揭示：不是替换，是**叠加** —— v5 maybeCompact 不动，在它内部 emit 标准 hook event 让外部观察者旁路接入。**v6 实证了这个内化**：v5 §7 整段几乎不动，只在两个具体位置加 emit 调用。

---

### 要点 3：27 个 HOOK_EVENTS 工业枚举

**判定**：✅ **命中**（事实证据）

**v6 教学子集**：v6 只实现 4 项（`PreToolUse / PostToolUse / PreCompact / PostCompact`）。**工业 27 项见 [excerpts.md §1](./excerpts.md)**。

### 工业 27 项的分类

| 类别 | events | v6 覆盖 |
|---|---|---|
| 工具周期 | PreToolUse, PostToolUse, PostToolUseFailure | ✅ Pre / Post（缺 Failure 分支）|
| 用户交互 | UserPromptSubmit, Notification, Elicitation, ElicitationResult | ❌ |
| 会话生命周期 | SessionStart, SessionEnd, Stop, StopFailure | ❌ |
| Subagent | SubagentStart, SubagentStop | ❌ |
| **Compact** | PreCompact, PostCompact | ✅ |
| Permission | PermissionRequest, PermissionDenied | ❌ |
| Task | TaskCreated, TaskCompleted, TeammateIdle | ❌ |
| 配置 / 文件 | Setup, ConfigChange, WorktreeCreate, WorktreeRemove, InstructionsLoaded, CwdChanged, FileChanged | ❌ |

**v6 选 4 项的考量**：

- PreToolUse + PostToolUse：所有 tool 调用都触发，单 session 几个到几十个 event，最容易演示
- PreCompact + PostCompact：与 v5 sub-system 直接耦合，演示 "sub-system 入口 vs hook emit point" 边界
- 4 项足够覆盖"工具周期 + 子系统周期"两个核心维度

**扩展性**：v6 `HookEvent` type 是 string union，新增 event 只需要：(a) `type HookEvent = ... | "NewEvent"`；(b) 找到对应的 emit point（dispatch / runRounds / compact）加 `await hooks.emit("NewEvent", ctx)`；(c) 不影响 dispatch / role / compact 任何核心逻辑。

---

### 要点 4：3 种 handler 执行形态

**判定**：✅ **命中**

**v6 代码体现**：§9 完整实现 3 种 `HookHandler` union type + `dispatchHandler` 多态分发：

```ts
type FunctionHandler = { kind: "function"; name: string; fn: (ctx) => Promise<{ok, reason?}>; timeout? };
type PromptHandler = { kind: "prompt"; name: string; prompt: string; timeout? };
type HttpHandler = { kind: "http"; name: string; url: string; timeout? };
type HookHandler = FunctionHandler | PromptHandler | HttpHandler;
```

**3 种形态对照工业版**：

| v6 | 工业版 | 共同点 |
|---|---|---|
| **Function** | (新增的最简形态 — in-process JS function) | 最简 / 最快 / 无 LLM 成本 |
| **Prompt** ↔ | `execPromptHook.ts:21-30` 单轮 LLM JSON | 调一次 LLM 询问 / 强制 JSON 返回 / 30s timeout |
| **Http** ↔ | `execHttpHook.ts:123-150` POST + SSRF guard | POST 外部端点 / ssrfGuard / 默认 10min |
| (v6 未实现) | `execAgentHook.ts:36-50` 多轮 agent | 多轮 LLM + 有 tools 访问权限 / 60s timeout |

**v6 关键简化**：

- Function handler 是 v6 新增的最简形态（in-process JS function 调用）—— 工业版没有这种（工业 hook 都是异步 shell command 或独立 LLM call，目的是隔离 + 跨进程友好）
- Prompt handler 跟工业 execPromptHook 接口语义一致：单轮 LLM + 空 tools 数组 + 强制 JSON 返回
- Http handler 简化 SSRF guard 为字面量正则（工业用 DNS lookup 时校验 IP），**production 必须像工业版那样在 DNS 层防 rebinding 攻击**

**实测**：v6 run-log 都用 Function handler（最简）。Prompt + Http 形态保留接口验证：未来加 LLM-based 安全审计 hook 直接注册一个 PromptHandler 即可，dispatch 代码完全不动。

---

## §3. emit point 物理承载结构图（v6 三层架构）

```
                +----------------------------------+
                |  agent loop / dispatch / compact |
                |  (in-process critical path)      |
                +----------------------------------+
                                 |
                                 v
                        +--------+--------+
                        | sub-system 入口  |
                        | (永不被 hook 阻) |
                        +--------+--------+
                                 |
                                 v
              +------------------+-----------------+
              | 内部 emit hook event (旁路广播)    |
              | await hooks.emit("X", ctx)         |
              | .catch(() => [])                   |
              +------------------+-----------------+
                                 |
                                 v
              +------------------+-----------------+
              | HookRegistry.emit() {              |
              |   Promise.allSettled(             |
              |     handlers.map(runHandler)       |
              |   )                                 |
              | }  ← 单 handler 失败不影响其他    |
              +------------------+-----------------+
                                 |
                                 v
                  +-----+--------+--------+-----+
                  |     |        |        |     |
                  v     v        v        v     v
              Function Prompt   Http   (Agent) (其他)
                  |     |        |
              JS fn   LLM call POST + SSRF
              直接跑  禁工具   guard
                  |     |        |
                  v     v        v
            HookOutcome (success | non_blocking_error)
```

**对照工业实现**：

- agent loop → dispatch / compact → sub-system 入口：v6 §5/§7 ↔ claude-code `query.ts` 主循环 + `services/compact/` 子系统
- 内部 emit hook event：v6 §5/§7 内部的 `hooks.emit(...)` ↔ claude-code `hooks.ts:3410-3477` `executePreToolHooks` / `executePostToolHooks` async generator
- Registry + Promise.allSettled：v6 §8 ↔ claude-code `AsyncHookRegistry.ts:144`
- Handler 多态：v6 §9 ↔ claude-code `execAgentHook/execHttpHook/execPromptHook.ts`

---

## §4. 失败容忍实测数据

### 实验设计

`run-log-failing-hook.txt`：在 PreToolUse event 上注册 5 个 handler（log-pre-tool / log-post-tool 标准 + throws-immediately / slow-loris / still-running 测试 3 个）。跑 2 个 read_file 任务，观察：

- 哪些 hook 成功 / 失败？
- 核心 dispatch 是否完成？
- audit 记录是否完整？

### 实测结果

| handler 名 | 行为 | 实测 outcome |
|---|---|---|
| `log-pre-tool` | 正常返回 `{ok: true}` | success × 2 |
| `still-running` | 正常返回 + 显式 `peer hooks failed but I still ran` reason | success × 2 |
| `throws-immediately` | 立刻 `throw new Error("intentional hook failure")` | non_blocking_error × 2 |
| `slow-loris` | `setTimeout(5000)` 模拟挂起 + handler timeout 300ms | non_blocking_error × 2（timeout after 300ms）|
| `log-post-tool` | PostToolUse 正常 | success × 2 |

**统计**：

- 10 PreToolUse emit + 2 PostToolUse emit = 12 hook events 总
- 8 success + 4 non_blocking_error
- **3 ROUND 都正常完成（end_turn）—— 核心 sub-system 完全不知道 hook 失败发生过**

### 关键洞察（CLAUDE.md 0 假设原则的实战收益）

如果不实测，凭直觉可能猜：
- "throws-immediately 抛错应该让 emit 调用方 throw" → ❌ 错（Promise.allSettled + .catch 双层保险）
- "slow-loris 挂起 5s 应该让 dispatch 卡 5s" → ❌ 错（handler 内 Promise.race + 300ms timeout）
- "1 个 hook 失败应该让其他 hook 也失败" → ❌ 错（allSettled 隔离）

**实测推翻所有这些猜测** —— 这就是工业实现的精致之处：失败容忍设计层层嵌套（runHandler 内 Promise.race + dispatchHandler 内 try-catch + emit 内 Promise.allSettled + 调用方 .catch），每层都防御性兜底。

---

## §5. Hook vs sub-system 边界判断准则

基于 v6 实现 + 工业对照，以下三条准则用于判断"该用 hook 还是 sub-system"：

### 准则 A：可靠性需求

- **sub-system**：失败必须有确定性后果（permission 失败 → 拒绝执行；compact 失败 → 重试 / 熔断 / 抛错给 user）
- **hook**：失败 = "我们记录这个失败，但 critical path 不在乎"（audit / observability / 通知 / 外部审计 hook）

**判断**：如果失败必须导致核心行为改变 → sub-system；如果失败只影响"旁路观察" → hook。

### 准则 B：耦合度需求

- **sub-system**：与 critical path 紧耦合，调用方需要拿到结果做决策（modeMatrix 返回 policy → dispatch 必须根据 policy 走分支）
- **hook**：与 critical path 解耦，调用方可以完全忽略结果（emit 即可，结果由其他订阅者消费）

**判断**：如果调用方需要 await + 用结果 → sub-system；如果调用方"emit 完就走" → hook。

### 准则 C：扩展频率需求

- **sub-system**：扩展频率低（permission 模式从 3 种到 6 种是 yearly 级别的设计变更）
- **hook**：扩展频率高（user 添加自定义 audit / 第三方 plugin 加 lint hook 是 daily 级别）

**判断**：如果扩展需要 harness 代码改动 → sub-system；如果扩展是 settings.json 或 plugin 注册 → hook。

### 错误划分示例

| 场景 | 划分 | 理由 |
|---|---|---|
| permission gate（block dangerous tool）| ❌ 不应该用 hook | 失败必须确定性拒绝（准则 A）+ 紧耦合 dispatch（准则 B）|
| compact 决策（messages 太大时压）| ❌ 不应该用 hook | 失败需要熔断 / 重试（准则 A）+ 紧耦合 runRounds（准则 B）|
| audit log（记录所有 tool 调用）| ✅ hook 合适 | 失败只影响观测（准则 A）+ 解耦（准则 B）+ 高频扩展（准则 C）|
| 自定义 lint hook（PreToolUse 时检查 commit message）| ✅ hook 合适 | 失败 = "lint 没跑成功" 不阻断 commit（准则 A）+ 解耦（准则 B）+ user 频繁定制（准则 C）|
| 通知 desktop（任务完成时 osascript display notification）| ✅ hook 合适 | 全部 3 准则都符合 hook |

---

## §6. 写回 v5 的扩展点

### 6.1 maybeCompact 已经是完美的 sub-system 入口

v5 设计意外正确：`maybeCompact` 不放在 dispatch 内，而是 runRounds 末尾单独调用。v6 不需要改这个结构，**只需要在 maybeCompact 内部加 emit**。这条 v5 的 notes.md §7.2 写"runRounds 加 hook 链" 看起来好像要重构 maybeCompact 出 hook 链；实际 Socratic 07 + v6 实证：v5 结构本身就对，hook 是叠加。

### 6.2 dispatch 用 wrapper 模式包 inner

v5 dispatch 是单一函数（policy 判决 + 执行混在一起）。v6 提取 `dispatchInner` 后 dispatch 变成 "emit Pre → run inner → emit Post" 三步骨架 —— **这种 wrapper 模式让 emit 调用点变得显式可见**，便于未来加更多 around-style hook（如 cost-tracking hook 计算 dispatchInner 耗时）。

### 6.3 audit / pp 等 helper 集中到 §4

v5 §4 已经把 audit / pp 等 helper 集中。v6 不动，但**进一步可改进**：把 `audit()` 也做成 hook 注册（如 `hooks.register("PostToolUse", logTo OpenTelemetry)`）—— 让 audit 从"硬编码 console.error" 变成"标准 hook 之一"。这是 Lecture 07 Observability 维度的入口。

---

## §7. 一句话总结

4 条 Lecture 06 + Socratic 07 要点全部命中工业实现。最大学习：

> **hook 系统是 cross-cutting concern 的注入机制，不是 sub-system 的替代品。它通过 (a) Registry 数据结构（Map<event, handler[]>）；(b) emit 时机选择（critical path 内部 emit 但不阻塞）；(c) Promise.allSettled 失败隔离；(d) 多形态 handler（in-process function / LLM prompt / HTTP）—— 让 user 在不动 harness 核心代码的情况下注入新的旁路行为。判断"该用 hook 还是 sub-system"的三准则：失败的确定性需求 / 调用方对结果的依赖度 / 扩展频率。错用 hook 替代 sub-system 会引入不可靠的安全 / 数据完整性问题；错用 sub-system 实现简单 audit 会导致 harness 代码爆炸不可维护。**

v6 + 这 4 条要点是进入 Lecture 07 的基础：**Observability 维度自然延伸** —— audit / metrics / tracing 都是 hook 的典型应用场景，通过结构化的 PostToolUse / PostCompact event 输出到 OTel / Sentry / 自定义日志聚合。
