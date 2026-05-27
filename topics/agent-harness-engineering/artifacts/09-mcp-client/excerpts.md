# claude-code MCP 关键源码片段（v9 实现对照）

所有片段都经实际 Read 验证（CLAUDE.md 0 假设原则）。引用格式：`file:start-end`。

## 1. StdioClientTransport spawn — 工业版的 transport 抽象

> `src/services/mcp/client.ts:944-958`

```typescript
} else if (serverRef.type === 'stdio' || !serverRef.type) {
  const finalCommand =
    process.env.CLAUDE_CODE_SHELL_PREFIX || serverRef.command
  const finalArgs = process.env.CLAUDE_CODE_SHELL_PREFIX
    ? [[serverRef.command, ...serverRef.args].join(' ')]
    : serverRef.args
  transport = new StdioClientTransport({
    command: finalCommand,
    args: finalArgs,
    env: {
      ...subprocessEnv(),
      ...serverRef.env,
    } as Record<string, string>,
    stderr: 'pipe', // prevents error output from the MCP server from printing to the UI
  })
}
```

**v9 对照**：我们在 `MCPClient.connect()` 用 `Bun.spawn(this.serverCmd, { stdin: "pipe", stdout: "pipe", stderr: "pipe" })`，stderr pipe 同样思路——避免 MCP server 错误日志污染 agent 主输出，通过 audit 渠道单独捕获。

工业版相对 v9 多的能力：env 注入（subprocess inherits cleaned env + server-specific env override）、shell prefix（容器化等场景）。教学版没必要。

## 2. MCP tool → claude-code Tool 接口转换（同权的核心）

> `src/services/mcp/client.ts:1768-1815`（fetchToolsForClient 主体）

```typescript
return toolsToProcess
  .map((tool): Tool => {
    const fullyQualifiedName = buildMcpToolName(client.name, tool.name)
    return {
      ...MCPTool,
      name: skipPrefix ? tool.name : fullyQualifiedName,
      mcpInfo: { serverName: client.name, toolName: tool.name },
      isMcp: true,
      // ...
      isConcurrencySafe() {
        return tool.annotations?.readOnlyHint ?? false
      },
      isReadOnly() {
        return tool.annotations?.readOnlyHint ?? false
      },
      // ...
      isDestructive() {
        return tool.annotations?.destructiveHint ?? false
      },
      isOpenWorld() {
        return tool.annotations?.openWorldHint ?? false
      },
      // ...
      inputJSONSchema: tool.inputSchema as Tool['inputJSONSchema'],
```

**关键决策点**：

1. **`...MCPTool` spread** — 一个全局共享的 MCPTool 模板（默认 prompt / userFacingName / mapToolResultToToolResultBlockParam 等），具体 tool 只 override 必要字段。教学版砍掉这层抽象，直接构造对象。
2. **`name: fullyQualifiedName`** — `mcp__<serverName>__<toolName>` 前缀，与 v9 的 `MCP_PREFIX = "mcp__mock__"` 同精神。
3. **`isMcp: true`** — 标记位，不影响 dispatch 逻辑（只有 UI / analytics 用）。v9 的同权论断的关键证据：**没有 dispatch 路径 `if (tool.isMcp)` 分支**。
4. **`mcpInfo: { serverName, toolName }`** — 拆开存原名，便于 callTool 时使用（callTool 要传原始 tool.name，不带前缀）。v9 用字符串 `.slice(MCP_PREFIX.length)` 简化。
5. **`isConcurrencySafe / isReadOnly / isDestructive / isOpenWorld` 来自 MCP `annotations`** — server 自己声明 tool 行为属性，client 用来决定 streaming 时是否并发、permission 时是否需要确认。**这一行实际就是 streaming + permission 系统的接入点**。v9 教学版不区分（全 mock 为 concurrent-safe）。
6. **`inputJSONSchema: tool.inputSchema`** — MCP 的 inputSchema 本就是 JSON Schema 格式，**零转换**直接复用为 Anthropic API 接受的 schema 字段。v9 同样直接复用。

## 3. MCPTool.call() — dispatch 入口，无 isMcp 特殊分支

> `src/services/mcp/client.ts:1833-1867`

```typescript
async call(
  args: Record<string, unknown>,
  context,
  _canUseTool,
  parentMessage,
  onProgress?: ToolCallProgress<MCPProgress>,
) {
  const toolUseId = extractToolUseId(parentMessage)
  const meta = toolUseId
    ? { 'claudecode/toolUseId': toolUseId }
    : {}

  // Emit progress when tool starts
  if (onProgress && toolUseId) {
    onProgress({
      toolUseID: toolUseId,
      data: {
        type: 'mcp_progress',
        status: 'started',
        serverName: client.name,
        toolName: tool.name,
      },
    })
  }
  const startTime = Date.now()
  const MAX_SESSION_RETRIES = 1
  for (let attempt = 0; ; attempt++) {
    try {
      const connectedClient = await ensureConnectedClient(client)
      const mcpResult = await callMCPToolWithUrlElicitationRetry({
        client: connectedClient,
        clientConnection: client,
        tool: tool.name,
        args,
```

**核心论断的字面证据**：函数签名与内置 tool 的 call() 完全相同（`args, context, canUseTool, parentMessage, onProgress`）。Dispatch 层调用时不需要知道这是 MCP tool。`onProgress` 接收的事件类型 `MCPProgress` 是 MCP 特化（带 `serverName / toolName`），但通过同一个 progress callback channel 走，下游 hook/obs 完全统一处理。

**v9 对照**：教学版 execute() 入口的 `if (name.startsWith(MCP_PREFIX))` 分支是单文件版本的简化——工业版用对象多态（每个 MCP tool 是一个独立 Tool 对象，call() 是该对象的方法），v9 用前缀字符串分流到 `activeMCPClient.callTool()`，达到同样效果。**架构本质：MCP tool 的实例化时间点是 client 启动时，不是 dispatch 时**。

## 4. JSON-RPC 协议类型 — 教学版严格遵守的 spec

> `node_modules/@modelcontextprotocol/sdk/dist/esm/spec.types.d.ts:129-150`

```typescript
export interface JSONRPCRequest extends Request {
  jsonrpc: typeof JSONRPC_VERSION; // "2.0"
  id: RequestId;  // string | number
}
export interface JSONRPCNotification extends Notification {
  jsonrpc: typeof JSONRPC_VERSION;
  // 注意：没有 id 字段
}
export interface JSONRPCResultResponse {
  jsonrpc: typeof JSONRPC_VERSION;
  id: RequestId;
  result: Result;
}
```

**v9 对照**：mcp-mock-server.ts 的 `send` helper 同样严格遵守：

```typescript
const send = (id: number | string | null, payload: any) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...payload }) + "\n");
```

`notifications/initialized` 是 notification（无 id），mock server 收到时 `log("client ready")` 但不回 response——这与 spec 的 `JSONRPCNotification` 类型（无 id 字段）一致。Run-log 中的 audit 行 `[MCP server-stderr] recv method=notifications/initialized id=(notif)` 字面记录了这个区分。

## 5. MCP Tool schema 字段 — inputSchema 是 JSON Schema 不是 Anthropic format

> `node_modules/@modelcontextprotocol/sdk/dist/esm/spec.types.d.ts:1172-1214`

```typescript
export interface Tool extends BaseMetadata, Icons {
  description?: string;
  inputSchema: {
    $schema?: string;
    type: "object";
    properties?: {
      [key: string]: object;
    };
    required?: string[];
  };
  execution?: ToolExecution;
  outputSchema?: { ... };  // Optional
  annotations?: ToolAnnotations;  // readOnlyHint / destructiveHint / openWorldHint / title
  _meta?: { ... };  // 扩展字段
}
```

**v9 对照**：mock server 返回的 tool schema 严格遵守这个结构：

```typescript
const TOOLS = [
  { name: "weather_lookup", description: "...",
    inputSchema: { type: "object", properties: { city: { type: "string", description: "City name" } }, required: ["city"] } },
  { name: "calculator", description: "...",
    inputSchema: { type: "object",
      properties: { a: { type: "number" }, op: { type: "string", enum: ["add", "sub", "mul", "div"] }, b: { type: "number" } },
      required: ["a", "op", "b"] } },
];
```

**关键洞察**：MCP 协议层把"工具描述格式"标准化为 JSON Schema，Anthropic API 也接受 JSON Schema 作为 `input_schema`，所以**零转换**。v9 的 `loadMCPTools()` 直接：

```typescript
const merged = mcpTools.map((t) => ({
  name: `${MCP_PREFIX}${t.name}`,
  description: `[MCP/mock-server] ${t.description}`,
  input_schema: t.inputSchema, // JSON Schema 直接复用
}));
```

如果 LLM provider 用不同的 schema 格式（如老式 OpenAI function call 的格式），这里就需要 schema 转换器。MCP 选 JSON Schema 是为了协议层 provider-agnostic。

## 6. 工业版超时配置 — v9 砍掉的三层细分

> `src/services/mcp/client.ts:209,463,1101`（按 Explore 报告位置；行号可能因 minor 版本漂移）

工业版三层超时：
- `DEFAULT_MCP_TOOL_TIMEOUT_MS = 100_000_000` (~27 小时，长任务用)
- `MCP_REQUEST_TIMEOUT_MS = 60000` (60s，普通 request)
- `getConnectionTimeoutMs(): 30000ms` (connect 30s)

**v9 对照**：教学版只有一层 `setTimeout(30000)` —— 所有 request 30s 超时。教学清晰度优于工业可靠性。

## 7. 工业版连接错误恢复机制 — v9 完全没实现

> `src/services/mcp/client.ts:1227-1370` (Explore 报告位置)

工业版有完整的 onerror 状态机：检测 `ECONNRESET / ETIMEDOUT / EPIPE / EHOSTUNREACH / ECONNREFUSED / Body Timeout Error / terminated / SSE stream disconnected`，连续 3 次后触发 `closeTransportAndRejectPending('max consecutive terminal errors')`，下次调用 `connectToServer` 自动重连。

**v9 对照**：完全没实现重连。subprocess 死掉就是死掉，下次 callTool 会 stuck 在 setTimeout(30000) 然后报 timeout。这是教学版"砍掉可靠性换清晰度"的最大代价。生产环境必须用 SDK 或自己实现重连。
