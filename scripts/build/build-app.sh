#!/bin/bash
# EasyDB 打包脚本 — 构建 macOS .app
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$SCRIPT_DIR/../.."
DESKTOP_UI_DIR="$ROOT_DIR/apps/desktop-ui"
KERNEL_DIR="$ROOT_DIR/kernel"
RESOURCES_DIR="$DESKTOP_UI_DIR/src-tauri/resources"

echo "🔨 EasyDB 打包开始..."
echo ""

# 1. 构建 Kotlin 内核
echo "📦 [1/3] 构建 Kotlin 内核..."
cd "$KERNEL_DIR"
./gradlew :launcher:shadowJar --quiet
JAR_FILE=$(ls -t launcher/build/libs/*-all.jar 2>/dev/null | head -1)
if [ -z "$JAR_FILE" ]; then
  echo "❌ 内核 JAR 构建失败"
  exit 1
fi
mkdir -p "$RESOURCES_DIR"
cp "$JAR_FILE" "$RESOURCES_DIR/easydb-kernel.jar"
echo "  ✅ 内核已复制到 resources/easydb-kernel.jar"

# 2. 安装前端依赖
echo ""
echo "📦 [2/3] 安装前端依赖..."
cd "$ROOT_DIR"
npm install --quiet 2>/dev/null

# 3. 构建 Tauri 桌面应用
echo ""
echo "📦 [3/3] 构建 Tauri 桌面应用..."
cd "$DESKTOP_UI_DIR"
npm run tauri:build 2>&1

echo ""
echo "✅ 打包完成！"
echo ""
echo "产物位置："
echo "  .app: $DESKTOP_UI_DIR/src-tauri/target/release/bundle/macos/"
echo "  .dmg: $DESKTOP_UI_DIR/src-tauri/target/release/bundle/dmg/"
