# 10 — System Prompt Assembly Engine

## 它做什么

v10 在 v9 之上把 system prompt 从一个固定字符串常量改造为**完整的子系统**：注册 6 个 section（core_instruction / tool_list_hint / env_info / mcp_instructions / memory / session_context）→ memoize 默认开 + DANGEROUS opt-out 跳读 cache → 每轮重新 assemble → compact 完成后清空 cache。

**核心论断**（4 个，run-log 字面证据全 ✅）：

1. **memoization 默认开**：5 个普通 section 第 2 轮起 cache 命中（hit=5/6）
2. **DANGEROUS opt-out**：`mcp_instructions` 标记 `cacheBreak: true`，跳读 cache 但仍写副本，每轮 miss
3. **BOUNDARY sentinel 切分**：把 prompt 分为 cacheable prefix（工业 scope:'global'）和 per-session suffix（工业 scope:null）
4. **clearSystemPromptSections 在 maybeCompact 末尾**：compact 完成后所有 cache entries 字面被清（"cleared by compact: 6 entries dropped"）

最深的工程意义：v10 偿还了 v9 (Task 09) MCP 同权论断的**cache 经济债**。v9 验证了 MCP tool 走完全相同的 dispatch / permission / hook / obs 管道，但代价是 `mcp_instructions` 必须 DANGEROUS_uncached——server 在 turn 间断连重连，cache 副本会 stale。

## 怎么用

```bash
# 场景 A: cache-warm（验证 memoization 默认开 + DANGEROUS 跳读）
~/.bun/bin/bun run agent-v10-system-prompt.ts \
  --role=interactive --mode=bypassPermissions --hooks=none --stream=false --cache-audit \
  '--prompt=请依次读取 /tmp/x.txt 和 /tmp/y.txt 两个文件，每读完一个先用一句话总结再读下一个。'

# 场景 B: compact-clear（让 round > 4 触发 fullCompact + cache clear）
~/.bun/bin/bun run agent-v10-system-prompt.ts \
  --role=interactive --mode=bypassPermissions --hooks=compact --stream=false --cache-audit \
  '--prompt=请依次读取 /tmp/a.txt /tmp/b.txt /tmp/c.txt /tmp/d.txt /tmp/e.txt 这 5 个文件。每次只读一个，每读完一个就用一句话总结再读下一个。'
```

`--cache-audit` 是 v10 新增的唯一 flag，开启后每轮 audit 输出：

- `[CACHE hit=X/6 miss=Y/6 cache_size=Z]`
- `[CACHE hit-sections=...]`
- `[CACHE miss-sections=...]`
- `[BOUNDARY prefix=N_chars / suffix=M_chars]`
- compact 触发后：`[CACHE cleared by compact: N entries dropped]`

其他 flag（`--role / --mode / --hooks / --stream / --prompt / --mcp`）从 v9 继承。可与 `--mcp=<server cmd>` 组合验证 MCP tool 同权 + cache 同步影响。

启动 HTML 阅读视图（agent-notebook）：

```bash
cd /Users/stringzhao/workspace/learn-everything
bun run tools/agent-notebook/server.ts \
  topics/agent-harness-engineering/artifacts/10-system-prompt-assembly
```

浏览器打开 `http://localhost:3000`，看 `lesson.md` 的 `@include` 切片把 §19/§20/§21 代码段、run-log 的 cache hit/miss / cache cleared 字面证据、教学讲解编织起来。

## 与其他组件的关系

**继承**：v10 严格继承 v9 全部 18 段。改动统计（v9 730 → v10 889 行 = +159）：
- §7 maybeCompact 末尾加 6 行 `clearSystemPromptSections("compact")` + 注释
- §10 runRounds 签名改：`system: string` → `systemAssembler: () => Promise<{prefix, suffix}>`
- §10 三 run* 函数：`SYSTEM_PROMPT` 引用替换为 `assembleSystemPrompt(USE_CACHE_AUDIT)`
- §13 删除 `SYSTEM_PROMPT` 字符串常量
- §19 新增 SystemPromptSection 子系统内核（sectionCache + 2 工厂 + clear + resolve, ~49 行）
- §20 新增 6 section 注册（BEFORE 5 段 + AFTER 1 段, ~48 行）
- §21 新增 assembleSystemPrompt 函数 + BOUNDARY sentinel + audit 输出（~24 行）
- §22 启动入口加 `--cache-audit` flag + bootstrap audit + final audit

v9 §1-6 / §8-9 / §11-12 / §14-15 / §16-17 字面 0 修改（permission / hook / obs / streaming / MCP）。

**对照 task 列表**：
- task 05 maybeCompact sub-system ↔ v10 在其末尾加 clearSystemPromptSections（语义因果链显式）
- task 06 hook handler reason 字段 ↔ v10 DANGEROUS_uncachedSystemPromptSection 的 `_reason: string` 同源（类型系统强制 self-audit）
- task 09 MCP 同权 4 论断 ↔ v10 揭示 cache 经济同权债（v9 没付的账）
- task 02 sandbox+permission 双层防御 ↔ v10 类型系统 vs runtime 检查也是双层（编译期 + 运行期）

**v10 偏离工业的教学化简**（在 notes.md §3 详细说明）：
- v10 把 5 个 dynamic section 放 BEFORE_BOUNDARY 区让 cache 命中可视化
- 工业 `prompts.ts:560-576` 的 dynamicSections（含 mcp_instructions）全在 BOUNDARY 之后 cacheScope: null
- 学生学完应理解这是教学化简、不是工业默认

**final 拼装**（task 11+）：v10 是 mini-工具最后一块系统化拼图。final/ 会把 v1-v10 全部组件做完整工程演示——从 minimal agent loop 出发，逐层加 permission / multi-agent / compact / hook / obs / streaming / MCP / system prompt assembly，每一步都是单文件可运行实例。

**与外部工程仓的关系**：本 artifact 是自包含的（所有代码 + run-log + 教学文档在同一目录），不依赖外部工程仓。`lesson.md` 中的 `@include` 全部用相对路径，整个目录可作原子单元搬运。

## 文件清单

| 文件 | 行数 | 内容 |
|---|---|---|
| `agent-v10-system-prompt.ts` | 889 行 | v10 完整实现（v9 730 + §19/§20/§21 新增 159 行）|
| `.api-config.json` | - | DeepSeek API 配置（与 v9 共享）|
| `run-log-cache-warm.txt` | ~145 行 | cache-warm 场景：5/6 hit + DANGEROUS 1/6 miss 跨轮稳定 |
| `run-log-compact-clear.txt` | ~225 行 | compact-clear 场景：compact 触发 → "cleared by compact: 6 entries dropped" → cold restart → warm again |
| `notes.md` | - | 6 节实现笔记：工厂签名 / memoization 数据结构 / BOUNDARY 切分修正 / clear 末尾 vs 开头 / v9 同权债 / 工业对照速查 |
| `excerpts.md` | - | 7 段 claude-code 源码引用（含 file:line + v10 对照说明）|
| `lesson.md` | - | 教学叙事（agent-notebook @include 入口）|
| `spec.md` | - | task 10 retrospective alignment 文档（最后补档）|
| `README.md` | - | 本文件 |
