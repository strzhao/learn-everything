# v9: 工具定义权外移 —— MCP Mini Client

从 v1 到 v8，所有 tool 都硬编码在 harness 内部。v9 跨过的边界是：**tool 来源从 harness 内部移到外部 server**，但 dispatch / permission / hook / obs 管道完全不变。这是架构正交性的第三次验证（第一次：v7 sub-system 在 v8 streaming 模式零修改；第二次：v6 hook 系统对 v5 compact 零侵入）。

## MCP = USB 协议

类比 USB：操作系统提供统一的设备接口，鼠标键盘 U 盘存储设备扫描仪都用同一套协议。USB 之前，每个设备厂商写自己的驱动 + 自己的串口协议，软件硬件耦合死。USB 之后，**设备定义权从 OS 内核移到设备厂商**，OS 只负责协议解析。

MCP 之前，agent 想接新工具就要在 harness 代码里加一段。MCP 之后，**工具定义权从 harness 内部移到 server**，harness 只负责协议解析 + dispatch。第三方 server（Slack / GitHub / Notion / 你自己写的 mock）都通过同一套 JSON-RPC 协议接入。

## JSON-RPC over stdio 三件套

最小化 transport 选 stdio：spawn 子进程，父子用 stdin/stdout pipe 交换 newline-delimited JSON，stderr 走日志。三件套清晰：

```
父 (agent)  ───  stdin   ───►  子 (mock server)
父 (agent)  ◄──  stdout  ───   子 (mock server)
父 (audit) ◄──  stderr  ───   子 (mock server log)
```

为什么不用 HTTP？stdio 最小依赖（无 socket / 无端口冲突 / 无 SSE 复杂度）。教学上 stdio 是 MCP 三种 transport（stdio / SSE / Streamable HTTP）的最简形态。工业 claude-code 三种都支持（`src/services/mcp/client.ts:944-958` 是 stdio 分支）。

## initialize lifecycle 不能跳过

MCP 强制：第一个 request 必须是 `initialize`，等 response 后才能发其他 request，还要发 `notifications/initialized` 通知 server "我准备好了"。

为什么不能跳过：
1. **Protocol version 协商**：双方报告自己理解的 version + capabilities，未来 server 添加 prompts/resources/sampling 等 capability 可以通过 initialize response 通知 client
2. **HTTP/2 SETTINGS / TLS ClientHello 同源**：分布式协议都需要建连阶段对齐能力
3. **教学完整性**：跳过 initialize 会让学生学到一个残缺的协议

@include(./mcp-mock-server.ts, section=1)

mock server 完整实现就是这一段——`initialize` / `notifications/initialized`（无回复）/ `tools/list` / `tools/call`，外加 stderr 日志和路径注入陷阱（`weather_lookup` 的 city 永远不真实读 fs）。

## MCPClient 类：手写 vs SDK 的取舍

工业版用 `@modelcontextprotocol/sdk`，v9 手写一遍能精确知道 SDK 抽象掉了什么：

- **id 配对**：自增整数 + `Map<id, {resolve, reject}>` —— 多个 in-flight request 各自找到自己的 response
- **超时安全网**：`setTimeout(30000)` 兜底，避免 server hang 时 client 永远 await
- **stdin/stdout split**：buffer + `\n` 分割，处理 partial chunk

@include(./agent-v9-mcp-client.ts, section=16)

砍掉的部分：Zod schema validation / 重连机制 / 多 transport / Progress callback / Elicitation / 三层 timeout。**生产环境必须用 SDK 或自己实现重连**——v9 教学版的最大代价就是 subprocess 死掉无法恢复。

## tools/list 与 merge 进 registry

`loadMCPTools()` 把 server 返回的 tool schema 加上 `mcp__mock__` 前缀 merge 进 harness tool registry。前缀防冲突（万一 server 提供一个 `read_file` 不会撞内置的）+ 标识来源。

@include(./agent-v9-mcp-client.ts, section=17)

**关键技术决策**：MCP 协议的 `inputSchema` 本就是 JSON Schema 格式（spec.types.d.ts:1182-1189 严格规定 `type: "object"` + `properties` + `required`），Anthropic API 也接受 JSON Schema 作为 `input_schema` —— **零转换**直接复用。MCP 选 JSON Schema 是为了 provider-agnostic（不绑死 Claude / OpenAI 任一家的 tool format）。

## execute 加 mcp__ 前缀分支：唯一的 dispatch 改动

@include(./agent-v9-mcp-client.ts, section=5)

v9 在 §5 `execute()` 入口加了 6 行：检测 `name.startsWith(MCP_PREFIX)` → 调 `activeMCPClient.callTool(realName, input)`。注意：

- 这 6 行**在 PreToolUse hook + permission gate 之后**（dispatch wrapper 调 dispatchInner 调 execute）—— 意味着 MCP tool 已经穿过完整的安全链路
- 后续 PostToolUse / obs fan-out **自动覆盖** MCP tool（因为它们也在 dispatch wrapper 内）
- 其他 9 段（§6 compact / §8-9 hook / §11-12 obs / §14-15 streaming）**字面 0 修改**

这是 v9 的同权论断的物理实现：**只穿过最小切面**。

工业对照（excerpts.md §3）：claude-code 的 `MCPTool.call()` 签名与内置 tool 完全一样，dispatch 层不需要 isMcp 分支。我们用前缀字符串分流是单文件版的简化，本质架构一样。

## 跑通 weather-normal：完整 lifecycle 一目了然

@include(./run-log-mcp-weather-normal.txt, round=1)

启动阶段 audit 行清晰呈现整个 MCP lifecycle：

```
[BOOT] role=interactive mode=bypassPermissions ... mcp=/Users/.../bun run mcp-mock-server.ts
[MCP spawn cmd=...]
[MCP server-stderr] mock-mcp server started
[MCP server-stderr] recv method=initialize id=1
[MCP initialize → {"protocolVersion":"2024-11-05","capabilities":{"tools":{}}, ...}]
[MCP server-stderr] recv method=notifications/initialized id=(notif)
[MCP server-stderr] client ready (notifications/initialized)
[MCP server-stderr] recv method=tools/list id=2
[MCP tools/list → 2 tools: weather_lookup,calculator]
[MCP merged 2 tools into registry: mcp__mock__weather_lookup,mcp__mock__calculator]
```

然后 model 选了 `mcp__mock__weather_lookup`，OBS METRIC dump 显示 PreToolUse / PostToolUse 都正确 labels `tool_name=mcp__mock__weather_lookup` —— **v7 写的 obs 系统完全不知道 MCP 存在，但 MCP tool 自然命中**。

## 跑通 calculator-denied：permission gate 对 MCP tool 同样生效

@include(./run-log-mcp-calculator-denied.txt, round=1)

`--mode=default` 下 `mcp__mock__calculator` 不属于 READ_LIKE 也不在 META_TOOLS，modeMatrix 返回 `ask`。permission gate 触发 readline prompt，用户输入 `n` 拒绝。tool_result 拼回 `is_error: true`，model 自适应——手算了 12345 × 67890 = 838,102,050（验算正确）。

OBS METRIC dump：

```
harness.PreToolUse{event=PreToolUse,mode=default,role=interactive,tool_name=mcp__mock__calculator} = 1
harness.PostToolUse{event=PostToolUse,is_error=true,mode=default,role=interactive,tool_name=mcp__mock__calculator} = 1
```

**关键证据**：`is_error=true` label 正确 propagate 到 PostToolUse metric —— permission deny 走的是 v3 task 02 设计的 `is_error: true` 反馈通道，MCP tool 与内置 tool 在反馈机制上同样统一。

## 路径注入陷阱：MCP tool 也是输入不可信

`weather_lookup` 的 city 字段是教学陷阱——mock server 实现固定文本返回，**永远不读 fs**：

```typescript
const city = String(args?.city ?? "(unspecified)");
return { content: [{ type: "text", text: `${city} 今天晴 22°C...` }] };
```

如果改成 `fs.readFileSync(\`/weather/${city}.txt\`)`，model 一句 prompt 注入就能让 server 读任意文件。**MCP 协议层不管 server 内部安全**，安全是 server 实现者的责任。

这条教训跟 task 02 的 sandbox + permission 双层防御同源——对外部输入永远当 untrusted，无论来自 user / model / 其他 server。client 侧的 permission gate 是补充防御，不是替代 server 侧的输入清洗。

## 同权论断的工业意义

v9 验证的 4 个论断：

1. ✅ **MCP tool 数据结构与内置 tool 同结构**（claude-code: `Tool` 接口；v9: Anthropic tool schema）
2. ✅ **dispatch 路径无 isMcp 特殊分支**（claude-code: 对象多态；v9: 前缀字符串分流，本质一样）
3. ✅ **hook / permission / obs 对 MCP tool 同样触发**（run-log OBS METRIC 字面证据）
4. ✅ **MCP server 完全外部黑盒，安全由 server 自己负责**（路径注入陷阱印证）

工业意义：第三方可以独立开发 MCP server，harness 不需要任何改动就能集成。Anthropic 维护 protocol，社区维护 server 生态（Slack / GitHub / Linear / Filesystem / Postgres / Memory / ...）。**MCP 是 agent 生态的 USB 时刻**——工具定义权外移让生态可以独立演化，agent 厂商不再需要为每个工具集成单独写代码。

下一节预告（v10+ 候选）：Tool 系统 deeper（agent 主动调 tool 决策 / tool description 设计 / tool 调用频率与 reliability）/ System Prompt / Skill 系统 / Plugin 系统 / 子 agent 资源管理。
