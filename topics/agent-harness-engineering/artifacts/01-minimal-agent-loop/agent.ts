// Task 01: 最小 Agent Loop —— 不依赖任何 SDK，纯 fetch 调 Anthropic Messages API
// 教学目的：让你看见 "harness = fetch + msgs 拼接 + while" 的真实物理形态

// ---------- 1. 配置：直接读 ~/.claude-dev/settings.json，不维护任何 .env ----------
const settings = JSON.parse(
  await Bun.file(`${process.env.HOME}/.claude-dev/settings.json`).text(),
);
const { ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, ANTHROPIC_DEFAULT_HAIKU_MODEL } = settings.env;

// ---------- 2. 工具定义 ----------
// 关键设计：input_schema 只允许二元运算 (a op b)，这让 "23 * 47 + 100" 必须分两轮调用。
// 协议约束塑造行为 —— 这就是 tool schema 的设计哲学。
const tools = [{
  name: "calculator",
  description: "二元四则运算，每次只能计算 a op b 一次",
  input_schema: {
    type: "object",
    properties: {
      a: { type: "number" },
      op: { type: "string", enum: ["+", "-", "*", "/"] },
      b: { type: "number" },
    },
    required: ["a", "op", "b"],
  },
}];

const execTool = ({ a, op, b }: { a: number; op: string; b: number }) =>
  ({ "+": a + b, "-": a - b, "*": a * b, "/": a / b })[op];

// ---------- 3. 初始 messages ----------
const messages: any[] = [
  { role: "user", content: "请帮我算 23 * 47 再加 100，每一步用 calculator 工具。" },
];

// ---------- 4. Agent Loop ----------
// 终止条件：stop_reason !== "tool_use"。这是 Anthropic 协议规定的唯一退出信号。
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
      messages,
      tools,
    }),
  }).then((r) => r.json()) as any;

  console.log(`\n========== ROUND ${round}  stop_reason=${res.stop_reason} ==========`);
  console.log(JSON.stringify(res.content, null, 2));

  // 闭环关键：把 assistant 整条 content 先 push 进 messages（无论是不是 tool_use 都要记入历史）
  messages.push({ role: "assistant", content: res.content });

  if (res.stop_reason !== "tool_use") break;

  // 对每个 tool_use 执行工具，把结果以 tool_result block 拼回 user 消息
  // 这一步让模型在下一轮"看见"上一轮工具结果 —— observation→feedback→decision 的物理体现
  const toolResults = res.content
    .filter((b: any) => b.type === "tool_use")
    .map((b: any) => ({
      type: "tool_result",
      tool_use_id: b.id,
      content: String(execTool(b.input)),
    }));
  messages.push({ role: "user", content: toolResults });
}

// ---------- 5. 把完整 messages 历史 dump 出来，让你看清楚一轮 agent 跑下来 msgs 长什么样 ----------
console.log("\n========== FINAL MESSAGES ==========");
console.log(JSON.stringify(messages, null, 2));
