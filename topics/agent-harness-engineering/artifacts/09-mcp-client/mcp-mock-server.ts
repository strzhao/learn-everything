// Mock MCP Server: stdin/stdout newline-delimited JSON-RPC 2.0
// 对照 claude-code @modelcontextprotocol/sdk: spec.types.d.ts:129-150 / src/services/mcp/client.ts:944-958 (StdioClientTransport)
// 暴露 2 个 tool: weather_lookup (路径注入陷阱) + calculator
// ---------- 1. mock-mcp server 完整实现 ----------
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
const send = (id: number | string | null, payload: any) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...payload }) + "\n");
const log = (msg: string) => process.stderr.write(`[mock-mcp ${new Date().toISOString()}] ${msg}\n`);
const TOOLS = [
  { name: "weather_lookup", description: "Look up the current weather for a city. Returns a short text summary.",
    inputSchema: { type: "object", properties: { city: { type: "string", description: "City name" } }, required: ["city"] } },
  { name: "calculator", description: "Perform a binary arithmetic operation: add/sub/mul/div.",
    inputSchema: { type: "object",
      properties: { a: { type: "number" }, op: { type: "string", enum: ["add", "sub", "mul", "div"] }, b: { type: "number" } },
      required: ["a", "op", "b"] } },
];
function handleToolCall(name: string, args: any): { content: any[]; isError?: boolean } {
  if (name === "weather_lookup") {
    // 路径注入陷阱：city 即使是 "../../../etc/passwd" 也只返回固定 mock 文本，不读 fs
    const city = String(args?.city ?? "(unspecified)");
    return { content: [{ type: "text", text: `${city} 今天晴 22°C，东南风 3 级，湿度 55%。(mocked)` }] };
  }
  if (name === "calculator") {
    const { a, op, b } = args ?? {};
    if (typeof a !== "number" || typeof b !== "number") return { content: [{ type: "text", text: "Invalid args: a and b must be numbers" }], isError: true };
    const ops: Record<string, (x: number, y: number) => number> = { add: (x, y) => x + y, sub: (x, y) => x - y, mul: (x, y) => x * y, div: (x, y) => y === 0 ? NaN : x / y };
    const fn = ops[op as string];
    if (!fn) return { content: [{ type: "text", text: `Invalid op: ${op}` }], isError: true };
    return { content: [{ type: "text", text: String(fn(a, b)) }] };
  }
  return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
}
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg: any;
  try { msg = JSON.parse(line); } catch (e) { log(`parse error: ${String(e).slice(0, 80)} line=${line.slice(0, 120)}`); return; }
  const { id, method, params } = msg;
  log(`recv method=${method} id=${id ?? "(notif)"}`);
  if (method === "initialize") {
    send(id, { result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mock-mcp", version: "0.1.0" } } });
  } else if (method === "notifications/initialized") {
    log("client ready (notifications/initialized)"); // 无 id，无回复
  } else if (method === "tools/list") {
    send(id, { result: { tools: TOOLS } });
  } else if (method === "tools/call") {
    const result = handleToolCall(params?.name, params?.arguments);
    send(id, { result });
  } else {
    send(id, { error: { code: -32601, message: `Method not found: ${method}` } });
  }
});
rl.on("close", () => log("stdin closed, exiting"));
log("mock-mcp server started, waiting for JSON-RPC over stdin");
