// Task 09 v9: mini MCP client —— v8 全继承 + 手写 JSON-RPC stdio MCP client
// v8 §1-15 字面不动 + §5 execute 加 mcp__ 前缀分支 + §16 MCPClient 类 + §17 loadMCPTools merge + 启动入口加 --mcp flag
// 对照: claude-code src/services/mcp/client.ts:944-958 (StdioClientTransport spawn) / :1768-1815 (MCP tool 与内置 tool 同结构) / :1813 (inputSchema 直接复用为 inputJSONSchema)
// 核心论断：MCP tool 与内置 tool 同权 —— 走相同 dispatch (PreToolUse/PostToolUse hook) / permission (modeMatrix) / obs (emitObservability) 管道
// 注意：claude-code 工业版用 @modelcontextprotocol/sdk，我们手写 JSON-RPC 完整 lifecycle (initialize → notifications/initialized → tools/list → tools/call)
// ---------- 1. Role + Mode + Policy + Compact 配置（v5 继承）----------
type Mode = "default" | "acceptEdits" | "bypassPermissions";
type Role = "interactive" | "coordinator" | "swarm-worker";
type Policy = "auto-allow" | "ask" | "hard-block";
const READ_LIKE = new Set(["read_file"]);
const EDIT_LIKE = new Set(["edit_file"]);
const META_TOOLS = new Set(["ask_user", "spawn_swarm"]);
const MIN_TOOL_RESULT_BYTES_TO_CLEAR = 30;
const KEEP_RECENT_ROUNDS = 2;
const MAX_ROUNDS_BEFORE_FULL_COMPACT = 4;
// v9 新增：MCP tool 前缀（仿 claude-code 工业版 mcp__<server>__<tool> 命名习惯）
const MCP_PREFIX = "mcp__mock__";
type MCPClientLike = { connect(): Promise<void>; listTools(): Promise<{name:string; description:string; inputSchema:any}[]>; callTool(name:string, args:any): Promise<string>; close(): void };
let activeMCPClient: MCPClientLike | null = null; // §16 类实现 / §18 启动入口注入
let mcpToolsExtra: any[] = []; // 由 §17 loadMCPTools 填充；§3 getToolsForRole 在末尾 spread 进每个 role 的 tools
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
  // v9 改造：在 v8 三个 role 的 base 之上，末尾 spread mcpToolsExtra —— MCP tool 对所有 role 同样可见 + 同权
  if (role === "swarm-worker") return [...BASE_TOOLS, ...mcpToolsExtra];
  if (role === "coordinator") return [...BASE_TOOLS, ASK_USER_TOOL, SPAWN_SWARM_TOOL, ...mcpToolsExtra];
  return [...BASE_TOOLS, ASK_USER_TOOL, ...mcpToolsExtra];
}
// ---------- 4. Ask 转发通道 + audit + 字节估算 helper ----------
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
// ---------- 5. Dispatch + execute + runRounds（dispatch 内 PreToolUse/PostToolUse emit）----------
async function dispatch(
  name: string, input: any, mode: Mode, role: Role, askFn: AskFn,
  spawnFn?: (task: string, swarmMode: Mode) => Promise<string>,
): Promise<{ content: string; is_error: boolean }> {
  await hooks.emit("PreToolUse", { tool: name, input, mode, role }).catch(() => []);
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
  // v9 新增：MCP tool 分支 —— 同权于内置 tool（已穿过 §5 dispatch 的 PreToolUse hook + permission gate + 即将穿过 PostToolUse + obs）
  // 对照 claude-code src/services/mcp/client.ts:1833-1971 MCPTool.call() —— 接收标准 ToolUseContext，无 isMcp 特殊分支
  if (name.startsWith(MCP_PREFIX)) {
    if (!activeMCPClient) return { content: `MCP tool ${name} called but no MCP client active (start with --mcp=<server cmd>)`, is_error: true };
    const realName = name.slice(MCP_PREFIX.length);
    try {
      const text = await activeMCPClient.callTool(realName, input);
      return { content: text, is_error: false };
    } catch (e) {
      return { content: `MCP tool ${name} failed: ${String(e).slice(0, 200)}`, is_error: true };
    }
  }
  // 模拟不同 tool 执行耗时（--sim-delay 开启）：让 yield order ≠ concat order 可观测
  if (name === "read_file" && process.argv.includes("--sim-delay")) {
    const delays: Record<string, number> = { "a.txt": 500, "b.txt": 100, "c.txt": 300, "d.txt": 50, "e.txt": 200 };
    const file = String(input.path).split("/").pop() ?? "";
    const ms = delays[file] ?? 150;
    await new Promise(r => setTimeout(r, ms));
    return { content: `Read ${input.path}: <mocked ~${ms}ms latency content>`, is_error: false };
  }
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
// runRounds: v8 新增 --stream=true streaming 分支，--stream=false 走 v7 batch 原路径
async function runRounds(
  messages: any[], system: string, tools: any[], mode: Mode, role: Role,
  askFn: AskFn, spawnFn: ((t: string, m: Mode) => Promise<string>) | undefined,
  formatHeader: (round: number, stopReason: string) => string,
): Promise<void> {
  const useStreaming = process.argv.includes("--stream=true");
  for (let round = 1; round <= 8; round++) {
    if (useStreaming) {
      // v8 streaming 模式：model 流式 yield tool_use → 立即并发执行 → yield 完成顺序
      const result = await runStreamingRound(messages, system, tools, mode, role, askFn, spawnFn, round, formatHeader);
      if (!result.continueLoop) break;
    } else {
      // v7 batch 模式：等 model 全部返回 → batch dispatch all tools → 下一轮
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
    }
    await maybeCompact(messages, role, system);
  }
}
// ---------- 6. groupByRound + microCompact（v5 继承）----------
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
// ---------- 7. fullCompact + maybeCompact（maybeCompact 内 PreCompact/PostCompact emit）----------
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
  const res = await callModel(compactionMessages, NO_TOOLS_PREAMBLE, []);
  const summary = (res.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim()
    || "(compaction LLM returned no text — fallback)";
  let firstValid = 0;
  while (firstValid < toKeep.length && toKeep[firstValid].role === "user"
         && Array.isArray(toKeep[firstValid].content)
         && toKeep[firstValid].content.some((b: any) => b.type === "tool_result")) { firstValid++; }
  messages.length = 0;
  messages.push({ role: "user", content: `[COMPACTED SUMMARY]\n${summary}` });
  for (let j = firstValid; j < toKeep.length; j++) messages.push(toKeep[j]);
  const afterBytes = estimateBytes(messages);
  console.log(`\n========== COMPACT EVENT round=${rounds.length} type=full role=${role} before=${beforeBytes} after=${afterBytes} ==========`);
  console.log(`summary (first 600 chars): ${summary.slice(0, 600)}`);
  return { before: beforeBytes, after: afterBytes, rounds: rounds.length };
}
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
// ---------- 8. HookRegistry：注册中心 + emit Promise.allSettled 隔离 ----------
type HookEvent = "PreToolUse" | "PostToolUse" | "PreCompact" | "PostCompact";
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
// ---------- 9. Handler 形态：Function / Prompt / Http (含 SSRF guard) ----------
type FunctionHandler = { kind: "function"; name: string; fn: (ctx: any) => Promise<{ ok: boolean; reason?: string }>; timeout?: number };
type PromptHandler = { kind: "prompt"; name: string; prompt: string; timeout?: number };
type HttpHandler = { kind: "http"; name: string; url: string; timeout?: number };
type HookHandler = FunctionHandler | PromptHandler | HttpHandler;
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
// ---------- 10. runSwarm / runCoordinator / runInteractive ----------
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
  const hookSet = arg("hooks") ?? "none"; // none | tool | compact | all | fail | obs
  const userPrompt = arg("prompt") ?? "请依次读取 /tmp/a.txt /tmp/b.txt /tmp/c.txt /tmp/d.txt /tmp/e.txt 这 5 个文件，每次只读一个，每读完一个先用一句话总结再读下一个。";
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
    hooks.register("PreToolUse", { kind: "function", name: "throws-immediately",
      fn: async () => { throw new Error("intentional hook failure"); } });
    hooks.register("PreToolUse", { kind: "function", name: "slow-loris",
      fn: async () => { await new Promise((r) => setTimeout(r, 5000)); return { ok: true }; }, timeout: 300 });
    hooks.register("PreToolUse", { kind: "function", name: "still-running",
      fn: async (ctx) => ({ ok: true, reason: `peer hooks failed but I still ran for tool=${ctx.tool}` }) });
  }
}
// ---------- 11. ObservabilitySink: 三形态 sink (logs JSONL + metrics counter + context Map) ----------
import { appendFileSync, writeFileSync } from "node:fs";
const OBS_LOGS_PATH = "/tmp/v8-obs-logs.jsonl";
writeFileSync(OBS_LOGS_PATH, "");
const obsContextMap = new Map<string, { event: string; timestamp: number; attributes: any }>();
const obsMetricCounters = new Map<string, Map<string, number>>();
class ObservabilitySink {
  static logs(eventName: string, attributes: any): void {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), event_name: eventName, attributes }) + "\n";
    try { appendFileSync(OBS_LOGS_PATH, line); } catch { /* sink 失败永不抛 */ }
    audit(`[OBS event=${eventName} sink=logs attrs=${JSON.stringify(attributes).slice(0, 80)}]`);
  }
  static readonly METRIC_LABEL_WHITELIST = new Set(["tool_name", "role", "decision", "mode", "event", "is_error"]);
  static metrics(metricName: string, labels: Record<string, string>): void {
    for (const k of Object.keys(labels)) {
      if (!this.METRIC_LABEL_WHITELIST.has(k)) {
        audit(`[OBS REJECT cardinality: field=${k} not in whitelist={tool_name,role,decision,mode,event,is_error}]`);
        return;
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
// ---------- 12. emitObservability fan-out 单一入口 + privacy redact ----------
const REDACTED = "<REDACTED>";
const isUserPromptLoggingEnabled = () => process.env.OTEL_LOG_USER_PROMPTS === "1";
const redactIfDisabled = (content: string): string => isUserPromptLoggingEnabled() ? content : REDACTED;
function extractAttributes(event: string, ctx: any): { metricLabels: Record<string, string>; logAttrs: any; toolUseId: string } {
  const isPreOrPost = event === "PreToolUse" || event === "PostToolUse";
  const toolUseId = ctx?.tool_use_id ?? ctx?.input?.tool_use_id ?? `${event}-${Date.now()}`;
  const metricLabels: Record<string, string> = { event };
  if (isPreOrPost && ctx?.tool) metricLabels.tool_name = String(ctx.tool);
  if (ctx?.role) metricLabels.role = String(ctx.role);
  if (ctx?.mode) metricLabels.mode = String(ctx.mode);
  if (event === "PostToolUse") metricLabels.is_error = String(ctx?.result?.is_error ?? false);
  const logAttrs: any = { ...metricLabels };
  if (ctx?.input?.path) logAttrs.file_path = ctx.input.path;
  if (ctx?.input?.question) logAttrs.user_question = redactIfDisabled(String(ctx.input.question));
  if (ctx?.input?.content) logAttrs.edit_content = redactIfDisabled(String(ctx.input.content).slice(0, 200));
  if (ctx?.rounds) logAttrs.rounds = ctx.rounds;
  if (ctx?.before !== undefined && ctx?.after !== undefined) { logAttrs.bytes_before = ctx.before; logAttrs.bytes_after = ctx.after; }
  return { metricLabels, logAttrs, toolUseId };
}
function emitObservability(event: string, ctx: any): { ok: boolean } {
  try {
    const { metricLabels, logAttrs, toolUseId } = extractAttributes(event, ctx);
    ObservabilitySink.logs(event, logAttrs);
    ObservabilitySink.metrics(`harness.${event}`, metricLabels);
    ObservabilitySink.contextMap(toolUseId, event, logAttrs);
    return { ok: true };
  } catch (e) { audit(`[OBS ERROR] ${String(e).slice(0, 100)}`); return { ok: false }; }
}
function registerObsHooks(): void {
  for (const event of ["PreToolUse", "PostToolUse", "PreCompact", "PostCompact"] as HookEvent[]) {
    hooks.register(event, { kind: "function", name: `obs-${event}`,
      fn: async (ctx) => { emitObservability(event, ctx); return { ok: true, reason: "obs emitted" }; } });
  }
}
// ---------- 13. 配置 + callModel + 启动入口 ----------
const apiConfig = JSON.parse(await Bun.file(new URL(".api-config.json", import.meta.url)).text());
const ANTHROPIC_AUTH_TOKEN = apiConfig.ANTHROPIC_AUTH_TOKEN;
const ANTHROPIC_BASE_URL = apiConfig.ANTHROPIC_BASE_URL;
const MODEL_NAME = apiConfig.MODEL;
async function callModel(messages: any[], system: string, tools: any[]): Promise<any> {
  return await fetch(`${ANTHROPIC_BASE_URL}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_AUTH_TOKEN, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL_NAME, max_tokens: 2048, system, messages, ...(tools.length > 0 ? { tools } : {}) }),
  }).then((r) => r.json());
}
const SYSTEM_PROMPT =
  "You manage files via read_file / edit_file / delete_file. " +
  "If you are unsure about user intent, use ask_user to clarify (if available in your tools). " +
  "When a tool returns is_error: true, report the error honestly and suggest next steps. " +
  "If you have spawn_swarm available, prefer fanning out independent subtasks IN PARALLEL.";
// ---------- 14. StreamingToolExecutor: async generator + Promise.race yield 顺序 + pending Map<id, Promise> ----------
// 对照 claude-code StreamingToolExecutor.ts:40-531: addTool 立即启动 / getCompletedResults 同步 poll / getRemainingResults async drain
// 对照 grouping.ts:29-31 "yield order, not concat order" / query.ts:841-843 addTool in streaming loop
// v8 教学简化：所有 tool 均视为 concurrent-safe（mock），用 Promise.race 实现真正的 yield order
type StreamingToolEntry = {
  toolUseId: string;
  name: string;
  input: any;
  enqueuedAt: number;       // performance.now() 用于 wallclock 审计
  promise: Promise<{ content: string; is_error: boolean }>;
};
class StreamingToolExecutor {
  private pending: StreamingToolEntry[] = [];
  private mode: Mode;
  private role: Role;
  private askFn: AskFn;
  private spawnFn?: (task: string, swarmMode: Mode) => Promise<string>;
  constructor(mode: Mode, role: Role, askFn: AskFn, spawnFn?: (task: string, swarmMode: Mode) => Promise<string>) {
    this.mode = mode;
    this.role = role;
    this.askFn = askFn;
    this.spawnFn = spawnFn;
  }
  // 立即 enqueue + 启动 dispatch（不等其他 tool / 不等 stop_reason）
  enqueue(toolUseId: string, name: string, input: any): void {
    const enqueuedAt = performance.now();
    const promise = dispatch(name, input, this.mode, this.role, this.askFn, this.spawnFn);
    this.pending.push({ toolUseId, name, input, enqueuedAt, promise });
    audit(`[STREAM tool_use_id=${toolUseId} name=${name} enqueued at t=${Math.round(enqueuedAt)} ms]`);
  }
  // 按完成顺序 yield（Promise.race 反复挑最先完成的 —— "yield order, not concat order"）
  async *yieldResults(): AsyncGenerator<{ toolUseId: string; name: string; result: { content: string; is_error: boolean }; completedAt: number; duration: number }> {
    const remaining = [...this.pending];
    while (remaining.length > 0) {
      // Promise.race: 挑第一个 settle 的（不管 index）
      const winner = await Promise.race(
        remaining.map((entry, i) => entry.promise.then(result => ({ result, index: i, entry })))
      );
      const completedAt = performance.now();
      const duration = completedAt - winner.entry.enqueuedAt;
      audit(`[STREAM tool_use_id=${winner.entry.toolUseId} name=${winner.entry.name} completed at t=${Math.round(completedAt)} ms duration=${Math.round(duration)} ms]`);
      yield { toolUseId: winner.entry.toolUseId, name: winner.entry.name, result: winner.result, completedAt, duration };
      remaining.splice(winner.index, 1);
    }
  }
  get size(): number { return this.pending.length; }
}
// ---------- 15. callModelStreaming + runStreamingRound + wallclock 测量 ----------
// 对照 query.ts:659-708 for await streaming loop / 模拟 SSE 用 setTimeout 延迟 yield chunks
type StreamChunk =
  | { type: "thinking"; thinking: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: any }
  | { type: "stop"; stop_reason: string };
async function* callModelStreaming(messages: any[], system: string, tools: any[]): AsyncGenerator<StreamChunk> {
  const response = await callModel(messages, system, tools);
  if (!response.content) {
    yield { type: "stop", stop_reason: response.stop_reason ?? "error" };
    return;
  }
  // 模拟逐块流出：把 batch 返回拆成 chunks，每个加 100ms 延迟（模拟 model token-by-token 输出的累积延迟）
  for (const block of response.content) {
    if (block.type === "thinking") {
      yield { type: "thinking", thinking: block.thinking };
    } else if (block.type === "text") {
      yield { type: "text", text: block.text };
    } else if (block.type === "tool_use") {
      yield { type: "tool_use", id: block.id, name: block.name, input: block.input };
    }
    await new Promise(r => setTimeout(r, 100)); // 模拟流间隔
  }
  yield { type: "stop", stop_reason: response.stop_reason };
}
// runStreamingRound: 流式接收 → 立即 enqueue tool_use → 收集完成顺序结果（pipelining 核心）
async function runStreamingRound(
  messages: any[], system: string, tools: any[], mode: Mode, role: Role,
  askFn: AskFn, spawnFn: ((t: string, m: Mode) => Promise<string>) | undefined,
  round: number, formatHeader: (round: number, stopReason: string) => string,
): Promise<{ continueLoop: boolean }> {
  const roundStart = performance.now();
  const executor = new StreamingToolExecutor(mode, role, askFn, spawnFn);
  const collectedAssistant: any[] = [];
  let stopReason = "end_turn";
  // Phase 1: 流式接收 model chunks + 流式 enqueue tool_use
  const streamStart = performance.now();
  for await (const chunk of callModelStreaming(messages, system, tools)) {
    if (chunk.type === "tool_use") {
      executor.enqueue(chunk.id, chunk.name, chunk.input);
      collectedAssistant.push({ type: "tool_use", id: chunk.id, name: chunk.name, input: chunk.input });
    } else if (chunk.type === "thinking") {
      collectedAssistant.push({ type: "thinking", thinking: chunk.thinking });
    } else if (chunk.type === "text") {
      collectedAssistant.push({ type: "text", text: chunk.text });
    } else if (chunk.type === "stop") {
      stopReason = chunk.stop_reason;
      break;
    }
  }
  const streamEnd = performance.now();
  console.log(`\n${formatHeader(round, stopReason)}`);
  console.log(JSON.stringify(collectedAssistant, null, 2));
  messages.push({ role: "assistant", content: collectedAssistant });
  if (stopReason !== "tool_use") {
    // 无 tool_use → 对话结束，打印 wallclock
    const roundEnd = performance.now();
    console.log(`\n========== WALLCLOCK SUMMARY ==========`);
    console.log(`  total: ${Math.round(roundEnd - roundStart)} ms`);
    console.log(`  model_streaming: ${Math.round(streamEnd - streamStart)} ms`);
    console.log(`  tool_execution_overlap: 0 ms (no tools this round)`);
    return { continueLoop: false };
  }
  // Phase 2: 收集所有 tool 结果（按完成顺序 yield —— interleaves, not concat order）
  const toolResults: any[] = [];
  const toolExecutionStart = performance.now();
  for await (const { toolUseId, result } of executor.yieldResults()) {
    toolResults.push({ type: "tool_result", tool_use_id: toolUseId, content: result.content, is_error: result.is_error });
  }
  const toolExecutionEnd = performance.now();
  messages.push({ role: "user", content: toolResults });
  const roundEnd = performance.now();
  const modelStreaming = streamEnd - streamStart;
  const toolExecution = toolExecutionEnd - toolExecutionStart;
  const overlap = Math.max(0, Math.round(modelStreaming + toolExecution - (roundEnd - roundStart)));
  console.log(`\n========== WALLCLOCK SUMMARY ==========`);
  console.log(`  total: ${Math.round(roundEnd - roundStart)} ms`);
  console.log(`  model_streaming: ${Math.round(modelStreaming)} ms`);
  console.log(`  tool_execution: ${Math.round(toolExecution)} ms`);
  console.log(`  tool_execution_overlap: ${overlap} ms`);
  console.log(`  pipelining_savings: ${Math.round(modelStreaming + toolExecution - (roundEnd - roundStart))} ms`);
  return { continueLoop: true };
}
// ---------- 16. MCPClient: 手写 JSON-RPC over stdio (newline-delimited JSON) ----------
// 对照 claude-code @modelcontextprotocol/sdk Client + StdioClientTransport / spec.types.d.ts:129-150 JSONRPCRequest
// 教学简化：单一 server / 无重连 / 无 progress 回调 / 无 elicitation —— 只保留 Request id 配对 + Promise map + initialize lifecycle
class MCPClient implements MCPClientLike {
  private proc: any = null; // Bun.Subprocess
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private buffer = "";
  private closed = false;
  constructor(private serverCmd: string[]) {}
  async connect(): Promise<void> {
    audit(`[MCP spawn cmd=${this.serverCmd.join(" ")}]`);
    this.proc = Bun.spawn(this.serverCmd, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    this.startStdoutReader();
    this.startStderrReader();
    // SDK 强制：第一个 request 必须是 initialize（client.ts:1048-1080 client.connect → initialize → notifications/initialized）
    const initResult = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      clientInfo: { name: "v9-agent", version: "0.1.0" },
    });
    audit(`[MCP initialize → ${JSON.stringify(initResult).slice(0, 120)}]`);
    // 发 notifications/initialized notification（无 id 无 response）
    this.sendRaw({ jsonrpc: "2.0", method: "notifications/initialized" });
  }
  async listTools(): Promise<{ name: string; description: string; inputSchema: any }[]> {
    const result = await this.request("tools/list", {});
    audit(`[MCP tools/list → ${result.tools.length} tools: ${result.tools.map((t: any) => t.name).join(",")}]`);
    return result.tools;
  }
  async callTool(name: string, args: any): Promise<string> {
    const result = await this.request("tools/call", { name, arguments: args });
    // MCP 返回 content: [{type:"text", text:"..."}, ...] —— 我们拼接成单 string
    const text = (result.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
    return text || JSON.stringify(result);
  }
  close(): void { this.closed = true; this.proc?.kill?.(); }
  private async request(method: string, params: any): Promise<any> {
    const id = this.nextId++;
    const promise = new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`MCP timeout: ${method} id=${id} after 30000ms`)); } }, 30000);
    });
    this.sendRaw({ jsonrpc: "2.0", id, method, params });
    return promise;
  }
  private sendRaw(msg: any): void {
    const line = JSON.stringify(msg) + "\n";
    this.proc.stdin.write(line);
  }
  private async startStdoutReader(): Promise<void> {
    const reader = this.proc.stdout.getReader();
    const decoder = new TextDecoder();
    while (!this.closed) {
      const { value, done } = await reader.read();
      if (done) break;
      this.buffer += decoder.decode(value, { stream: true });
      let nl = this.buffer.indexOf("\n");
      while (nl !== -1) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        if (line.trim()) this.handleLine(line);
        nl = this.buffer.indexOf("\n");
      }
    }
  }
  private async startStderrReader(): Promise<void> {
    const reader = this.proc.stderr.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (!this.closed) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (line.trim()) audit(`[MCP server-stderr] ${line}`);
        nl = buf.indexOf("\n");
      }
    }
  }
  private handleLine(line: string): void {
    let msg: any;
    try { msg = JSON.parse(line); } catch (e) { audit(`[MCP parse error] ${String(e).slice(0, 80)} line=${line.slice(0, 120)}`); return; }
    if (msg.id === undefined || msg.id === null) { audit(`[MCP notification recv method=${msg.method}]`); return; }
    const entry = this.pending.get(msg.id);
    if (!entry) { audit(`[MCP orphan response id=${msg.id}]`); return; }
    this.pending.delete(msg.id);
    if (msg.error) entry.reject(new Error(`MCP error code=${msg.error.code} msg=${msg.error.message}`));
    else entry.resolve(msg.result);
  }
}
// ---------- 17. loadMCPTools: MCP tool → Anthropic tool schema (加 mcp__ 前缀防冲突) ----------
// 对照 claude-code src/services/mcp/client.ts:1768-1815 fetchToolsForClient —— buildMcpToolName(serverName, toolName) = "mcp__<server>__<tool>"
// 关键：MCP 的 inputSchema 本就是 JSON Schema 格式（spec.types.d.ts:1172-1214），Anthropic API 也接受 JSON Schema —— 零转换
async function loadMCPTools(client: MCPClient): Promise<any[]> {
  const mcpTools = await client.listTools();
  const merged = mcpTools.map((t) => ({
    name: `${MCP_PREFIX}${t.name}`,
    description: `[MCP/mock-server] ${t.description}`,
    input_schema: t.inputSchema, // JSON Schema 直接复用
  }));
  audit(`[MCP merged ${merged.length} tools into registry: ${merged.map((t) => t.name).join(",")}]`);
  return merged;
}
// ---------- 18. 启动入口（v9 扩展 --mcp flag）----------
const { role, mode, hookSet, userPrompt } = parseFlags(process.argv.slice(2));
const mcpServerArg = process.argv.find((a) => a.startsWith("--mcp="))?.slice(6);
registerDefaultHooks(hookSet);
if (hookSet === "obs" || hookSet === "all") registerObsHooks();
const streamMode = process.argv.includes("--stream=true") ? "streaming" : "batch";
audit(`[BOOT] role=${role} mode=${mode} hooks=${hookSet} stream=${streamMode} mcp=${mcpServerArg ?? "(disabled)"} OTEL_LOG_USER_PROMPTS=${process.env.OTEL_LOG_USER_PROMPTS ?? "(unset, redacting)"}`);
// v9 新增：启动 MCP client + 把 MCP tool merge 进 mcpToolsExtra（getToolsForRole 在 §3 已改造为 append mcpToolsExtra）
if (mcpServerArg) {
  const mcpClient = new MCPClient(mcpServerArg.split(/\s+/));
  await mcpClient.connect();
  activeMCPClient = mcpClient;
  mcpToolsExtra = await loadMCPTools(mcpClient);
}
try {
  // §10 三个 run* 通过 getToolsForRole 取 tools —— MCP merge 在 §3 已完成，run* 字面零修改
  if (role === "coordinator") await runCoordinator(userPrompt, mode);
  else if (role === "swarm-worker") {
    const s = await runSwarm(userPrompt, mode, interactiveAsk);
    console.log(`\n========== FINAL SUMMARY ==========\n${s}`);
  } else await runInteractive(userPrompt, mode);
} finally {
  if (hookSet === "obs" || hookSet === "all") ObservabilitySink.dumpAll();
  if (activeMCPClient) { audit(`[MCP shutting down]`); activeMCPClient.close(); }
}
