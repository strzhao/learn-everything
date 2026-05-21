# decision-tree.md — /learn 内部调度决策树

本文档定义 `/learn` 被调用时，AI 的完整决策流程。每次用户调用 `/learn` 时，AI **必须严格按以下顺序执行**，不得跳过任何节点。

---

## 阶段 0：前置检查（Pre-flight Checks）

在执行任何学习动作前，必须完成以下检查：

### 0-A：工作目录写权限检查

```bash
test -w .
```

- **通过**：继续执行
- **失败**：立即中止，向用户输出错误信息：
  ```
  错误：当前目录不可写。learn-everything 需要在可写目录中运行以创建 .learn/ 数据目录。
  请 cd 到一个可写目录后重试，例如你的项目根目录或 home 目录。
  ```

### 0-B：skill 自身完整性检查

检查以下文件是否存在：
```
$SKILL_DIR/references/topic-init-template.md
$SKILL_DIR/references/decision-tree.md
$SKILL_DIR/pedagogy/socratic-method.md
$SKILL_DIR/pedagogy/gemini-learning-mode.md
$SKILL_DIR/pedagogy/blooms-taxonomy.md
$SKILL_DIR/pedagogy/spaced-repetition.md
$SKILL_DIR/pedagogy/feynman-technique.md
```

- **全部存在**：继续执行
- **缺少文件**：输出警告（非中止）：
  ```
  警告：skill 资源不完整，缺少以下文件：<列表>。
  部分教学功能可能降级。建议重新运行 install.sh 修复。
  ```

---

## 阶段 1：参数解析（Argument Parsing）

### 1-A：解析调用参数

| 调用形式 | 含义 |
|---------|------|
| `/learn`（无参数）| 读取 `.learn/active.md` 中的 slug，推进当前 topic |
| `/learn <topic-name>` | 切换到或新建指定 topic |
| `/learn --list` | 列出 `.learn/topics/` 下所有 topic 及其状态 |
| `/learn --status` | 显示当前 active topic 的 `state.md` 摘要 |

### 1-B：`.learn/` 目录状态判断

**情况 A：`.learn/` 不存在**

→ 询问用户想学什么：
```
你好！看起来你还没有开始任何学习 topic。
你想学什么？请告诉我主题，例如「React Hooks」、「机器学习基础」、「Git 工作流」等。
```
→ 等待用户回复后，进入「新建 topic 流程」（见阶段 2-C）

**情况 B：`.learn/` 存在但 `active.md` 为空或不存在**

→ 询问：
```
你有以下学习 topic，但没有设置活跃 topic：
<列出所有 topics>
输入 topic 编号/名称继续，或输入新主题名称开始新 topic：
```

**情况 C：`.learn/active.md` 存在且含有效 slug**

→ 读取 slug，进入阶段 2，推进该 topic

---

## 阶段 2：上下文读取（Context Loading）

### 2-A：读取 state.md

路径：`.learn/topics/<slug>/state.md`

读取：
- YAML frontmatter 全部字段（特别是 `status`、`stuck_count`、`bloom_level`、`artifact_count`）
- `## 当前位置` 段落全文
- `## 下一步建议` 段落全文
- `## 卡点记录` 段落全文

如果 `state.md` 不存在但目录存在：按 `references/topic-init-template.md` 重新初始化。

### 2-B：读取 journal.md（最新 N 条）

路径：`.learn/topics/<slug>/journal.md`

- N 的默认值：最近 **5 条** journal 条目（每条为 `### <时间戳> [<动作类型>]` 开头的段落）
- 若 journal.md 不存在：视为空，继续执行
- 读取目的：了解上一轮动作类型（`lecture` / `socratic` / `task` / `accept` 等），作为本轮决策的主要输入

### 2-C：按需引入 pedagogy 资料

以下情况下，AI 应在内部调用（reference）对应教学法文档：
- 即将执行 `socratic` 动作时：引用 `pedagogy/socratic-method.md`
- 检测到 stuck_count 增加趋势时：引用 `pedagogy/spaced-repetition.md`（可能需要回顾旧知识）
- 即将执行 `task` 动作时：引用 `pedagogy/feynman-technique.md`（任务设计参考）
- 评估学生当前 bloom_level 时：引用 `pedagogy/blooms-taxonomy.md`
- 整体调度策略参考：引用 `pedagogy/gemini-learning-mode.md`

---

## 阶段 3：动作决策（Action Decision）

### 决策主树

按以下优先级从高到低依次判断，命中第一条即停止：

```
优先级 1（最高）：stuck_count >= 3
  → 动作：stuck->lecture（escape 机制）
  → 说明：无论上一轮是什么，立即切换到讲解模式

优先级 2：status == "completed"
  → 动作：提示已完成
  → 说明："该 topic 已标记为完成。你可以 /learn <new-topic> 开始新主题，
           或 /learn --status 查看当前状态。"

优先级 3：上一轮动作 == "lecture" 且无卡住迹象（stuck_count < 3）
  → 动作：socratic
  → 说明：讲解后必须出反问验证理解，不允许连续两轮 lecture

优先级 4：上一轮动作 == "socratic" 且学生回答展示了理解
  → 动作：accept（确认理解）→ 立即决定下一步
      - 若 bloom_level < apply 且没有悬而未做的任务：→ 出 lecture（新概念）
      - 若 bloom_level >= understand 且 artifact_count 需要增加：→ 出 task
      - 若 artifact_count >= 2 且主题预期完成：→ 出 assemble

优先级 5：上一轮动作 == "socratic" 且学生回答不完整或错误
  → stuck_count += 1
  → 动作：stuck-detected（记录）→ 追加提示/提供线索（hint），重新出变体问题
  → 注意：不是直接切 lecture，而是先给 hint 再问

优先级 6：上一轮动作 == "task" 且学生提交了产物
  → 动作：accept（验收）→ 写入 artifacts/<NN-name>/ → artifact_count += 1
  → 决定下一步（同优先级 4 的子逻辑）

优先级 7：上一轮动作 == "assemble"
  → 动作：accept（验收 final/）→ status 设为 "completed" → 庆祝🎉 + 总结

优先级 8（兜底）：无法匹配以上任何情况
  → 动作：lecture（以新概念推进）
```

---

## 阶段 4：执行动作（Action Execution）

### 动作类型枚举与执行规范

#### `lecture`（讲解）

**触发条件**：首次开始、上一轮是 socratic 且需要推进新概念、escape 机制触发

**执行内容**：
1. 输出讲解文本（200-500 字，含类比/例子）
2. 追加 journal 条目：`### <ISO8601> [lecture]`，正文包含本轮讲解的核心概念摘要
3. 更新 `state.md`：`## 当前位置` 加入本轮概念，`## 下一步建议` 更新为"下一步出 socratic 验证"，`updated_at` 更新

#### `socratic`（苏格拉底反问）

**触发条件**：上一轮是 lecture 且学生回应正向

**执行内容**：
1. 输出 1-3 个反问（不要同时问太多），类型轮换（澄清 / 假设探究 / 反例构建）
2. 追加 journal 条目：`### <ISO8601> [socratic]`，正文包含问题内容摘要
3. 更新 `state.md`：`## 下一步建议` 更新为"等待学生回答，预判接下来的动作"

#### `task`（任务出题）

**触发条件**：上一轮 socratic accept 且 bloom_level 适合

**执行内容**：
1. 描述任务：目标、交付物格式（代码 / 文字说明 / 类比）、验收标准（acceptance criteria）
2. 追加 journal 条目：`### <ISO8601> [task]`，正文包含任务描述摘要
3. 更新 `state.md`：`## 下一步建议` 更新为"等待任务交付物"

#### `accept`（验收）

**触发条件**：socratic 回答正确 或 task 产物满足验收标准

**执行内容**（验收 task 时）：
1. 创建 `artifacts/<NN-name>/` 目录，NN 为两位数零填充（`artifact_count + 1`，最小为 `01`）
2. 写入 `artifacts/<NN-name>/README.md`，包含三个必须段落：
   ```markdown
   ## 它做什么
   （用简单语言描述此组件的功能，无需技术背景即可理解）
   
   ## 怎么用
   （使用示例，代码或步骤均可）
   
   ## 与其他组件的关系
   （说明此组件如何与已有 artifacts 配合，或 final/ 中如何引用它）
   ```
3. `artifact_count += 1`，追加 journal：`### <ISO8601> [accept]`
4. 更新 `state.md` 的 `artifact_count` 和 `bloom_level`（若有提升）

#### `stuck-detected`（卡住检测）

**触发条件**：学生连续回答未能推进理解

**执行内容**：
1. `stuck_count += 1`
2. 追加 journal：`### <ISO8601> [stuck-detected]`，记录卡住的概念和推断原因
3. 更新 `state.md`：`## 卡点记录` 追加新条目，`stuck_count` 字段更新
4. 输出额外提示（escalating hints）：第 1 次给小提示，第 2 次给更明显线索

#### `stuck->lecture`（escape：卡住后切讲解）

**触发条件**：`stuck_count >= 3`

**执行内容**：
1. 输出说明："我注意到这个概念有些难，让我换个角度来讲解..."
2. 执行 `lecture` 动作（针对卡住的概念重新讲解）
3. `stuck_count = 0`（归零）
4. 追加 journal：`### <ISO8601> [stuck->lecture]`
5. 更新 `state.md`：`stuck_count` 归零，`## 卡点记录` 对应条目追加"→ 已切换讲解模式"

#### `assemble`（最终拼装）

**触发条件**：`artifact_count >= 2` 且 AI 判断主题核心概念已全部覆盖

**执行内容**：
1. 创建 `final/` 目录
2. 写入 `final/README.md`，包含：
   - 项目概述（这个 mini-工具做什么）
   - 使用方法（入口说明）
   - 组件清单（通过相对路径引用所有 artifacts）：`../artifacts/<NN-name>/`
   - 学习旅程总结（学生在此主题上完成了什么）
3. 追加 journal：`### <ISO8601> [assemble]`
4. 等待学生验收（提交最终产物后执行 `accept`，将 status 设为 `completed`）

---

## 阶段 5：状态持久化（State Persistence）

每次执行动作后，必须：

1. **追加 journal.md**（追加，不覆盖）：
   ```
   ### 2025-11-05T14:35:22+08:00 [<动作类型>]
   
   <本轮摘要：50-150 字，记录关键信息，供后续调度参考>
   ```

2. **更新 state.md**：
   - 必须更新 `updated_at`
   - 按需更新其他字段（`stuck_count`、`bloom_level`、`artifact_count`、`status`）
   - 必须更新 `## 下一步建议` 段落

3. **更新 active.md**（仅在切换 topic 时）：
   - 写入新 slug（单行，不含换行符以外的空格）

---

## 附：stuck_count 状态机

```
[初始化/归零]
stuck_count = 0
       |
       | 学生回答未能推进
       v
stuck_count = 1  →  [stuck-detected] 追加 hint 1
       |
       | 再次未能推进
       v
stuck_count = 2  →  [stuck-detected] 追加 hint 2（更明显）
       |
       | 再次未能推进
       v
stuck_count = 3  →  ★ [stuck->lecture] 强制切讲解
                    stuck_count 归零 = 0
```

**归零触发条件**（除 `stuck->lecture` 外）：
- 成功的 `accept` 动作（证明理解突破）
- 切换到新的 topic（`active.md` 更新）
- `status` 变为 `completed`

---

## 附：动作类型合法值（journal.md 使用）

```
lecture         讲解新概念
socratic        苏格拉底反问
task            布置实践任务
accept          验收理解/产物
stuck-detected  检测到卡点
stuck->lecture  escape：卡住后切讲解
assemble        触发最终拼装
```

以上为全部合法动作类型，journal 中不应出现其他值。
