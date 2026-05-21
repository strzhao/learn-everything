## 探索的目的与约束

**用户目标**：构建 `learn-everything` —— 一个由 AI 主导的个人学习辅助工具，能让用户在 AI 引导下系统学习任意主题，最终交付"实用工具"作为学会的标志。首个使用场景：基于 `../claude-code/`（只读源码快照）学习 agent 与 harness，从 0 到 1 实现一个 mini-claude-code。

**项目上下文探索关键发现**：
- `learn-everything/` 当前是空目录，无任何代码或 .autopilot 状态
- `../claude-code/` 是 Anthropic Claude Code 的只读源码快照（约 1900 文件、512K 行 TS），含 QueryEngine、Tool 系统、Agent 子代理、coordinator、bridge、services 等模块；将作为 agent+harness 学习的研究素材，不是被改的代码
- 用户原始诉求里特别强调：(1) AI 作为学习的主体；(2) 借鉴 Gemini Learning Mode 的优秀做法、要求预先调研保存资料；(3) 苏格拉底反问式有价值；(4) "学会"必须以产出实用工具为标志；(5) 长周期学习需要课程设计 + 进度跟踪机制保证持续性

**明确约束**：
- 工具形态固定为 Claude Code skill 集合，不做独立 CLI / Web App
- 课程内容必须**完全动态生成**，不预设大纲（用户已确认接受其灵活性的代价）
- 本次 brainstorm 范围**仅限 learn-everything 工具本身的设计**；具体 topic（如 agent+harness）的课程内容大纲不在本次范围
- 所有交互界面用中文（用户全局规范）

## 候选方案与权衡

### 方案 A：极简 MVP — markdown 中央调度（已选）
- 单一 skill 文件 `learn.md`；用户唯一入口 `/learn`
- 状态文件全部为可读 markdown：
  - `.learn/active.md` — 当前 active topic 的 slug
  - `.learn/topics/<slug>/state.md` — 当前章节、上次到哪、下一步建议、stuck 标记
  - `.learn/topics/<slug>/journal.md` — 流水日志（讲解摘要、反问对话、关键 insight）
  - `.learn/topics/<slug>/artifacts/` — 已交付的可拼装子组件（代码）
  - `.learn/topics/<slug>/final/` — mini-工具最终拼装目录
  - `.learn/topics/<slug>/research.md` — 该 topic 的资料调研
  - `.learn/pedagogy/*.md` — 全局学习法资料（设计阶段一次性预调研）
- AI 行为：每次 /learn 时读 active + state，自主决定下一步是讲解、反问、出任务、验收子组件还是阶段总结
- **优势**：状态全是自然语言 markdown、对 AI 友好、用户可随时手改、git 可追溯；最契合"完全动态生成"
- **劣势**：无严格 schema，多 topic 横向 status 扫描随规模增长会变慢（远期问题，当前不构成障碍）

### 方案 B：结构化数据模型
- 同 A 的目录布局，但 `state.md` 顶部强制 YAML schema：`chapters[]`、`milestones[]`、`prerequisites`、`stuck_count` 等结构化字段；章节按 DAG 组织
- **优势**：AI 调度精准、可机器分析进度、能可视化课程图谱
- **劣势**：与"完全动态生成"硬冲突——schema 一旦写死就等于半预设课程；MVP 阶段过度设计，违反 YAGNI

### 方案 C：复用 ai-todo CLI
- 把课程节点包装成 ai-todo 项，进度=todo 状态，产出=todo metadata；/learn 是一层薄壳
- **优势**：复用已有任务工具
- **劣势**：ai-todo 是为多人/多 agent **协作**语义设计的（owner、blocks、blockedBy），与"个人学习的反问对话流水"语义不匹配；强行套用会扭曲两边语义且日志类内容无处安放

## 选择与理由

**选定方案：A（极简 MVP）**

**选择理由**：
- 与"完全动态生成 + AI 自动调度"两个已确认决策强一致：自然语言状态最适合 AI 读写，没有 schema 阻碍 AI 在主题间灵活适应
- markdown 全可读、用户随时人工介入修正，符合"AI 主体但用户可随时纠偏"的协作姿态
- 第一版工程量最小、最快可用，符合用户"学习是长期的，先能跑起来才能跟进"的核心痛点

**排除 B 的原因**：YAGNI；用户已选"完全动态生成"，结构化 schema 即等于半预设课程，自相矛盾。
**排除 C 的原因**：语义错配；ai-todo 是协作型任务流，不是学习日志型流水。

## 待主 SKILL 接力的设计决策

以下是用户在 brainstorm 阶段确认的核心决策，请在设计文档中保留并深化：

1. **工具形态**：Claude Code skill 集合，**仅一个入口** `/learn`，由 AI 在 skill 内部根据 `.learn/` 状态自主调度（不开放 /learn-status、/learn-quiz 等子命令）
2. **课程生成策略**：完全动态生成；不预生成大纲；每次 /learn 时 AI 决定下一段教什么
3. **教学风格**：讲解+反问、苏格拉底反问、任务驱动 三者动态切换；由 AI 根据当前主题特性选择
4. **验收哲学**：每节课交付一个可拼装的子组件到 `artifacts/` 目录，最终拼装成 mini-工具进入 `final/`；学完=拼出能跑的工具
5. **教学法预调研**：设计阶段一次性调研至少 5 种主流学习法（建议覆盖 Gemini Learning Mode、苏格拉底反问法、Bloom's Taxonomy、间隔重复 / Spaced Repetition、费曼学习法）落到 `.learn/pedagogy/*.md`，并在 skill 提示词中引用，作为 AI 调度教学风格的依据

**设计文档需要深化的点**：
- `.learn/topics/<slug>/state.md` 的具体内部段落约定（即便不强 schema，也要有约定的 H2 段落让 AI 一致地写）
- /learn 的内部决策树：什么情况下选讲解、什么情况下反问、什么情况下出任务、什么情况下验收子组件
- **Escape 机制**：用户被反问 N 次仍卡住时，AI 自动切换到讲解模式并在 journal.md 标记 stuck（具体阈值、行为细节待设计）
- 多 topic 切换协议：`/learn <topic-slug>` 切换 active；新 topic 的初始化流程（首次启动产生哪些种子内容）
- 子组件的"可拼装"约束：artifacts 目录之间应有什么接口约定，避免后期拼不到一起
- 教学法预调研的具体执行（哪个 skill / 子代理执行、调研深度、引用方式）
- 第一个 topic（agent+harness）的 topic 具体内容**不在此设计范围**，工具就绪后由用户单独发起

**注意**：项目目录初始无 .autopilot 状态，本 brainstorm 由 task_dir `.autopilot/tasks/learn-everything-design/` 接管。如需进入设计阶段，主 SKILL 应在该目录下创建/初始化 state.md 后接力。
