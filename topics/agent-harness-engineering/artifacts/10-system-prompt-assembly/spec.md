# Task 10 Spec: v10 System Prompt Assembly Engine

> Retrospective alignment 文档（实施完成后补档）。lecture 复盘 + 决策清单已替代 spec 的对齐功能，这里仅作 artifact 留档。

## 目标

在 v9 730 行之上加 ~150 行实现 system prompt 子系统化。验证 4 个核心论断：

1. memoization 默认开 + DANGEROUS opt-out
2. `_reason: string` 类型系统 self-audit
3. clearSystemPromptSections 在 maybeCompact 末尾（语义因果链）
4. BOUNDARY sentinel 是下游 cache 物理分割点

## 交付清单

| 文件 | 内容 |
|---|---|
| `agent-v10-system-prompt.ts` | ~889 行（v9 730 + §19/§20/§21 共 +159 行）|
| `mcp-mock-server.ts` | 不需要（复用 v9 的，仅作可选 MCP 验证）|
| `.api-config.json` | DeepSeek API 配置（与 v9 共享）|
| `run-log-cache-warm.txt` | warm cache 场景：Round 2+ hit=5/6, mcp_instructions 始终 miss |
| `run-log-compact-clear.txt` | compact 场景：fullCompact → "cleared by compact: 6 entries dropped" → cold restart |
| `notes.md` | 6 节实现笔记 |
| `excerpts.md` | 7 段 claude-code 源码引用 |
| `lesson.md` | 14 段教学叙事 + @include 切片 |
| `README.md` | 三段式 |

## 改造定位（基于 0 假设原则源码报告）

**v10 完全继承 v9 §1-18**，改造仅 4 处：

1. **§7 maybeCompact 末尾**加 `clearSystemPromptSections("compact")` + 注释
2. **§10 runRounds 签名**：`system: string` → `systemAssembler: () => Promise<{prefix; suffix}>`
3. **§10 三 run* 函数**：`SYSTEM_PROMPT` 引用替换为 `assembleSystemPrompt(USE_CACHE_AUDIT)`
4. **§13 SYSTEM_PROMPT 字符串**：删除（被 §19/§20/§21 取代）
5. **新增 §19/§20/§21**：sub-system 内核 + 6 section 注册 + assembler
6. **§22 启动入口**：扩展 `--cache-audit` flag + bootstrap/final audit

## 工业对照（必须命中）

- `systemPromptSection` / `DANGEROUS_uncachedSystemPromptSection` 签名 1:1 抄 `src/constants/systemPromptSections.ts:20-37`
- `sectionCache: Map` 对照 `src/bootstrap/state.ts:203,399,1641-1654`
- `resolveSystemPromptSections` 逻辑对照 `src/constants/systemPromptSections.ts:43-58`
- `BOUNDARY_SENTINEL` 字面值 `"__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__"` 对照 `src/constants/prompts.ts:114-115`
- `clearSystemPromptSections` 在 compact 末尾调用对照 `src/services/compact/postCompactCleanup.ts:62`
- mcp_instructions DANGEROUS reason 字符串保留工业前缀 `"MCP servers connect/disconnect between turns"`（对照 `src/constants/prompts.ts:530`）

## 教学化简（与工业有意偏离的点）

1. **BEFORE_BOUNDARY 安排**：v10 把 5 dynamic section 放 BEFORE，工业 dynamicSections 全在 AFTER。理由：cache 命中可视化
2. **不发 cache_control 到 API**：仅 audit 输出两段长度，端点兼容性
3. **6 section vs 工业 11+**：教学复杂度控制
4. **2-block split vs 工业 4-block**：去掉 attribution / fallback 路径

## 验收要点（4 论断 → 4 run-log 字面证据）

- ✅ 论断 1: cache-warm Round 2+ hit=5/6
- ✅ 论断 2: mcp_instructions 始终在 miss-sections（DANGEROUS 跳读）
- ✅ 论断 3: compact-clear "cleared by compact: 6 entries dropped" 字面行
- ✅ 论断 4: 每轮 audit `[BOUNDARY prefix=N_chars / suffix=M_chars]` 跨轮稳定

## 已知偏离的修正记录

- lesson 10 讲 "BOUNDARY 之前 scope:global / 之后 会话隔离" → 工业精确语义是 "之后 cacheScope: null 不进 cache"，notes.md §3 修正
- lesson 10 暗示 DANGEROUS 不缓存 → 工业实际仍写 cache 副本只跳读，notes.md §1 / excerpts.md §3 修正
