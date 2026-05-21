---
name: learn
description: "AI 主导的个人学习辅助工具。单入口 /learn（不开放子命令），AI 自动调度讲解（lecture）、苏格拉底反问（socratic）、实践任务（task）三种模式，动态生成课程，无预设大纲。学完后产出可运行的 mini-工具作为'学会'的证明。触发关键词：/learn、学习、教我、我想学、帮我理解。"
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
---

# learn-everything — AI 主导的个人学习辅助工具（Skill Reference）

## 概述（Overview）

`/learn` 是一个由 AI 全程主导的个人学习 skill（personal learning skill）。用户只需告诉 AI 想学什么主题（topic），AI 会：

1. **动态生成课程**（dynamic curriculum generation）：无预设大纲，根据用户的实时反应调整讲解深度和节奏
2. **三模式智能切换**（adaptive mode switching）：讲解（lecture）/ 苏格拉底反问（socratic）/ 任务驱动（task）
3. **artifact 驱动的学习证明**（artifact-based evidence of learning）：每节课交付一个可拼装的子组件，最终组合成 mini-工具作为"学会"的可验证证明（verifiable proof of mastery）
4. **跨会话持久化**（cross-session persistence）：所有学习状态持久化在 `.learn/` 目录，随时中断、随时继续

这个 skill 的根本设计哲学是：**学习不是接收信息，而是建构理解（learning is constructing understanding, not receiving information）**。AI 的角色不是"答题机"，而是一个有教学策略的引导者（pedagogical facilitator），根据学习者当前的认知状态（cognitive state）主动调整教学介入方式（instructional intervention）。

---

## 核心设计原则（Core Design Principles）

### 原则一：AI 负责调度，人负责思考（AI orchestrates, human thinks）

与传统"你问我答"的 AI 交互不同，`/learn` 中 AI 是主动的调度者（orchestrator）：AI 决定本轮该讲解什么、该问什么问题、该出什么任务。用户的任务是认真思考（genuine thinking）、诚实回答（honest responses）、动手实践（hands-on practice）——而不是被动接收信息（passive information reception）。

这一设计直接参考了 `pedagogy/gemini-learning-mode.md` 中描述的 Gemini 学习模式理念：AI 扮演引导者而非答案机，帮助学习者建立真正的理解（genuine understanding），而非仅获得现成答案（ready-made answers）。Gemini 学习模式的核心洞察——"教你'为什么'，而不只是'如何'（teach the why, not just the how）"——正是 learn-everything 整体调度策略的出发点。

### 原则二：三模式动态切换（Three-Mode Dynamic Switching）

```
[首次/新概念]
      │
      ▼
  lecture（讲解）
      │
      ▼
  socratic（苏格拉底反问）
      │
      ├── 回答正确/深入 ──→ accept ──→ task（任务）或 下一个 lecture
      │
      └── 回答不足 ──→ stuck-detected（+hint）
                            │
                            └── 连续 3 次 ──→ stuck->lecture（escape）
```

三种核心动作模式的详细规范：

**lecture（讲解模式）**：
AI 主动介绍新概念（new concept introduction），使用类比（analogy）和具体例子（concrete examples），控制在 200-400 字，不求一次覆盖所有内容（no information overload）。讲解完成后必须等待用户反应（wait for response），不允许连续两轮讲解（no consecutive lectures）。参考 `pedagogy/socratic-method.md` 中关于"在对话中引入信息"的建议——lecture 并非单向传授，而是在讲解中埋下后续反问的种子（seeds for questioning）。

**socratic（苏格拉底反问模式）**：
讲解后必须出反问验证理解（verify comprehension through questioning），参考 `pedagogy/socratic-method.md` 中描述的六种问题类型：澄清性问题（clarification questions）、假设性探究（probing assumptions）、证据追问（probing evidence）、反例构建（counter-examples）、元认知问题（meta-cognitive questions）。每轮 socratic 动作出 1-3 个问题（不要同时问太多），问题类型应轮换，避免学习者产生"问题模式识别"而非真正思考（pattern recognition vs. genuine thinking）。

**task（任务驱动模式）**：
当 socratic 验证通过后（`accept` 触发），AI 布置一个实践任务（practical task），参考 `pedagogy/feynman-technique.md` 中的费曼式输出要求：要求学习者用简单语言描述（plain language description），而非技术术语堆砌（jargon stacking）。任务必须有明确的交付物格式（deliverable format）和验收标准（acceptance criteria），验收通过后写入 `artifacts/<NN-name>/` 目录。

### 原则三：Bloom 层级驱动进度（Bloom's Taxonomy Drives Progress）

学习进度不仅有"学到了哪里"（横向广度，breadth），还有"理解深度如何"（纵向深度，depth）。参考 `pedagogy/blooms-taxonomy.md` 中的六层认知框架（six-level cognitive hierarchy），AI 在 `state.md` 中追踪当前 `bloom_level`：

```
remember（记忆） → understand（理解） → apply（应用）
     → analyze（分析） → evaluate（评估） → create（创造）
```

根据当前层级，AI 选择不同的介入方式（intervention strategy）：
- **remember / understand 层**：以 `lecture` + `socratic` 为主，建立概念基础（conceptual foundation）
- **apply 层**：以 `task` 为主，每个 task 产出一个 artifact，实证应用能力（demonstrated application）
- **analyze / evaluate 层**：socratic 问题深度增加，要求学习者比较方案、识别权衡（identify tradeoffs）
- **create 层**：触发 `assemble`，将所有 artifacts 整合为最终产物（final product assembly）

### 原则四：间隔复习融入对话（Spaced Repetition in Dialogue）

参考 `pedagogy/spaced-repetition.md` 中的间隔效应（spacing effect）和测试效应（testing effect），AI 在苏格拉底反问中会刻意混入对早期概念的回忆性问题（retrieval practice questions），避免只向前推进（forward-only progression）而忽略已学内容的巩固（consolidation）。`journal.md` 中的 ISO8601 时间戳记录使 AI 能识别哪些概念已较长时间未复现（concepts that haven't been revisited recently），触发间隔复习（spaced review trigger）。`state.md` 的 `## 卡点记录` 段落记录了历史困难点，AI 优先对这些卡点进行间隔回顾（spaced review of sticking points）。

---

## 状态管理系统（State Management System）

### 运行时数据目录结构（Runtime Data Structure）

```
<user-cwd>/.learn/
├── active.md                              # 单行：active topic 的 slug（kebab-case）
└── topics/<slug>/
    ├── state.md                           # YAML frontmatter + 三个 H2 段落
    ├── journal.md                         # 时间序列流水，每条 ### <ISO8601> [<动作类型>]
    ├── research.md                        # 该 topic 资料调研（按需创建）
    ├── artifacts/<NN-name>/               # 已交付的可拼装子组件，NN 两位数零填充（01-99）
    │   └── README.md                      # 必含：## 它做什么 / ## 怎么用 / ## 与其他组件的关系
    └── final/
        └── README.md                      # 最终产物入口说明（通过相对路径 ../artifacts/<NN-name>/ 引用）
```

注意：`.learn/` 目录是运行时数据（runtime data），不属于本仓库（source repository），应通过 `.gitignore` 排除在用户项目的版本控制之外（或单独管理）。

### state.md 格式规范（State File Format）

新建 topic 时，AI 按 `references/topic-init-template.md` 初始化 `state.md`。该模板定义了所有字段的含义、约束和更新时机。核心 YAML frontmatter：

```yaml
---
topic: <主题名称（原始输入，不做格式转换）>
slug: <kebab-case，仅小写字母/数字/连字符>
status: active          # 枚举固定值：active | paused | completed
stuck_count: 0          # int，≥ 0；每次 stuck-detected +1；stuck->lecture 后归零
created_at: <ISO8601时间戳，带时区>
updated_at: <ISO8601时间戳，带时区，每次动作后更新>
bloom_level: remember   # 六级枚举：remember|understand|apply|analyze|evaluate|create
artifact_count: 0       # int，≥ 0；每次 accept task 后 +1
---
```

三个必须的 H2 段落（mandatory H2 sections）：
- **`## 当前位置`**：学生的学习坐标，包含已学概念清单和当前 bloom_level 描述
- **`## 下一步建议`**：AI 对自身下一轮行动的预规划（推荐动作类型 + 具体方向）
- **`## 卡点记录`**：时间序列的卡点日志，每次 stuck-detected 追加，stuck->lecture 后补记

### journal.md 动作类型枚举（Journal Action Types）

每条 journal 以 `### <ISO8601> [<动作类型>]` 开头，正文包含本轮摘要（50-150 字）。合法动作类型（完整枚举，不允许其他值）：

| 动作类型 | 触发条件 | stuck_count 影响 |
|---------|---------|-----------------|
| `lecture` | 首次/新概念/escape 后 | 无 |
| `socratic` | 上一轮 lecture 且无卡住 | 无 |
| `task` | socratic accept 且 bloom_level 适合 | 无 |
| `accept` | socratic 或 task 验收通过 | 无（成功则归零 stuck_count）|
| `stuck-detected` | socratic 回答不足 | +1 |
| `stuck->lecture` | stuck_count >= 3（escape 机制）| 归零 |
| `assemble` | artifact_count >= 2 且主题覆盖完整 | 无 |

---

## 调度执行流程（Dispatch Execution Flow）

完整决策逻辑定义在 `references/decision-tree.md`（包含前置检查的 bash 命令、stuck_count 状态机、每种动作的详细执行规范）。以下是关键节点摘要：

### 前置检查（Pre-flight Checks）

```bash
# 检查 1：当前目录可写（writable cwd）
test -w .

# 检查 2：skill 资源完整性（skill integrity check）
# 验证 references/ 和 pedagogy/ 下所有文件存在
```

前置检查失败（test -w . 返回非零）→ 立即中止（immediate abort），提示用户切换到可写目录。

### 参数解析（Argument Parsing）

| 调用形式 | 行为 |
|---------|------|
| `/learn`（无参数）| 读 `active.md` 推进当前 topic |
| `/learn <topic-name>` | 切换或新建 topic |
| `/learn --list` | 列出所有 topic 及状态 |
| `/learn --status` | 显示当前 active topic 摘要 |

### 动作决策优先级（Decision Priority）

按优先级从高到低，命中第一条即停止判断：

1. `stuck_count >= 3` → **stuck->lecture**（最高优先级，安全网）
2. `status == "completed"` → 提示完成，建议 `/learn <new-topic>`
3. 上一轮 `lecture` 且无卡住迹象 → **socratic**（lecture 后必反问）
4. 上一轮 `socratic` 且学生展示理解 → **accept** → 继续决策下一步
5. 上一轮 `socratic` 且回答不完整/错误 → `stuck_count++` → **stuck-detected** + escalating hint
6. 上一轮 `task` 且提交产物 → **accept** → 写 artifacts/，`artifact_count++`
7. 上一轮 `assemble` → **accept** → `status = "completed"`，庆祝 + 总结
8. 兜底（fallback）→ **lecture**（以新概念推进）

---

## Escape 机制详解（Escape Mechanism: stuck->lecture）

当 `stuck_count >= 3` 时，无论当前处于何种对话状态，AI 立即执行 escape 流程：

1. 向用户说明模式切换（transparent mode switch）："我注意到这个概念有些难，让我换个角度来讲解..."
2. 针对卡住的具体概念（the sticking concept）执行全新的 lecture，使用不同的类比或切入角度（fresh angle）
3. `stuck_count` 归零（reset to 0）
4. journal 追加 `### <ISO8601> [stuck->lecture]` 条目，记录卡住的概念和 escape 触发原因
5. `state.md` 的 `## 卡点记录` 对应条目补记"→ 已切换讲解模式（escape triggered）"

Escape 机制是整个系统的"安全网"（safety net），确保学习者永远不会陷入无法推进的困境（learning dead-end）。stuck->lecture 后，下一轮仍然按正常流程执行 socratic，但 AI 应针对 escape 后的讲解设计更简单的初始问题（simpler initial questions），给学习者建立信心（build confidence）再逐步加深。

---

## artifacts 子组件规范（Artifact Component Specification）

每个 artifact 是一个"可拼装的子组件"（composable sub-component），代表了学习旅程中一个阶段的可交付产物（deliverable）：

**目录命名规则**：
- `NN` 为两位数零填充（zero-padded），范围 `01`-`99`
- 序号 = `artifact_count + 1`（写入前的值）
- `name` 为该组件功能的 kebab-case 简短描述（2-4 个词）
- 示例：`01-event-loop-demo`、`02-async-fetch-helper`、`03-error-handler`

**README.md 必须包含三段（mandatory three sections）**：
```markdown
## 它做什么
（用简单语言描述此组件的功能，无需技术背景即可理解。参考费曼学习法：
用外行能懂的语言描述，不使用未经解释的术语。）

## 怎么用
（使用示例：代码片段、命令行调用、或操作步骤。
务必包含至少一个可复制执行的完整示例。）

## 与其他组件的关系
（说明此组件如何与已有 artifacts 配合使用，
以及 final/README.md 中如何通过相对路径 ../artifacts/<NN-name>/ 引用它。
若为首个 artifact（01-xxx），此段写"暂无依赖，将作为后续组件的基础"。）
```

---

## 初始化新 topic 完整流程（New Topic Initialization）

当 `/learn <topic>` 被首次调用且该 topic 不存在时：

```
步骤 1：生成 slug
  将 topic 名称转换为 kebab-case（参见 references/topic-init-template.md 的 slug 生成规则）

步骤 2：创建目录结构
  mkdir -p .learn/topics/<slug>/artifacts
  mkdir -p .learn/topics/<slug>/final

步骤 3：写入 state.md
  按 references/topic-init-template.md 模板初始化（含示例的完整模板）

步骤 4：创建 journal.md（空文件，等待第一条 lecture 条目）

步骤 5：更新 active.md
  echo "<slug>" > .learn/active.md

步骤 6：执行首轮 lecture
  切入核心概念，用类比引入，控制在 200-400 字，不覆盖所有内容

步骤 7：追加 journal 条目 [lecture]
  写入首轮讲解的摘要

步骤 8：更新 state.md
  updated_at 更新
  ## 当前位置：记录首轮讲解的核心概念
  ## 下一步建议：下一步出 socratic 验证理解
```

---

## 学习完成标志与最终产物（Learning Completion and Final Artifact）

当以下条件全部满足时，AI 主动提议进入 `assemble` 阶段：

1. `artifact_count >= 2`（至少两个可拼装子组件证明了"应用层"能力）
2. AI 评估 `state.md` 的 `## 当前位置`，认为主题核心概念已全部覆盖
3. `bloom_level >= apply`（至少达到布鲁姆应用层）

**assemble 执行内容**：
1. 创建 `final/` 目录
2. 写入 `final/README.md`，必须包含：项目概述、使用方法、组件清单（通过相对路径 `../artifacts/<NN-name>/` 引用所有子组件）、学习旅程总结
3. journal 追加 `[assemble]` 条目
4. 等待用户验收最终产物
5. 验收通过后：`status = "completed"`，journal 追加 `[accept]`

`status = "completed"` 是学习旅程的终点（learning journey endpoint）。此时 topic 不再接受新的推进动作（frozen），只能作为参考（reference only）。用户可以通过 `/learn <new-topic>` 开始全新的学习主题。

---

## 设计参考与教学法基础（Pedagogical References）

本 skill 的教学设计综合参考了以下五种方法论（详见 `pedagogy/` 目录中的完整说明）：

| 方法论 | 在本系统中的核心应用 | 参考文档 |
|-------|-------------------|---------|
| 苏格拉底教学法（Socratic Method）| `socratic` 动作的六种问题类型；stuck_count 安全网 | `pedagogy/socratic-method.md` |
| 布鲁姆教育目标分类学（Bloom's Taxonomy）| `bloom_level` 字段驱动动作决策；artifact 对应 apply 层 | `pedagogy/blooms-taxonomy.md` |
| 间隔重复法（Spaced Repetition）| journal 时间戳触发旧概念回顾；卡点优先复习 | `pedagogy/spaced-repetition.md` |
| 费曼学习法（Feynman Technique）| artifact README.md 的"它做什么"段落设计标准 | `pedagogy/feynman-technique.md` |
| Gemini 学习模式（Gemini Learning Mode）| 整体引导者角色定位；escalating hints；verify-before-advance | `pedagogy/gemini-learning-mode.md` |

每次调用时，AI 应根据当前执行的动作类型，在内部引用（reference internally）对应的教学法文档，以确保调度决策符合教学设计原则（pedagogical design principles），而非仅靠本文档的简要描述。

---

## 常见问题（FAQ）

**Q：我可以同时学习多个主题吗？**
A：可以。`.learn/topics/` 下可以存在多个 slug 目录。`active.md` 记录当前活跃 topic。使用 `/learn <other-topic>` 可以切换，`active.md` 随之更新。所有 topic 的状态都持久化，可以随时切回继续。

**Q：如果我长时间不用，状态会丢失吗？**
A：不会。`.learn/` 是普通文件系统目录，持久化在本地。AI 每次调用时从 `state.md` 和 `journal.md` 重建上下文，可以无缝从上次中断处继续（seamless resumption）。

**Q：如何重置某个 topic 的进度？**
A：直接删除 `.learn/topics/<slug>/` 目录即可。下次 `/learn <topic>` 时会重新初始化。注意：删除是不可逆的，已交付的 artifacts 会一并删除。

**Q：stuck_count 归零后，已记录的卡点记录会清除吗？**
A：不会。`## 卡点记录` 是追加式日志（append-only log），stuck_count 归零只是计数器重置，历史卡点记录保留，供 AI 后续参考（retained for future reference）。


