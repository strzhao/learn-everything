# Task 03 Spec —— v3 Mode Matrix Agent

下发日期：2026-05-24
父 topic：agent-harness-engineering
前置 artifact：[`02-permission-gate/`](../02-permission-gate/)

---

## 任务定位

从 v2 的"单层 harness gate"升级到 v3 的"mode 矩阵 agent"。

**核心交付是一份可运行的 v3 代码**：把 Task 02 README 第 4 节推测的 5 条 + Socratic 03 / 04 抽象出的 `(tool × mode) → policy` 矩阵，**用代码物理化**出来。读 production 源码（claude-code 的 toolPermission 子系统）是为了校准实现而不是为了写报告——报告变成"为什么 v3 这么实现"的论证支撑。

这是 evaluate → create 的真正跨越：从"看懂别人的设计"到"写出体现自己设计的代码"。

---

## 5 条推测（待 v3 实现 + notes.md 验证）

原文照录自 Task 02 README 第 4 节：

1. **不是 model 层的"假装无 permission"**：system prompt 不变，model 仍然以为有 gate，bypass 只发生在 harness 内部
2. **不是工具集层的"删 ask_user"**：ask_user 在 bypass 模式下应该照常存在，保留 model 协作能力
3. **应该有审计日志**：bypass 必须可观测，否则违反 production 原则
4. **应该有作用域限制 + hard-block 列表豁免**：永久 bypass = 把 v2 关闭，太危险（已在 Socratic 04 确认：hard-block 防的是 user 自己，是"双因素激活"在 bypass 模式下的延伸）
5. **mode 矩阵的物理承载是 dispatch + is_error，而不是某个 config 表**（已在 Socratic 04 确认：config 是行为的输入，policy 是 runtime 行为）

---

## v3 必须实现的 mode 矩阵

至少 3 种 mode，对应 5 条推测的代码物理化：

- `default`：每次破坏性 tool 都弹 readline（≈ v2 行为）
- `acceptEdits`：白名单 tool（如 `edit_file`）自动通过；黑名单（`delete_file`）仍弹 readline —— 体现 `(tool × mode) → policy` 的矩阵性
- `bypassPermissions`：所有 tool 直接放行，**但**：
  - hard-block 列表里的 tool 或 path 永远拒（推测 4 / user 兜底）
  - `ask_user` 工具仍然挂在 tools schema 里（推测 2）
  - system prompt 在三种 mode 下字面量完全一致（推测 1）
  - 每次绕过都写 audit 日志到 stdout 或文件（推测 3）

mode 切换：runtime 由 user 输入 `/mode <name>` 切换，或启动时 `--mode=bypass` 传入。两种实现一种即可。

---

## 步骤

### 步骤 0：源码定位（任务的一部分）

claude-code 不开源完整源码。可走路径：
- `npm view @anthropic-ai/claude-code` 看包结构 → 安装到本地 → 读 `dist/cli.js`
- minified 单文件需要 grep 关键字（`bypassPermissions` / `toolPermission` / `PermissionMode` / `acceptEdits`）+ prettier 局部格式化
- 也可先 `grep -ri "toolPermission" $HOME/.claude 2>/dev/null` 看是否已有反编译参考

把"怎么找到源码 / 哪个文件 / 哪个版本"写在 `notes.md` 第 1 节。源码定位本身就是 production 研究的真实技能。如果实在找不到结构化源码，在 minified 里 grep 关键字片段也可以，notes.md 标 ⬛ 并说清 grep 结论即可。

### 步骤 1：写 v3 代码

按 §"v3 代码切段约束"组织，严格切 7 段。

### 步骤 2：跑出 4 份真实 run-log

按 §"Run-log 约束"。

### 步骤 3：写 notes.md（5 条推测逐条对照 + mode 矩阵物理化论证）

每条推测产出三元组：
- **源码引用**（路径 + 行号或片段；excerpts.md 里贴片段）
- **判定**：✅ 命中 / ❌ 推翻 / ⚠️ 部分命中 / ⬛ 源码未覆盖
- **推理链**（≥ 80 字）：为什么这段代码满足/违反推测；如果推翻，工业实现实际怎么做的，差异背后的考量是什么

**推翻 / 部分命中 / 未覆盖都是有价值的发现，不是失败**。

第 4 节 "推测之外的发现"：工业实现额外做了什么是 5 条推测之外的？至少 1 条（例如 hook 链路优先级、cache 决策、async 审批、规则继承、subagent 隔离等）。

第 5 节 "写回 v2 的改进意见"：基于这次阅读，如果重做 v2 会改哪几处？≥ 2 处，具体到代码层。

### 步骤 4：写 lesson.md（agent-notebook 入口）

按 §"agent-notebook 高质量消费"。

---

## v3 代码切段约束

`agent-v3-mode-matrix.ts` 按**教学叙事顺序**切段（不是代码组织顺序），每段一个 `// ---------- N. <段名> ----------` 标记：

1. `1. Mode 枚举与 mode 矩阵定义`
2. `2. Hard-block 列表`
3. `3. Tools schema（含 ask_user，三种 mode 下不变）`
4. `4. Dispatch 入口（按 mode 早返回 + audit log）`
5. `5. Agent loop 主体`
6. `6. Mode 切换处理`
7. `7. 启动入口`

每段独立可读，因为 lesson.md 会一段段 `@include`。

---

## Run-log 约束

至少产出 **4 份真实运行日志**（不能手写）：

- `run-log-default.txt`：default mode，用户拒一次 / 允一次混合
- `run-log-accept-edits.txt`：acceptEdits，edit_file 自动通过 + delete_file 仍要确认
- `run-log-bypass.txt`：bypass，delete_file 静默放行 + audit 行可见
- `run-log-bypass-hard-blocked.txt`：bypass 下 model 试图删 hard-block 路径（如 `/`），被硬拦，model 在 `is_error` 反馈下自适应

每份 run-log 必须有：
- `========== ROUND N stop_reason=X ==========` 切片（至少 2 个 ROUND）
- `========== FINAL MESSAGES ==========` 段，含 messages 数组完整 JSON dump

---

## agent-notebook 高质量消费（硬约束）

这是核心交付路径。打开 `http://localhost:3737/` 应该能"从开篇看到结尾"独立讲完整个 v3 设计。**不能假定读者已经看过 README 或 notes.md**。

### lesson.md 叙事（11 段）

1. **开篇**（H1 + 段落）：从 v2 的局限切入 —— "v2 只有一种 mode，production 需要矩阵"
2. **Mode 枚举介绍**：`@include(./agent-v3-mode-matrix.ts, section=1)` + 段落讲解
3. **Hard-block 设计动机**（user 兜底）：`@include(./agent-v3-mode-matrix.ts, section=2)`
4. **Tools schema 不变**（推测 2）：`@include(./agent-v3-mode-matrix.ts, section=3)`
5. **Dispatch 是矩阵的物理化**（推测 1 + 推测 5）：`@include(./agent-v3-mode-matrix.ts, section=4)` + audit log 片段
6. **default mode 跑一遍**：`@include(./run-log-default.txt, round=1)` + 解读
7. **acceptEdits mode 矩阵性体现**：`@include(./run-log-accept-edits.txt, round=1)`
8. **bypass mode**：`@include(./run-log-bypass.txt, round=1)` + 强调 audit
9. **bypass + hard-block 触发**：`@include(./run-log-bypass-hard-blocked.txt, round=1)` + model 在 is_error 下的自适应（推测 4 实战验证）
10. **5 条推测对照小结**（H2 + 列表）：每条一行，标 ✅/❌/⚠️/⬛
11. **写回 v2 的改进意见**（H2 + 列表）

### Markdown 子集限制

只能用：H1-H3 标题、段落、无序列表、`inline code`、`**bold**`。

**不能用**：表格 / mermaid / fenced code block。mode 对比拆成多个 H3 + 段落；矩阵结构用文字描述或缩进列表，不依赖等宽对齐。

### 可视化验证

```bash
~/.bun/bin/bun run /Users/stringzhao/workspace/learn-everything/tools/agent-notebook/server.ts \
  /Users/stringzhao/workspace/learn-everything/topics/agent-harness-engineering/artifacts/03-mode-matrix-agent/
```

打开 `http://localhost:3737/` → 顶部 banner 能切到 03 → 单步推进能在右侧 messages 侧栏看到 mode 切换的物理体现（dispatch 早返回时不会多 readline 等待，但会多 tool_result）。任何红色错误块（错误 `@include`）即 fail。

---

## 交付清单

| 文件 | 角色 |
|---|---|
| `agent-v3-mode-matrix.ts` | **核心产出**：v3 实现，≤ 200 行，严格切 7 段 |
| `lesson.md` | **核心产出**：agent-notebook 入口，11 段叙事 |
| `run-log-default.txt` | default mode 真实运行日志 |
| `run-log-accept-edits.txt` | acceptEdits mode 真实运行日志 |
| `run-log-bypass.txt` | bypass mode + audit 日志 |
| `run-log-bypass-hard-blocked.txt` | bypass 下被 hard-block 拦截 + model is_error 自适应 |
| `notes.md` | 5 条推测对照报告 + mode 矩阵物理化论证（≥ 600 字）|
| `excerpts.md` | 源码关键片段引用（找不到源码就在 notes.md 第 1 节说清）|
| `README.md` | 三段式：学到了什么 / 怎么读这份归档（指向 lesson.md）/ 在课程中的位置 |
| `spec.md` | 本文件 |

---

## 约束

- **必须真实运行**：4 份 run-log 都是 v3 真实跑出来的，不能手写
- `delete_file` 仍 mock；hard-block 拦截可以用真实危险 path（`/`、`/etc` 等）触发但不真删
- `agent-v3-mode-matrix.ts` ≤ 200 行
- 5 条推测在 notes.md 必须逐条有判定 + 论证
- `ask_user` 在三种 mode 下都挂在 tools schema 里（推测 2 的代码体现）
- system prompt 在三种 mode 下字面量一致（推测 1 的代码体现）
- 用 `fetch` 直打 Anthropic 协议，不用 SDK（Otter 硬约束）
- model: `claude-haiku-4-5-20251001`

---

## 验收标准

1. v3 严格切 7 段（`grep -c "^// ----------"` = 7）
2. 4 份 run-log 每份都有 ROUND 切片 + FINAL MESSAGES 段
3. lesson.md 在 agent-notebook 打开后能从头看到尾、无红色错误块
4. mode 矩阵的物理承载在代码里能 grep 到（dispatch 入口的 mode switch + hard-block 列表 + is_error 拼回）
5. notes.md 5 条推测全部判定 + 论证（≥ 600 字）
6. hard-block run-log 能看到 model 在 `is_error` 下生成"我无法删除此路径"的自适应回复

---

## 完成后

- artifact_count: 2 → 3
- bloom_level 推进到 `create`（如果 lesson.md 叙事清晰、矩阵物理化干净）
- 更新 INDEX.md、写 journal accept 条
- 下一步：Lecture 04（context compaction 或 multi-agent coordinator 二选一）
