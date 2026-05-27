# 09 — MCP Mini Client

## 它做什么

v9 在 v8 之上加了一个手写的最小 MCP（Model Context Protocol）client + 配套 mock server。**核心论断**：MCP server 提供的工具与 harness 内置工具同权——走完全相同的 dispatch / permission / hook / observability 管道，agent 代码侧只穿过最小切面就能融入外部工具。

具体能力：

- spawn 一个 mock MCP server 子进程（stdio newline-delimited JSON-RPC 2.0）
- 完整 lifecycle handshake：`initialize` → `notifications/initialized` → `tools/list` → `tools/call`
- 把 server 返回的工具 schema（JSON Schema 格式）加 `mcp__mock__` 前缀 merge 进 harness tool registry，零转换
- model 选择 `mcp__mock__weather_lookup` 或 `mcp__mock__calculator` 时，dispatch 自动路由到 `mcpClient.callTool()`
- PreToolUse / PostToolUse hook、permission gate（modeMatrix）、observability fan-out（v7 三 sink）对 MCP tool **完全透明地同样触发**

砍掉的复杂度（vs 工业 `@modelcontextprotocol/sdk`）：Zod schema validation / 重连机制 / 多 transport / Progress callback / Elicitation / 三层 timeout 细分。教学版只保留 4 件事：id 配对 / 单一超时 / newline-delimited JSON / 4 个核心 method。

## 怎么用

```bash
# 场景 A: weather-normal（bypassPermissions 模式 + obs hook 启用）
~/.bun/bin/bun run agent-v9-mcp-client.ts \
  --role=interactive --mode=bypassPermissions --hooks=obs --stream=false \
  '--mcp=/Users/stringzhao/.bun/bin/bun run mcp-mock-server.ts' \
  '--prompt=查一下北京的天气。'

# 场景 B: calculator-denied（default 模式 + 用户拒绝）
echo "n" | ~/.bun/bin/bun run agent-v9-mcp-client.ts \
  --role=interactive --mode=default --hooks=obs --stream=false \
  '--mcp=/Users/stringzhao/.bun/bin/bun run mcp-mock-server.ts' \
  '--prompt=帮我算 12345 乘 67890。'
```

`--mcp=<完整命令>` 是 v9 新增的唯一 flag。其他 flag（`--role / --mode / --hooks / --stream / --prompt`）从 v8 继承。

启动 HTML 阅读视图（agent-notebook）：

```bash
cd /Users/stringzhao/workspace/learn-everything
bun run tools/agent-notebook/server.ts \
  topics/agent-harness-engineering/artifacts/09-mcp-client
```

浏览器打开 `http://localhost:3000`，看 `lesson.md` 的 `@include` 切片把代码片段、run-log、讲解编织起来。

## 与其他组件的关系

**继承**：v9 严格继承 v8 全部 15 段。改动统计：
- §1 新增 4 行常量（`MCP_PREFIX` / `MCPClientLike` / `activeMCPClient` / `mcpToolsExtra`）
- §3 `getToolsForRole` 三个 return 末尾各加 `...mcpToolsExtra`
- §5 `execute` 入口加 6 行 MCP 分支
- §16 新增 MCPClient 类（~80 行）
- §17 新增 loadMCPTools helper（~10 行）
- §18 启动入口扩展 `--mcp` parse + connect + finally close

v8 §6-15 字面 0 修改（compact / hook / obs / streaming）。

**对照 task 列表**：
- task 02 sandbox+permission 双层防御 ↔ v9 MCP server 的"输入不可信"（路径注入陷阱）同源
- task 03 modeMatrix permission gate ↔ v9 calculator-denied 场景对 MCP tool 同样生效
- task 06 hook 系统 ↔ v9 PreToolUse/PostToolUse 对 MCP tool 自动触发
- task 07 obs 三 sink ↔ v9 OBS METRIC dump 显示 MCP tool 同样命中 cardinality 控制
- task 08 streaming 架构正交性的第二次验证 ↔ v9 是第三次（MCP sub-system 零侵入融入）

**final 拼装**（task 10+）：v9 是 mini-工具的最后一块关键拼图。final/ 会把 v1-v9 全部组件做一个完整工程演示——从 minimal agent loop 出发，逐层加 permission / multi-agent / compact / hook / obs / streaming / MCP，每一步都是单文件可运行实例。

**与外部工程仓的关系**：本 artifact 是自包含的（所有代码 + run-log + 教学文档在同一目录），不依赖外部工程仓。`lesson.md` 中的 `@include` 全部用相对路径，整个目录可作原子单元搬运。

## 文件清单

| 文件 | 行数 | 内容 |
|---|---|---|
| `agent-v9-mcp-client.ts` | 730 行 | v9 完整实现（v8 593 → 加 ~137 行 MCP 段） |
| `mcp-mock-server.ts` | ~50 行 | 独立 mock server（initialize / tools/list / tools/call + 2 tool） |
| `.api-config.json` | - | DeepSeek API 配置（与 v8 共享） |
| `spec.md` | - | task 09 的下发规范（执行前的对齐文档） |
| `run-log-mcp-weather-normal.txt` | - | bypassPermissions + obs 场景真实运行输出 |
| `run-log-mcp-calculator-denied.txt` | - | default mode + 用户 deny 场景真实运行输出 |
| `notes.md` | - | 6 节实现笔记：手写 vs SDK / 同权物理实现 / initialize 必要性 / 路径注入 / 改动统计 / 工业对照速查 |
| `excerpts.md` | - | claude-code MCP 7 段关键源码（含 file:line + v9 对照说明） |
| `lesson.md` | - | 教学叙事（agent-notebook @include 入口） |
| `README.md` | - | 本文件 |
