# excerpts —— claude-code hook 系统关键源码

> 备查文档。所有片段来自本机 `/Users/stringzhao/workspace/claude-code/` 工作副本。
> notes.md 4 条要点对照按需引用。**遵守 CLAUDE.md 0 假设原则**：每条都带 file:line + 字面量 quote，不凭命名推断。

---

## §1. HOOK_EVENTS 27 项枚举（事实证据）

**文件**：`src/entrypoints/sdk/coreTypes.ts:25-53`

```ts
export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PermissionRequest',
  'PermissionDenied',
  'Setup',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'Elicitation',
  'ElicitationResult',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'InstructionsLoaded',
  'CwdChanged',
  'FileChanged',
] as const
```

**关键**：精确 27 项。覆盖 (a) 工具周期 PreToolUse/PostToolUse/PostToolUseFailure；(b) 会话生命周期 SessionStart/End / Stop; (c) subagent SubagentStart/Stop；(d) **compact 周期 PreCompact/PostCompact**；(e) permission PermissionRequest/Denied；(f) 外部 worktree/config/file change；(g) UI Notification/Elicitation；(h) task TaskCreated/Completed。v6 教学子集 4 项（PreToolUse/PostToolUse/PreCompact/PostCompact）。

---

## §2. AsyncHookRegistry 数据结构 + 注册接口（推论 1：注册中心）

**文件**：`src/utils/hooks/AsyncHookRegistry.ts:12-28`

```ts
export type PendingAsyncHook = {
  processId: string
  hookId: string
  hookName: string
  hookEvent: HookEvent | 'StatusLine' | 'FileSuggestion'
  toolName?: string
  pluginId?: string
  startTime: number
  timeout: number
  command: string
  responseAttachmentSent: boolean
  shellCommand?: ShellCommand
  stopProgressInterval: () => void
}

const pendingHooks = new Map<string, PendingAsyncHook>()
```

**关键**：注册中心是 `Map<processId, PendingAsyncHook>` —— 以 **processId 为 key**（不是 hookId）。工业 hook 是异步 shell command 形态，每次 emit 启动一个独立 process，pending hooks 表是异步 hook 的"in-flight"队列。v6 简化为 `Map<HookEvent, HookHandler[]>` —— 按 event 分类的 handler 列表，单进程内 await Promise.allSettled 直接执行。

**对照 v6**：v6 `agent-v6-hook-engine.ts §8` 的 `HookRegistry` 类 + `private map = new Map<HookEvent, HookHandler[]>()` 同精神，简化为 in-process 直跑。

---

## §3. checkForAsyncHookResponses：Promise.allSettled 失败隔离（推论 4）

**文件**：`src/utils/hooks/AsyncHookRegistry.ts:113-268`（关键片段）

```ts
const settled = await Promise.allSettled(
  hooks.map(async hook => { ... })
)

for (const s of settled) {
  if (s.status !== 'fulfilled') {
    logForDebugging(
      `Hooks: checkForAsyncHookResponses callback rejected: ${s.reason}`,
      { level: 'error' }
    )
    continue
  }
  // process result
}
```

**关键**：工业实现明确用 `Promise.allSettled`（不是 `Promise.all`）。Promise.all 一旦任一 reject 整批 reject，会让一个 hook 失败拖垮其他 hooks；Promise.allSettled 永远 fulfill，单 reject 不影响其他。

**对照 v6**：v6 §8 `HookRegistry.emit()` 同手法：

```ts
const results = await Promise.allSettled(handlers.map((h) => runHandler(h, event, ctx)));
return results.map((r, i) => {
  if (r.status === "fulfilled") return r.value;
  const err = String(r.reason?.message || r.reason).slice(0, 120);
  audit(`[HOOK event=${event} handler=${name} kind=${kind} outcome=non_blocking_error error=${err}]`);
  return { handler: name, kind, outcome: "non_blocking_error", error: err };
});
```

run-log-failing-hook.txt 实测：3 个 PreToolUse handler 并发，1 抛错 + 1 timeout + 2 正常 → 后两个 success，前两个 non_blocking_error，**核心 dispatch 仍正常**。

---

## §4. execAgentHook 函数签名（推论 5：3 种 handler 形态之一）

**文件**：`src/utils/hooks/execAgentHook.ts:36-50`

```ts
export async function execAgentHook(
  hook: AgentHook,
  hookName: string,
  hookEvent: HookEvent,
  jsonInput: string,
  signal: AbortSignal,
  toolUseContext: ToolUseContext,
  toolUseID: string | undefined,
  _messages: Message[],
  agentName?: string,
): Promise<HookResult>
```

**关键**：execAgentHook 启动一个**多轮 LLM agent**（有工具访问权限：Read/Bash 等），让 agent 验证一个条件，返回 `HookResult`。**60s 默认 timeout** (`hook.timeout * 1000 : 60000`)。用独立的 `agentId` + `ToolUseContext` 模拟 agent 运行环境。

v6 没实现 agent 形态（教学简化）—— 但接口设计兼容：未来加 `kind: "agent"` handler 只需要扩展 `HookHandler` union type + `dispatchHandler` 加一个 if 分支。

---

## §5. execHttpHook 函数签名 + SSRF 防护对接（推论 5）

**文件**：`src/utils/hooks/execHttpHook.ts:123-150`

```ts
export async function execHttpHook(
  hook: HttpHook,
  _hookEvent: HookEvent,
  jsonInput: string,
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  statusCode?: number
  body: string
  error?: string
  aborted?: boolean
}>
```

**关键**：execHttpHook POST 外部端点，body = jsonInput。返回结构化 `{ok, statusCode, body, error?}`。功能：
- **URL allowlist 校验**（`allowedHttpHookUrls`）
- **Env var 插值**（`$VAR_NAME` → `process.env['VAR_NAME']`，仅白名单变量防泄密）
- **SSRF guard 通过 axios `lookup` 选项**（见 §6）
- **10 分钟默认超时**

**对照 v6**：v6 §9 `dispatchHandler` 的 http 分支：

```ts
const host = h.url.replace(/^https?:\/\//, "").split("/")[0].split(":")[0];
if (SSRF_BLOCKED.test(host)) throw new Error(`SSRF guard blocked host=${host}`);
const resp = await fetch(h.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ctx) });
```

简化版：(a) 没有 URL allowlist；(b) 没有 env var 插值；(c) SSRF guard 改为 hostname 字面量前缀正则；(d) 默认 timeout 30s（runHandler 通用 timeout）。

---

## §6. ssrfGuard IP block 列表

**文件**：`src/utils/hooks/ssrfGuard.ts:5-40`（关键片段）

**阻止的 IPv4 / IPv6 段**：

- `0.0.0.0/8` — "this" network
- `10.0.0.0/8` — RFC1918 私网
- **`100.64.0.0/10` — CGNAT**（某些云元数据如阿里云 `100.100.100.200`）
- **`169.254.0.0/16` — link-local**（云元数据 AWS `169.254.169.254` 是最有名的 SSRF 目标）
- `172.16.0.0/12` — RFC1918 私网
- `192.168.0.0/16` — RFC1918 私网
- IPv6: `::`, `fc00::/7`, `fe80::/10`, IPv4-mapped IPv6 中被阻止的 IPv4

**允许 loopback**：`127.0.0.0/8` 和 `::1`（本地开发 hooks）

**接口** (`ssrfGuard.ts:216-283`)：

```ts
export function ssrfGuardedLookup(
  hostname: string,
  options: object,
  callback: (err: Error | null, address: AxiosLookupAddress | AxiosLookupAddress[], family?: AddressFamily) => void,
): void
```

**关键**：注入到 axios 请求的 `lookup` 选项，**DNS 结果被即时校验**，恶意地址在 socket 连接前被拒。这避免了 DNS rebinding 攻击（hostname 第一次解析为合法 IP，第二次解析为内网 IP）。

**对照 v6**：v6 简化 SSRF guard 是**字面量字符串前缀正则**（`SSRF_BLOCKED = /^(localhost|127\.|10\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|0\.0\.0\.0)/`）—— 不做 DNS 解析，无法防 DNS rebinding。production 必须像工业版那样在 DNS lookup 层防护。

---

## §7. execPromptHook 函数签名（推论 5：3 种 handler 形态之三）

**文件**：`src/utils/hooks/execPromptHook.ts:21-30`

```ts
export async function execPromptHook(
  hook: PromptHook,
  hookName: string,
  hookEvent: HookEvent,
  jsonInput: string,
  signal: AbortSignal,
  toolUseContext: ToolUseContext,
  messages?: Message[],
  toolUseID?: string,
): Promise<HookResult>
```

**关键**：**单轮 LLM query**，system prompt 要求返回 `{ok: boolean, reason?: string}` JSON。**不允许 tool use**（与 execAgentHook 多轮 + 有 tool 形成对比）。**30s 默认超时**。

**对照 v6**：v6 §9 prompt 分支：

```ts
const text = `${h.prompt}\n\nContext: ${JSON.stringify(ctx).slice(0, 400)}\n\nRespond with STRICT JSON only: {"ok": boolean, "reason": string}.`;
const res = await callModel([{ role: "user", content: text }], "Respond ONLY with JSON {\"ok\": boolean, \"reason\": string}. NEVER call tools.", []);
const parsed = JSON.parse(txt.match(/\{[^{}]*\}/)?.[0] ?? '{"ok":false,"reason":"no JSON"}');
```

**接口语义完全一致**：单轮 LLM + 强制 JSON + 空 tools 数组（禁工具）+ 30s timeout。v6 是 production execPromptHook 的最简对照。

---

## §8. emit 是 fire-and-forget：dispatch / compact 永不被 hook 阻断（推论 4 + 决定性证据）

**文件**：`src/utils/hooks.ts:3410-3436`（executePreToolHooks）+ `:3450-3477`（executePostToolHooks）

```ts
export function* executePreToolHooks(...): AsyncGenerator<AggregatedHookResult> {
  const hookInput: PreToolUseHookInput = {
    ...createBaseHookInput(permissionMode, undefined, toolUseContext),
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseID,
  }
  yield* executeHooks({
    hookInput,
    toolUseID,
    matchQuery: toolName,
    ...
  })
}
```

**关键**：`executePreToolHooks` 是 **async generator**，调用方 `yield*` 取结果 —— 这意味着：

- emit 调用方可以**选择消费**结果（用 for-await loop）或**直接丢弃**（不消费 yielded value）
- generator 的 throw 不会**自动**冒到调用方 —— 调用方需要 try-catch yield value 才能感知错误
- 工业实现是 fire-and-yield 而不是 fire-and-forget；v6 简化为 fire-and-forget（`await hooks.emit(...).catch(() => [])`）

**对照 v6**：v6 §5 dispatch wrapper：

```ts
async function dispatch(...) {
  await hooks.emit("PreToolUse", { tool: name, input, mode, role }).catch(() => []);
  const result = await dispatchInner(...);
  await hooks.emit("PostToolUse", { tool: name, input, result, mode, role }).catch(() => []);
  return result;
}
```

`.catch(() => [])` 是**双重保险** —— `emit` 内部已经 Promise.allSettled 不会 reject，但加这层让调用方代码显式表达 "永不被 hook 影响" 的意图。run-log-failing-hook.txt 实测：emit 调用前后 dispatch 完全不知道 hook 失败发生过。
