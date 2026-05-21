#!/usr/bin/env bash
# install.sh — 安装 learn-everything skill 到 ~/.claude/skills/learn
#
# 功能：
#   创建 ~/.claude/skills/learn → <repo>/skills/learn 的 symlink
#   已存在 symlink：询问是否覆盖（默认 N 不覆盖）
#   已存在真实目录：报错中止（不修改）
#
# 用法：
#   bash scripts/install.sh

set -euo pipefail

# ────────────────────────────────────────────────
# 1. 确定仓库根目录和 skill 源路径
# ────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILL_SRC="$REPO_ROOT/skills/learn"
SKILL_DST="$HOME/.claude/skills/learn"

echo "======================================"
echo " learn-everything 安装程序"
echo "======================================"
echo ""
echo "源目录：$SKILL_SRC"
echo "目标路径：$SKILL_DST"
echo ""

# ────────────────────────────────────────────────
# 2. 验证源目录存在
# ────────────────────────────────────────────────

if [ ! -d "$SKILL_SRC" ]; then
    echo "错误：源目录不存在：$SKILL_SRC"
    echo "请确保在 learn-everything 仓库根目录下运行本脚本。"
    exit 1
fi

# 验证 SKILL.md 存在（最基本的完整性检查）
if [ ! -f "$SKILL_SRC/SKILL.md" ]; then
    echo "错误：$SKILL_SRC/SKILL.md 不存在，skill 可能不完整。"
    echo "请检查仓库完整性后重试。"
    exit 1
fi

# ────────────────────────────────────────────────
# 3. 确保 ~/.claude/skills/ 目录存在
# ────────────────────────────────────────────────

SKILLS_DIR="$HOME/.claude/skills"
if [ ! -d "$SKILLS_DIR" ]; then
    echo "创建目录：$SKILLS_DIR"
    mkdir -p "$SKILLS_DIR"
fi

# ────────────────────────────────────────────────
# 4. 检查目标路径状态
# ────────────────────────────────────────────────

if [ -L "$SKILL_DST" ]; then
    # 已存在 symlink（可能指向旧路径或相同路径）
    EXISTING_TARGET="$(readlink "$SKILL_DST")"
    echo "检测到已有 symlink：$SKILL_DST → $EXISTING_TARGET"
    echo ""

    if [ "$EXISTING_TARGET" = "$SKILL_SRC" ]; then
        echo "该 symlink 已指向当前仓库的 skill 目录，无需重新安装。"
        echo ""
        echo "安装状态：已是最新（up-to-date）"
        exit 0
    fi

    # 询问是否覆盖（默认 N）
    printf "是否覆盖已有 symlink？[y/N] "
    read -r ANSWER
    ANSWER="${ANSWER:-N}"

    case "$ANSWER" in
        [yY]|[yY][eE][sS])
            echo "正在移除旧 symlink..."
            rm "$SKILL_DST"
            ;;
        *)
            echo "已取消。保留现有 symlink，不做任何修改。"
            exit 0
            ;;
    esac

elif [ -d "$SKILL_DST" ]; then
    # 已存在真实目录（非 symlink）
    echo "错误：$SKILL_DST 是一个真实目录（非 symlink）。"
    echo ""
    echo "为了安全起见，本安装程序不会修改真实目录。"
    echo "如果你想用本 skill 替换它，请手动执行以下步骤："
    echo ""
    echo "  1. 备份或删除现有目录："
    echo "     mv \"$SKILL_DST\" \"${SKILL_DST}.backup\""
    echo "     # 或者：rm -rf \"$SKILL_DST\""
    echo ""
    echo "  2. 重新运行安装程序："
    echo "     bash \"$SCRIPT_DIR/install.sh\""
    echo ""
    exit 1

elif [ -e "$SKILL_DST" ]; then
    # 存在但既不是 symlink 也不是目录（例如是文件）
    echo "错误：$SKILL_DST 已存在但不是目录或 symlink。"
    echo "请手动检查并处理该路径后重试。"
    exit 1
fi

# ────────────────────────────────────────────────
# 5. 创建 symlink
# ────────────────────────────────────────────────

echo "正在创建 symlink..."
ln -s "$SKILL_SRC" "$SKILL_DST"

# ────────────────────────────────────────────────
# 6. 验证安装结果
# ────────────────────────────────────────────────

if [ -L "$SKILL_DST" ] && [ -d "$SKILL_DST" ]; then
    echo ""
    echo "======================================"
    echo " 安装成功！"
    echo "======================================"
    echo ""
    echo "  symlink：$SKILL_DST"
    echo "  → 指向：$SKILL_SRC"
    echo ""
    echo "现在可以在任意目录中通过 /learn 命令开始学习。"
    echo ""
    echo "快速开始："
    echo "  /learn                  # 继续当前学习 topic"
    echo "  /learn Python 异步编程  # 开始新 topic"
    echo "  /learn --list           # 查看所有 topic"
    echo ""
else
    echo ""
    echo "错误：symlink 创建后验证失败，请手动检查："
    echo "  ls -la \"$SKILL_DST\""
    exit 1
fi

# ────────────────────────────────────────────────
# 7. 确保本脚本自身可执行
# ────────────────────────────────────────────────

chmod +x "${BASH_SOURCE[0]}"
