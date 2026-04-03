#!/bin/bash
# ============================================
# EasyDB 一键发版脚本
# 用法: ./release.sh <版本号>
# 示例: ./release.sh 1.3.1
# ============================================

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}[INFO]${NC} $1"; }
ok()    { echo -e "${GREEN}[✅]${NC} $1"; }
warn()  { echo -e "${YELLOW}[⚠️]${NC} $1"; }
error() { echo -e "${RED}[❌]${NC} $1"; exit 1; }

# ========== 参数检查 ==========
if [ -z "$1" ]; then
    echo ""
    echo -e "${YELLOW}EasyDB 一键发版脚本${NC}"
    echo ""
    echo "用法: ./release.sh <版本号>"
    echo ""
    echo "示例:"
    echo "  ./release.sh 1.3.1    # 补丁版本"
    echo "  ./release.sh 1.4.0    # 新功能版本"
    echo ""
    echo "当前已有 tag:"
    git tag -l "v*" --sort=-v:refname | head -5
    echo ""
    exit 1
fi

VERSION="$1"
TAG="v${VERSION}"

echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  EasyDB 发版 ${TAG}${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# ========== 前置检查 ==========

# 检查版本号格式
if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    error "版本号格式错误: $VERSION (应为 x.y.z，如 1.3.1)"
fi

# 检查 tag 是否已存在
if git tag -l "$TAG" | grep -q "$TAG"; then
    warn "Tag $TAG 已存在，将覆盖（本地 + 远程）"
    git tag -d "$TAG" 2>/dev/null || true
    git push origin :refs/tags/"$TAG" 2>/dev/null || true
fi

# 获取当前分支
CURRENT_BRANCH=$(git branch --show-current)
info "当前分支: $CURRENT_BRANCH"

# 检查工作区是否干净
if [ -n "$(git status --porcelain)" ]; then
    error "工作区有未提交的修改，请先提交或暂存。"
fi
ok "工作区干净"

# ========== 确认操作 ==========
echo ""
info "即将执行以下操作:"
echo "  1. 切换到 main 分支"
echo "  2. 合并 $CURRENT_BRANCH → main"
echo "  3. 打 tag $TAG"
echo "  4. 推送 main + $TAG 到 GitHub"
echo "  5. GitHub Actions 自动构建打包"
echo "  6. 切回 $CURRENT_BRANCH"
echo ""
read -p "确认发版 $TAG？(y/N) " confirm
if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
    warn "已取消"
    exit 0
fi

echo ""

# ========== 执行发版 ==========

# 1. 切换到 main
info "切换到 main 分支..."
git checkout main
git pull origin main
ok "已切换到 main 并拉取最新"

# 2. 合并开发分支
info "合并 $CURRENT_BRANCH → main..."
if ! git merge "$CURRENT_BRANCH" --no-ff -m "release: $TAG - 合并 $CURRENT_BRANCH"; then
    error "合并失败！请手动解决冲突后重试。"
fi
ok "合并成功"

# 3. 打 tag（-f 强制覆盖）
info "创建 tag $TAG..."
git tag -a "$TAG" -m "Release $TAG" -f
ok "Tag $TAG 已创建"

# 4. 推送
info "推送到 GitHub..."
git push origin main --tags --force
ok "推送成功"

# 5. 切回开发分支
info "切回 $CURRENT_BRANCH..."
git checkout "$CURRENT_BRANCH"
ok "已切回 $CURRENT_BRANCH"

# ========== 完成 ==========
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  🎉 发版 $TAG 完成！${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  📦 GitHub Actions 正在构建..."
echo "  👉 https://github.com/qingwz1994/easydb/actions"
echo ""
echo "  构建完成后，前往 Release 页面发布:"
echo "  👉 https://github.com/qingwz1994/easydb/releases"
echo ""
