# CLAUDE.md — learn-everything 仓库协作约定

本文档定义在本仓库工作时的协作规范。Claude Code 在进入此项目时会自动读取本文件作为上下文，同时自动加载 `.claude/skills/learn/SKILL.md` 作为项目级 skill。

## 仓库结构

```
learn-everything/
├── .claude/skills/learn/        ← skill 装载点（Claude Code 自动加载，仅本项目生效）
│   ├── SKILL.md                  ← 主入口：frontmatter + 调度核心
│   ├── references/               ← 调度规则与模板
│   │   ├── decision-tree.md
│   │   └── topic-init-template.md
│   └── pedagogy/                 ← 5 份学习法资料（格式固定）
├── topics/                       ← 长期学习状态库（git 跟踪、一等内容）
│   ├── _active                   ← 当前 active topic slug（无扩展名）
│   ├── INDEX.md                  ← AI 自动维护
│   ├── _archive/                 ← 已 completed 的 topic
│   └── <slug>/                   ← 活跃或暂停的 topic
├── tests/acceptance-check.sh     ← 结构合规性自检（保留作为 QA 工具）
├── README.md
└── CLAUDE.md                     ← 本文件
```

**关键约定**：本 skill 是项目级（`.claude/skills/<name>/`），仅在 learn-everything 项目目录下生效。不再有 `install.sh` 全局安装脚本。`topics/` 是项目的一等内容，git 跟踪。

---

## 实战代码归档约定（artifacts/）

`topics/<slug>/artifacts/NN-name/` 不只是 instructor 写的文字 descriptor，也是学生实战代码的物理归宿：

- **代码本体**直接放在该目录里：`agent.ts` / `run-log.txt` / `lesson.md` / `notes.md` / `spec.md` / `brainstorm.md` 等都是一等公民
- **README.md** 既写学生角度的「学到了什么」，也写 instructor 角度的「与其他组件的关系 / 在课程中的位置」，合并为单一 README
- **交互式阅读视图**：`bun run tools/agent-notebook/server.ts <artifact-abs-path>` 启动 HTML notebook，用 `lesson.md` 里的 `@include(./xxx.ts, section=N)` / `@include(./run-log.txt, round=N)` 把代码片段、运行日志、讲解编织起来

**新任务交付约定**：instructor 下发新 task 时直接以 `topics/<slug>/artifacts/NN-name/` 为交付地址，**不再借助外部实战工程仓**。这避免了"半教学半工程"双重身份导致的归档割裂。lesson.md 里的所有 `@include` 用相对路径，artifact 目录可作原子单元搬运。

**已有归档**：`topics/agent-harness-engineering/artifacts/01-minimal-agent-loop/` 与 `02-permission-gate/` 是这套约定的范例。

---

## 如何修改 skill

### 修改 SKILL.md

`SKILL.md` 是 skill 主入口。修改时必须：

1. **frontmatter 保留**：`name: learn`、`description`、`allowed-tools` 三字段必填
2. **description 含字面量**：必须含触发关键词（"learn" 或 "学习"）和"单入口"四字
3. **字数 ≥1500 字符**（`wc -m`）
4. **引用完整性**：至少引用一次 `references/` 和一次 `pedagogy/`
5. **契约一致性**：state.md 字段、动作枚举、目录结构必须与 `references/decision-tree.md` 1:1 匹配

### 修改 references/decision-tree.md

调度树是 AI 行为的权威源（single source of truth）。修改时：

1. 动作枚举 `lecture|socratic|task|accept|stuck-detected|stuck->lecture|assemble|archive` 增删须同步 SKILL.md 和 acceptance-check.sh
2. `stuck_count` 阈值 3 / 归零条件是契约，修改须同步 SKILL.md + topic-init-template.md
3. 目录管理三件事（多 topic 列表 / INDEX 维护 / 归档）的规则**全部 AI 驱动**，禁止引入新的 sh 脚本承担这些职责
4. 修改后字数 ≥300（`wc -m`）

### 修改 references/topic-init-template.md

模板定义 state.md 初始格式。修改时：

1. YAML 字段增删须同步 decision-tree.md（字段读取）和 SKILL.md（说明表）
2. `status` 枚举（`active|paused|completed`）和 `bloom_level` 枚举（六级）是契约，不可扩展
3. 字数 ≥300（`wc -m`）

### 修改 pedagogy/*.md

5 份资料格式固定（5 段落：方法名 / 核心理念 / 适用场景 / 在 learn-everything 中的应用启示 / 来源引用）。修改时：

1. 5 段落结构不变
2. 字数 200-2000 字符（`wc -m`，对应 200-500 中文字）
3. 文件名（kebab-case slug）不可改，SKILL.md 有引用

---

## 如何测试

### 结构合规性自检

```bash
bash tests/acceptance-check.sh
```

acceptance-check.sh 验证：核心文件齐全、frontmatter 正确、字数合规、契约关键字面量在位。详见脚本注释。

### 手动功能测试

在 Claude Code 中：
1. cd 到本项目根目录
2. 输入 `/learn` 测试主题或 `/learn` 推进现有 topic
3. 检查 `topics/<slug>/state.md` 字段是否符合契约
4. 检查 `topics/INDEX.md` 是否被自动重写
5. 完成一个 topic 后检查它是否被自动 mv 到 `topics/_archive/<slug>/`

---

## 如何发布

"源码即发布"，无构建步骤：

1. 修改后跑 `bash tests/acceptance-check.sh` 确认全绿
2. 合并到 `main`
3. 用户更新：`git pull` 即生效（项目级 skill，下次进入项目自动重新加载 SKILL.md）

---

## 契约变更流程（Breaking Changes）

以下修改会导致已有 `topics/` 数据与新版本不兼容：

- 增删 state.md 的 YAML 字段
- 修改 `status`、`bloom_level` 枚举值
- 修改 artifacts 目录命名规则（NN 零填充位数等）
- 修改 journal.md 动作枚举
- 修改 `_active` 文件格式
- 修改 INDEX.md / _archive/ 的位置或语义

执行 breaking change 时：
1. commit message 注明 `BREAKING CHANGE:`
2. README 记录迁移步骤
3. 提供迁移指引（手工或 AI 辅助），但不引入新 sh 脚本

---

## 代码风格

- 中文写作，技术术语保留英文括注（如"间隔效应（spacing effect）"）
- 文件名使用 kebab-case
- YAML frontmatter 使用 2 空格缩进
- **不引入新的 sh 脚本承担目录管理职责**——`topics/` 的所有读写、归档、索引重生成都由 AI 在调度过程中完成
- 已有的 `tests/acceptance-check.sh` 仅作为 QA 自检工具保留，不参与运行时调度
