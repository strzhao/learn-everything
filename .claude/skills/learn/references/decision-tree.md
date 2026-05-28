# decision-tree.md — /learn 内部调度决策树

本文档定义 `/learn` 被调用时，AI 的完整决策流程。每次用户调用 `/learn` 时，AI **必须严格按以下顺序执行**，不得跳过任何节点。所有目录管理（INDEX.md 维护、自动归档）由 AI 在调度过程中读写文件完成，**不依赖任何 sh 脚本**。

---

## 阶段 0：前置检查（Pre-flight Checks）

### 0-A：工作目录写权限检查

```bash
test -w .
```

- **通过**：继续
- **失败**：立即中止，提示用户切换到可写目录

### 0-B：skill 自身完整性检查

检查以下文件存在：
- `$SKILL_DIR/references/topic-init-template.md`
- `$SKILL_DIR/references/decision-tree.md`
- `$SKILL_DIR/pedagogy/{socratic-method,gemini-learning-mode,blooms-taxonomy,spaced-repetition,feynman-technique}.md`

缺文件 → 输出警告（非中止），建议用户重新克隆本项目。

### 0-C：cwd 必须是 learn-everything 项目根

本 skill 是项目级 skill（位于 `<project>/.claude/skills/learn/`），调用时 cwd 应为 learn-everything 项目根。AI 通过检测顶层 `CLAUDE.md` 是否含 `learn-everything` 关键词或 `.claude/skills/learn/SKILL.md` 是否存在来确认。如果不是，提示用户 `cd` 到 learn-everything 项目根。

---

## 阶段 1：参数解析与目录状态判断

### 1-A：调用形式

| 形式 | 含义 |
|------|------|
| `/learn`（无参）| 无 `_active` → 列出 topic 让用户选 / 有 `_active` → 推进 |
| `/learn <topic-name>` | 切换到该 topic（已存在）或新建（不存在） |

**本 skill 单一入口，不接受 `--list` `--status` 等子命令。**所有"列出""归档""索引"动作由 AI 在合适时机自动执行。

### 1-B：`topics/` 目录状态判断

**情况 A：`topics/` 不存在或为空目录**

→ AI 询问用户首个主题：
```
你好！还没有任何学习 topic。
你想学什么？例如：「React Hooks」「机器学习基础」「Git 工作流」等。
```
→ 等待用户回复后进入「新建 topic 流程」。

**情况 B：`topics/` 存在 + 有 ≥1 个 slug 子目录 + `_active` 不存在或为空**

→ AI 通过 **`AskUserQuestion`** 列出活跃 topic（不含 `_archive/`），询问继续哪个：

- 问题文本："你想继续哪个学习 topic？"
- 每个活跃 topic 一个选项，label 含 topic 名（≤12 字符限制内尽量精简），description 含 `bloom_level + artifacts数 + 最后更新日期`
- 最近 `updated_at` 的 topic 放首位 + label 末尾标 "（推荐）"
- 必须包含一个"开始新主题"选项（你选后用 "Other" 输入新主题名，或在后续轮次提供）
- 活跃 topic 数 > 3：仅列出最近更新的 3 个 + "查看更多"选项（选后 AI 用纯文本完整列出后再次发起 AskUserQuestion）

如归档区非空，在 AskUserQuestion 调用前先用一行文本告知："已归档 N 个 topic（位于 _archive/）。"

→ 你选定后写 `_active` 指针，进入阶段 2。

**情况 C：`topics/_active` 存在且含有效 slug**

→ 读取 slug，进入阶段 2 推进该 topic。

**情况 D：`/learn <topic-name>` 显式参数**

→ kebab-case 转换：参数名 → slug
- 已存在 `topics/<slug>/` → 切换 active（更新 `_active`，原 active 转 paused）
- 不存在 → 新建（按 `topic-init-template.md`），写 `_active`

---

## 阶段 2：上下文读取（Context Loading）

### 2-A：读 state.md 全文（YAML frontmatter + 三个 H2）
路径：`topics/<slug>/state.md`

### 2-B：读最新 5 条 journal 条目
路径：`topics/<slug>/journal.md`

了解上一轮动作类型（`lecture` / `socratic` / `task` / `accept` 等），是本轮决策主要输入。

### 2-C：按需引入 pedagogy

- 即将 `socratic` → `pedagogy/socratic-method.md`
- stuck_count 上升趋势 → `pedagogy/spaced-repetition.md`（回顾旧知识）
- 即将 `task` → `pedagogy/feynman-technique.md`
- 评估 bloom_level → `pedagogy/blooms-taxonomy.md`
- 整体调度参考 → `pedagogy/gemini-learning-mode.md`

---

## 阶段 3：动作决策（Action Decision）

按优先级从高到低，命中第一条即停止：

| 优先级 | 条件 | 动作 |
|-------|------|------|
| 1 | `stuck_count >= 3` | **stuck->lecture**（escape） |
| 2 | `status == "completed"` | 提示已完成；如未归档则触发 archive 动作 |
| 3 | 上轮 `lecture` 且无卡迹象 | **socratic**（lecture 后必反问） |
| 4 | 上轮 `socratic` 且你展示理解 | **accept** → 决定下一步（lecture / task / assemble） |
| 5 | 上轮 `socratic` 但回答不完整/错 | `stuck_count++` → **stuck-detected** + escalating hint |
| 6 | 上轮 `task` 且提交了产物 | **accept**（写 artifacts/）→ 决定下一步 |
| 7 | 上轮 `assemble` 且你确认 final | **accept** → `status: completed` → 触发 **archive** |
| 8 | 兜底 | **lecture**（推进新概念） |

---

## 阶段 4：执行动作（Action Execution）

### 动作枚举（journal.md 合法值）

```
lecture          讲解新概念
socratic         苏格拉底反问
task             布置实践任务
accept           验收理解/产物
stuck-detected   检测到卡点
stuck->lecture   escape：卡住后切讲解
assemble         触发最终拼装
archive          topic 完成后自动归档（移到 _archive/）
```

### `lecture`
- 输出 200-500 字讲解
- **过渡态动作，不落盘**——讲解内容留在对话上下文；下次 `accept` 里程碑触发时由 AI 回填概念到 state.md `## 当前位置` 的"已覆盖"清单
- **例外**：首轮 lecture（新 topic 初始化）= 初始化里程碑，需同轮写入 state.md + journal.md + INDEX.md，详见 SKILL.md `## 初始化新 topic 完整流程`
- 完成后 AI 必须在响应中显式声明 `[本轮无落盘]`（除首轮外）

### `socratic`
- **必须通过 `AskUserQuestion` 工具发起**，一次调用包含 1-3 个问题（每个问题独立 questions 数组项）
- 问题类型轮换（澄清 / 假设探究 / 反例 / 元认知 / 证据追问）
- 每个问题配 **2-4 个候选答案选项**（AskUserQuestion 自动追加 "Other"）：
  - 一个最佳答案 + 1-3 个**有教学价值的干扰项**：基于常见误解 / 不完整答案 / 似是而非的错误
  - **不标记"（推荐）"**——会暴露答案，破坏诊断价值
  - 选项之间互斥、粒度相近；description 简短点出该选项的"立场"，不要写答题解析
- **过渡态动作，不落盘**——问题与选项内容由 AskUserQuestion 工具调用日志自动保留；pending 状态可由"上轮是 lecture/accept"推断
- 完成后 AI 必须在响应中显式声明 `[本轮无落盘]`

### `task`
- 描述：目标 + 交付物格式 + 验收标准（**纯文本输出**——task 描述是教学内容而非问询）
- **过渡态动作，不落盘**——任务描述在对话上下文中可被你回顾；pending 状态可由"上轮是 accept"推断
- 完成后 AI 必须在响应中显式声明 `[本轮无落盘]`

### `accept`

**本动作为里程碑**——state.md + journal.md 在同一轮中并行更新（一次响应内 ≤2 个写入工具调用）。详见 SKILL.md `## 落盘策略`。

- **验收 socratic** 时：
  - 读取 AskUserQuestion 返回的 answers（每问一个 answer，"Other" 时含自定义文本）
  - 评估理解深度：
    - 选了**最佳选项** → 直接 accept；如多题连续命中，可提升 `bloom_level`
    - 选了**干扰项** → **不直接 stuck-detected**；先给反馈解释"为什么这个选项是常见误解"，再继续推进（轻量纠正而非强 escalate）；如多次反复选错才升 stuck_count
    - 选了 **"Other" 自定义文本** → 按 `pedagogy/feynman-technique.md` 评估其表达：能用简单语言表达 → accept；停留在术语堆砌 → 引导重表达
  - journal 追单行 `### <ISO8601> [accept] socratic 通过 concept=<X>; bloom <旧>→<新>`（≤50 字符）
  - state.md：`updated_at` 更新；`## 当前位置` 的"已覆盖"清单追加新概念名；`bloom_level` 视情况升级
- **验收 task** 时：
  - **先用 `AskUserQuestion` 询问交付状态**，选项：
    - "已交付（推荐）"
    - "还需修改"
    - "跳过此任务"
  - 你选"已交付" → 进入下面步骤 1-4
  - 你选"还需修改" → 给反馈，不 accept，等下一轮（不升 stuck_count）
  - 你选"跳过" → 不写 artifact，journal 记 `[stuck-detected]`（视为不通过）
  - 步骤 1-4：
    1. `mkdir -p topics/<slug>/artifacts/<NN-name>`，NN 两位零填充（`artifact_count + 1`，最小 `01`）
    2. 写 `topics/<slug>/artifacts/<NN-name>/README.md`，必含三段：
       ```
       ## 它做什么
       ## 怎么用
       ## 与其他组件的关系
       ```
    3. `artifact_count += 1`，journal 追单行 `### <ISO8601> [accept] task-<NN> → artifacts/<NN-name>; bloom <旧>→<新>`（≤50 字符）
    4. state.md：`updated_at` / `artifact_count` / `bloom_level` 更新；`## 当前位置` 追加 task 验收的概念名；`## 下一步建议` 可按需更新（如下一步预判 task 还是 lecture）
- **验收 assemble** 时：见优先级 7 → 设 `status: completed` → 触发 archive

### `stuck-detected`

**本动作为里程碑**——safety-net 计数器必须跨会话持久；若漏写，下次会话 escape 永不触发。

- `stuck_count += 1`
- journal 追单行 `### <ISO8601> [stuck-detected] stuck_count=<N> concept=<X>`（≤50 字符）
- state.md：`updated_at` 更新；`stuck_count` 字段更新；`## 卡点记录` 追一行：`- <date> <concept>（hint <N>）`
- 输出 escalating hint（第 1 次小提示，第 2 次更明显）
- **hint 后必须用 `AskUserQuestion` 重新发起问询**，避免你陷入"我该说什么"的次生困惑：
  - 选项可简化到 2 个："我有思路了 / 还是不太明白"——让你在不暴露细节的情况下表达"是否要更多提示"
  - 或：重出原 socratic 问题但选项减少 1 个（去掉最有干扰性的错误选项），降低难度
  - 若 `stuck_count == 2`（下一轮就会 escape），选项 description 显式说明"再答错就切换讲解模式"，让你有心理预期

### `stuck->lecture`

**本动作为里程碑**——状态机归零；卡点记录补记必须落盘以备追溯。

- 输出"我注意到这个概念有些难，让我换个角度..."
- **先用 `AskUserQuestion` 确认切换方向**，选项：
  - "换类比再讲（推荐）"
  - "我想再试一次回答"
  - "跳过这个概念暂存卡点"
- 你选"换类比再讲" → 执行 `lecture` 动作，针对卡住的概念用全新类比/角度
- 你选"再试一次" → 重出原 socratic（不进入 lecture），但**不再 +stuck_count**（已经在 escape 临界）
- 你选"跳过暂存" → 在 state.md 卡点记录标"暂存"，开**新概念**的 lecture
- `stuck_count = 0`（任一分支都归零）
- journal 追单行 `### <ISO8601> [stuck->lecture] reset; <你选择>: <角度/概念>`（≤50 字符）
- state.md：`updated_at` 更新；`stuck_count` 归零；`## 卡点记录` 对应条目补"→ 已切换讲解模式"或"→ 暂存"

### `assemble`

**本动作为里程碑**——新产物 `final/README.md` 诞生 + status 即将转 completed。

- **触发前必须用 `AskUserQuestion` 确认**，选项：
  - "现在拼装 final（推荐）"
  - "再加一节内容"
  - "暂停 topic"
- 你选"现在拼装" → 执行下方步骤
- 你选"再加一节" → 不写 final，按 AI 判断继续 lecture 或 socratic
- 你选"暂停" → 设 `status: paused`，不归档，下次 `/learn` 时仍可恢复
- 拼装步骤：
  - `mkdir -p topics/<slug>/final`
  - 写 `topics/<slug>/final/README.md`：
    - 项目概述（这个 mini-工具做什么）
    - 使用方法
    - 组件清单（用相对路径 `../artifacts/<NN-name>/` 引用每个 artifact）
    - 学习旅程总结
- journal 追单行 `### <ISO8601> [assemble] final/ 写入；待 accept 转 completed`（≤50 字符）

### `archive`（自动归档，触发自优先级 7 的 accept）

**本动作为里程碑**——目录移动 + INDEX.md 重生成 + journal 末条带归档时间。

**触发条件**：`status` 刚刚转为 `completed`（同一轮内）

**执行步骤**（AI 用 Bash 工具完成，**不引入新 sh 脚本**）：
1. **移动整个 topic 目录**：`mv topics/<slug> topics/_archive/<slug>`
2. **清理 _active 指针**：如果 `topics/_active` 当前指向被归档的 slug，执行 `: > topics/_active`（清空但保留文件）
3. **journal 追单行**：在已归档目录里 `topics/_archive/<slug>/journal.md` 追 `### <ISO8601> [archive] 主题学习完成`（≤50 字符）
4. **不修改 state.md**：归档时 state.md status 已是 completed，无需再改
5. **INDEX.md 重生成**：归档动作触发 INDEX.md 全量重建（status / 路径都变了）

**注意**：归档前必须确保 final/ 目录已建且你已 accept；如果 status 已 completed 但归档因任何原因失败（mv 出错），不要静默继续，向用户报告。

---

## 阶段 4.5：交互工具契约（AskUserQuestion 强制使用）

本 skill 的所有"向用户问询"动作**必须**通过 `AskUserQuestion` 工具，不允许用纯文本"请问..."这类伪问询代替。完整使用规范见 SKILL.md 中"交互机制：何时用 AskUserQuestion"章节，本节仅作调度层的契约提醒。

### 强制使用 AskUserQuestion 的时机（决策枚举）

| 时机 | 触发位置 | 选项典型构成 |
|------|---------|-------------|
| 多 topic 列表选择 | 阶段 1-B 情况 B | 各 topic 名（最近更新者标"（推荐）"）+ "开始新主题" |
| socratic 反问 | 阶段 4 socratic | 最佳答案 + 1-3 个基于常见误解的干扰项（**不标推荐**）|
| task 验收确认 | 阶段 4 accept | "已交付（推荐）/ 还需修改 / 跳过此任务" |
| stuck-detected hint 后 | 阶段 4 stuck-detected | "我有思路了 / 还是不太明白"（或简化版原问题）|
| stuck->lecture 切换前 | 阶段 4 stuck->lecture | "换类比再讲（推荐）/ 我想再试一次 / 跳过暂存" |
| assemble 触发 | 阶段 4 assemble | "现在拼装 final（推荐）/ 再加一节 / 暂停 topic" |

### 唯一允许纯文本问询的时机

- **阶段 1-B 情况 A**（`topics/` 为空，问首个主题）——本质自由输入，AskUserQuestion 会退化

### 违约判定

如果在任何"问询"时机使用了纯文本（除上述唯一例外），视为违反本契约。`acceptance-check.sh` 会校验 SKILL.md 与本文件均含 `AskUserQuestion` 字面量，作为契约存在的最低保证。

### 选项设计要点（与 SKILL.md 一致）

- **2-4 个**（AskUserQuestion 工具上限），互斥，粒度相近
- 决策类：推荐项标"（推荐）"放首位
- socratic 类：**绝不标记推荐**；干扰项基于常见误解设计
- description 简短描述选项含义，不写答题解析

---

## 阶段 5：状态持久化（State Persistence）

**仅里程碑动作触发**。lecture / socratic / task 三类过渡态动作执行后无落盘；AI 必须在响应中显式声明 `[本轮无落盘]` 便于审计。里程碑判定见 SKILL.md `## 落盘策略` 的权威表。

### 5-A：追加 journal.md（追加，不覆盖；仅里程碑动作触发）

格式：**单行变化日志**，≤50 字符。

```
### <ISO8601> [<动作类型>] <一句关键变化>
```

示例：
```
### 2026-05-21T14:30:00+08:00 [accept] task-02 → artifacts/02-permission-gate; bloom apply→analyze
### 2026-05-21T14:35:12+08:00 [stuck-detected] stuck_count=2 concept=permission双层架构
### 2026-05-21T14:40:00+08:00 [stuck->lecture] reset; 换"门禁+前台"类比
### 2026-05-21T15:10:00+08:00 [accept] socratic 通过 concept=ToolSchema; bloom remember→understand
```

**取消旧版"正文 50-150 字摘要"要求**——详细教学内容本就在对话历史里，journal 只记"什么变了"。

### 5-B：更新 state.md（仅里程碑动作触发）

按需更新以下字段（其他字段保持原值，避免无用 diff）：

- `updated_at`：本里程碑触发时刻
- `stuck_count`：stuck-detected +1 / stuck->lecture 归 0 / 成功 accept 归 0
- `bloom_level`：accept 时 AI 判断是否升级
- `artifact_count`：accept (task) 时 +1
- `status`：assemble 通过后 accept 时设为 `completed`
- `## 当前位置`：accept 时追加新概念名到"已覆盖"清单（权威源）
- `## 下一步建议`：仅 task 下发时或里程碑触发时按需更新——**不要求每轮更新**
- `## 卡点记录`：stuck-detected 追一行；stuck->lecture 在对应条目后补"→ 已切换/暂存"

### 5-C：更新 _active（仅切换 topic 时）

单行写入新 slug，无前缀无空格无换行（`echo -n` 风格）。归档时如指向被归档 slug，则清空。

### 5-D：重生成 INDEX.md（仅 status / artifact_count / topic 切换 / 归档时）

**触发**（任一发生）：
- 任意 topic 的 `status` 变更（包括转 `completed`、`paused`）
- 任意 topic 的 `artifact_count` 增加
- topic 切换（`_active` 改变）
- 归档（mv 到 `_archive/`）

普通推进（如非首轮 lecture、socratic、task、stuck-detected、stuck->lecture）**不**触发 INDEX 重生成。INDEX.md 头部"最后更新"字段允许滞后到下次里程碑——这是俯瞰视图非实时仪表，可接受。

**执行**：
1. AI 列出 `topics/` 下所有 slug 子目录（不含 `_archive/`、不含 `_active` 文件、不含 `INDEX.md`）作为"活跃区"
2. 列出 `topics/_archive/` 下所有 slug 子目录作为"归档区"
3. 对每个 slug 读取 `state.md` 的 frontmatter 字段
4. 覆盖写 `topics/INDEX.md`：

```markdown
# topics 索引

> 由 AI 自动维护，**请勿手动编辑**。仅在 status/artifact_count/切换/归档里程碑时重生成。最后更新：<ISO8601>

## 活跃 topic

| slug | 主题名 | status | bloom_level | artifacts | 更新于 |
|------|--------|--------|-------------|-----------|--------|
| <slug> | <topic name> | active | apply | 3 | 2026-05-21 |
| ... | ... | ... | ... | ... | ... |

当前 active：`<slug from _active>`（或 `（无）` 如 _active 为空）

## 已归档（_archive/）

| slug | 主题名 | 归档于 | artifacts |
|------|--------|--------|-----------|
| ... | ... | ... | ... |

（如归档区为空：写 "暂无已归档 topic。"）
```

### 5-E：Resumption 协议（会话中断后续传）

会话被 compact 或新会话启动后，AI 重建状态流程：

1. 读 `_active` → slug
2. 读 `state.md` 全文（frontmatter + 三 H2）
3. 读 `journal.md` 末尾 5 条（全是里程碑变化日志）
4. 推断"上次里程碑"和"当前应做什么"
5. **关键**：上次里程碑之后的 lecture/socratic/task 状态**直接放弃**——不询问用户、不试图复原（询问破坏沉浸感，你大概率也想不起来）
6. 根据末条 journal 推断下一步：
   - `[accept]` → 下一步是 lecture 或 task（按 bloom_level 选）
   - `[stuck-detected]` → 按 `stuck_count` 判断再尝试 socratic（hint 加码）还是触发 escape（≥3 时）
   - `[stuck->lecture]` → 重出原 socratic 或推进新概念
   - `[assemble]` → 等待你 accept 完成 final
   - `[archive]` → 提示该 topic 已完成，建议 `/learn <new-topic>`
7. 若 AI 实在拿不准上下文（如 5 条 journal 都不足以推断），用 `AskUserQuestion` 问"我们上次到 X，想继续推进 / 复习 / 换方向"

---

## 附：stuck_count 状态机

```
[初始]
stuck_count = 0
   │
   │ 你回答未推进
   ▼
stuck_count = 1  →  [stuck-detected] 追加 hint 1
   │
   │ 再次未推进
   ▼
stuck_count = 2  →  [stuck-detected] 追加 hint 2（更明显）
   │
   │ 再次未推进
   ▼
stuck_count = 3  →  ★ [stuck->lecture] 强制切讲解
                     stuck_count 归零 = 0
```

**归零条件**（除 stuck->lecture 外）：
- 成功的 `accept` 动作（理解突破）
- 切换到新 topic（`_active` 更新）
- `status` 变为 `completed`（连同 archive）
