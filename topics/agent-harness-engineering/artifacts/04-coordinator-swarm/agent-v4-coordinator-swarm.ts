// Task 04 v4: coordinator + swarm worker harness
// v3 (tool × mode) → v4 (tool × mode × agent-role) + coordinator/swarm 二分
// 重点：判决统一 / 执行多态 / context 隔离
// 对照: claude-code/src/coordinator/coordinatorMode.ts + src/hooks/toolPermission/handlers/{coordinator,swarmWorker,interactive}Handler.ts

// ---------- 1. Role 枚举 + 三维矩阵函数 ----------
// role 是物理约束维度（Socratic 05 Q1）。matrix(tool, input, mode, role) → policy 只输出 policy；
// 执行多态在 §5 dispatch。注意 role 参数当前不参与 policy 计算——这是有意的，体现"判决统一"。
// 工业实现里 role 也不影响 policy (permissions.ts)，只影响 handler 选择 (useCanUseTool.tsx:95-165)。
type Mode = "default" | "acceptEdits" | "bypassPermissions";
type Role = "interactive" | "coordinator" | "swarm-worker";
type Policy = "auto-allow" | "ask" | "hard-block";

const READ_LIKE = new Set(["read_file"]);
const EDIT_LIKE = new Set(["edit_file"]);
const META_TOOLS = new Set(["ask_user", "spawn_swarm"]); // 元工具：执行本身就是 user/swarm 交互

function modeMatrix(tool: string, input: any, mode: Mode, _role: Role): Policy {
  if (isHardBlocked(tool, input)) return "hard-block"; // 与 mode / role 都正交
  if (META_TOOLS.has(tool)) return "auto-allow";
  if (READ_LIKE.has(tool)) return "auto-allow";
  if (mode === "bypassPermissions") return "auto-allow";
  if (mode === "acceptEdits" && EDIT_LIKE.has(tool)) return "auto-allow";
  return "ask";
}

// ---------- 2. Hard-block 列表（v3 继承，role/mode 都正交）----------
// 参考 claude-code permissions.ts:1252-1260 的 safetyCheck。
// "hard-block 防 user 自己" 是 Socratic 04 已确认的核心抽象。
const HARD_BLOCK_PATHS = ["/", "/etc", "/usr", "/System", "/Library", "/bin", "/sbin"];

function isHardBlocked(tool: string, input: any): boolean {
  if (tool !== "delete_file" && tool !== "edit_file") return false;
  const path = String(input?.path ?? "");
  return HARD_BLOCK_PATHS.some((p) => path === p || path.startsWith(p + "/"));
}

// ---------- 3. Tools schema 按 role 分化（物理约束的代码体现）----------
// swarm-worker 的 tools schema 字面量不含 ask_user / spawn_swarm —— Socratic 05 Q2
// 内化的"swarm 无 ask 是物理约束"在代码里的字面量体现：不是"建议 model 不要用"，
// 是"schema 里根本没有这个工具"。对照 claude-code: createSubagentContext + 工具裁剪。
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
const ASK_USER_TOOL = {
  name: "ask_user", description: "Ask the human user a clarifying question and get their reply.",
  input_schema: obj({ question: str }, ["question"]),
};
const SPAWN_SWARM_TOOL = {
  name: "spawn_swarm",
  description: "Spawn a swarm worker to handle an independent subtask. Returns worker's text summary. " +
    "Tip: fan out parallel work by emitting MULTIPLE spawn_swarm calls in ONE turn — they run concurrently.",
  input_schema: obj(
    { task: { type: "string", description: "Subtask for the swarm worker." },
      mode: { type: "string", enum: ["default", "acceptEdits", "bypassPermissions"],
              description: "Permission mode for the swarm. Inherits parent if omitted." } },
    ["task"],
  ),
};

function getToolsForRole(role: Role): any[] {
  if (role === "swarm-worker") return BASE_TOOLS;                               // 物理上无 ask_user / spawn_swarm
  if (role === "coordinator") return [...BASE_TOOLS, ASK_USER_TOOL, SPAWN_SWARM_TOOL];
  return [...BASE_TOOLS, ASK_USER_TOOL];                                         // interactive
}

// ---------- 4. Ask 转发通道（swarm → coordinator）+ audit helper ----------
// 接口：AskFn = (question, ctx) => Promise<answer>
// 当前实现：in-process Promise + closure capture（单进程，最简）
// 未来跨进程：换成 stdin/stdout pipe / Unix socket / mailbox / RPC，
//             swarm 端代码完全不变 —— 只需替换注入的 askFn。
// 对照 claude-code: swarmWorkerHandler.ts:67-147 用 mailbox + registerPermissionCallback
//                   + sendPermissionRequestViaMailbox 实现同样语义（生产级是为了跨进程隔离）。
type AskFn = (question: string, ctx: { tool: string; input: any; role: Role }) => Promise<string>;

const audit = (msg: string) => console.error(`[AUDIT] ${msg}`);
const pp = (x: any) => (x?.path ? x.path : JSON.stringify(x));

const interactiveAsk: AskFn = async (question) => {
  return (prompt(question) ?? "").trim();
};

function makeRoutedAsk(swarmId: string, parentAsk: AskFn): AskFn {
  // swarm 端的 ask 函数：包装请求 → 转发 parent → 等回传
  return async (question, ctx) => {
    audit(`role=swarm-worker swarm=${swarmId} ROUTED-UP tool=${ctx.tool} q=${JSON.stringify(question)}`);
    const answer = await parentAsk(`[from ${swarmId}] ${question}`, ctx);
    audit(`role=swarm-worker swarm=${swarmId} ROUTED-UP answer=${JSON.stringify(answer)}`);
    return answer;
  };
}

// ---------- 5. Dispatch 入口（按 role 多态执行）----------
// 判决统一：modeMatrix(tool, input, mode, role) → policy（§1）
// 执行多态：ask policy 在不同 role 下走不同 askFn —— interactive/coordinator 用 readline,
//          swarm-worker 用 makeRoutedAsk 包装的 parentAsk（向上转发）
// 对照 claude-code: useCanUseTool.tsx:95-165 的三层 handler 分发是同一思想。
async function dispatch(
  name: string,
  input: any,
  mode: Mode,
  role: Role,
  askFn: AskFn,
  spawnFn?: (task: string, swarmMode: Mode) => Promise<string>,
): Promise<{ content: string; is_error: boolean }> {
  const policy = modeMatrix(name, input, mode, role);

  if (policy === "hard-block") {
    audit(`role=${role} hard-block tool=${name} path=${input?.path} mode=${mode} (bypass-immune)`);
    return {
      content: `Hard-block: ${input?.path} is in the protected path list and cannot be ${name === "delete_file" ? "deleted" : "edited"} even in bypass mode.`,
      is_error: true,
    };
  }

  if (policy === "ask") {
    const ans = (await askFn(`mode=${mode} Allow ${name} on ${pp(input)}? [y/N]`, { tool: name, input, role })).toLowerCase();
    if (ans !== "y") return { content: `User denied ${name}: ${pp(input)}`, is_error: true };
    return execute(name, input, askFn, spawnFn, mode);
  }

  // auto-allow
  if (mode !== "default" && !READ_LIKE.has(name) && !META_TOOLS.has(name)) {
    audit(`role=${role} auto-allow tool=${name} mode=${mode} input=${pp(input)}`);
  }
  return execute(name, input, askFn, spawnFn, mode);
}

async function execute(
  name: string, input: any, askFn: AskFn,
  spawnFn: ((task: string, swarmMode: Mode) => Promise<string>) | undefined, mode: Mode,
): Promise<{ content: string; is_error: boolean }> {
  if (name === "read_file") return { content: `Read ${input.path}: <mocked content of ${input.path}>`, is_error: false };
  if (name === "edit_file") {
    console.log(`[MOCK] would write ${input.path} <- ${JSON.stringify(input.content).slice(0, 60)}`);
    return { content: `Edited ${input.path}`, is_error: false };
  }
  if (name === "delete_file") {
    console.log(`[MOCK] would rm -rf ${input.path}`);
    return { content: `Deleted ${input.path}`, is_error: false };
  }
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

// 共享 loop 引擎：所有 role 都用这个 body；差异在传入的 role / askFn / spawnFn / formatHeader
async function runRounds(
  messages: any[], system: string, tools: any[], mode: Mode, role: Role,
  askFn: AskFn, spawnFn: ((t: string, m: Mode) => Promise<string>) | undefined,
  formatHeader: (round: number, stopReason: string) => string,
): Promise<void> {
  for (let round = 1; round <= 6; round++) {
    const res = await callModel(messages, system, tools);
    console.log(`\n${formatHeader(round, res.stop_reason)}`);
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
}

// ---------- 6. Swarm worker runLoop ----------
// 独立 messages 数组（context 隔离 —— 物理证据）。独立 swarm system prompt。
// 工具集物理上无 ask_user / spawn_swarm。askFn = makeRoutedAsk 包装 parentAsk（向上转发）。
// 完成后从最后一条 assistant text 提取 summary 返回 coordinator —— 注意 coordinator 只
// 拿到这个 string，看不到 swarm 内部 messages 数组（context 隔离的代码可验证证据）。
// 对照 claude-code: createSubagentContext({ messages: initialMessages, ... }) 同形态。
let swarmCounter = 0;

async function runSwarm(task: string, mode: Mode, parentAsk: AskFn): Promise<string> {
  const swarmId = `swarm[${swarmCounter++}]`;
  const askFn = makeRoutedAsk(swarmId, parentAsk);
  const tools = getToolsForRole("swarm-worker");
  const messages: any[] = [{ role: "user", content: task }];
  const swarmSystem = SYSTEM_PROMPT +
    "\nYou are a swarm worker. You do NOT have ask_user or spawn_swarm. " +
    "If you cannot proceed without user confirmation, the harness routes an ask request to the coordinator on your behalf.";

  console.log(`\n========== ${swarmId} LIFECYCLE ==========`);
  console.log(`task: ${task} | mode: ${mode} | tools: ${tools.map((t: any) => t.name).join(",")}`);

  await runRounds(messages, swarmSystem, tools, mode, "swarm-worker", askFn, undefined,
    (n, sr) => `---------- ${swarmId} ROUND ${n}  stop_reason=${sr} ----------`);

  console.log(`\n========== ${swarmId} FINAL MESSAGES ==========`);
  console.log(JSON.stringify(messages, null, 2));

  const last = messages[messages.length - 1];
  const summary = last?.role === "assistant"
    ? (last.content as any[]).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim()
      || "(swarm produced no final text)"
    : "(swarm did not end on assistant turn)";
  return `[${swarmId}] ${summary}`;
}

// ---------- 7. Coordinator runLoop（含 spawn_swarm executor） ----------
// coordinator 用 interactive askFn 跟 user 交互；spawn_swarm 时 fork 出 runSwarm。
// 多 swarm 并行 = 同一轮多 tool_use → runRounds 内部 Promise.all 并发 dispatch（隐式并行）。
// 对照 claude-code coordinatorMode.ts:213 "Parallelism is your superpower. To launch
// workers in parallel, make multiple tool calls in a single message."
async function runCoordinator(userPrompt: string, mode: Mode): Promise<void> {
  const tools = getToolsForRole("coordinator");
  const messages: any[] = [{ role: "user", content: userPrompt }];
  const spawnFn = (task: string, swarmMode: Mode) => runSwarm(task, swarmMode, interactiveAsk);

  await runRounds(messages, SYSTEM_PROMPT, tools, mode, "coordinator", interactiveAsk, spawnFn,
    (n, sr) => `========== ROUND ${n}  stop_reason=${sr} ==========`);

  console.log(`\n========== FINAL MESSAGES ==========`);
  console.log(JSON.stringify(messages, null, 2));
}

// ---------- 8. Interactive runLoop (v3 退化兼容) + 启动入口 ----------
// 三维矩阵向下兼容 v3：role=interactive 时行为跟 v3 完全一致（除 audit 多带 role 标签）。
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
  const role = (arg("role") ?? "coordinator") as Role;
  if (!["interactive", "coordinator", "swarm-worker"].includes(role)) throw new Error(`Invalid role: ${role}`);
  const mode = (arg("mode") ?? "default") as Mode;
  const userPrompt =
    arg("prompt") ?? "请并行读 /tmp/a.txt /tmp/b.txt /tmp/c.txt 三个文件，分别提取关键信息，然后综合成一份总结。";
  return { role, mode, userPrompt };
}

// ---------- 9. 配置 + callModel + 系统启动 ----------
const settings = JSON.parse(await Bun.file(`${process.env.HOME}/.claude-dev/settings.json`).text());
const { ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, ANTHROPIC_DEFAULT_HAIKU_MODEL } = settings.env;

async function callModel(messages: any[], system: string, tools: any[]): Promise<any> {
  return await fetch(`${ANTHROPIC_BASE_URL}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_AUTH_TOKEN,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: ANTHROPIC_DEFAULT_HAIKU_MODEL, max_tokens: 2048, system, messages, tools }),
  }).then((r) => r.json());
}

const SYSTEM_PROMPT =
  "You manage files via read_file / edit_file / delete_file. " +
  "If you are unsure about user intent, use ask_user to clarify (if available in your tools). " +
  "When a tool returns is_error: true, report the error honestly and suggest next steps. " +
  "If you have spawn_swarm available, prefer fanning out independent subtasks IN PARALLEL by emitting multiple spawn_swarm calls in ONE turn.";

const { role, mode, userPrompt } = parseFlags(process.argv.slice(2));
if (role === "coordinator") await runCoordinator(userPrompt, mode);
else if (role === "swarm-worker") {
  const s = await runSwarm(userPrompt, mode, interactiveAsk);
  console.log(`\n========== FINAL MESSAGES ==========\n${s}`);
} else await runInteractive(userPrompt, mode);
