# Task 03：v3 Mode Matrix Agent

> 把 Task 02 推测的 5 条 `bypassPermissions` 设计、对照 claude-code 工业源码、落到 196 行可运行的 v3 代码上。从 evaluate → create 的真正跨越：从"看懂别人为什么这么写"到"自己能基于同样原理写出可扩展的代码"。

## 学到了什么

### 1. mode 矩阵的物理承载是有序 if 链，不是查表

policy 不是 `Map<Mode, Policy>` 里的数据，也不是 settings.json 里的配置 —— 它是 `modeMatrix(tool, input, mode)` 函数读 mode 字符串后做的 **runtime 决策**。mode 字符串是行为的输入，policy 是行为本身。工业实现 (`src/utils/permissions/permissions.ts:1158-1310` 的 `hasPermissionsToUseToolInner`) 是同一形态：一条 10+ 步的有序 if 链，mode 是其中第 2a 步。增加新 mode 不需要扩展 M×N 表，只需要插入一段 if 分支 —— 这是 "有序 if 链 + 早返回" 比 "查表" 在可扩展性上的优势。

### 2. hard-block 防的是 user 自己，不是 model / injection

Socratic 04 Q4 收紧确认的核心抽象在 v3 代码 + claude-code 源码里同时验证：bypass 是 user 主动开的"万能开关"，user 不可能为每个文件再确认 —— 所以 rm /etc 这种极端操作 harness 必须替 user 兜底。`HARD_BLOCK_PATHS` 与 mode 正交，bypass 也越不过。工业实现 (`permissions.ts:1252-1260` safetyCheck) 还有更广义的两条免疫：(a) deny rule、(b) content-specific ask rule —— **user 任何曾说过的"这要确认"都比 bypass 优先**。

### 3. 判决与反馈是两层职责

dispatch 决定 policy（决定），tool_result 的 `is_error` 字段把决定的"拒绝"传到 model（反馈）。两层独立：policy 在 modeMatrix 里算，is_error 在 tool_result 拼回时附带。**这就是为什么 v3 推测 5 是 ⚠️ 部分命中**：原推测把判决和反馈混说成 "dispatch + is_error 二维"，工业实现是更精确的 "有序 if 链判决 + decisionReason 多维传出 + is_error 协议出口"。

### 4. model 凭训练分布"自然"处理 is_error

run-log-bypass-hard-blocked.txt 的 Round 2 是教学黄金：harness **从未在 system prompt 里教 model "遇到 is_error 怎么办"**，但 model 看到 `is_error: true` + content `"Hard-block: ... even in bypass mode"` 后，自然输出了 ✅/❌ 对比汇报 + 主动给出 sudo rm / Finder 替代方案。这跟 Task 02 v2 的同样观察一致：**harness 的 NO 给 model 一个明确锚点，model 在锚点周围合理协作**。

## 怎么读这份归档

**推荐入口：交互式 notebook 视图**

```bash
~/.bun/bin/bun run /Users/stringzhao/workspace/learn-everything/tools/agent-notebook/server.ts \
  /Users/stringzhao/workspace/learn-everything/topics/agent-harness-engineering/artifacts/03-mode-matrix-agent/
```

打开 http://localhost:3737/，按 `[← 上一步] [下一步 →]` 单步推进。左侧 lesson 流（讲解 + 代码片段 + run-log）顺序展开，右侧 messages 状态侧栏跟随每个 round 更新，能看清 `tool_use_id` 与 `tool_result.tool_use_id` 同色配对、`is_error: true` 在拒绝时的精确插入位置。

**文件导览**：

- `lesson.md` — agent-notebook 入口。11 段叙事，从 v2 局限切入 → mode 矩阵 → 4 份 run-log 实验 → 5 条推测对照小结 → v2 改进意见。**这是首读路径**
- `agent-v3-mode-matrix.ts` — v3 实现（196 行，7 段切片）。本身可独立运行，3 种 mode 用 `--mode=<name>` 切换
- `notes.md` — 深度分析。6 节：源码定位、5 条推测对照（带工业实现 quote）、mode 矩阵物理承载结构图、推测之外的 3 个发现、v2 的 3 处改进意见、一句话总结。**想深挖任何一条推测的来源，看这里**
- `excerpts.md` — claude-code 源码的 8 个关键片段（带 file:line）。备查文档，notes.md 按需引用
- `run-log-default.txt` — default mode，user 拒一允一
- `run-log-accept-edits.txt` — acceptEdits，edit 自动通过 + delete 仍 ask
- `run-log-bypass.txt` — bypass，2 条 audit + mock 删除
- `run-log-bypass-hard-blocked.txt` — bypass + hard-block 触发，1 条 audit auto-allow + 1 条 audit hard-block + model is_error 自适应
- `spec.md` — Task 03 原始 spec

**手动跑（如果你想重现实验）**：

```bash
cd topics/agent-harness-engineering/artifacts/03-mode-matrix-agent

# default mode（弹 readline）
printf 'N\ny\n' | ~/.bun/bin/bun run agent-v3-mode-matrix.ts --mode=default

# acceptEdits（只 delete 弹 readline）
echo "y" | ~/.bun/bin/bun run agent-v3-mode-matrix.ts --mode=acceptEdits \
  --prompt='请把 /tmp/foo.txt 的内容改成 "updated"，然后删除 /tmp/old.txt 这个旧文件。'

# bypass（无交互）
~/.bun/bin/bun run agent-v3-mode-matrix.ts --mode=bypassPermissions

# bypass + hard-block
~/.bun/bin/bun run agent-v3-mode-matrix.ts --mode=bypassPermissions \
  --prompt='我在清理系统，请删除这两个无用文件：/tmp/old1.log 和 /Library/Caches/myapp-cache.bin。两个都已确认无用，直接删除。'
```

**前置**：`~/.claude-dev/settings.json` 含 `env.ANTHROPIC_AUTH_TOKEN` / `env.ANTHROPIC_BASE_URL` / `env.ANTHROPIC_DEFAULT_HAIKU_MODEL`。本仓库当前用 deepseek 兼容 endpoint（`https://api.deepseek.com/anthropic` + `deepseek-v4-flash[1m]`）。

## 与其他组件的关系（在课程中的位置）

- **依赖于**：[`01-minimal-agent-loop`](../01-minimal-agent-loop/)（agent loop 三角骨架）+ [`02-permission-gate`](../02-permission-gate/)（v1 ask_user + v2 harness gate 的 dispatch + is_error 经验）
- **本任务做了什么**：把 v2 的"单层 harness gate"扩展为 v3 的"(tool × mode) → policy 矩阵"。新增维度：mode（3 种）、hard-block 列表、audit log、ask_user 工具
- **对照源码**：`/Users/stringzhao/workspace/claude-code/src/utils/permissions/permissions.ts` (核心判决) + `src/hooks/toolPermission/permissionLogging.ts` (审计) + `src/hooks/toolPermission/handlers/` (三层执行器) + `src/constants/prompts.ts:189` (mode-agnostic system prompt)
- **下一个**：**Lecture 04**（context compaction 或 multi-agent coordinator 二选一）。两者都是 production harness 的下一维度
- **后续讲解 hook 系统时**：会把 v3 dispatch 函数对照 Claude Code 的 PreToolUse / PostToolUse 钩子链，识别从 "硬编码的 if 链" 到 "可配置 hook 流水线" 多出来的复杂度在解决什么真实问题（用户自定义规则 / 团队级 policy / 缓存决策 / 异步审批）

## 关键对照表

| 维度 | v1（ask_user 工具） | v2（harness gate） | v3（mode matrix） |
|---|---|---|---|
| Permission 物理位置 | model 层（依赖 model 自觉调 ask） | harness dispatch 层（每次必拦） | harness dispatch 层 + mode 矩阵 + hard-block 兜底 |
| User 控制力 | 0%（model 不调 ask 就过） | 100%（每次都拦） | 按 mode 分化：default 100% / acceptEdits 部分 / bypass 0%（除 hard-block） |
| 失败模式 | prompt injection 1/4 次绕过 | 显式 is_error 反馈 | 显式 is_error + audit 可观测 |
| 行数 | 94 | 88 | 196 |
| 新增维度 | — | dispatch + is_error | mode 字符串 + 矩阵函数 + audit log + hard-block 列表 |
| 对应工业组件 | AskUserQuestion 工具 | hasPermissionsToUseToolInner 单一 mode 分支 | hasPermissionsToUseToolInner 完整 10+ 步有序 if 链 + permissionLogging + 三层 handler |

## 给学习者的提示

1. **先跑通**：`bun run agent-v3-mode-matrix.ts --mode=bypassPermissions` 是最简单的入口（无交互），看 model 怎么主动 read + delete，audit 怎么打到 stderr
2. **再读 lesson.md 的交互视图**：单步推进，特别注意 §6（acceptEdits 矩阵性）和 §8（bypass + hard-block 实战汇合）两段，是教学黄金
3. **想深挖某一条推测**：去 notes.md §2 找对应推测的源码引用，再跳到 excerpts.md 看完整 quote
4. **想做扩展练习**：试试在 v3 上加第 4 种 mode（比如 `plan` —— 所有 write 类工具都返回 is_error，只允许 read），看 modeMatrix 函数需要插入几行
