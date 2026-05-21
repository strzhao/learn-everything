# Patterns

<!-- tags: contract, autopilot, contract-checker, design -->
## 契约规约字面量化

**Pattern**：契约规约的每条要求必须用具体字面量表达（字段名、枚举值、文件名、关键词），避免语义化描述（"必须明确说明 X 语义"、"应当遵守 Y 规范"）。

**Why**：autopilot 的 contract-checker Agent 做的是字面比对（field_name / boundary / error_code / route / signature），不评估语义。本次教训——契约写"description 必须明确说明工具用途以及单入口语义（不开放子命令）"，contract-checker 报 high mismatch（description 里没出现"单入口"字面量），即便 description 实际语义已涵盖。修复方式是在 description 加入"单入口"和"不开放子命令"两个字面量。

**How to apply**：
- 写契约时，把每个语义要求转化为可 grep/diff 的字面量。例如 "name 必须为 learn" 而不是 "name 应为合法的 skill 标识符"
- 枚举值固定写出（active|paused|completed），不允许同义改写
- 段落标题逐字写（"## 它做什么"），不允许变体（"它的作用"）
- 触发关键词、动作枚举、字段名、文件命名格式都用代码标记 `` ` `` 包裹强调字面量边界

---

<!-- tags: testing, sandbox, bash, isolation -->
## 测试脚本备份用户环境

**Pattern**：当测试脚本要写入或修改用户全局环境（如 `~/.claude/`、`/etc/`、共享目录）时，必须先备份再恢复，并用 `trap EXIT` 保证无论成功失败都能还原。

**Why**：本项目的 `tests/acceptance-check.sh` 要跑 `bash scripts/install.sh` 验证 symlink 能装到 `~/.claude/skills/learn/`。如果用户已经有 learn skill（即使是另一个版本），裸跑测试会覆盖掉用户的实际安装。备份策略让测试可以在用户机器上反复跑而不破坏其工作环境。

**How to apply**：
```bash
# 1. 测试开始时备份
SKILL_BACKUP=""
backup_existing_skill() {
  if [ -e "$SKILL_INSTALL_PATH" ]; then
    SKILL_BACKUP="${SKILL_INSTALL_PATH%/*}/.learn-backup-$(date +%s)"
    mv "$SKILL_INSTALL_PATH" "$SKILL_BACKUP"
  fi
}

# 2. 注册 trap 保证恢复
restore_backup() {
  [ -n "$SKILL_BACKUP" ] && [ -e "$SKILL_BACKUP" ] && mv "$SKILL_BACKUP" "$SKILL_INSTALL_PATH"
}
trap restore_backup EXIT

# 3. 跑测试
backup_existing_skill
... 测试 ...
# trap 自动恢复
```

适用范围：任何修改 `~/`、`/etc/`、`/usr/local/` 等全局路径的测试脚本。
