# Task 09 Spec: v9 MCP Mini Client

## 目标

在 v8 之上实现一个最小 MCP client（stdio JSON-RPC 传输），连接外部 mock MCP server，验证 **MCP tool 与内置 tool 同权**——走相同的 dispatch/permission/hook/obs 管道。

## 核心升级

```
v8: 所有 tool 硬编码在 harness 内（§3 tools schema）
v9: tool 来源二分 —— 内置 tool + MCP 发现 tool，merge 后统一走 dispatch
```

## 必须实现的组件

### 1. MCP Client（stdio JSON-RPC transport）

新增一个 MCPClient 类：
- `constructor(serverCommand: string)` — spawn 子进程（stdio pipe）
- `async listTools(): Promise<MCPTool[]>` — 发送 `tools/list` JSON-RPC 请求，解析返回的工具列表
- `async callTool(name, args): Promise<string>` — 发送 `tools/call` JSON-RPC 请求，返回 `result.content[0].text`
- JSON-RPC 2.0 协议：`{"jsonrpc":"2.0","id":N,"method":"...","params":{...}}`
- 错误处理：超时、进程崩溃、JSON 解析失败

**不引入 `@modelcontextprotocol/sdk`**——手动实现 JSON-RPC over stdio（遵守 Otter 禁 SDK 约束）。

### 2. Mock MCP Server（独立文件 `mcp-mock-server.ts`）

同一个 artifact 目录下的独立文件，暴露 2 个工具：

| 工具名 | 功能 | inputSchema |
|--------|------|-------------|
| `weather_lookup` | 查询城市天气（mock） | `{city: string}` |
| `calculator` | 二元运算 | `{a: number, op: "add"\|"sub"\|"mul"\|"div", b: number}` |

实现：
- 从 stdin 逐行读 JSON-RPC 请求
- `tools/list` → 返回上面两个工具的标准 MCP schema
- `tools/call` → mock 执行并返回结果（weather 返回固定文本 / calculator 真实计算）
- stderr 打日志（与 stdin/stdout 数据通道分离）
- `bun run mcp-mock-server.ts` 直接启动

### 3. v9 Agent 改动点

**§3 Tools schema**：加 `loadMCPTools()` 函数，启动时调 `mcpClient.listTools()`，把返回的 MCP tool 转成 Anthropic tool schema 格式，与内置 tool 合并。

**§5 execute**：在 `execute()` 函数中加分支——如果 tool name 属于 MCP-discovered 工具，调 `mcpClient.callTool(name, input)` 而非本地 executor。

**§13 启动入口**：加 `--mcp` flag（`--mcp=true bun run mcp-mock-server.ts` 或类似），传 server 启动命令给 MCPClient。

**关键不变**：
- `modeMatrix()` / `isHardBlocked()` 对 MCP tool 同样生效（permission gate 不区分来源）
- `dispatch()` 内的 `hooks.emit("PreToolUse")` / `hooks.emit("PostToolUse")` 对 MCP tool 同样触发
- observability fan-out（如启用 obs hooks）对 MCP tool 同样记录
- v8 §14-15 streaming 逻辑完整保留

### 4. Run-logs（2 份，控制规模）

**(a) `run-log-mcp-weather-normal.txt`**：
- `--mcp=true --stream=false --mode=bypassPermissions --hooks=obs`
- prompt: "查一下北京的天气"
- 证明链：AUDIT STREAM line 含 tools/list 结果 → PreToolUse emit → weather_lookup 走 dispatch → PostToolUse emit → OBS event 记录 → model 收到结果

**(b) `run-log-mcp-calculator-denied.txt`**：
- `--mcp=true --stream=false --mode=default`
- prompt: "帮我算 12345 * 67890"
- 用户在 readline 中拒绝（输入 n）
- 证明链：calculator 触发 permission gate（policy=ask）→ 用户 deny → is_error: true 拼回 → model 自适应

## 交付物清单

| 文件 | 要求 |
|------|------|
| `agent-v9-mcp-client.ts` | ≤ 800 行（v8 已 593），严格切段 `// ---------- N. ----------` |
| `mcp-mock-server.ts` | ≤ 80 行，独立可运行 |
| `run-log-mcp-weather-normal.txt` | 真实运行输出，含完整 AUDIT + OBS trace |
| `run-log-mcp-calculator-denied.txt` | 真实运行输出，证明 permission gate 对 MCP tool 生效 |
| `notes.md` | 3-4 节，含 MCP client 实现决策 + 同权验证 + 工业对照 |
| `README.md` | 三段式 |
| `lesson.md` | 精简版（8-10 段），agent-notebook 入口 |

## 硬约束

- 禁 SDK / fetch 直打协议 / sharing settings.json / bun 直跑 / destructive mock
- MCP JSON-RPC **手动实现**（不引入 `@modelcontextprotocol/sdk`）
- v8 §1-15 已有段落**字面量尽可能不动**，仅 §3/§5/§13 加 MCP 分支
- mock server 用 stdin/stdout 做数据通道，stderr 做日志
- `weather_lookup` 的 `city` 字段设计为**路径注入陷阱**——如果 model 传 `city="../../../etc/passwd"`，mock server 应返回固定文本而非真实读文件（体现 MCP tool 也是"输入不可信"）

## 步骤 0：工业源码对照

重点读：
- `src/services/mcp/client.ts` — MCP SDK 封装
- `src/services/mcp/MCPConnectionManager.tsx` — 连接管理（stdio spawn / HTTP SSE / WebSocket）
- `src/tools/MCPTool/` — MCP tool 如何被 merge 进 tool registry
- `src/tools.ts` — `mergeTools()` 合并内置 + MCP + plugin tools

对照要点：
1. MCP tool 在 tool registry 中是否与内置 tool 数据结构相同
2. dispatch 路径上是否有 `isMcpTool` 之类的分支判断
3. hook/observability 对 MCP tool 是否有特殊处理
