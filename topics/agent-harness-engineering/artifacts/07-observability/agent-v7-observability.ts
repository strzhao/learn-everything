// Task 07 v7: mini observability sub-system —— v6 hook 系统的天然消费者
// v6 §1-10 完全不动 + 新增 §11 ObservabilitySink (3 形态) + §12 emitObservability fan-out (cardinality + privacy)
// v6 §11 启动入口 → v7 §13（字面量保留，仅 registerDefaultHooks 加 obs 分支 + dump 三 sink 在结束）
// 核心 distinction（Socratic 09 内化）: fan-out 单一入口语义一致性 / cardinality 字段精确分类 / privacy 在机制层 / context map ≠ sink
// 对照: claude-code/src/utils/telemetry/events.ts (75 行: redactIfDisabled + prompt.id only events + workspaceDir only events)
//      + src/hooks/toolPermission/permissionLogging.ts:178-235 (单一入口 fan-out 4 sink 教科书范本)

// ---------- 1. Role + Mode + Policy + Compact 配置（v5 继承）----------
// v5 三维矩阵 + compact 阈值都不动。v6 不修改 v5 任何核心常量。
type Mode = "default" | "acceptEdits" | "bypassPermissions";
type Role = "interactive" | "coordinator" | "swarm-worker";
type Policy = "auto-allow" | "ask" | "hard-block";

const READ_LIKE = new Set(["read_file"]);
const EDIT_LIKE = new Set(["edit_file"]);
const META_TOOLS = new Set(["ask_user", "spawn_swarm"]);

// Compact 阈值（教学版定低，方便观察触发；production 一般按 token 估算 + context window 推算）
const MIN_TOOL_RESULT_BYTES_TO_CLEAR = 30; // 单条 tool_result content 超过 N bytes 才值得 microCompact
const KEEP_RECENT_ROUNDS = 2;              // microCompact / fullCompact 都保留最近 N round 不动
const MAX_ROUNDS_BEFORE_FULL_COMPACT = 4;  // round 数超过 N 就触发 fullCompact

function modeMatrix(tool: string, input: any, mode: Mode, _role: Role): Policy {
  if (isHardBlocked(tool, input)) return "hard-block";
  if (META_TOOLS.has(tool)) return "auto-allow";
  if (READ_LIKE.has(tool)) return "auto-allow";
  if (mode === "bypassPermissions") return "auto-allow";
  if (mode === "acceptEdits" && EDIT_LIKE.has(tool)) return "auto-allow";
  return "ask";
}

// ---------- 2. Hard-block 列表（v3/v4 继承，role/mode 都正交）----------
const HARD_BLOCK_PATHS = ["/", "/etc", "/usr", "/System", "/Library", "/bin", "/sbin"];
function isHardBlocked(tool: string, input: any): boolean {
  if (tool !== "delete_file" && tool !== "edit_file") return false;
  const path = String(input?.path ?? "");
  return HARD_BLOCK_PATHS.some((p) => path === p || path.startsWith(p + "/"));
}

// ---------- 3. Tools schema 按 role 分化（v4 继承）----------
const obj = (props: any, required: string[]) => ({ type: "object", properties: props, required });
const str = { type: "string" };

const BASE_TOOLS = [
  { name: "read_file", description: "Read a file's content. Read-only, always safe.",
    input_schema: obj({ path: str }, ["path"]) },
  { name: "edit_file", description: "Overwrite a file's content. Modifies disk.",
    input_schema: obj({ path: str, content: str }, ["path", "content"]) },
  { name: "delete_file", description: "Delete a file at the given absolute path. Destructive and irreversible.",
    input_schema: obj({ path: str }, ["path"]) },
];
const ASK_USER_TOOL = { name: "ask_user", description: "Ask the human user a clarifying question and get their reply.",
  input_schema: obj({ question: str }, ["question"]) };
const SPAWN_SWARM_TOOL = {
  name: "spawn_swarm",
  description: "Spawn a swarm worker to handle an independent subtask. Returns worker's text summary. " +
    "Tip: fan out parallel work by emitting MULTIPLE spawn_swarm calls in ONE turn — they run concurrently.",
  input_schema: obj(
    { task: { type: "string", description: "Subtask for the swarm worker." },
      mode: { type: "string", enum: ["default", "acceptEdits", "bypassPermissions"],
              description: "Permission mode for the swarm. Inherits parent if omitted." } },
    ["task"]),
};

function getToolsForRole(role: Role): any[] {
  if (role === "swarm-worker") return BASE_TOOLS;
  if (role === "coordinator") return [...BASE_TOOLS, ASK_USER_TOOL, SPAWN_SWARM_TOOL];
  return [...BASE_TOOLS, ASK_USER_TOOL];
}

// ---------- 4. Ask 转发通道 + audit + 字节估算 helper ----------
// v4 继承 makeRoutedAsk；v5 新增 estimateBytes 用于 compact 决策与 audit。
type AskFn = (question: string, ctx: { tool: string; input: any; role: Role }) => Promise<string>;

const audit = (msg: string) => console.error(`[AUDIT] ${msg}`);
const pp = (x: any) => (x?.path ? x.path : JSON.stringify(x));
const estimateBytes = (m: any[]) => JSON.stringify(m).length;

const interactiveAsk: AskFn = async (question) => (prompt(question) ?? "").trim();

function makeRoutedAsk(swarmId: string, parentAsk: AskFn): AskFn {
  return async (question, ctx) => {
    audit(`role=swarm-worker swarm=${swarmId} ROUTED-UP tool=${ctx.tool} q=${JSON.stringify(question)}`);
    const answer = await parentAsk(`[from ${swarmId}] ${question}`, ctx);
    audit(`role=swarm-worker swarm=${swarmId} ROUTED-UP answer=${JSON.stringify(answer)}`);
    return answer;
  };
}

// ---------- 5. Dispatch + execute + runRounds（dispatch 内部新增 PreToolUse/PostToolUse emit）----------
// 关键：dispatch 是 in-process critical path，hook emit 是旁路广播；emit 失败永远不阻断 dispatch
// 对照 claude-code: hooks.ts:3410-3436 executePreToolHooks + :3450-3477 executePostToolHooks
async function dispatch(
  name: string, input: any, mode: Mode, role: Role, askFn: AskFn,
  spawnFn?: (task: string, swarmMode: Mode) => Promise<string>,
): Promise<{ content: string; is_error: boolean }> {
  await hooks.emit("PreToolUse", { tool: name, input, mode, role }).catch(() => []); // 双重保险：emit 内部已用 Promise.allSettled
  const result = await dispatchInner(name, input, mode, role, askFn, spawnFn);
  await hooks.emit("PostToolUse", { tool: name, input, result, mode, role }).catch(() => []);
  return result;
}

async function dispatchInner(
  name: string, input: any, mode: Mode, role: Role, askFn: AskFn,
  spawnFn?: (task: string, swarmMode: Mode) => Promise<string>,
): Promise<{ content: string; is_error: boolean }> {
  const policy = modeMatrix(name, input, mode, role);
  if (policy === "hard-block") {
    audit(`role=${role} hard-block tool=${name} path=${input?.path} mode=${mode} (bypass-immune)`);
    return { content: `Hard-block: ${input?.path} is in the protected path list and cannot be ${name === "delete_file" ? "deleted" : "edited"} even in bypass mode.`, is_error: true };
  }
  if (policy === "ask") {
    const ans = (await askFn(`mode=${mode} Allow ${name} on ${pp(input)}? [y/N]`, { tool: name, input, role })).toLowerCase();
    if (ans !== "y") return { content: `User denied ${name}: ${pp(input)}`, is_error: true };
    return execute(name, input, askFn, spawnFn, mode);
  }
  if (mode !== "default" && !READ_LIKE.has(name) && !META_TOOLS.has(name)) {
    audit(`role=${role} auto-allow tool=${name} mode=${mode} input=${pp(input)}`);
  }
  return execute(name, input, askFn, spawnFn, mode);
}

async function execute(
  name: string, input: any, askFn: AskFn,
  spawnFn: ((task: string, swarmMode: Mode) => Promise<string>) | undefined, mode: Mode,
): Promise<{ content: string; is_error: boolean }> {
  if (name === "read_file") return { content: `Read ${input.path}: <mocked content of ${input.path} — pretend this is a 500-byte chunk of file contents that the model will analyze>`, is_error: false };
  if (name === "edit_file") { console.log(`[MOCK] would write ${input.path} <- ${JSON.stringify(input.content).slice(0, 60)}`); return { content: `Edited ${input.path}`, is_error: false }; }
  if (name === "delete_file") { console.log(`[MOCK] would rm -rf ${input.path}`); return { content: `Deleted ${input.path}`, is_error: false }; }
  if (name === "ask_user") {
    const ans = await askFn(`[ask_user] ${input.question}`, { tool: "ask_user", input, role: "interactive" });
    return { content: `User answered: ${ans || "(empty)"}`, is_error: false };
  }
  if (name === "spawn_swarm") {
    if (!spawnFn) return { content: "spawn_swarm not available in this role", is_error: true };
    return { content: await spawnFn(input.task, (input.mode as Mode) || mode), is_error: false };
  }
  return { content: `Unknown tool: ${name}`, is_error: true };
}

// runRounds: v4 继承 + 每 round 末尾调一次 maybeCompact（compact 是独立 sub-system，runRounds 只挂钩不感知细节）
async function runRounds(
  messages: any[], system: string, tools: any[], mode: Mode, role: Role,
  askFn: AskFn, spawnFn: ((t: string, m: Mode) => Promise<string>) | undefined,
  formatHeader: (round: number, stopReason: string) => string,
): Promise<void> {
  for (let round = 1; round <= 8; round++) {
    const res = await callModel(messages, system, tools);
    console.log(`\n${formatHeader(round, res.stop_reason)}`);
    if (!res.content) { console.log("RAW RES (likely error):", JSON.stringify(res, null, 2).slice(0, 500)); break; }
    console.log(JSON.stringify(res.content, null, 2));
    messages.push({ role: "assistant", content: res.content });
    if (res.stop_reason !== "tool_use") break;
    const toolResults = await Promise.all(
      res.content.filter((b: any) => b.type === "tool_use").map(async (b: any) => {
        const r = await dispatch(b.name, b.input, mode, role, askFn, spawnFn);
        return { type: "tool_result", tool_use_id: b.id, content: r.content, is_error: r.is_error };
      }),
    );
    messages.push({ role: "user", content: toolResults });
    await maybeCompact(messages, role, system); // ← 独立 sub-system 钩子，唯一介入点
  }
}

// ---------- 6. groupByRound + microCompact（v5 §6+§7 合并继承）----------
// groupByRound 按 assistant 出现切分；microCompact 替换老 tool_result 内容为 CLEARED_MARKER。
// 对照 claude-code: grouping.ts:22-63 边界规则 + microCompact.ts:36 字面量。v6 完全不动。
function groupByRound(messages: any[]): any[][] {
  const groups: any[][] = [];
  let cur: any[] = [];
  for (const m of messages) {
    cur.push(m);
    if (m.role === "assistant") { groups.push(cur); cur = []; }
  }
  if (cur.length > 0) groups.push(cur);
  return groups;
}

const CLEARED_MARKER = "[Old tool result content cleared]";

function microCompact(messages: any[]): { cleared: number; bytesFreed: number } {
  const rounds = groupByRound(messages);
  if (rounds.length <= KEEP_RECENT_ROUNDS + 1) return { cleared: 0, bytesFreed: 0 };
  let cleared = 0, bytesFreed = 0;
  // 只清前 (rounds.length - KEEP_RECENT_ROUNDS) 个 round 的 tool_result
  const compactableRounds = rounds.slice(0, rounds.length - KEEP_RECENT_ROUNDS);
  for (const round of compactableRounds) {
    for (const m of round) {
      if (m.role !== "user" || !Array.isArray(m.content)) continue;
      for (const block of m.content) {
        if (block.type !== "tool_result" || block.content === CLEARED_MARKER) continue;
        const sz = typeof block.content === "string" ? block.content.length : JSON.stringify(block.content).length;
        if (sz < MIN_TOOL_RESULT_BYTES_TO_CLEAR) continue;
        block.content = CLEARED_MARKER;
        bytesFreed += sz - CLEARED_MARKER.length;
        cleared++;
      }
    }
  }
  return { cleared, bytesFreed };
}

// ---------- 7. fullCompact + maybeCompact（maybeCompact 内部新增 PreCompact/PostCompact emit）----------
// 关键：maybeCompact 是 sub-system 入口（compact 真发生地），PreCompact/PostCompact 是 emit 给 hook 系统的 event。
// 两者叠加不替代（Socratic 07 Q2 内化）—— hook 失败 / 超时不影响 fullCompact 实际执行。
// 对照 claude-code prompt.ts:19-26 NO_TOOLS_PREAMBLE + compact.ts:614-624 插回 user message.
const NO_TOOLS_PREAMBLE = "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools. " +
  "You already have all context you need in the conversation above. " +
  "Tool calls will be REJECTED and waste your only turn. " +
  "Your entire response must be plain text: an <analysis> block followed by a <summary> block.";

const COMPACT_INSTRUCTION = "Summarize the following conversation history. Capture: user's intents, key technical decisions, " +
  "file names and code snippets, errors encountered. Output <analysis> then <summary>.";

async function fullCompact(messages: any[], role: Role, _system: string): Promise<{ before: number; after: number; rounds: number }> {
  const beforeBytes = estimateBytes(messages);
  const rounds = groupByRound(messages);
  if (rounds.length <= KEEP_RECENT_ROUNDS) return { before: beforeBytes, after: beforeBytes, rounds: rounds.length };
  const toCompact = rounds.slice(0, rounds.length - KEEP_RECENT_ROUNDS).flat();
  const toKeep = rounds.slice(rounds.length - KEEP_RECENT_ROUNDS).flat();

  const compactionMessages = [{ role: "user",
    content: `${COMPACT_INSTRUCTION}\n\n=== CONVERSATION HISTORY TO COMPACT ===\n${JSON.stringify(toCompact, null, 2).slice(0, 6000)}` }];
  const res = await callModel(compactionMessages, NO_TOOLS_PREAMBLE, []); // 空 tools 数组：物理禁工具
  const summary = (res.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim()
    || "(compaction LLM returned no text — fallback)";

  // 替换 messages：清空 + 插 summary（user role）+ 保留段
  // 关键修复：toKeep[0] 通常是 user(tool_result)，但对应的 tool_use 已在 toCompact 里被压掉了 ——
  // 这种"悬空 tool_result"会被 API 拒绝。跳过 toKeep 开头悬空 tool_result 段，直到找到 assistant
  // （那 assistant 之后的 tool_result 才有完整 tool_use 配对）。这是 round 原子性约束在 compact 边界的体现。
  let firstValid = 0;
  while (firstValid < toKeep.length && toKeep[firstValid].role === "user"
         && Array.isArray(toKeep[firstValid].content)
         && toKeep[firstValid].content.some((b: any) => b.type === "tool_result")) {
    firstValid++;
  }
  messages.length = 0;
  messages.push({ role: "user", content: `[COMPACTED SUMMARY]\n${summary}` });
  for (let j = firstValid; j < toKeep.length; j++) messages.push(toKeep[j]);
  const afterBytes = estimateBytes(messages);
  console.log(`\n========== COMPACT EVENT round=${rounds.length} type=full role=${role} before=${beforeBytes} after=${afterBytes} ==========`);
  console.log(`summary (first 600 chars): ${summary.slice(0, 600)}`);
  return { before: beforeBytes, after: afterBytes, rounds: rounds.length };
}

// maybeCompact 内部新增 PreCompact / PostCompact emit：emit 是旁路广播，failed hook 不影响 fullCompact 实际执行
async function maybeCompact(messages: any[], role: Role, system: string): Promise<void> {
  const rounds = groupByRound(messages);
  const beforeBytes = estimateBytes(messages);
  const micro = microCompact(messages);
  if (micro.cleared > 0) {
    const afterBytes = estimateBytes(messages);
    console.log(`\n========== COMPACT EVENT round=${rounds.length} type=micro role=${role} before=${beforeBytes} after=${afterBytes} ==========`);
    audit(`COMPACT type=micro role=${role} cleared=${micro.cleared}_tool_results freed=${micro.bytesFreed}b`);
  }
  if (rounds.length > MAX_ROUNDS_BEFORE_FULL_COMPACT) {
    await hooks.emit("PreCompact", { role, rounds: rounds.length, bytes: estimateBytes(messages) }).catch(() => []);
    const result = await fullCompact(messages, role, system);
    await hooks.emit("PostCompact", { role, before: result.before, after: result.after, rounds: result.rounds }).catch(() => []);
  }
}

// ---------- 8. HookRegistry：注册中心（Map<event, handler[]>）+ emit Promise.allSettled 隔离 ----------
// 对照 claude-code AsyncHookRegistry.ts:28 `const pendingHooks = new Map<string, PendingAsyncHook>()` 数据结构
// 对照 claude-code AsyncHookRegistry.ts:144 `await Promise.allSettled(hooks.map(...))` 失败隔离
// 关键：emit 用 allSettled 保证单 handler 失败不影响其他 handler / 不阻断 emit 调用方
type HookEvent = "PreToolUse" | "PostToolUse" | "PreCompact" | "PostCompact"; // 教学子集；工业 27 项见 coreTypes.ts:25-53
type HookOutcome = { handler: string; kind: string; outcome: "success" | "non_blocking_error"; ok?: boolean; reason?: string; error?: string };

class HookRegistry {
  private map = new Map<HookEvent, HookHandler[]>();
  register(event: HookEvent, handler: HookHandler): void {
    if (!this.map.has(event)) this.map.set(event, []);
    this.map.get(event)!.push(handler);
  }
  async emit(event: HookEvent, ctx: any): Promise<HookOutcome[]> {
    const handlers = this.map.get(event) ?? [];
    if (handlers.length === 0) return [];
    // Promise.allSettled：一个 handler 抛错不影响其他 handler / emit 调用方永不 throw
    const results = await Promise.allSettled(handlers.map((h) => runHandler(h, event, ctx)));
    return results.map((r, i) => {
      const name = handlers[i].name;
      const kind = handlers[i].kind;
      if (r.status === "fulfilled") return r.value;
      const err = String(r.reason?.message || r.reason).slice(0, 120);
      audit(`[HOOK event=${event} handler=${name} kind=${kind} outcome=non_blocking_error error=${err}]`);
      return { handler: name, kind, outcome: "non_blocking_error", error: err };
    });
  }
}
const hooks = new HookRegistry();

// ---------- 9. Handler 形态：Function / Prompt / Http (含简化 SSRF guard) ----------
// 对照 claude-code 3 种 handler：execAgentHook.ts:36 (60s) / execHttpHook.ts:123 (POST + SSRF, 10min) / execPromptHook.ts:21 (30s 单轮 LLM JSON)
// v6 简化：Function = in-process JS fn；Prompt = 单轮 LLM 要求 JSON；Http = POST + 简化 SSRF guard
type FunctionHandler = { kind: "function"; name: string; fn: (ctx: any) => Promise<{ ok: boolean; reason?: string }>; timeout?: number };
type PromptHandler = { kind: "prompt"; name: string; prompt: string; timeout?: number };
type HttpHandler = { kind: "http"; name: string; url: string; timeout?: number };
type HookHandler = FunctionHandler | PromptHandler | HttpHandler;

// 简化 SSRF guard 对照 claude-code ssrfGuard.ts:5-40 IP block 列表（loopback/RFC1918/link-local 云元数据）
const SSRF_BLOCKED = /^(localhost|127\.|10\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|0\.0\.0\.0)/;

async function runHandler(h: HookHandler, event: HookEvent, ctx: any): Promise<HookOutcome> {
  const timeout = h.timeout ?? 30000;
  const t = new Promise<HookOutcome>((_, rej) => setTimeout(() => rej(new Error(`timeout after ${timeout}ms`)), timeout));
  return await Promise.race([dispatchHandler(h, event, ctx), t]);
}

async function dispatchHandler(h: HookHandler, event: HookEvent, ctx: any): Promise<HookOutcome> {
  if (h.kind === "function") {
    const r = await h.fn(ctx);
    audit(`[HOOK event=${event} handler=${h.name} kind=function outcome=success ok=${r.ok}${r.reason ? ` reason=${String(r.reason).slice(0, 60)}` : ""}]`);
    return { handler: h.name, kind: "function", outcome: "success", ok: r.ok, reason: r.reason };
  }
  if (h.kind === "prompt") {
    const text = `${h.prompt}\n\nContext: ${JSON.stringify(ctx).slice(0, 400)}\n\nRespond with STRICT JSON only: {"ok": boolean, "reason": string}.`;
    const res = await callModel([{ role: "user", content: text }], "Respond ONLY with JSON {\"ok\": boolean, \"reason\": string}. NEVER call tools.", []);
    const txt = (res.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
    const parsed = JSON.parse(txt.match(/\{[^{}]*\}/)?.[0] ?? '{"ok":false,"reason":"no JSON"}');
    audit(`[HOOK event=${event} handler=${h.name} kind=prompt outcome=success ok=${parsed.ok} reason=${String(parsed.reason || "").slice(0, 60)}]`);
    return { handler: h.name, kind: "prompt", outcome: "success", ok: Boolean(parsed.ok), reason: parsed.reason };
  }
  const host = h.url.replace(/^https?:\/\//, "").split("/")[0].split(":")[0];
  if (SSRF_BLOCKED.test(host)) throw new Error(`SSRF guard blocked host=${host}`);
  const resp = await fetch(h.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ctx) });
  const body = (await resp.text()).slice(0, 200);
  audit(`[HOOK event=${event} handler=${h.name} kind=http outcome=success status=${resp.status}]`);
  return { handler: h.name, kind: "http", outcome: "success", ok: resp.ok, reason: body };
}

// ---------- 10. runSwarm / runCoordinator / runInteractive（v5 继承，hook emit 自动作用于各 role）----------
// 关键：每个 role 独立 messages 数组，maybeCompact 只动当前 messages —— swarm 内部 compact 不影响 coordinator
// （Socratic 06 Q4 收紧的"隔离原则在 compact 维度延伸"代码体现）
let swarmCounter = 0;

async function runSwarm(task: string, mode: Mode, parentAsk: AskFn): Promise<string> {
  const swarmId = `swarm[${swarmCounter++}]`;
  const askFn = makeRoutedAsk(swarmId, parentAsk);
  const tools = getToolsForRole("swarm-worker");
  const messages: any[] = [{ role: "user", content: task }];
  const swarmSystem = SYSTEM_PROMPT + "\nYou are a swarm worker. You do NOT have ask_user or spawn_swarm. " +
    "If you cannot proceed without user confirmation, the harness routes an ask request to the coordinator on your behalf.";
  console.log(`\n========== ${swarmId} LIFECYCLE ==========`);
  console.log(`task: ${task} | mode: ${mode} | tools: ${tools.map((t: any) => t.name).join(",")}`);
  await runRounds(messages, swarmSystem, tools, mode, "swarm-worker", askFn, undefined,
    (n, sr) => `---------- ${swarmId} ROUND ${n}  stop_reason=${sr} ----------`);
  console.log(`\n========== ${swarmId} FINAL MESSAGES ==========`);
  console.log(JSON.stringify(messages, null, 2));
  const last = messages[messages.length - 1];
  const summary = last?.role === "assistant"
    ? (last.content as any[]).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim() || "(swarm produced no final text)"
    : "(swarm did not end on assistant turn)";
  return `[${swarmId}] ${summary}`;
}

async function runCoordinator(userPrompt: string, mode: Mode): Promise<void> {
  const tools = getToolsForRole("coordinator");
  const messages: any[] = [{ role: "user", content: userPrompt }];
  const spawnFn = (task: string, swarmMode: Mode) => runSwarm(task, swarmMode, interactiveAsk);
  await runRounds(messages, SYSTEM_PROMPT, tools, mode, "coordinator", interactiveAsk, spawnFn,
    (n, sr) => `========== ROUND ${n}  stop_reason=${sr} ==========`);
  console.log(`\n========== FINAL MESSAGES ==========`);
  console.log(JSON.stringify(messages, null, 2));
}

async function runInteractive(userPrompt: string, mode: Mode): Promise<void> {
  const tools = getToolsForRole("interactive");
  const messages: any[] = [{ role: "user", content: userPrompt }];
  await runRounds(messages, SYSTEM_PROMPT, tools, mode, "interactive", interactiveAsk, undefined,
    (n, sr) => `========== ROUND ${n}  stop_reason=${sr} ==========`);
  console.log(`\n========== FINAL MESSAGES ==========`);
  console.log(JSON.stringify(messages, null, 2));
}

function parseFlags(argv: string[]) {
  const arg = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const role = (arg("role") ?? "interactive") as Role;
  if (!["interactive", "coordinator", "swarm-worker"].includes(role)) throw new Error(`Invalid role: ${role}`);
  const mode = (arg("mode") ?? "bypassPermissions") as Mode;
  const hookSet = arg("hooks") ?? "none"; // none | tool | compact | all | fail
  const userPrompt = arg("prompt") ?? "请依次读取 /tmp/a.txt /tmp/b.txt /tmp/c.txt /tmp/d.txt /tmp/e.txt /tmp/f.txt 这 6 个文件，每次只读一个，每读完一个先用一句话总结再读下一个。";
  return { role, mode, hookSet, userPrompt };
}

function registerDefaultHooks(set: string): void {
  if (set === "tool" || set === "all" || set === "fail") {
    hooks.register("PreToolUse", { kind: "function", name: "log-pre-tool",
      fn: async (ctx) => ({ ok: true, reason: `pre tool=${ctx.tool} input=${JSON.stringify(ctx.input).slice(0, 60)}` }) });
    hooks.register("PostToolUse", { kind: "function", name: "log-post-tool",
      fn: async (ctx) => ({ ok: true, reason: `post tool=${ctx.tool} is_error=${ctx.result?.is_error}` }) });
  }
  if (set === "compact" || set === "all") {
    hooks.register("PreCompact", { kind: "function", name: "log-pre-compact",
      fn: async (ctx) => ({ ok: true, reason: `role=${ctx.role} rounds=${ctx.rounds} bytes=${ctx.bytes}` }) });
    hooks.register("PostCompact", { kind: "function", name: "log-post-compact",
      fn: async (ctx) => ({ ok: true, reason: `role=${ctx.role} before=${ctx.before} after=${ctx.after}` }) });
  }
  if (set === "fail") {
    // 教学：3 个 hook 在同一 event 上，一个抛错、一个超时、一个正常 —— 验证 Promise.allSettled 隔离 + 核心不阻断
    hooks.register("PreToolUse", { kind: "function", name: "throws-immediately",
      fn: async () => { throw new Error("intentional hook failure"); } });
    hooks.register("PreToolUse", { kind: "function", name: "slow-loris",
      fn: async () => { await new Promise((r) => setTimeout(r, 5000)); return { ok: true }; }, timeout: 300 });
    hooks.register("PreToolUse", { kind: "function", name: "still-running",
      fn: async (ctx) => ({ ok: true, reason: `peer hooks failed but I still ran for tool=${ctx.tool}` }) });
  }
}

// ---------- 11. ObservabilitySink: 三形态 mock sink (logs JSONL + metrics counter Map + context Map) ----------
// 对照 claude-code: events.ts:71-74 (eventLogger.emit logs) + permissionLogging.ts:216 (counter.add metrics) + :221-228 (toolUseContext.toolDecisions Map context)
// 三形态消费时机不同（Socratic 09 Q4 内化）: logs 异步导出事后调试 / metrics 异步聚合触发告警 / context map 同步 inspect 同进程查询
import { appendFileSync, writeFileSync } from "node:fs"; // 用 appendFileSync 保证多次写 logs JSONL 不覆盖（Bun.file().writer() 会 truncate）
const OBS_LOGS_PATH = "/tmp/v7-obs-logs.jsonl";
writeFileSync(OBS_LOGS_PATH, ""); // 启动时清空，确保每次运行 logs 干净
const obsContextMap = new Map<string, { event: string; timestamp: number; attributes: any }>();
const obsMetricCounters = new Map<string, Map<string, number>>(); // metricName → labelKey → count

class ObservabilitySink {
  static logs(eventName: string, attributes: any): void {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), event_name: eventName, attributes }) + "\n";
    try { appendFileSync(OBS_LOGS_PATH, line); } catch { /* sink 失败永不抛 */ }
    audit(`[OBS event=${eventName} sink=logs attrs=${JSON.stringify(attributes).slice(0, 80)}]`);
  }
  // cardinality 控制（Socratic 09 Q2 内化）: 白名单字段才能作 metric label，高基数字段拒绝 + audit
  static readonly METRIC_LABEL_WHITELIST = new Set(["tool_name", "role", "decision", "mode", "event", "is_error"]);
  static metrics(metricName: string, labels: Record<string, string>): void {
    for (const k of Object.keys(labels)) {
      if (!this.METRIC_LABEL_WHITELIST.has(k)) {
        audit(`[OBS REJECT cardinality: field=${k} not in whitelist={tool_name,role,decision,mode,event,is_error}]`);
        return; // 拒绝整次 inc，避免 metric backend 时序段爆炸
      }
    }
    const labelKey = Object.entries(labels).sort().map(([k, v]) => `${k}=${v}`).join(",");
    if (!obsMetricCounters.has(metricName)) obsMetricCounters.set(metricName, new Map());
    const bucket = obsMetricCounters.get(metricName)!;
    bucket.set(labelKey, (bucket.get(labelKey) ?? 0) + 1);
    audit(`[OBS event=${metricName} sink=metrics labels=${labelKey} count=${bucket.get(labelKey)}]`);
  }
  static contextMap(toolUseId: string, eventName: string, attributes: any): void {
    obsContextMap.set(toolUseId, { event: eventName, timestamp: Date.now(), attributes });
    audit(`[OBS event=${eventName} sink=contextMap toolUseId=${toolUseId.slice(0, 24)}]`);
  }
  static dumpAll(): void {
    console.log(`\n========== OBS METRIC counter dump ==========`);
    for (const [metricName, bucket] of obsMetricCounters) {
      for (const [labelKey, count] of bucket) console.log(`  ${metricName}{${labelKey}} = ${count}`);
    }
    console.log(`\n========== OBS CONTEXT MAP dump ==========`);
    for (const [id, entry] of obsContextMap) console.log(`  ${id.slice(0, 32)} → event=${entry.event} attrs=${JSON.stringify(entry.attributes).slice(0, 80)}`);
  }
}

// ---------- 12. emitObservability fan-out 单一入口 + privacy redact + cardinality 测试调用 ----------
// 对照 claude-code permissionLogging.ts:181-235 (logPermissionDecision 单一入口 fan-out 4 sink 教科书范本)
// 对照 claude-code events.ts:17-19 (redactIfDisabled 字面量) + :49 (prompt.id only events 注释)
// Socratic 09 Q1 内化: 单一入口保证语义一致 / 新增 sink 改 1 处 vs N 处
// Socratic 09 Q3 内化: redact 在 sink 包装层 / 跟 task 02 v1「靠 model 自觉」反例同源 —— 机制层 1 处 vs 业务层 N 处
const REDACTED = "<REDACTED>";
const isUserPromptLoggingEnabled = () => process.env.OTEL_LOG_USER_PROMPTS === "1";
const redactIfDisabled = (content: string): string => isUserPromptLoggingEnabled() ? content : REDACTED;

// extractAttributes: 字段抽取（redact 在抽取时统一应用，业务层永远拿不到原文）
function extractAttributes(event: string, ctx: any): { metricLabels: Record<string, string>; logAttrs: any; toolUseId: string } {
  const isPreOrPost = event === "PreToolUse" || event === "PostToolUse";
  const toolUseId = ctx?.tool_use_id ?? ctx?.input?.tool_use_id ?? `${event}-${Date.now()}`;
  // 低基数字段（metric label）—— 严格只取白名单内字段
  const metricLabels: Record<string, string> = { event };
  if (isPreOrPost && ctx?.tool) metricLabels.tool_name = String(ctx.tool);
  if (ctx?.role) metricLabels.role = String(ctx.role);
  if (ctx?.mode) metricLabels.mode = String(ctx.mode);
  if (event === "PostToolUse") metricLabels.is_error = String(ctx?.result?.is_error ?? false);
  // 高基数字段（events only）—— 含 redact 处理
  const logAttrs: any = { ...metricLabels };
  if (ctx?.input?.path) logAttrs.file_path = ctx.input.path; // 故意高基数，metric 拒绝 events 可
  if (ctx?.input?.question) logAttrs.user_question = redactIfDisabled(String(ctx.input.question));
  if (ctx?.input?.content) logAttrs.edit_content = redactIfDisabled(String(ctx.input.content).slice(0, 200));
  if (ctx?.rounds) logAttrs.rounds = ctx.rounds;
  if (ctx?.before !== undefined && ctx?.after !== undefined) { logAttrs.bytes_before = ctx.before; logAttrs.bytes_after = ctx.after; }
  return { metricLabels, logAttrs, toolUseId };
}

// fan-out 单一入口: 1 个函数 → 3 个 sink (Socratic 09 Q1 内化)
function emitObservability(event: string, ctx: any): { ok: boolean } {
  try {
    const { metricLabels, logAttrs, toolUseId } = extractAttributes(event, ctx);
    ObservabilitySink.logs(event, logAttrs);           // sink 1: 高基数字段全收，含 redact
    ObservabilitySink.metrics(`harness.${event}`, metricLabels);  // sink 2: 严格低基数 label
    ObservabilitySink.contextMap(toolUseId, event, logAttrs);     // sink 3: 同步 inspect 接口
    return { ok: true };
  } catch (e) { audit(`[OBS ERROR] ${String(e).slice(0, 100)}`); return { ok: false }; }
}

// cardinality 控制实测函数: 故意把 file_path 加到 metric labels，看 sink 拒绝
function runCardinalityRejectTest(): void {
  audit(`[OBS TEST] cardinality reject test —— intentionally passing file_path to metric counter`);
  ObservabilitySink.metrics("cardinality-test", { tool_name: "delete_file", file_path: "/tmp/test.txt" });
  ObservabilitySink.metrics("cardinality-test", { tool_name: "delete_file", prompt_id: "uuid-xyz-123" });
  audit(`[OBS TEST] cardinality reject test —— both attempts should have been rejected above`);
}

// 注册 obs handlers 到 v6 hook 系统
function registerObsHooks(): void {
  for (const event of ["PreToolUse", "PostToolUse", "PreCompact", "PostCompact"] as HookEvent[]) {
    hooks.register(event, { kind: "function", name: `obs-${event}`,
      fn: async (ctx) => { emitObservability(event, ctx); return { ok: true, reason: "obs emitted" }; } });
  }
}

// ---------- 13. 配置 + callModel + 启动入口（注册默认 hooks + obs hooks + 结束时 dump）----------
const settings = JSON.parse(await Bun.file(`${process.env.HOME}/.claude-dev/settings.json`).text());
const { ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, ANTHROPIC_DEFAULT_HAIKU_MODEL } = settings.env;

async function callModel(messages: any[], system: string, tools: any[]): Promise<any> {
  return await fetch(`${ANTHROPIC_BASE_URL}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_AUTH_TOKEN, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: ANTHROPIC_DEFAULT_HAIKU_MODEL, max_tokens: 2048, system, messages, tools }),
  }).then((r) => r.json());
}

const SYSTEM_PROMPT =
  "You manage files via read_file / edit_file / delete_file. " +
  "If you are unsure about user intent, use ask_user to clarify (if available in your tools). " +
  "When a tool returns is_error: true, report the error honestly and suggest next steps. " +
  "If you have spawn_swarm available, prefer fanning out independent subtasks IN PARALLEL.";

const { role, mode, hookSet, userPrompt } = parseFlags(process.argv.slice(2));
registerDefaultHooks(hookSet);
// v7 新增: hookSet=obs 或 all 时注册 4 个 obs handler 到 v6 hook 系统
if (hookSet === "obs" || hookSet === "all") registerObsHooks();
// v7 新增: cardinality-test 模式只跑 cardinality 拒绝实测，不跑 agent
if (hookSet === "cardinality-test") { runCardinalityRejectTest(); ObservabilitySink.dumpAll(); process.exit(0); }
audit(`[BOOT] role=${role} mode=${mode} hooks=${hookSet} OTEL_LOG_USER_PROMPTS=${process.env.OTEL_LOG_USER_PROMPTS ?? "(unset, redacting)"}`);
try {
  if (role === "coordinator") await runCoordinator(userPrompt, mode);
  else if (role === "swarm-worker") {
    const s = await runSwarm(userPrompt, mode, interactiveAsk);
    console.log(`\n========== FINAL SUMMARY ==========\n${s}`);
  } else await runInteractive(userPrompt, mode);
} finally {
  // v7 新增: 跑完后 dump metric counter + context map（logs sink 已经实时写文件）
  if (hookSet === "obs" || hookSet === "all") ObservabilitySink.dumpAll();
}
