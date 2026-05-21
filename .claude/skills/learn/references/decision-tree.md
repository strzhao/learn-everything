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

→ AI **主动列出**所有活跃 topic（不含 `_archive/` 下的）+ 归档区简要计数：

```
你有以下学习 topic：

活跃：
| # | topic 名 | status | bloom_level | artifacts | 最后更新 |
|---|----------|--------|-------------|-----------|----------|
| 1 | <topic_a 名> | active | apply | 3 | 2026-05-21 |
| 2 | <topic_b 名> | paused | understand | 1 | 2026-05-19 |

已完成（_archive/ 内）：N 个

请输入序号继续，或输入新主题名称开始：
```

→ 用户选定后写 `_active` 指针，进入阶段 2。

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
| 4 | 上轮 `socratic` 且学生展示理解 | **accept** → 决定下一步（lecture / task / assemble） |
| 5 | 上轮 `socratic` 但回答不完整/错 | `stuck_count++` → **stuck-detected** + escalating hint |
| 6 | 上轮 `task` 且提交了产物 | **accept**（写 artifacts/）→ 决定下一步 |
| 7 | 上轮 `assemble` 且学生确认 final | **accept** → `status: completed` → 触发 **archive** |
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
- journal 追 `### <ISO8601> [lecture]`
- state.md：`## 当前位置` 加入本轮概念，`## 下一步建议` 更新为 socratic，`updated_at` 更新

### `socratic`
- 输出 1-3 个反问，类型轮换（澄清 / 假设探究 / 反例 / 元认知）
- journal 追 `### <ISO8601> [socratic]`
- state.md：`## 下一步建议` 更新为"等待学生回答"

### `task`
- 描述：目标 + 交付物格式 + 验收标准
- journal 追 `### <ISO8601> [task]`
- state.md：`## 下一步建议` 更新为"等待任务交付"

### `accept`
- **验收 socratic** 时：journal 追 `### <ISO8601> [accept]`，按需提升 `bloom_level`
- **验收 task** 时：
  1. `mkdir -p topics/<slug>/artifacts/<NN-name>`，NN 两位零填充（`artifact_count + 1`，最小 `01`）
  2. 写 `topics/<slug>/artifacts/<NN-name>/README.md`，必含三段：
     ```
     ## 它做什么
     ## 怎么用
     ## 与其他组件的关系
     ```
  3. `artifact_count += 1`，journal 追 `### <ISO8601> [accept]`
  4. state.md `artifact_count` 和 `bloom_level` 更新
- **验收 assemble** 时：见优先级 7 → 设 `status: completed` → 触发 archive

### `stuck-detected`
- `stuck_count += 1`
- journal 追 `### <ISO8601> [stuck-detected]`，记卡住概念和推断原因
- state.md `## 卡点记录` 追条目，`stuck_count` 字段更新
- 输出 escalating hint（第 1 次小提示，第 2 次更明显）

### `stuck->lecture`
- 输出"我注意到这个概念有些难，让我换个角度..."
- 执行 `lecture` 动作，针对卡住的概念用全新类比/角度
- `stuck_count = 0`
- journal 追 `### <ISO8601> [stuck->lecture]`
- state.md `stuck_count` 归零，`## 卡点记录` 对应条目补"→ 已切换讲解模式"

### `assemble`
- `mkdir -p topics/<slug>/final`
- 写 `topics/<slug>/final/README.md`：
  - 项目概述（这个 mini-工具做什么）
  - 使用方法
  - 组件清单（用相对路径 `../artifacts/<NN-name>/` 引用每个 artifact）
  - 学习旅程总结
- journal 追 `### <ISO8601> [assemble]`

### `archive`（自动归档，触发自优先级 7 的 accept）

**触发条件**：`status` 刚刚转为 `completed`（同一轮内）

**执行步骤**（AI 用 Bash 工具完成，**不引入新 sh 脚本**）：
1. **移动整个 topic 目录**：`mv topics/<slug> topics/_archive/<slug>`
2. **清理 _active 指针**：如果 `topics/_active` 当前指向被归档的 slug，执行 `: > topics/_active`（清空但保留文件）
3. **journal 追 `### <ISO8601> [archive]`**：写在已归档目录里 `topics/_archive/<slug>/journal.md`，记录归档时间和归档原因（"主题学习完成"）
4. **不修改 state.md**：归档时 state.md status 已是 completed，无需再改

**注意**：归档前必须确保 final/ 目录已建且学生已 accept；如果 status 已 completed 但归档因任何原因失败（mv 出错），不要静默继续，向用户报告。

---

## 阶段 5：状态持久化（State Persistence）

每次执行动作后**必须**完成：

### 5-A：追加 journal.md（追加，不覆盖）
```
### <ISO8601> [<动作类型>]

<本轮摘要：50-150 字，记录关键信息供后续调度参考>
```

### 5-B：更新 state.md
- `updated_at` 必更
- 按需更：`stuck_count` / `bloom_level` / `artifact_count` / `status`
- `## 下一步建议` 必更（指明下次调度的预判动作）

### 5-C：更新 _active（仅切换 topic 时）
单行写入新 slug，无前缀无空格无换行（`echo -n` 风格）。归档时如指向被归档 slug，则清空。

### 5-D：重生成 INDEX.md（每轮必做）

**触发**：阶段 4 的任何动作完成后（lecture / socratic / task / accept / stuck-detected / stuck->lecture / assemble / archive 任一）

**执行**：
1. AI 列出 `topics/` 下所有 slug 子目录（不含 `_archive/`、不含 `_active` 文件、不含 `INDEX.md`）作为"活跃区"
2. 列出 `topics/_archive/` 下所有 slug 子目录作为"归档区"
3. 对每个 slug 读取 `state.md` 的 frontmatter 字段
4. 覆盖写 `topics/INDEX.md`：

```markdown
# topics 索引

> 由 AI 自动维护，**请勿手动编辑**。每次 /learn 调度结束后会被重新生成。最后更新：<ISO8601>

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

INDEX.md 是用户俯瞰所有学习状态的入口，应当随时反映真实状态。

---

## 附：stuck_count 状态机

```
[初始]
stuck_count = 0
   │
   │ 学生回答未推进
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
