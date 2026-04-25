<p align="center">
  <img src="apps/desktop-ui/src-tauri/icons/icon.png" width="128" height="128" alt="EasyDB Logo">
</p>

<h1 align="center">EasyDB</h1>

<p align="center">
  <strong>开源、跨平台的数据库管理工具</strong><br>
  连接管理 · 对象浏览 · SQL 编辑器 · 数据追踪 · DDL 审计 · 结构对比 · 数据迁移 · 数据同步 · 数据导出 · 备份恢复 · 任务中心 · 安全连接
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg" alt="License"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey" alt="Platform">
  <img src="https://img.shields.io/badge/database-MySQL-4479A1?logo=mysql&logoColor=white" alt="MySQL">
  <img src="https://img.shields.io/badge/version-1.5.0--dev-green" alt="Version">
</p>

<p align="center">
  <a href="README.md">🇬🇧 English</a>
</p>

---

## ✨ 功能特性

### 🔌 连接管理
- 支持 MySQL 连接的创建、编辑、测试、分组、搜索
- **SSH 隧道**：JSch 本地端口转发，真正绕过跳板机访问内网数据库（密码/私钥双认证）
- **SSL/TLS 加密**：支持 CA 证书验证、客户端双向认证（PEM 格式直读）
- **凭据加密存储**：连接密码 AES-256-GCM 加密落盘，机器 ID 绑定密钥；API 响应自动脱敏

### 🗂️ 数据库工作台
- 对象树分类浏览：表 · 视图 · 存储过程 · 函数 · 触发器
- 数据预览（支持 WHERE 筛选 + 列排序 + 字段自动补全）
- 视图支持：数据预览（只读）+ DDL 查看
- 存储过程/函数/触发器 DDL 查看
- 表结构设计器、DDL 查看

### ⚙️ 存储过程执行
- 工作台对象树右键菜单入口（⚙ 执行存储过程 / ⨍ 调用函数）
- 自动加载参数元数据（IN/OUT/INOUT 方向、数据类型）
- 类型感知输入组件（整数、小数、布尔、日期、文本）
- 每个参数支持 NULL 复选框
- OUT 参数值执行后回显
- 多结果集 Tab 形式展示
- 函数返回值单独显示
- 执行耗时统计
- ProcedureAdapter 架构，支持扩展 PostgreSQL / 达梦

### ✏️ SQL 编辑器
- 基于 Monaco Editor，支持语法高亮
- **智能补全**：表名、字段名、SQL 关键字、MySQL 函数
- 上下文感知：自动识别 FROM/JOIN 子句中的表并提示字段
- 支持选中部分执行、`⌘+Enter` 快捷执行
- **SQL 历史**：可按库开关、可搜索、一键重新执行（可在设置中开关）

### 🔍 数据追踪（CDC）
- 实时 Binlog 事件采集：INSERT / UPDATE / DELETE（行级）
- 回放模式：对历史 Binlog 文件进行回放，可配置起止位点
- 服务端分页：后端全量存储事件、前端按需拉取
- UPDATE 事件列级 Diff 视图，Diff 模式可隐藏未变列
- 回滚 SQL 生成：将 DML 反向生成 DELETE/INSERT/UPDATE，可下载 `.sql`
- 正向重放 SQL 生成
- **DDL 审计**：从 Binlog QUERY 事件采集表级 DDL
  - 5 种 DDL 类型：`CREATE TABLE` / `ALTER TABLE` / `DROP TABLE` / `TRUNCATE TABLE` / `RENAME TABLE`
  - 风险分级：low / medium / high / critical 四档
  - 保留原始 SQL，完整审计轨迹
  - DDL 独立详情面板（仅查看，不支持回滚/重放）
  - 事件列表支持 DDL 筛选，统计面板展示 DDL 计数
  - 选中包含 DDL 事件时回滚/重放按钮自动跳过并提示

### 🆚 结构对比
- 两个 MySQL 实例之间的表级结构对比
- 扩展对象对比：视图 · 存储过程 · 函数 · 触发器
- DDL 归一化：对比前屏蔽 DEFINER、注释、多余空白
- 非表对象支持双栏 DDL 对比展示

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
- 导出为 SQL/ZIP 文件，适用于查看、交付和兼容处理
- 支持导出取消，自动清理半成品文件
- 支持导出文件下载

### 💾 数据库备份与恢复
- **备份功能**
  - 创建标准备份包 (.edbkp)，包含结构、数据和校验信息
  - 支持三种备份模式：完整备份、仅结构、仅数据
  - 表级选择：可选择特定表或整库备份
  - 一致性快照备份，记录 Binlog 位点支持 PITR
  - SHA-256 校验确保数据完整性
  - 自定义输出路径、预估体积、进度跟踪
- **恢复功能**
  - 从标准备份包恢复数据库内容
  - 文件预检：校验完整性、SHA-256、一致性状态
  - 支持两种恢复策略：恢复到新库、覆盖已有库
  - 支持三种恢复模式：完整恢复、仅结构、仅数据
  - 表级选择：可选择恢复特定表
  - 实时进度、日志输出、支持取消

### 📥 SQL 文件导入
- 原生文件选择器（Tauri 调用系统对话框）
- 拖拽上传 / 路径手动输入
- 流式导入，大文件无内存压力
- 执行统计：成功、失败、跳过计数
- 进度追踪、日志查看、支持取消

### 📋 任务中心
- 迁移/同步/导出/导入任务统一管理
- 实时进度、耗时、日志查看
- 任务取消、筛选、历史记录

### ⚙️ 设置中心
- 深色 / 浅色 / 跟随系统主题切换
- 存储管理：磁盘占用可视化、分类清理（导出文件 / 日志 / 备份文件 / 任务记录）
- 备份文件管理：列表查看、单独删除、按天数批量清理
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
│  ┌──────────────────────────────────────────────┐│
│  │           SSH/SSL 安全层                     ││
│  │  CredentialCipher · SshTunnelManager · JDBC  ││
│  └──────────────────────────────────────────────┘│
└─────────────────────────────────────────────────┘
         │                           │
    ┌────┴────┐                ┌─────┴─────┐
    │~/.easydb│                │  MySQL DB  │
    │ AES加密  │                │  via SSH   │
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
│   ├── tunnel/              # SSH 隧道（JSch）
│   └── api/                 # 协议定义
├── scripts/                 # 构建脚本
└── docs/                    # 项目文档
```

## 🗺️ 产品路线

| 版本 | 状态 | 目标 |
|------|------|------|
| v1.0 | ✅ 已发布 | MySQL 连接管理 → 工作台 → SQL 编辑器 → 数据迁移 → 同步 → 任务中心 |
| v1.1.0 | ✅ 已发布 | 连接搜索/筛选、数据导出、任务日志优化 |
| v1.2.0 | ✅ 已发布 | 数据预览筛选/排序/分页、行内编辑、结构对比、多标签页 |
| v1.3.0 | ✅ 已发布 | 深色模式、SQL 文件导入、存储管理、查询收藏、快捷键体系、导出取消优化、自动更新检查、视图/存储过程/函数/触发器浏览 |
| v1.3.1 | ✅ 已发布 | **数据库备份恢复**（完整备份、表级选择、一致性快照、SHA-256 校验、恢复策略、恢复模式） |
| v1.3.2 | ✅ 已发布 | 备份文件管理、**存储过程执行**、参数面板 |
| v1.4.0 | ✅ 已发布 | **安全连接**（凭据 AES-256-GCM 加密、SSH 隧道真正接入、SSL/TLS 参数接入 JDBC） |
| **v1.5.0** | ✅ 已发布 | **SQL 历史**（按库浏览开关、搜索、重执行）· **结构对比扩展**（视图/过程/函数/触发器，DDL 归一化）· **DDL 审计**（Binlog 表级 DDL 采集、5 类 DDL、风险分级、原始 SQL 保留） |

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

## 🙏 致谢

感谢 [LinuxDo](https://linux.do/) 社区每一位朋友的支持！
