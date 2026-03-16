# EasyDB 桌面应用打包指南

## 前置条件

| 依赖 | 版本 | 安装方式 |
|------|------|----------|
| JDK | 21+ | `brew install openjdk@21` |
| Node.js | 18+ | `brew install node` |
| Rust | 1.77+ | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |

## 打包

### 一键打包

```bash
bash scripts/build/build-app.sh
```

此命令会依次执行：
1. 构建 Kotlin 内核（`shadowJar`）→ 复制到 `src-tauri/resources/easydb-kernel.jar`
2. 安装前端依赖
3. 构建前端 + 编译 Rust + 打包 `.app` 和 `.dmg`

### 产物位置

| 产物 | 路径 |
|------|------|
| EasyDB.app | `apps/desktop-ui/src-tauri/target/release/bundle/macos/EasyDB.app` |
| DMG 安装包 | `apps/desktop-ui/src-tauri/target/release/bundle/dmg/EasyDB_1.0.0_aarch64.dmg` |

### 耗时参考

| 场景 | 耗时 |
|------|------|
| 首次构建（编译 470+ Rust 依赖） | 约 3-5 分钟 |
| 增量构建（仅改前端/内核代码） | 约 30 秒 |

## 清理

```bash
# 清理 Tauri 编译产物（释放磁盘空间，约 1-2GB）
cd apps/desktop-ui/src-tauri && cargo clean

# 清理打包用的内核 JAR 副本
rm -rf apps/desktop-ui/src-tauri/resources/easydb-kernel.jar

# 清理 Kotlin 内核编译产物
cd kernel && ./gradlew clean

# 清理前端编译产物
rm -rf apps/desktop-ui/dist
```

## 安装与运行

### 直接运行 .app

```bash
open apps/desktop-ui/src-tauri/target/release/bundle/macos/EasyDB.app
```

### 通过 DMG 安装

双击 `.dmg` 文件，将 EasyDB 拖入 Applications 文件夹。

### macOS 安全提示

首次打开可能提示「无法验证开发者」：

1. 打开「系统设置 → 隐私与安全性」
2. 找到 EasyDB 的提示，点击「仍要打开」

## 目录说明

```
apps/desktop-ui/src-tauri/         # Tauri 项目目录（需提交到 Git）
├── Cargo.toml                     # Rust 依赖配置
├── tauri.conf.json                # Tauri 打包配置（窗口大小、bundle 目标等）
├── capabilities/                  # 权限配置
├── icons/                         # 应用图标
├── src/                           # Rust 源码（内核启动器）
│   ├── lib.rs                     # Tauri 入口 + 内核 JAR 启动逻辑
│   └── main.rs                    # 主函数
├── resources/                     # ⚠️ 打包时生成，不提交
│   └── easydb-kernel.jar          # 内核 JAR（由 build-app.sh 复制）
└── target/                        # ⚠️ Rust 编译产物，不提交（1-2GB）
    └── release/bundle/            # 打包产物
```

## 开发模式

开发时不需要打包，使用 `dev.sh` 即可：

```bash
./dev.sh start     # 启动内核 + 前端（浏览器访问 http://localhost:5173）
./dev.sh rebuild   # 改完 Kotlin 代码后重构建
```
