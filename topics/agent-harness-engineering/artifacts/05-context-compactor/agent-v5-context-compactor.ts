// Task 05 v5: context compactor —— 双层 compaction（micro + full）作为独立 sub-system
// v4 (tool×mode×role) + 不动 dispatch/role 逻辑下加 §6/7/8 compact 子模块 + §5 runRounds 末加 maybeCompact 钩子
// 重点：round 原子单位 / 事实≠原文 / 专用 LLM call / 隔离原则跨维度延伸
// 对照: claude-code/src/services/compact/{grouping.ts (63),microCompact.ts:36 字面量,prompt.ts:19 NO_TOOLS_PREAMBLE,compact.ts:387-624 fullCompact}

// ---------- 1. Role + Mode + Policy + Compact 配置 ----------
// v4 三维矩阵继承不动。新增 4 个 compact 阈值常量（顶部集中可调）。
// 对照 claude-code: autoCompact.ts:72-90 三层阈值 + 熔断器；v5 简化为 2 个粒度 + 静态阈值。
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

// ---------- 5. Dispatch + execute + runRounds（runRounds 末尾加 maybeCompact 钩子）----------
async function dispatch(
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

// ---------- 6. groupByRound: messages 按 API round 三元组分组 ----------
// 对照 claude-code grouping.ts:22-63 用 assistant.message.id 边界；v5 简化为按 assistant 出现切分。
// 每 round = [可选 user(初始prompt 或 tool_results), assistant(text/thinking/tool_use)] —— assistant 是边界。
// 协议约束（Socratic 06 Q1 收紧）：tool_use 与 tool_result 必须同一 round / 同压同留。
function groupByRound(messages: any[]): any[][] {
  const groups: any[][] = [];
  let cur: any[] = [];
  for (const m of messages) {
    cur.push(m);
    if (m.role === "assistant") { groups.push(cur); cur = []; }
  }
  if (cur.length > 0) groups.push(cur); // 不完整 round（user 拼回后 model 还没回）单独一组
  return groups;
}

// ---------- 7. microCompact: 单个 tool_result 内容替换（事实≠原文）----------
// 对照 claude-code microCompact.ts:36 const TIME_BASED_MC_CLEARED_MESSAGE = '[Old tool result content cleared]'
// 触发原则（Socratic 06 Q2 收紧）：model 在后续 round 的 reasoning text 已融入信息，原文是冷状态，可释放。
// 跳过最近 KEEP_RECENT_ROUNDS 个 round（保留 ongoing context），跳过已 cleared 的，跳过小 result。
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

// ---------- 8. fullCompact + maybeCompact: 专用 LLM call 把段历史压成 summary 文本 ----------
// 对照 claude-code prompt.ts:19-26 NO_TOOLS_PREAMBLE（强制 text-only，禁工具）+ compact.ts:614-624 插回 user message.
// 触发原则（Socratic 06 Q3 内化）：compact 是 harness 主动物理动作，调一次专用 LLM call，与主 loop 隔离。
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

// maybeCompact: 优先级链 — 先 microCompact（成本低），未达期望释放 → fullCompact（成本高调 LLM）
// runRounds 唯一介入点，独立 sub-system 不污染 dispatch/role 逻辑（Socratic 05 Q2 "独立 sub-system" 原则）
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
    await fullCompact(messages, role, system);
  }
}

// ---------- 9. runSwarm / runCoordinator / runInteractive（v4 继承，maybeCompact 自动作用于各 messages 数组）----------
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
  const userPrompt = arg("prompt") ?? "请依次读取 /tmp/a.txt /tmp/b.txt /tmp/c.txt /tmp/d.txt /tmp/e.txt /tmp/f.txt 这 6 个文件，每次只读一个，每读完一个先用一句话总结再读下一个。";
  return { role, mode, userPrompt };
}

// ---------- 10. 配置 + callModel + 启动入口 ----------
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

const { role, mode, userPrompt } = parseFlags(process.argv.slice(2));
if (role === "coordinator") await runCoordinator(userPrompt, mode);
else if (role === "swarm-worker") {
  const s = await runSwarm(userPrompt, mode, interactiveAsk);
  console.log(`\n========== FINAL SUMMARY ==========\n${s}`);
} else await runInteractive(userPrompt, mode);
