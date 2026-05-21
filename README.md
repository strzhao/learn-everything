# learn-everything

AI 主导的个人学习辅助工具，以 Claude Code skill 形态交付。单入口 `/learn`，动态生成课程，无预设大纲，最终交付可运行的 mini-工具作为"学会"的可验证证明。

## 安装

### 前提条件

- 已安装 [Claude Code](https://claude.ai/code)（`~/.claude/` 目录存在）
- macOS / Linux（Windows 未测试）
- bash 3.2+

### 一键安装

```bash
git clone <repo-url> learn-everything
cd learn-everything
bash scripts/install.sh
```

安装脚本会在 `~/.claude/skills/learn` 创建一个指向本仓库 `skills/learn/` 的 symlink。安装后无需重启，即可在任意目录使用 `/learn`。

### 验证安装

```bash
test -L ~/.claude/skills/learn && echo "安装成功" || echo "安装失败"
```

### 更新

直接 `git pull` 即可——symlink 指向本地仓库目录，拉取后自动生效，无需重新安装。

### 卸载

```bash
rm ~/.claude/skills/learn
```

---

## 使用

### 快速开始

```
/learn                        # 继续当前学习 topic（首次使用时会询问主题）
/learn Python 异步编程         # 开始或切换到指定 topic
/learn --list                 # 查看所有 topic 及状态
/learn --status               # 查看当前 active topic 的进度摘要
```

### 学习流程

1. 输入 `/learn <主题>` 开始，AI 自动执行首轮讲解（lecture）
2. AI 提出反问（socratic），你认真思考后回答
3. 理解通过后，AI 布置实践任务（task），完成并提交
4. 任务产物（artifact）被写入 `.learn/topics/<slug>/artifacts/` 目录
5. 积累 ≥2 个 artifact 后，AI 引导进行最终拼装（assemble），产出 mini-工具
6. 学习完成，`status` 设为 `completed`

### 状态文件位置

学习数据保存在你调用 `/learn` 时所在目录下的 `.learn/` 中：

```
.learn/
├── active.md                  # 当前活跃 topic 的 slug
└── topics/
    └── <slug>/
        ├── state.md           # 学习进度、Bloom 层级、卡点记录
        ├── journal.md         # 每轮对话的动作流水
        ├── artifacts/         # 各阶段产出的可拼装子组件
        └── final/             # 最终 mini-工具
```

### 卡住了怎么办

不需要做任何事——系统会自动检测。当你连续 3 次无法回答反问时，AI 自动切换回讲解模式（stuck->lecture escape 机制），换一个角度重新讲解，然后继续。

---

## 设计

### 整体架构

```
源码仓库（本项目）
    └── skills/learn/           ← skill 源码
            │
            └── symlink ←────── ~/.claude/skills/learn（全局可用）

运行时数据
    └── <user-cwd>/.learn/      ← 随 /learn 调用自动创建
```

### 核心调度机制

AI 根据以下状态自动决定本轮动作：

| 条件 | 动作 |
|-----|------|
| stuck_count >= 3 | stuck->lecture（强制切换讲解，escape 机制） |
| 上一轮讲解，无卡住 | socratic（苏格拉底反问） |
| 反问通过验收 | accept → 下一步讲解或任务 |
| 任务提交产物 | accept → 写入 artifact |
| artifact_count >= 2 且主题覆盖完整 | assemble（最终拼装） |

完整决策规则见 `skills/learn/references/decision-tree.md`。

### 教学法基础

| 方法论 | 核心应用 |
|-------|---------|
| 苏格拉底教学法（Socratic Method）| `socratic` 动作的问题类型设计 |
| 布鲁姆教育目标分类学（Bloom's Taxonomy）| `bloom_level` 字段驱动进度 |
| 间隔重复法（Spaced Repetition）| 在反问中混入早期概念回忆 |
| 费曼学习法（Feynman Technique）| artifact README 的"它做什么"写作标准 |
| Gemini 学习模式（Gemini Learning Mode）| 整体引导者角色定位 |

各方法论详细说明见 `skills/learn/pedagogy/` 目录（5 份文档）。

### 契约规约

学习数据格式有严格契约，以确保 AI 调度的一致性：

- `state.md` YAML frontmatter 字段：`status`（`active|paused|completed`）、`stuck_count`（int≥0）、`bloom_level`（六级枚举）、`artifact_count`（int≥0）
- `journal.md` 每条动作类型枚举：`lecture|socratic|task|accept|stuck-detected|stuck->lecture|assemble`
- `artifacts/<NN-name>/`：NN 两位数零填充，README.md 含三段（## 它做什么 / ## 怎么用 / ## 与其他组件的关系）
- `final/README.md`：必须存在，通过相对路径 `../artifacts/<NN-name>/` 引用所有子组件

---

## 许可

MIT License
