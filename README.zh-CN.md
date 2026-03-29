<p align="center">
  <img src="apps/desktop-ui/src-tauri/icons/icon.png" width="128" height="128" alt="EasyDB Logo">
</p>

<h1 align="center">EasyDB</h1>

<p align="center">
  <strong>开源、跨平台的数据库管理工具</strong><br>
  连接管理 · 对象浏览 · SQL 编辑器 · 数据迁移 · 数据同步 · 数据导出 · 任务中心 · 存储管理
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg" alt="License"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey" alt="Platform">
  <img src="https://img.shields.io/badge/database-MySQL-4479A1?logo=mysql&logoColor=white" alt="MySQL">
  <img src="https://img.shields.io/badge/version-1.3.0-green" alt="Version">
</p>

<p align="center">
  <a href="README.md">🇬🇧 English</a>
</p>

---

## ✨ 功能特性

### 🔌 连接管理
- 支持 MySQL 连接的创建、编辑、测试、分组、搜索
- SSH 隧道连接支持

### 🗂️ 数据库工作台
- 对象树浏览（数据库 → 表 → 列/索引）
- 数据预览（支持 WHERE 筛选 + 列排序 + 字段自动补全）
- 表结构查看、DDL 查看

### ✏️ SQL 编辑器
- 基于 Monaco Editor，支持语法高亮
- **智能补全**：表名、字段名、SQL 关键字、MySQL 函数
- 上下文感知：自动识别 FROM/JOIN 子句中的表并提示字段
- 支持选中部分执行、`⌘+Enter` 快捷执行

### 🚀 数据迁移
- 向导式操作：选择连接 → 选择对象 → 配置策略 → 确认执行
- 支持结构迁移 + 数据迁移

### 🔄 数据同步
- 表级实时同步，支持 INSERT / UPSERT 策略
- **性能优化**：190 万行同步 48 分 → 5 分 25 秒（9 倍提速）
  - `rewriteBatchedStatements` 批量写入
  - 同步期间关闭 `unique_checks` / `foreign_key_checks`
  - 动态 batch size（普通表 5000，大表 10000）

### 📤 数据导出
- 支持整库导出为 ZIP 压缩包（含建表 SQL + 数据 INSERT）
- 支持导出取消，自动清理半成品文件
- 支持导出文件下载

### 📥 SQL 文件导入
- 支持上传 .sql 文件执行导入
- 支持导入进度追踪和中途取消

### 📋 任务中心
- 迁移/同步/导出/导入任务统一管理
- 实时进度、耗时、日志查看
- 任务取消、筛选、历史记录

### ⚙️ 设置中心
- 深色 / 浅色 / 跟随系统主题切换
- 存储管理：磁盘占用可视化、分类清理（导出文件 / 日志 / 任务记录）
- 自动更新检查

## 🛠️ 技术架构

```
┌─────────────────────────────────────────────────┐
│            Desktop UI (React + TypeScript)       │
│        Ant Design · Monaco Editor · Zustand      │
├──────────────────── HTTP API ────────────────────┤
│              Kernel (Kotlin / JVM 21)            │
│  ┌──────────┐  ┌────────────┐  ┌──────────────┐ │
│  │ Launcher │  │   Common   │  │   Drivers    │ │
│  │  (Ktor)  │  │  接口 + 模型 │  │ MySQL (SPI) │ │
│  └──────────┘  └────────────┘  └──────────────┘ │
└─────────────────────────────────────────────────┘
         │                           │
    ┌────┴────┐                ┌─────┴─────┐
    │~/.easydb│                │  MySQL DB  │
    │本地持久化│                │           │
    └─────────┘                └───────────┘
```

| 层 | 技术 |
|----|------|
| 前端 | React 19 · TypeScript · Ant Design 6 · Monaco Editor · Zustand · Vite |
| 后端 | Kotlin · Ktor · kotlinx.serialization · JVM 21 |
| 桌面 | Tauri 2 (Rust) |
| 构建 | Gradle (Kotlin DSL) · npm workspace |

## 🚀 快速开始

### 环境要求

- JDK 21+
- Node.js 18+
- Rust (latest stable，Tauri 需要)

### 安装与启动

```bash
# 克隆仓库
git clone https://github.com/qingwz1994/easydb.git
cd easydb

# 安装前端依赖
npm install

# 一键启动开发环境（内核 + 前端）
./dev.sh start
```

启动后访问 http://localhost:5173

### 常用命令

| 命令 | 说明 |
|------|------|
| `./dev.sh start` | 启动内核 + 前端 |
| `./dev.sh stop` | 停止全部 |
| `./dev.sh restart` | 重启全部 |
| `./dev.sh rebuild` | 构建 + 重启（改完 Kotlin 代码后用这个） |
| `./dev.sh status` | 查看运行状态 |
| `./dev.sh logs` | 查看内核日志 |

### 打包构建

```bash
# 构建桌面应用（会生成 .app / .dmg / .exe）
cd apps/desktop-ui && npx tauri build
```

## 📁 项目结构

```
easydb/
├── apps/desktop-ui/         # 前端（React + Tauri）
│   ├── src/
│   │   ├── components/      # 通用组件
│   │   ├── pages/           # 页面模块
│   │   ├── services/        # API 封装
│   │   ├── stores/          # Zustand 状态管理
│   │   └── utils/           # 工具函数
│   └── src-tauri/           # Tauri 配置与原生层
├── kernel/                  # 后端内核（Kotlin 多模块）
│   ├── common/              # 接口定义 + 核心服务
│   ├── drivers/mysql/       # MySQL 驱动（连接/元数据/迁移/同步）
│   ├── launcher/            # HTTP 服务入口（Ktor）
│   ├── tunnel/              # SSH 隧道
│   └── api/                 # 协议定义
├── scripts/                 # 构建脚本
└── docs/                    # 项目文档
```

## 🗺️ 产品路线

| 版本 | 状态 | 目标 |
|------|------|------|
| v1.0 | ✅ 已完成 | MySQL 连接管理 → 工作台 → SQL 编辑器 → 数据迁移 → 同步 → 任务中心 |
| v1.1.0 | ✅ 已完成 | 连接搜索/筛选、数据导出、任务日志优化 |
| v1.2.0 | ✅ 已完成 | 数据预览筛选/排序/分页、行内编辑、结构对比、多标签页 |
| **v1.3.0** | 🚧 进行中 | 深色模式、SQL 文件导入、存储管理、查询收藏、快捷键体系、导出取消优化、自动更新检查 |
| v1.4.0 | 📋 规划中 | 视图/存储过程/函数浏览、数据库备份恢复 |
| v1.5.0 | 📋 规划中 | 慢查询分析、国际化 (i18n)、性能监控 |

## 🤝 参与贡献

欢迎提交 Issue 和 Pull Request！请先阅读 [贡献指南](CONTRIBUTING.md)。

## 📄 许可证

本项目基于 [GNU Affero General Public License v3.0](LICENSE) 开源。

- ✅ 允许个人使用、学习、修改
- ✅ 允许商业使用，但衍生作品必须以相同许可证开源
- ✅ 即使作为 SaaS 服务提供，也必须开源修改后的代码

```
Copyright (c) 2024-2026 EasyDB Contributors
```
