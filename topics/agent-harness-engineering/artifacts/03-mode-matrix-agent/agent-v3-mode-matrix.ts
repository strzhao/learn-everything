// Task 03 v3: mode matrix agent —— (tool × mode) → policy 的代码物理化
// 教学目的：把 Task 02 推测的 5 条 bypassPermissions 设计 + Socratic 04 抽象的
// "policy 是 runtime 行为 / hard-block 是 user 兜底" 落到可运行代码上。
// 对照参考: /Users/stringzhao/workspace/claude-code/src/utils/permissions/permissions.ts
//          /Users/stringzhao/workspace/claude-code/src/hooks/toolPermission/ 整个子系统

// ---------- 1. Mode 枚举与 mode 矩阵定义 ----------
// mode 是 union string（参考 claude-code sdk-tools.d.ts:337 — 工业实现也是字符串）。
// policy 不是数据 —— 它是 modeMatrix() 读 mode + tool 后做的 runtime 决策。
// 这就是 Socratic 04 Q2 内化的"config 是行为的输入，dispatch 是行为本身"的代码体现。
type Mode = "default" | "acceptEdits" | "bypassPermissions";
type Policy = "auto-allow" | "ask" | "hard-block";

const READ_LIKE = new Set(["read_file"]);
const EDIT_LIKE = new Set(["edit_file"]);

function modeMatrix(tool: string, input: any, mode: Mode): Policy {
  if (isHardBlocked(tool, input)) return "hard-block";                  // hard-block 与 mode 正交
  if (tool === "ask_user") return "auto-allow";                         // ask_user 本身就是协作通道
  if (READ_LIKE.has(tool)) return "auto-allow";                         // 读类工具三种 mode 下都安全
  if (mode === "bypassPermissions") return "auto-allow";                // bypass 放过其余
  if (mode === "acceptEdits" && EDIT_LIKE.has(tool)) return "auto-allow"; // acceptEdits 放过 edit
  return "ask";                                                          // default 兜底：destructive 一律 ask
}

// ---------- 2. Hard-block 列表（user 兜底，跟 mode 正交）----------
// 参考 claude-code permissions.ts:1252-1260 的 safetyCheck —— 即使 user 主动开 bypass，
// 对 .git/.claude/.vscode/shell 配置等 path 仍然 ask。
// 这是 Socratic 04 Q4 收紧的工业版："hard-block 防的不是 model 不是 injection，是 user 自己"
// —— "双因素激活" 在 bypass 模式下的延伸：user 不可能为每个文件再确认，所以 rm /etc 这种
// 极端操作 harness 必须替 user 兜底，与 sandbox 防 model 错调正交。
const HARD_BLOCK_PATHS = ["/", "/etc", "/usr", "/System", "/Library", "/bin", "/sbin"];

function isHardBlocked(tool: string, input: any): boolean {
  if (tool !== "delete_file" && tool !== "edit_file") return false;
  const path = String(input?.path ?? "");
  return HARD_BLOCK_PATHS.some((p) => path === p || path.startsWith(p + "/"));
}

// ---------- 3. Tools schema（三种 mode 下完全不变）----------
// 推测 2 的代码体现：ask_user 永远挂在 tools schema 里 —— bypass 不删它，保留 model
// 的"主动澄清"通道。对照 claude-code permissions.ts:1231-1236 的 requiresUserInteraction
// 检查：AskUserQuestion 即使在 bypass 下也仍要 ask（"bypass-immune tool"）。
const tools = [
  {
    name: "read_file",
    description: "Read a file's content. Read-only, always safe.",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "edit_file",
    description: "Overwrite a file's content. Modifies disk.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "delete_file",
    description: "Delete a file at the given absolute path. Destructive and irreversible.",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "ask_user",
    description: "Ask the human user a clarifying question and get their reply.",
    input_schema: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
    },
  },
];

// ---------- 4. Dispatch 入口（按 mode 早返回 + audit log）----------
// 推测 1 + 3 + 5 的代码体现：
//   - mode 字符串从未进 system prompt（推测 1）— mode 只在 dispatch 内部被读
//   - bypass / acceptEdits 触发 auto-allow 时立刻 [AUDIT] 一行（推测 3）
//   - (tool × mode) → policy 判决发生在 modeMatrix + 下方 if 链（推测 5）：
//     policy 是 runtime 行为，不是 config 表里的查表结果
// 对照 claude-code permissions.ts:1262-1281 的 shouldBypassPermissions 早返回。
function dispatch(name: string, input: any, mode: Mode): { content: string; is_error: boolean } {
  const policy = modeMatrix(name, input, mode);

  if (policy === "hard-block") {
    audit(`hard-block tool=${name} path=${input?.path} mode=${mode} (bypass-immune)`);
    return {
      content: `Hard-block: ${input?.path} is in the protected path list and cannot be ${name === "delete_file" ? "deleted" : "edited"} even in bypass mode.`,
      is_error: true,
    };
  }

  if (policy === "ask") {
    const ans = (prompt(`[harness gate] mode=${mode} Allow ${name} on ${pp(input)}? [y/N]`) ?? "")
      .trim().toLowerCase();
    if (ans !== "y") return { content: `User denied ${name}: ${pp(input)}`, is_error: true };
    return execute(name, input);
  }

  // policy === "auto-allow" —— 在非 default mode 且非 read/ask 工具时审计
  if (mode !== "default" && !READ_LIKE.has(name) && name !== "ask_user") {
    audit(`auto-allow tool=${name} mode=${mode} input=${pp(input)}`);
  }
  return execute(name, input);
}

const audit = (msg: string) => console.error(`[AUDIT] ${msg}`);
const pp = (x: any) => (x?.path ? x.path : JSON.stringify(x));

function execute(name: string, input: any): { content: string; is_error: boolean } {
  if (name === "read_file") return { content: `Read ${input.path}: <mocked content>`, is_error: false };
  if (name === "edit_file") {
    console.log(`[MOCK] would write ${input.path} <- ${JSON.stringify(input.content).slice(0, 60)}`);
    return { content: `Edited ${input.path}`, is_error: false };
  }
  if (name === "delete_file") {
    console.log(`[MOCK] would rm -rf ${input.path}`);
    return { content: `Deleted ${input.path}`, is_error: false };
  }
  if (name === "ask_user") {
    const ans = prompt(`[ask_user] ${input.question}`) ?? "";
    return { content: `User answered: ${ans.trim() || "(empty)"}`, is_error: false };
  }
  return { content: `Unknown tool: ${name}`, is_error: true };
}

// ---------- 5. Agent loop 主体 ----------
// 与 v1/v2 同骨架：fetch + messages 拼接 + while + tool_result 闭环。
// 唯一新增：dispatch 多一个 mode 参数。audit 行打到 stderr，不污染 stdout 的 JSON dump。
const settings = JSON.parse(
  await Bun.file(`${process.env.HOME}/.claude-dev/settings.json`).text(),
);
const { ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, ANTHROPIC_DEFAULT_HAIKU_MODEL } = settings.env;

async function runLoop(userPrompt: string, mode: Mode, system: string): Promise<void> {
  const messages: any[] = [{ role: "user", content: userPrompt }];

  for (let round = 1; round <= 10; round++) {
    const res = await fetch(`${ANTHROPIC_BASE_URL}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_AUTH_TOKEN,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: ANTHROPIC_DEFAULT_HAIKU_MODEL,
        max_tokens: 1024,
        system,
        messages,
        tools,
      }),
    }).then((r) => r.json()) as any;

    console.log(`\n========== ROUND ${round}  stop_reason=${res.stop_reason} ==========`);
    console.log(JSON.stringify(res.content, null, 2));
    messages.push({ role: "assistant", content: res.content });

    if (res.stop_reason !== "tool_use") break;

    const toolResults = res.content
      .filter((b: any) => b.type === "tool_use")
      .map((b: any) => {
        const r = dispatch(b.name, b.input, mode);
        return { type: "tool_result", tool_use_id: b.id, content: r.content, is_error: r.is_error };
      });
    messages.push({ role: "user", content: toolResults });
  }

  console.log("\n========== FINAL MESSAGES ==========");
  console.log(JSON.stringify(messages, null, 2));
}

// ---------- 6. Mode 切换处理 ----------
// 启动方式：bun run agent-v3-mode-matrix.ts --mode=<name> [--prompt='...']
// system prompt 在三种 mode 下字面量完全一致 —— 推测 1 的代码体现。
// 对照 claude-code/src/constants/prompts.ts:189：工业 system prompt 也只说 "permission mode"
// 通用语，不写任何具体 mode 字符串，mode 信息只在 harness 内部流转。
function parseFlags(argv: string[]): { mode: Mode; userPrompt: string } {
  const arg = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const mode = (arg("mode") ?? "default") as Mode;
  if (!["default", "acceptEdits", "bypassPermissions"].includes(mode)) {
    throw new Error(`Invalid mode: ${mode}. Use default | acceptEdits | bypassPermissions`);
  }
  const userPrompt = arg("prompt") ?? "请删除 /tmp/test1.txt 和 /tmp/test2.txt 两个文件。";
  return { mode, userPrompt };
}

// ---------- 7. 启动入口 ----------
const SYSTEM_PROMPT =
  "You manage files via read_file / edit_file / delete_file. " +
  "If you are unsure about user intent, use ask_user to clarify. " +
  "When a tool returns is_error: true, report the error to the user honestly and suggest next steps.";

const { mode, userPrompt } = parseFlags(process.argv.slice(2));
await runLoop(userPrompt, mode, SYSTEM_PROMPT);
