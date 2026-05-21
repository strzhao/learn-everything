# learn-everything

AI 主导的个人学习辅助工具，以 **项目级** Claude Code skill 形态交付。本项目同时是 skill 源码 + 长期学习状态库——你的所有学习产出（笔记、子组件、mini-工具）都在 `topics/` 目录下作为项目的一等内容由 git 跟踪保存。

单入口 `/learn`，AI 动态生成课程，无预设大纲，最终交付可运行的 mini-工具作为"学会"的可验证证明。

## 使用

### 启动条件
- 已安装 [Claude Code](https://claude.ai/code)
- 已 `git clone` 本仓库到本地
- 在 Claude Code 中 `cd` 到本项目根目录后调用 `/learn`

**本 skill 仅在 learn-everything 项目目录内生效**。无需任何安装步骤——Claude Code 会自动加载 `.claude/skills/learn/SKILL.md`。

### 快速开始

```
cd path/to/learn-everything

/learn                       # 无参：有 active 推进；多 topic 时 AI 主动列表让你选；为空时询问首个主题
/learn Python 异步编程        # 指定主题：切换到该 topic 或新建
```

注意：本 skill 单一入口，不接受 `--list` `--status` 等子命令。所有目录管理动作（列出、归档、索引）都由 AI 在调度过程中**自动判断并执行**。

### 学习流程

1. 输入 `/learn <主题>` 开始，AI 自动执行首轮讲解（lecture）
2. AI 提出反问（socratic），你认真思考后回答
3. 理解通过后，AI 布置实践任务（task），完成并提交
4. 任务产物（artifact）写入 `topics/<slug>/artifacts/<NN-name>/`
5. 累积 ≥2 个 artifact 后，AI 引导最终拼装（assemble）→ `topics/<slug>/final/`
6. 学习完成后 AI 自动归档 → `topics/_archive/<slug>/`

### 卡住怎么办

不需要做任何事——系统自动检测。连续 3 次无法回答反问 → AI 自动切换讲解（stuck->lecture escape），换角度重讲后继续。

## 目录管理

`topics/` 是学习产出的根目录，由 AI 全自动管理（**不依赖任何 sh 脚本**）：

```
topics/
├── _active                  # 单行：当前 active topic 的 slug（无扩展名）
├── INDEX.md                 # AI 自动维护的 topic 总览，禁止手动编辑
├── _archive/                # 已 completed 的 topic 自动归档至此
│   └── <slug>/              # 与活跃 topic 同结构
└── <slug>/                  # 活跃或暂停的 topic
    ├── state.md             # YAML frontmatter（status/stuck_count/bloom_level/artifact_count/created_at/updated_at）
    │                         # + 三个 H2（## 当前位置 / ## 下一步建议 / ## 卡点记录）
    ├── journal.md           # 每条 ### <ISO8601> [<动作类型>] 的时间序列流水
    ├── research.md          # 该 topic 的资料调研（按需创建）
    ├── artifacts/<NN-name>/ # 每节课交付的可拼装子组件，NN 两位零填充（01-99）
    │   └── README.md        # 必含三段：## 它做什么 / ## 怎么用 / ## 与其他组件的关系
    └── final/
        └── README.md        # 最终拼装产物入口，通过 ../artifacts/<NN-name>/ 引用
```

### AI 自动管理的三件事

1. **多 topic 列表展示**：无参 `/learn` 且无 `_active` 时，AI 列出所有 topic 让你选
2. **INDEX.md 自动维护**：每轮动作结束后，AI 重新扫描 `topics/` + `_archive/` 重写 INDEX
3. **完成自动归档**：`status: completed` 触发后，AI 用 `mv` 把整个 topic 目录移到 `_archive/`

### 想看所有学过什么

直接打开 `topics/INDEX.md`——AI 始终保持它最新。

## 设计

### 整体架构

```
learn-everything/                       ← 本仓库（既是 skill 源码也是学习状态库）
├── .claude/skills/learn/               ← skill 装载点（Claude Code 进入本项目自动加载）
│   ├── SKILL.md
│   ├── references/                     ← 调度规则文档
│   └── pedagogy/                       ← 5 份学习法资料
└── topics/                             ← 学习产出（git 跟踪）
```

### 核心调度机制

AI 根据当前状态自动决定本轮动作：

| 条件 | 动作 |
|-----|------|
| stuck_count >= 3 | stuck->lecture（强制切讲解，escape） |
| status == "completed" | 提示完成，触发 archive |
| 上轮 lecture 且无卡 | socratic（反问验证） |
| socratic 通过 | accept → 推进 lecture / task |
| task 提交产物 | accept → 写入 artifact |
| artifact_count >= 2 且覆盖完整 | assemble（最终拼装） |

完整决策见 `.claude/skills/learn/references/decision-tree.md`。

### 教学法基础

| 方法论 | 核心应用 |
|-------|---------|
| 苏格拉底教学法 | `socratic` 动作的问题类型设计 |
| 布鲁姆教育目标分类学 | `bloom_level` 字段驱动进度 |
| 间隔重复法 | 在反问中混入早期概念回忆 |
| 费曼学习法 | artifact README 的"它做什么"写作标准 |
| Gemini 学习模式 | AI 整体引导者角色定位 |

详见 `.claude/skills/learn/pedagogy/` 目录。

### 契约规约

学习数据格式有严格契约保证 AI 调度一致性：

- **state.md**：YAML 字段 `status`（`active|paused|completed`）、`stuck_count: int≥0`、`bloom_level`（六级枚举）、`artifact_count: int≥0`、`created_at`/`updated_at`；后接三个 H2：`## 当前位置`、`## 下一步建议`、`## 卡点记录`
- **journal.md**：每条 `### <ISO8601> [<动作类型>]`，动作枚举 `lecture|socratic|task|accept|stuck-detected|stuck->lecture|assemble|archive`
- **artifacts/<NN-name>/**：NN 两位零填充（01-99），README.md 含三段（## 它做什么 / ## 怎么用 / ## 与其他组件的关系）
- **final/README.md**：必须存在，通过相对路径 `../artifacts/<NN-name>/` 引用所有子组件
- **_active**：无扩展名单行文件，仅含当前 active topic 的 slug 或为空
- **INDEX.md**：每轮 AI 自动重生成，不可手动编辑
- **_archive/<slug>/**：completed topic 的归档位置，AI 自动 `mv` 进入

## 许可

MIT License
