#!/usr/bin/env bash
# learn-everything 验收检查脚本（QA 自检工具，不参与运行时）
# 使用方式：在项目根目录执行 bash tests/acceptance-check.sh
# 兼容 bash 3.2（macOS 系统自带版本）
# 所有 case 独立运行，全部跑完后汇总

set -u

# ── 全局状态 ──────────────────────────────────────────────────────────────────
PASS_COUNT=0
FAIL_COUNT=0
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILL_DIR="$PROJECT_ROOT/.claude/skills/learn"

# ── 工具函数 ──────────────────────────────────────────────────────────────────
pass() {
  echo "[PASS] $1"
  PASS_COUNT=$((PASS_COUNT + 1))
}

fail() {
  echo "[FAIL] $1"
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

# ── V_GIT：git 仓库已初始化 ───────────────────────────────────────────────────
check_git() {
  if [ -d "$PROJECT_ROOT/.git" ]; then
    pass "GIT: git 仓库已初始化"
  else
    fail "GIT: .git 目录不存在"
  fi
}

# ── V_SKILL_LOC：skill 装载到项目级路径 .claude/skills/learn/ ─────────────────
check_skill_location() {
  if [ -d "$SKILL_DIR" ] && [ -f "$SKILL_DIR/SKILL.md" ]; then
    pass "SKILL_LOC: .claude/skills/learn/SKILL.md 存在（项目级 skill）"
  else
    fail "SKILL_LOC: $SKILL_DIR/SKILL.md 不存在或不是项目级布局"
  fi
}

# ── V_NO_INSTALL：不应再有 scripts/install.sh 或 ~/.claude/skills/learn ─────
check_no_install() {
  local fail_msgs=()
  if [ -e "$PROJECT_ROOT/scripts/install.sh" ]; then
    fail_msgs+=("scripts/install.sh 仍存在（应已删除）")
  fi
  # 项目目录下不应再有 skills/ 目录
  if [ -d "$PROJECT_ROOT/skills" ]; then
    fail_msgs+=("scripts/skills/ 顶层目录仍存在（应已迁移到 .claude/skills/）")
  fi
  if [ ${#fail_msgs[@]} -eq 0 ]; then
    pass "NO_INSTALL: 已无全局安装脚本/旧 skills 目录残留"
  else
    for m in "${fail_msgs[@]}"; do fail "NO_INSTALL: $m"; done
  fi
}

# ── V_PEDAGOGY：5 份教学法齐全 + 字数 + 文件名 ──────────────────────────────
check_pedagogy() {
  local pedagogy_dir="$SKILL_DIR/pedagogy"

  if [ ! -d "$pedagogy_dir" ]; then
    fail "PEDAGOGY: $pedagogy_dir 不存在"
    return
  fi

  local md_count
  md_count=$(find "$pedagogy_dir" -maxdepth 1 -name "*.md" | awk 'END{print NR}')
  if [ "$md_count" -ne 5 ]; then
    fail "PEDAGOGY: 文件数 $md_count，期望精确为 5"
    return
  fi

  local ok=true
  for fname in socratic-method.md gemini-learning-mode.md blooms-taxonomy.md spaced-repetition.md feynman-technique.md; do
    if [ ! -f "$pedagogy_dir/$fname" ]; then
      fail "PEDAGOGY: 缺少 $fname"; ok=false; continue
    fi
    local chars
    chars=$(wc -m < "$pedagogy_dir/$fname" | awk '{print $1}')
    if [ "$chars" -lt 200 ] || [ "$chars" -gt 2000 ]; then
      fail "PEDAGOGY: $fname 字符数 $chars 超出 200-2000"; ok=false
    fi
    # 检查文件名 kebab-case
    local base="${fname%.md}"
    if ! echo "$base" | grep -qE '^[a-z0-9]+(-[a-z0-9]+)*$'; then
      fail "PEDAGOGY: $fname 文件名非 kebab-case"; ok=false
    fi
    # 检查 ≥4 个 H2
    local h2
    h2=$(grep -c '^## ' "$pedagogy_dir/$fname" || echo 0)
    if [ "$h2" -lt 4 ]; then
      fail "PEDAGOGY: $fname H2 数量 $h2 < 4"; ok=false
    fi
  done
  $ok && pass "PEDAGOGY: 5 份齐全 + 字数合规 + 文件名 kebab-case + ≥4 H2"
}

# ── V_SKILL_FORMAT：SKILL.md 格式契约 ───────────────────────────────────────
check_skill_format() {
  local skill_md="$SKILL_DIR/SKILL.md"
  if [ ! -f "$skill_md" ]; then
    fail "SKILL_FMT: $skill_md 不存在"; return
  fi
  local ok=true

  # frontmatter name + description
  if ! grep -q '^name:' "$skill_md"; then fail "SKILL_FMT: 缺 name"; ok=false; fi
  if ! grep -q '^description:' "$skill_md"; then fail "SKILL_FMT: 缺 description"; ok=false; fi

  # 字数 ≥1500
  local chars
  chars=$(wc -m < "$skill_md" | awk '{print $1}')
  if [ "$chars" -lt 1500 ]; then fail "SKILL_FMT: 字符数 $chars < 1500"; ok=false; fi

  # 引用 references 和 pedagogy 各 ≥1
  if ! grep -q 'references/' "$skill_md"; then fail "SKILL_FMT: 未引用 references/"; ok=false; fi
  if ! grep -q 'pedagogy/' "$skill_md"; then fail "SKILL_FMT: 未引用 pedagogy/"; ok=false; fi

  # name 字段精确为 learn
  if ! grep -qE '^name:[[:space:]]*learn[[:space:]]*$' "$skill_md"; then
    fail "SKILL_FMT: name 不是 learn"; ok=false
  fi

  # description 含触发关键词 learn / 学习（YAML 内联或块标量；用整行 grep）
  if ! grep -qiE 'learn|学习' "$skill_md"; then
    fail "SKILL_FMT: description 缺 learn/学习 触发词"; ok=false
  fi

  # description 含"单入口"字面量（契约 3 关键词）
  if ! grep -qF '单入口' "$skill_md"; then
    fail "SKILL_FMT: description 或正文缺'单入口'字面量"; ok=false
  fi

  $ok && pass "SKILL_FMT: frontmatter + 字数 + 引用 + 触发词 + 单入口字面量 全合规"
}

# ── V_REFERENCES：references 完整 ───────────────────────────────────────────
check_references() {
  local ref_dir="$SKILL_DIR/references"
  if [ ! -d "$ref_dir" ]; then
    fail "REFS: $ref_dir 不存在"; return
  fi
  local ok=true
  for fname in topic-init-template.md decision-tree.md; do
    if [ ! -f "$ref_dir/$fname" ]; then fail "REFS: 缺 $fname"; ok=false; continue; fi
    local chars
    chars=$(wc -m < "$ref_dir/$fname" | awk '{print $1}')
    if [ "$chars" -lt 300 ]; then fail "REFS: $fname 字符数 $chars < 300"; ok=false; fi
  done
  $ok && pass "REFS: topic-init-template.md + decision-tree.md 均存在且 ≥300"
}

# ── V_DT_CONTRACT：decision-tree.md 含目录管理三件事 + archive 动作 ─────────
check_decision_tree_contract() {
  local dt="$SKILL_DIR/references/decision-tree.md"
  if [ ! -f "$dt" ]; then fail "DT: $dt 不存在"; return; fi
  local ok=true
  # archive 动作枚举
  if ! grep -q 'archive' "$dt"; then fail "DT: 缺 archive 动作枚举"; ok=false; fi
  # INDEX.md 维护规则
  if ! grep -q 'INDEX\.md' "$dt"; then fail "DT: 缺 INDEX.md 维护规则"; ok=false; fi
  # _archive 归档目录
  if ! grep -q '_archive' "$dt"; then fail "DT: 缺 _archive 归档目录提及"; ok=false; fi
  # _active 指针
  if ! grep -q '_active' "$dt"; then fail "DT: 缺 _active 指针提及"; ok=false; fi
  # 不应有 .learn/ 旧路径残留
  if grep -q '\.learn/' "$dt"; then fail "DT: 仍含 .learn/ 旧路径"; ok=false; fi
  $ok && pass "DT: 含目录管理三件事 + archive 动作 + 路径已迁移到 topics/"
}

# ── V_ASK_USER：AskUserQuestion 交互契约 ────────────────────────────────────
check_ask_user_question() {
  local skill_md="$SKILL_DIR/SKILL.md"
  local dt="$SKILL_DIR/references/decision-tree.md"
  local ok=true

  # SKILL.md 的 allowed-tools 必须包含 AskUserQuestion
  if ! grep -qE '^[[:space:]]*-[[:space:]]*AskUserQuestion[[:space:]]*$' "$skill_md"; then
    fail "ASK_USER: SKILL.md frontmatter allowed-tools 缺 AskUserQuestion"; ok=false
  fi

  # SKILL.md 正文必须含"交互机制"章节
  if ! grep -qF '交互机制' "$skill_md"; then
    fail "ASK_USER: SKILL.md 缺'交互机制'章节"; ok=false
  fi

  # decision-tree.md 必须提及 AskUserQuestion + 阶段 4.5 契约章节
  if ! grep -q 'AskUserQuestion' "$dt"; then
    fail "ASK_USER: decision-tree.md 缺 AskUserQuestion 规范"; ok=false
  fi
  if ! grep -qF '阶段 4.5' "$dt"; then
    fail "ASK_USER: decision-tree.md 缺'阶段 4.5'交互工具契约章节"; ok=false
  fi

  # SKILL.md 中 socratic 段落必须强制 AskUserQuestion（防退化）
  # 检查"socratic"+"AskUserQuestion"在同 200 字符窗口内（粗略契约校验）
  if ! awk '/socratic/{found=1} found && /AskUserQuestion/{print; exit}' "$skill_md" | grep -q .; then
    fail "ASK_USER: SKILL.md socratic 段落未绑定 AskUserQuestion"; ok=false
  fi

  $ok && pass "ASK_USER: SKILL.md + decision-tree.md 均含 AskUserQuestion 交互契约"
}

# ── V_DOCS：README + CLAUDE 完整 ───────────────────────────────────────────
check_docs() {
  local ok=true
  local readme="$PROJECT_ROOT/README.md"
  local claude="$PROJECT_ROOT/CLAUDE.md"

  [ -f "$readme" ] || { fail "DOCS: README.md 不存在"; ok=false; }
  [ -f "$claude" ] || { fail "DOCS: CLAUDE.md 不存在"; ok=false; }

  if [ -f "$readme" ]; then
    for section in '## 使用' '## 目录管理' '## 设计'; do
      if ! grep -qF "$section" "$readme"; then
        fail "DOCS: README.md 缺 $section"; ok=false
      fi
    done
  fi

  $ok && pass "DOCS: README.md 含 ## 使用 / ## 目录管理 / ## 设计；CLAUDE.md 存在"
}

# ── V_TOPICS_LAYOUT：topics/ 顶层布局合规（如已存在）───────────────────────
check_topics_layout() {
  local topics_dir="$PROJECT_ROOT/topics"
  if [ ! -d "$topics_dir" ]; then
    pass "TOPICS_LAYOUT: topics/ 不存在（首次启动前正常）"; return
  fi
  # _active 必须是普通文件（如存在）
  if [ -e "$topics_dir/_active" ] && [ ! -f "$topics_dir/_active" ]; then
    fail "TOPICS_LAYOUT: _active 不是普通文件"; return
  fi
  # _active 不应有 .md 扩展名
  if [ -f "$topics_dir/active.md" ]; then
    fail "TOPICS_LAYOUT: 存在旧版 active.md（应改为 _active 无扩展名）"; return
  fi
  pass "TOPICS_LAYOUT: 顶层 topics/ 布局合规"
}

# ── 主流程 ────────────────────────────────────────────────────────────────────
main() {
  echo "================================================================"
  echo " learn-everything 验收检查（项目级 skill 版）"
  echo " 项目根目录: $PROJECT_ROOT"
  echo " 运行时间: $(date)"
  echo "================================================================"
  echo ""

  echo "── 基础环境 ────────────────────────────────────────────────────"
  check_git
  check_skill_location
  check_no_install
  echo ""

  echo "── skill 内容结构 ──────────────────────────────────────────────"
  check_pedagogy
  check_skill_format
  check_references
  echo ""

  echo "── 调度契约 ────────────────────────────────────────────────────"
  check_decision_tree_contract
  check_ask_user_question
  echo ""

  echo "── 文档 + topics 布局 ──────────────────────────────────────────"
  check_docs
  check_topics_layout
  echo ""

  echo "================================================================"
  echo " 汇总：PASS=$PASS_COUNT  FAIL=$FAIL_COUNT"
  echo "================================================================"

  if [ "$FAIL_COUNT" -eq 0 ]; then
    echo " 全部通过。"; exit 0
  else
    echo " 存在 $FAIL_COUNT 项未通过。"; exit 1
  fi
}

main
