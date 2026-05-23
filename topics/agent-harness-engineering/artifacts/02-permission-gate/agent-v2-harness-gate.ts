// Task 02 v2: harness gate 版 —— permission 在 dispatch 阶段强制拦截
// 教学目的：让 model 看见 tool_result 的 is_error: true，观察其下一轮自适应。
// 这是 production permission 的第一层骨架：不依赖 model 自觉，硬规则在 harness。

// ---------- 1. 配置 ----------
const settings = JSON.parse(
  await Bun.file(`${process.env.HOME}/.claude-dev/settings.json`).text(),
);
const { ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, ANTHROPIC_DEFAULT_HAIKU_MODEL } = settings.env;

// ---------- 2. 工具定义：只暴露 delete_file，没有 ask_user ----------
// 关键：model 此时无法"自己问用户"。permission 完全是 harness 的事。
const tools = [{
  name: "delete_file",
  description: "Delete a file at the given absolute path. Destructive and irreversible.",
  input_schema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
}];

// ---------- 3. dispatch：harness gate 强制拦截 ----------
// 这一层不在 model 控制之内 —— 它就是 production permission gate 的骨架。
// is_error: true 是协议字段，model 在下一轮看到这个标记后会自适应（道歉 / 改路径 / 终止）。
function dispatch(name: string, input: any): { content: string; is_error: boolean } {
  if (name === "delete_file") {
    const answer = (prompt(`[harness gate] Allow delete ${input.path}? [y/N]`) ?? "")
      .trim()
      .toLowerCase();
    if (answer !== "y") {
      return {
        content: `User denied delete operation: ${input.path}`,
        is_error: true,
      };
    }
    console.log(`[MOCK] would rm -rf ${input.path}`);
    return { content: `Deleted ${input.path}`, is_error: false };
  }
  return { content: `Unknown tool: ${name}`, is_error: true };
}

// ---------- 4. 初始 messages ----------
const messages: any[] = [
  { role: "user", content: "删除 /tmp/test1.txt 和 /tmp/test2.txt 这两个文件。" },
];

// ---------- 5. Agent Loop ----------
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

  messages.push({ role: "assistant", content: res.content });

  if (res.stop_reason !== "tool_use") break;

  // 关键：每个 tool_use 都过 dispatch。is_error 字段让 model 在下一轮"看见"拒绝。
  const toolResults = res.content
    .filter((b: any) => b.type === "tool_use")
    .map((b: any) => {
      const result = dispatch(b.name, b.input);
      return {
        type: "tool_result",
        tool_use_id: b.id,
        content: result.content,
        is_error: result.is_error,
      };
    });
  messages.push({ role: "user", content: toolResults });
}

console.log("\n========== FINAL MESSAGES ==========");
console.log(JSON.stringify(messages, null, 2));
