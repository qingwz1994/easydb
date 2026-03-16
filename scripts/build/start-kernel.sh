#!/bin/bash
# 启动内核服务（本地开发用）
cd "$(dirname "$0")/../kernel"
echo "正在构建并启动 EasyDB 内核..."
./gradlew :launcher:run
