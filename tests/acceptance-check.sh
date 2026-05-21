#!/usr/bin/env bash
# learn-everything 验收检查脚本（红队产出，TDD 红灯版本）
# 使用方式：在项目根目录执行 bash tests/acceptance-check.sh
# 兼容 bash 3.2（macOS 系统自带版本）
# 所有 case 独立运行，全部跑完后汇总

set -u

# ── 全局状态 ──────────────────────────────────────────────────────────────────
PASS_COUNT=0
FAIL_COUNT=0
SKILL_INSTALL_PATH="$HOME/.claude/skills/learn"
BACKUP_PATH=""
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── 工具函数 ──────────────────────────────────────────────────────────────────
pass() {
  echo "[PASS] $1"
  PASS_COUNT=$((PASS_COUNT + 1))
}

fail() {
  echo "[FAIL] $1"
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

# ── 备份与恢复 symlink ─────────────────────────────────────────────────────────
backup_existing_skill() {
  if [ -e "$SKILL_INSTALL_PATH" ] || [ -L "$SKILL_INSTALL_PATH" ]; then
    BACKUP_PATH="$HOME/.claude/skills/.learn-backup-$(date +%s)"
    echo "[INFO] 检测到已存在的 ${SKILL_INSTALL_PATH}，备份到 ${BACKUP_PATH}"
    mv "$SKILL_INSTALL_PATH" "$BACKUP_PATH"
  fi
}

restore_skill_backup() {
  # 先清理测试期间安装的 symlink
  if [ -e "$SKILL_INSTALL_PATH" ] || [ -L "$SKILL_INSTALL_PATH" ]; then
    rm -rf "$SKILL_INSTALL_PATH"
  fi
  # 恢复备份
  if [ -n "${BACKUP_PATH:-}" ] && [ -e "$BACKUP_PATH" ]; then
    echo "[INFO] 恢复备份 $BACKUP_PATH -> $SKILL_INSTALL_PATH"
    mv "$BACKUP_PATH" "$SKILL_INSTALL_PATH"
  fi
}

# ── V8：git 仓库已初始化 ──────────────────────────────────────────────────────
check_v8() {
  if [ -d "$PROJECT_ROOT/.git" ]; then
    pass "V8: git 仓库已初始化（.git 目录存在）"
  else
    fail "V8: .git 目录不存在，项目尚未初始化为 git 仓库"
  fi
}

# ── V7：install.sh 可执行位 ───────────────────────────────────────────────────
check_v7() {
  local script="$PROJECT_ROOT/scripts/install.sh"
  if [ ! -f "$script" ]; then
    fail "V7: scripts/install.sh 文件不存在"
    return
  fi
  if [ -x "$script" ]; then
    pass "V7: scripts/install.sh 具有可执行权限"
  else
    fail "V7: scripts/install.sh 存在但没有可执行权限（缺少 +x）"
  fi
}

# ── V1：安装脚本创建 symlink ──────────────────────────────────────────────────
check_v1() {
  local script="$PROJECT_ROOT/scripts/install.sh"
  if [ ! -f "$script" ]; then
    fail "V1: scripts/install.sh 不存在，无法验证安装"
    return
  fi

  # 执行安装
  if ! bash "$script" > /dev/null 2>&1; then
    fail "V1: bash scripts/install.sh 执行失败（非零退出码）"
    return
  fi

  # 检查 symlink 是否存在
  if [ ! -L "$SKILL_INSTALL_PATH" ]; then
    fail "V1: 安装后 $SKILL_INSTALL_PATH 不是 symlink（可能是普通目录或不存在）"
    return
  fi

  # 检查 symlink 指向源码 skills/learn（解析绝对路径后对比）
  local expected_abs="$PROJECT_ROOT/skills/learn"
  local link_target
  link_target="$(readlink "$SKILL_INSTALL_PATH")"
  local resolved_target=""
  # 尝试解析 symlink 目标的绝对路径
  if [ -d "$SKILL_INSTALL_PATH" ]; then
    resolved_target="$(cd "$SKILL_INSTALL_PATH" && pwd -P)"
  fi

  if [ "$resolved_target" = "$expected_abs" ]; then
    pass "V1: ~/.claude/skills/learn 是指向源码 skills/learn 的 symlink"
  else
    fail "V1: symlink 目标不正确。期望: ${expected_abs}，实际解析: ${resolved_target}（readlink=${link_target}）"
  fi
}

# ── V6：symlink 幂等性 ────────────────────────────────────────────────────────
check_v6() {
  local script="$PROJECT_ROOT/scripts/install.sh"
  if [ ! -f "$script" ]; then
    fail "V6: scripts/install.sh 不存在，无法验证幂等性"
    return
  fi

  # 删除现有 symlink，再次安装测试幂等性
  if [ -e "$SKILL_INSTALL_PATH" ] || [ -L "$SKILL_INSTALL_PATH" ]; then
    rm -rf "$SKILL_INSTALL_PATH"
  fi

  # 第二次安装
  if ! bash "$script" > /dev/null 2>&1; then
    fail "V6: 第二次执行 bash scripts/install.sh 失败（幂等性破坏）"
    return
  fi

  if [ -L "$SKILL_INSTALL_PATH" ]; then
    pass "V6: 重复执行 install.sh 仍能成功创建 symlink（幂等性通过）"
  else
    fail "V6: 重复执行后 $SKILL_INSTALL_PATH 不是 symlink（幂等性失败）"
  fi
}

# ── V2：教学法 5 份齐全 ───────────────────────────────────────────────────────
check_v2() {
  local pedagogy_dir="$PROJECT_ROOT/skills/learn/pedagogy"

  if [ ! -d "$pedagogy_dir" ]; then
    fail "V2: skills/learn/pedagogy/ 目录不存在"
    return
  fi

  # 检查文件数量（用 awk 避免 tr/xargs 空白问题）
  local md_count
  md_count=$(find "$pedagogy_dir" -maxdepth 1 -name "*.md" | awk 'END{print NR}')

  if [ "$md_count" -ne 5 ]; then
    fail "V2: pedagogy/ 中 .md 文件数量为 ${md_count}，期望精确为 5 份"
    return
  fi

  # 检查预期的 5 个文件名（POSIX 兼容，不用数组）
  local v2_ok=true
  for fname in "socratic-method.md" "gemini-learning-mode.md" "blooms-taxonomy.md" "spaced-repetition.md" "feynman-technique.md"; do
    if [ ! -f "$pedagogy_dir/$fname" ]; then
      fail "V2: 缺少文件 pedagogy/$fname"
      v2_ok=false
    fi
  done

  if [ "$v2_ok" = false ]; then
    return
  fi

  # 检查每份字数 200-500 字（用 wc -m 字符数，200~2000 chars 兼容中英混合）
  local word_ok=true
  for fname in "socratic-method.md" "gemini-learning-mode.md" "blooms-taxonomy.md" "spaced-repetition.md" "feynman-technique.md"; do
    local fpath="$pedagogy_dir/$fname"
    local chars
    chars=$(wc -m < "$fpath" | awk '{print $1}')
    if [ "$chars" -lt 200 ] || [ "$chars" -gt 2000 ]; then
      fail "V2: $fname 字符数 $chars 超出范围（期望 200~2000，对应 200-500 字）"
      word_ok=false
    fi
  done

  if [ "$word_ok" = true ]; then
    pass "V2: pedagogy/ 共 5 份 .md 文件，文件名正确，字数均在 200~2000 字符范围内"
  fi
}

# ── V3：SKILL.md 格式 ─────────────────────────────────────────────────────────
check_v3() {
  local skill_md="$PROJECT_ROOT/skills/learn/SKILL.md"

  if [ ! -f "$skill_md" ]; then
    fail "V3: skills/learn/SKILL.md 不存在"
    return
  fi

  local v3_ok=true

  # 检查 frontmatter：含 name:
  if ! grep -q '^name:' "$skill_md"; then
    fail "V3: SKILL.md frontmatter 缺少 'name:' 字段"
    v3_ok=false
  fi

  # 检查 frontmatter：含 description:
  if ! grep -q '^description:' "$skill_md"; then
    fail "V3: SKILL.md frontmatter 缺少 'description:' 字段"
    v3_ok=false
  fi

  # 检查正文 ≥1500 字符
  local chars
  chars=$(wc -m < "$skill_md" | awk '{print $1}')
  if [ "$chars" -lt 1500 ]; then
    fail "V3: SKILL.md 字符数 ${chars}，期望 >=1500"
    v3_ok=false
  fi

  # 检查是否引用 references/ 至少 1 次
  if ! grep -q 'references/' "$skill_md"; then
    fail "V3: SKILL.md 正文未引用 references/（期望至少出现 1 次）"
    v3_ok=false
  fi

  # 检查是否引用 pedagogy/ 至少 1 次
  if ! grep -q 'pedagogy/' "$skill_md"; then
    fail "V3: SKILL.md 正文未引用 pedagogy/（期望至少出现 1 次）"
    v3_ok=false
  fi

  if [ "$v3_ok" = true ]; then
    pass "V3: SKILL.md frontmatter 完整（name/description），字数达标，引用了 references/ 和 pedagogy/"
  fi
}

# ── V4：references 完整 ───────────────────────────────────────────────────────
check_v4() {
  local ref_dir="$PROJECT_ROOT/skills/learn/references"

  if [ ! -d "$ref_dir" ]; then
    fail "V4: skills/learn/references/ 目录不存在"
    return
  fi

  local v4_ok=true

  for fname in "topic-init-template.md" "decision-tree.md"; do
    local fpath="$ref_dir/$fname"
    if [ ! -f "$fpath" ]; then
      fail "V4: references/$fname 不存在"
      v4_ok=false
      continue
    fi
    local chars
    chars=$(wc -m < "$fpath" | awk '{print $1}')
    if [ "$chars" -lt 300 ]; then
      fail "V4: references/${fname} 字符数 ${chars}，期望 >=300"
      v4_ok=false
    fi
  done

  if [ "$v4_ok" = true ]; then
    pass "V4: references/ 包含 topic-init-template.md 和 decision-tree.md，字数均 ≥300"
  fi
}

# ── V5：README/CLAUDE 完整 ────────────────────────────────────────────────────
check_v5() {
  local v5_ok=true

  # README.md 存在
  if [ ! -f "$PROJECT_ROOT/README.md" ]; then
    fail "V5: README.md 不存在"
    v5_ok=false
  else
    # 检查必须包含的三个 H2 章节
    for section in "## 安装" "## 使用" "## 设计"; do
      if ! grep -qF "$section" "$PROJECT_ROOT/README.md"; then
        fail "V5: README.md 缺少 H2 章节 '$section'"
        v5_ok=false
      fi
    done
  fi

  # CLAUDE.md 存在
  if [ ! -f "$PROJECT_ROOT/CLAUDE.md" ]; then
    fail "V5: CLAUDE.md 不存在"
    v5_ok=false
  fi

  if [ "$v5_ok" = true ]; then
    pass "V5: README.md 含三个 H2 章节（安装/使用/设计），CLAUDE.md 存在"
  fi
}

# ── 契约 C3a：SKILL.md description 触发关键词 ────────────────────────────────
check_c3a() {
  local skill_md="$PROJECT_ROOT/skills/learn/SKILL.md"

  if [ ! -f "$skill_md" ]; then
    fail "C3a: SKILL.md 不存在，无法检查 description 触发关键词"
    return
  fi

  local desc_line
  desc_line=$(grep '^description:' "$skill_md" | head -1)

  if echo "$desc_line" | grep -qi 'learn\|学习'; then
    pass "C3a: SKILL.md description 含触发关键词（'learn' 或 '学习'）"
  else
    fail "C3a: SKILL.md description 缺少触发关键词（'learn' 或 '学习'）。当前值: $desc_line"
  fi
}

# ── 契约 C3b：SKILL.md name 字段值为 learn ───────────────────────────────────
check_c3b() {
  local skill_md="$PROJECT_ROOT/skills/learn/SKILL.md"

  if [ ! -f "$skill_md" ]; then
    fail "C3b: SKILL.md 不存在，无法检查 name 字段值"
    return
  fi

  local name_line
  name_line=$(grep '^name:' "$skill_md" | head -1)

  if echo "$name_line" | grep -qE '^name:[[:space:]]*learn[[:space:]]*$'; then
    pass "C3b: SKILL.md name 字段值为 'learn'"
  else
    fail "C3b: SKILL.md name 字段值不是 'learn'。当前值: $name_line"
  fi
}

# ── 契约 C4：教学法文件名 kebab-case + ≥4 个二级标题 ────────────────────────
check_c4() {
  local pedagogy_dir="$PROJECT_ROOT/skills/learn/pedagogy"

  if [ ! -d "$pedagogy_dir" ]; then
    fail "C4: skills/learn/pedagogy/ 目录不存在"
    return
  fi

  local c4_ok=true

  for fname in "socratic-method.md" "gemini-learning-mode.md" "blooms-taxonomy.md" "spaced-repetition.md" "feynman-technique.md"; do
    local fpath="$pedagogy_dir/$fname"
    if [ ! -f "$fpath" ]; then
      # V2 已报告缺失，这里跳过避免重复
      continue
    fi

    # 检查文件名是否为 kebab-case
    local base="${fname%.md}"
    if ! echo "$base" | grep -qE '^[a-z0-9]+(-[a-z0-9]+)*$'; then
      fail "C4: pedagogy/$fname 文件名不符合 kebab-case 规范"
      c4_ok=false
    fi

    # 检查二级标题数量 ≥4
    local h2_count
    h2_count=$(grep -c '^## ' "$fpath" || echo "0")
    if [ "$h2_count" -lt 4 ]; then
      fail "C4: pedagogy/${fname} 二级标题数量 ${h2_count}，期望 >=4"
      c4_ok=false
    fi
  done

  if [ "$c4_ok" = true ]; then
    pass "C4: 所有教学法文件名符合 kebab-case，且每份 ≥4 个二级标题"
  fi
}

# ── 契约 C1：topic-init-template.md 含关键合规要素 ───────────────────────────
check_c1() {
  local template="$PROJECT_ROOT/skills/learn/references/topic-init-template.md"

  if [ ! -f "$template" ]; then
    fail "C1: references/topic-init-template.md 不存在，无法检查关键合规要素"
    return
  fi

  local c1_ok=true

  # 检查主题相关关键词
  if ! grep -qiE 'topic|主题' "$template"; then
    fail "C1: topic-init-template.md 缺少关键词（topic/主题）"
    c1_ok=false
  fi

  # 检查状态/进度相关关键词
  if ! grep -qiE 'status|状态|progress|进度' "$template"; then
    fail "C1: topic-init-template.md 缺少关键词（status/状态/progress/进度）"
    c1_ok=false
  fi

  if [ "$c1_ok" = true ]; then
    pass "C1: topic-init-template.md 包含关键合规要素（主题和状态相关关键词）"
  fi
}

# ── 主流程 ────────────────────────────────────────────────────────────────────
main() {
  echo "================================================================"
  echo " learn-everything 验收检查脚本"
  echo " 项目根目录: $PROJECT_ROOT"
  echo " 运行时间: $(date)"
  echo "================================================================"
  echo ""

  # 备份已有 skill（避免污染用户环境）
  backup_existing_skill

  # 注册退出时恢复（无论成功失败都恢复）
  trap restore_skill_backup EXIT

  echo "── 基础环境检查 ────────────────────────────────────────────────"
  check_v8
  check_v7
  echo ""

  echo "── 安装脚本验证 ────────────────────────────────────────────────"
  check_v1
  check_v6
  echo ""

  echo "── 内容结构验证 ────────────────────────────────────────────────"
  check_v2
  check_v3
  check_v4
  check_v5
  echo ""

  echo "── 契约合规扩展检查 ────────────────────────────────────────────"
  check_c3a
  check_c3b
  check_c4
  check_c1
  echo ""

  echo "================================================================"
  echo " 汇总结果"
  echo "================================================================"
  echo " PASS: $PASS_COUNT"
  echo " FAIL: $FAIL_COUNT"
  local total=$((PASS_COUNT + FAIL_COUNT))
  if [ "$total" -gt 0 ]; then
    echo " 通过率: $PASS_COUNT / $total"
  fi
  echo "================================================================"

  if [ "$FAIL_COUNT" -eq 0 ]; then
    echo " 全部通过！蓝队实现满足设计规约。"
    exit 0
  else
    echo " 存在 $FAIL_COUNT 项未通过，蓝队实现尚未完成或存在缺陷。"
    exit 1
  fi
}

main
