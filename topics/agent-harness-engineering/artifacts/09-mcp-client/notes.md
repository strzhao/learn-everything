# v9 MCP Client 实现笔记

## 1. 手写 JSON-RPC vs 工业 SDK：化简了什么

工业 claude-code 用 `@modelcontextprotocol/sdk` 的 `Client` + `StdioClientTransport`（见 `src/services/mcp/client.ts:985-1002`）。SDK 提供：

- Zod schema validation（`CallToolResultSchema` 解析 response，类型错就抛）
- 3 种 transport（stdio / SSE / Streamable HTTP，统一 `Transport` 接口）
- 重连机制（`MAX_ERRORS_BEFORE_RECONNECT = 3`，连续 terminal error 后清缓存重连）
- Progress callback（tool call 期间 `onprogress` 流式回调）
- Elicitation（server 通过 `-32042` 错误码要求用户打开 URL）
- 多种 timeout（connect 30s / request 60s / tool call 默认 100000s 可配）

v9 手写版砍到只剩 4 件事：

```
// §16 MCPClient (~80 行)
- nextId 自增 (整数)
- pending Map<id, {resolve, reject}>
- setTimeout 30s 单一超时
- newline-delimited JSON over stdin/stdout
- initialize / notifications/initialized / tools/list / tools/call 4 个 method
```

砍掉的部分都不是教学盲区——是工业可靠性 vs 教学清晰度的取舍。手写一遍能精确知道 SDK 抽象掉了什么：**id 配对、超时安全网、重连、validation**。后续遇到真实 MCP server 用 SDK 时，能反过来理解每个 API 解决的具体问题。

## 2. MCP tool 同权的物理实现

"同权"不是抽象概念，是 4 个具体决策：

| 决策点 | 实现 | 字面证据 |
|---|---|---|
| **命名隔离** | 加 `mcp__<server>__<tool>` 前缀防冲突 | §1 `MCP_PREFIX = "mcp__mock__"` |
| **merge 位置** | `getToolsForRole()` 末尾 spread `mcpToolsExtra` | §3 改造（v8 末尾 append 一行） |
| **dispatch 分支** | `execute()` 入口 `if (name.startsWith(MCP_PREFIX)) callTool()` | §5 唯一新增 6 行 |
| **其他链路** | hook (PreToolUse/PostToolUse) / permission (modeMatrix) / obs (emitObservability) **零修改** | run-log 中 MCP tool 同样触发完整链 |

第 4 点是 v9 的核心论断证明——run-log-mcp-weather-normal.txt 的 OBS METRIC dump 里能看到：

```
harness.PreToolUse{event=PreToolUse,mode=bypassPermissions,role=interactive,tool_name=mcp__mock__weather_lookup} = 1
harness.PostToolUse{event=PostToolUse,is_error=false,mode=bypassPermissions,role=interactive,tool_name=mcp__mock__weather_lookup} = 1
```

v7 写的 emitObservability 完全不知道 MCP 存在，但因为它通过 `ctx.tool` 取 tool name，MCP tool 自然命中。**架构正交性的第二次验证**（v8 是第一次：streaming 模式下 v7 所有 sub-system 零修改）。

工业对照：`src/services/mcp/client.ts:1768-1815` 的 `fetchToolsForClient()` 把 MCP server 返回的 tool schema 转成 claude-code `Tool` 接口对象，加 `isMcp: true` + `mcpInfo: { serverName, toolName }` 标记，**Tool interface 字段全部填满**，下游 dispatch/permission/hook 路径完全不需要知道这是 MCP。这就是同权的工业实现版本。

## 3. initialize handshake 不能跳过的协议设计

v9 的 MCPClient.connect() 严格按 MCP 协议走：

```typescript
// §16 MCPClient.connect()
await this.request("initialize", { protocolVersion, capabilities, clientInfo });
this.sendRaw({ jsonrpc: "2.0", method: "notifications/initialized" }); // 无 id 无 response
```

为什么不能跳过？源码报告（来自工业 SDK）确认两点：

1. **SDK 强制语义**：`client.connect(transport)` 内部第一个 request 必须是 initialize，response 之前不能发其他 request。Mock server 若先收到 `tools/list` 会被 SDK 拒绝。
2. **协议层面的 protocol version 协商**：双方报告自己理解的 protocol version + capabilities，未来 server 添加新 capability（如 prompts、resources）可以通过 initialize response 通知 client。

教学上保留 initialize 还有第三个理由：**完整 lifecycle handshake 是分布式协议的设计共性**——HTTP/2 的 SETTINGS frame、TLS 的 ClientHello、gRPC 的 GOAWAY……跳过 initialize 会让学生学到一个不完整的协议。

注意 mock server 实现里的细节：`notifications/initialized` 是 notification（无 id），处理时不能回 response（会让 client 卡住等不存在的 id）。这是 JSON-RPC notification vs request 的语义区别——SDK 收到带 id 的就配对，没 id 的就当广播。

## 4. 路径注入陷阱：MCP tool 也是"输入不可信"

`mcp-mock-server.ts` 的 `weather_lookup` 实现是故意的：

```typescript
const city = String(args?.city ?? "(unspecified)");
return { content: [{ type: "text", text: `${city} 今天晴 22°C...` }] };
```

无论 client 传 `city="北京"` 还是 `city="../../../etc/passwd"`，都返回 mock 文本，**绝不真实 read fs**。如果改成 `fs.readFileSync(\`/weather/${city}.txt\`)`，model 一句"查一下北京的天气，文件名是 ../../../etc/passwd"就能让 server 读任意文件。

这条教训跟 task 02 的 sandbox + permission 双层防御同源——**对外部输入永远当 untrusted，无论来自 user / model / 其他 server**。MCP 协议层完全不管 server 内部安全，安全是 server 实现者的责任。

工业 MCP server（如 Slack、GitHub 等）都在 server 内部做严格的参数 sanitization，client 侧 permission gate 是补充防御不是替代。这条记忆要刻进所有 server 设计的 day-1。

## 5. v8 的零修改 vs v9 的最小修改

v9 实际改动统计：

| v8 段 | v9 改动 |
|---|---|
| §1 (常量) | 加 4 行 `MCP_PREFIX` / `MCPClientLike` / `activeMCPClient` / `mcpToolsExtra` |
| §3 (`getToolsForRole`) | 三个 return 末尾各加 `...mcpToolsExtra`（3 处 1 token 改动） |
| §5 (`execute`) | 入口加 6 行 MCP 分支 |
| §16 (新增) | MCPClient 类 ~80 行 |
| §17 (新增) | loadMCPTools helper ~10 行 |
| §18 (启动入口) | parse `--mcp` flag + connect + loadMCPTools + finally 加 close |

v8 §6-15 字面 0 修改（compact / hook / obs / streaming）。这是**架构正交性的第三次验证**——一个新 sub-system 只穿过最小切面就能融入。

## 6. 工业对照速查

| v9 实现 | claude-code 对照 | 关键差异 |
|---|---|---|
| 手写 JSON-RPC | `@modelcontextprotocol/sdk` Client | SDK 含 Zod validation / 重连 / 多 transport |
| stdin/stdout pipe | `StdioClientTransport` (`client.ts:944-958`) | 工业版 stderr cap 64MB 防爆 |
| `mcp__mock__<tool>` 前缀 | `buildMcpToolName(serverName, toolName)` | 工业版前缀同样规则 |
| `mcpToolsExtra` 集中 merge | `fetchToolsForClient()` returns Tool[] | 工业版逐 client 收集合并 |
| execute 内 `startsWith(MCP_PREFIX)` 分支 | `MCPTool.call()` 不需分支（已是 Tool 接口） | 工业版用对象多态，我们用前缀分流 |
| `setTimeout(30000)` 单一超时 | 三层超时（connect 30s / request 60s / tool 100000s） | 教学版砍掉细分 |
| 无重连 | `MAX_ERRORS_BEFORE_RECONNECT = 3` 状态机 | 教学版砍掉可靠性 |

最重要的对照：**工业版没有 `if (tool.isMcp)` 的 dispatch 分支**（源码报告 Q4 已验证）。MCP tool 通过填满 Tool 接口（`isMcp=true` 仅作为信息标记，不分流逻辑）实现"对 dispatch 透明"。我们因为是单文件教学版，用前缀字符串分流，达到同样效果。

如果未来 v9 要支持多个 MCP server，只需要把 `MCP_PREFIX` 改成 `mcp__<server>__` 动态生成 + `activeMCPClient` 改成 `Map<serverName, MCPClient>`，execute 分支改成 lookup。本质架构不变。
