# Brainstorm — Notebook 式学习实验台

> 触发自：Task 01 跑通后用户反馈「理解过程不够高效」，希望把代码 / 文档 / 运行结果融合进单一可交互页面。

## 探索的目的与约束

**用户目标（一句话）**
为 Otter 的学习任务做一个 notebook 式可视化页面，把"代码 + 讲解 + 每轮运行结果"融合在同一视图里，让学习者能一站式吸收 agent loop 的核心概念，不必再在 3 个文件之间跳来跳去。

**项目上下文关键发现**
- Otter 当前只有 4 个文件：`CLAUDE.md` + Task 01 三件套（`agent.ts` / `README.md` / `run-log.txt`）
- Otter 的最高优先级是「学习是核心、只做最核心、从 0 到 1 手写底层协议」（CLAUDE.md 已沉淀）
- 学习课程在 `learn-everything/.learn/topics/agent-harness-engineering/`，与 Otter 是邻居工程
- Otter 工程严格保持纯净（教学代码本身），不放任何辅助工具

**明确约束（用户已确认）**
1. **三大痛点必须一起解决**：messages 演化看不见、三文件分散、缺少单步节奏控制
2. **工具定位 = 纯辅助，作为 learn-everything 的工具套件**（不是 Otter 教学产物的一部分，工具自身复杂度可适度上升 ~700 行）
3. **零侵入 Otter 现有 3 文件**：`README.md` / `agent.ts` / `run-log.txt` 一动不动
4. **每个 task 新增一份 `lesson.md`**：作为 notebook 源，用最小集引用语法（~3 种）拼接现有 3 文件的片段

## 候选方案与权衡

### 方案 A：静态 viewer（被排除）
- 工具读 run-log.txt + agent.ts 自动可视化，单步按钮控制 round 演化
- 优势：体量最轻 ~300 行；零侵入；离线可看
- 劣势：仅"看录像"，不解决"代码/文档/输出三者同页"问题；不满足用户"三痛点一起解决"

### 方案 B：现场调用 playground（被排除）
- bun http server，用户点"下一轮"实时发 API
- 优势：现场感强、能改 prompt 玩
- 劣势：要侵入改造 agent.ts（导出 loop 为函数）；每次烧 token；与 Otter "代码可独立运行" 原则冲突

### 方案 C：Notebook 式融合页（**选定**）
- 引入新源文件 `lesson.md`，工具读它渲染 notebook 视图
- `lesson.md` 用最小引用语法拼接现有 3 文件的片段（不复制代码）
- 三痛点一站解决：代码/文档/输出同页 + round 切片 + 单步展开

## 选择与理由

**选定方案：C（Notebook 式融合页）+ 子选 B（lesson.md 引用语法）**

**核心理由**：
1. 唯一能同时解决三大痛点的方案
2. 引用语法 + 零侵入 = Task 01 现有 3 文件保持纯净（GitHub 直接读、`bun run agent.ts` 直接跑、git blame 友好）
3. lesson.md 引用语法可跨任务复用 —— 后续 Task 02/03 都能套同一个工具
4. 工具放 `learn-everything/tools/agent-notebook/`，与教学课程同仓，Otter 不被污染

**被排除方案**：
- 方案 A：解决不了"三文件分散"
- 方案 B：必须改造 agent.ts，违反 Otter "代码可独立运行" 原则

## 关键设计决策（已与用户对齐）

| 决策点 | 决议 |
|---|---|
| 工具落地位置 | `learn-everything/tools/agent-notebook/` |
| Otter Task 01 现有 3 文件 | **零侵入**（`README.md` / `agent.ts` / `run-log.txt` 一动不动） |
| 每个 task 新增的源文件 | `lesson.md`（在 task 目录内） |
| 引用语法最小集 | 约 3 种：① 代码块引用 ② log 块引用（按 round 切片） ③ 普通 markdown 文本 |
| 工具自身复杂度预算 | ~700 行（notebook 渲染 + 代码块高亮 + 嵌入式输出块） |
| 工具自身依赖 | 待主 skill 设计阶段决定（暂倾向 bun + 最小前端，可考虑 marked / shiki，但不强制） |
| 是否包含"现场重跑" | **暂不做**（YAGNI，留待后续 task 扩展） |

## 待主 SKILL 接力的设计决策

主 SKILL 在写设计文档时需深化以下点：

1. **lesson.md 引用语法的精确规范**
   - 代码块引用：`\`\`\`ts file=./agent.ts lines=1-30 \`\`\`` 的精确语法（lines 是否支持多段？相对路径基准在哪？）
   - log 块引用：`\`\`\`log file=./run-log.txt round=1 \`\`\`` 的 round 切片规则（如何识别"第 N 轮"？依据 `========== ROUND N ==========` 分隔符还是别的？）
   - 是否需要"高亮区段"语法（如 `lines=1-30 highlight=15-18`）

2. **单步节奏控制的 UX**
   - 默认全展开 + 滚动跟随高亮，还是默认折叠后续 round + 点击"下一轮"展开？
   - messages 状态侧栏：每滚到一段，右侧 messages 数组高亮当前轮次的新增内容（diff 视图）

3. **工具技术栈选型**
   - bun http server + 静态 HTML？还是 Vite/Next 等成熟前端方案？（要权衡"工具自身可读性 vs 学习者使用便利"）
   - markdown 渲染：手写最小渲染器？还是用 marked / markdown-it？
   - 代码高亮：shiki / prism？还是不做（纯文本即可）？

4. **跨任务复用契约**
   - 工具如何"发现"任务？（CLI 参数 `agent-notebook ./Otter/tasks/01-minimal-agent-loop/` 还是配置文件？）
   - 多 task 切换的 UI

5. **brainstorm.md 之外的事项**
   - 工具仓库要不要走 autopilot 全流程（design.md / plan.md / 实现）？还是直接动手做最小可用版本？
   - 与 Otter Task 02 的发布顺序（先 Task 02 再做工具？还是反过来？）

## 状态

✅ Brainstorm 共识完成，移交主 SKILL 进入设计文档阶段。
