# CLAUDE.md — learn-everything 仓库协作约定

本文档定义了在本仓库（learn-everything）中工作时的协作规范，供 Claude Code 和人工贡献者共同遵守。

## 仓库结构说明

```
learn-everything/
├── skills/learn/           ← skill 源码（安装到 ~/.claude/skills/learn 的内容）
│   ├── SKILL.md            ← 主入口，frontmatter + 调度逻辑
│   ├── references/         ← 调度规则和模板文档
│   └── pedagogy/           ← 5 份教学法资料（格式固定）
├── scripts/
│   └── install.sh          ← 安装脚本（创建 symlink）
├── tests/                  ← 测试（见"如何测试"）
├── README.md
└── CLAUDE.md               ← 本文件
```

---

## 如何修改 skill

### 修改 SKILL.md

`SKILL.md` 是 skill 的主入口，修改时须遵守：

1. **frontmatter 必须保留**：`name: learn`、`description`、`allowed-tools` 三个字段不可删除
2. **字数要求**：正文 ≥ 1500 词（`wc -w skills/learn/SKILL.md` 验证）
3. **引用完整性**：必须至少引用一次 `references/` 和至少一次 `pedagogy/`（`grep -c "references/" skills/learn/SKILL.md` 验证）
4. **契约一致性**：修改后必须确保 `state.md` 字段枚举、动作类型枚举与 `references/decision-tree.md` 保持 1:1 匹配

### 修改 references/decision-tree.md

决策树是 AI 调度的权威来源（single source of truth）。修改时：

1. 动作类型枚举（`lecture|socratic|task|accept|stuck-detected|stuck->lecture|assemble`）不可随意增删，增删须同步更新 SKILL.md 中的动作类型表格
2. `stuck_count` 逻辑（+1 触发条件、归零触发条件、阈值 3）是契约（contract），修改须同步更新 SKILL.md、topic-init-template.md
3. 每次修改后运行自检：`wc -w skills/learn/references/decision-tree.md`（≥ 300 词）

### 修改 references/topic-init-template.md

模板定义了 `state.md` 的初始格式。修改时：

1. YAML frontmatter 字段增删须同步更新 decision-tree.md（字段读取逻辑）和 SKILL.md（字段说明表格）
2. `status` 枚举值（`active|paused|completed`）、`bloom_level` 枚举值（六级）是契约，不可随意扩展
3. 修改后运行：`wc -w skills/learn/references/topic-init-template.md`（≥ 300 词）

### 修改 pedagogy/*.md

5 份教学法资料格式固定（5 段落：方法名/核心理念/适用场景/在 learn-everything 中的应用启示/来源引用）。修改时：

1. 保持 5 段落结构不变
2. 字数控制在 200-500 词（`wc -w skills/learn/pedagogy/<file>.md` 验证）
3. 文件名（slug 格式）不可更改，因为 SKILL.md 中有硬编码引用

---

## 如何测试

### 结构合规性自检（每次修改后必跑）

```bash
# 在仓库根目录下运行
bash -c '
echo "=== 1. 核心文件存在 ==="
ls skills/learn/SKILL.md skills/learn/references/{topic-init-template,decision-tree}.md

echo "=== 2. pedagogy 文件数量 ==="
ls skills/learn/pedagogy/*.md | wc -l

echo "=== 3. pedagogy 字数（每份 200-500）==="
for f in skills/learn/pedagogy/*.md; do wc -w "$f"; done

echo "=== 4. SKILL.md frontmatter ==="
head -10 skills/learn/SKILL.md | grep -E "^name:|^description:"

echo "=== 5. SKILL.md 字数 ==="
wc -w skills/learn/SKILL.md

echo "=== 6. SKILL.md 引用 ==="
echo "references/ 引用次数: $(grep -c "references/" skills/learn/SKILL.md)"
echo "pedagogy/ 引用次数: $(grep -c "pedagogy/" skills/learn/SKILL.md)"

echo "=== 7. references 字数 ==="
wc -w skills/learn/references/{topic-init-template,decision-tree}.md

echo "=== 8. README.md 章节 ==="
grep -E "^## (安装|使用|设计)" README.md | wc -l

echo "=== 9. install.sh 可执行 ==="
test -x scripts/install.sh && echo "executable" || echo "NOT executable"

echo "=== 10. symlink 状态 ==="
test -L ~/.claude/skills/learn && echo "symlink OK" || echo "NOT symlink"
'
```

### 手动功能测试（集成测试）

在一个临时目录下测试完整流程：

```bash
# 1. 创建临时测试目录
mkdir -p /tmp/learn-test && cd /tmp/learn-test

# 2. 调用 /learn，开始一个测试 topic
# （在 Claude Code 中执行 /learn "测试主题-temp"）

# 3. 验证 .learn/ 目录结构
ls -la .learn/
cat .learn/active.md
cat ".learn/topics/$(cat .learn/active.md)/state.md"

# 4. 验证 state.md 格式合规
grep -E "^status: (active|paused|completed)$" ".learn/topics/$(cat .learn/active.md)/state.md"
grep -E "^stuck_count: [0-9]+$" ".learn/topics/$(cat .learn/active.md)/state.md"

# 5. 清理测试目录
cd ~ && rm -rf /tmp/learn-test
```

---

## 如何发布

本 skill 采用"源码即发布"（source-is-release）模式，无构建步骤：

1. **开发完成后**，运行结构合规性自检（见上）
2. **合并到主分支**（`main` 或 `master`）
3. **用户更新**：只需 `git pull` 即可——symlink 指向本地目录，拉取后立即生效

### 版本说明

暂无正式语义版本（semver）。如需追踪变更，使用 git log。

### 多用户共享（可选）

如果多个用户需要共享同一个 skill：

```bash
# 方案 A：每人 clone 一份
git clone <repo-url> ~/learn-everything
bash ~/learn-everything/scripts/install.sh

# 方案 B：共享只读目录（不推荐，因为 install.sh 需要写 ~/.claude/）
```

---

## 契约变更流程（Breaking Changes）

以下修改属于"契约破坏性变更"（breaking changes），可能导致已有 `.learn/` 数据与新版本不兼容：

- 增删 `state.md` 的 YAML 字段
- 修改 `status`、`bloom_level` 枚举值
- 修改 `artifacts/<NN-name>/` 的目录命名规则
- 修改 journal.md 的动作类型枚举

执行契约破坏性变更时，必须：
1. 在 commit message 中注明 `BREAKING CHANGE:`
2. 在 README.md 中记录迁移步骤（migration steps）
3. 提供迁移脚本（如果用户有现有 `.learn/` 数据需要迁移）

---

## 代码风格

- SKILL.md 和所有文档使用中文写作，技术术语保留英文括注（如"间隔效应（spacing effect）"）
- 文件名使用 kebab-case
- YAML frontmatter 使用 2 空格缩进
- Shell 脚本使用 `set -euo pipefail`，函数名使用 `snake_case`
