# EasyDB

跨平台数据库管理工具，提供连接管理、对象浏览、SQL 执行（含智能补全）、数据迁移与同步能力。首版支持 MySQL，架构上预留多数据库扩展。

## 技术架构

```
┌─────────────────────────────────────────────────────┐
│                   Desktop UI (React)                │
│           Ant Design · Monaco Editor · Zustand      │
│                 Vite · TypeScript · React 19         │
├──────────────────────── HTTP ────────────────────────┤
│                 Kernel (Kotlin / JVM 21)             │
│  ┌──────────┐ ┌──────────┐ ┌────────────────────┐   │
│  │ Launcher │ │   API    │ │  Common (接口层)    │   │
│  │ (Ktor)   │ │ Protocol │ │  ConnectionManager  │   │
│  └────┬─────┘ └──────────┘ │  TaskManager        │   │
│       │                    │  SqlExecutionService │   │
│  ┌────┴───────────────┐    └────────────────────┘   │
│  │    Drivers (SPI)   │                              │
│  │ ┌────────────────┐ │    ┌───────────┐             │
│  │ │  MySQL Driver  │ │    │  Tunnel   │             │
│  │ │ · Connection   │ │    │  (SSH)    │             │
│  │ │ · Metadata     │ │    └───────────┘             │
│  │ │ · Migration    │ │                              │
│  │ │ · Sync         │ │    ┌───────────────────┐     │
│  │ │ · Dialect      │ │    │ 预留模块 (空壳)    │     │
│  │ └────────────────┘ │    │ · compare-engine  │     │
│  │ ┌────────────────┐ │    │ · metadata        │     │
│  │ │ PostgreSQL ... │ │    │ · dialect          │     │
│  │ │   (预留扩展)    │ │    │ · task-center      │     │
│  │ └────────────────┘ │    └───────────────────┘     │
│  └────────────────────┘                              │
└─────────────────────────────────────────────────────┘
            │                    │
     ┌──────┴──────┐      ┌─────┴─────┐
     │ ~/.easydb/  │      │   MySQL   │
     │ 本地持久化   │      │  Server   │
     └─────────────┘      └───────────┘
```

### 核心设计

- **SPI 驱动架构**：`DatabaseAdapter` 接口定义统一的连接、元数据、方言、迁移、同步能力，每种数据库实现一套 Driver
- **前后端分离**：Kernel 通过 HTTP API 暴露能力，UI 通过 `fetch` 调用
- **Monorepo 管理**：根目录 `package.json` 管理前端 workspace，`kernel/` 内部用 Gradle 多模块管理

## 技术栈

| 层 | 技术 | 版本 |
|----|------|------|
| **前端框架** | React + TypeScript | 19.x / 5.9 |
| **UI 组件库** | Ant Design | 6.x |
| **代码编辑器** | Monaco Editor | 4.7 |
| **状态管理** | Zustand | 5.x |
| **构建工具** | Vite | 8.x |
| **路由** | React Router | 7.x |
| **后端语言** | Kotlin | 1.9.22 |
| **HTTP 框架** | Ktor | 2.3.7 |
| **JVM** | OpenJDK | 21 |
| **构建系统** | Gradle (Kotlin DSL) | 8.x |
| **序列化** | kotlinx.serialization | 1.6.2 |
| **SSH 隧道** | Apache Mina SSHD | 0.2.16 |
| **数据库驱动** | MySQL Connector/J (JDBC) | — |

## 目录结构

```
easydb/
├── README.md                        # 本文件
├── dev.sh                           # 开发环境管理脚本（启动/停止/构建/日志）
├── package.json                     # NPM workspace 根配置
│
├── apps/
│   └── desktop-ui/                  # 前端应用
│       ├── src/
│       │   ├── components/          # 通用组件（ConfirmModal, LogPanel, StepBar...）
│       │   ├── layouts/             # 布局组件（MainLayout 侧边导航 + 内容区）
│       │   ├── pages/               # 页面模块
│       │   │   ├── connection/      #   连接管理（创建/编辑/测试连接）
│       │   │   ├── workbench/       #   数据库工作台（对象浏览/数据预览）
│       │   │   ├── sql-editor/      #   SQL 编辑器（Monaco + 智能补全 + 执行结果）
│       │   │   ├── migration/       #   数据迁移（向导式多步操作）
│       │   │   ├── sync/            #   数据同步
│       │   │   ├── task-center/     #   任务中心（进度/耗时/日志/历史）
│       │   │   └── settings/        #   设置
│       │   ├── services/            # API 调用封装
│       │   ├── stores/              # Zustand 状态管理
│       │   ├── types/               # TypeScript 类型定义
│       │   └── utils/               # 工具函数
│       └── package.json
│
├── kernel/                          # 后端内核（Kotlin / Gradle 多模块）
│   ├── common/                      # 🔵 公共接口与核心服务
│   │   └── src/.../common/
│   │       ├── Interfaces.kt        #   核心接口：DatabaseAdapter, ConnectionAdapter,
│   │       │                        #   MetadataAdapter, MigrationAdapter, SyncAdapter...
│   │       ├── Models.kt            #   数据模型：ConnectionConfig, MigrationConfig...
│   │       ├── DataModels.kt        #   元数据模型：DatabaseInfo, TableInfo, ColumnInfo...
│   │       ├── ConnectionManager.kt #   连接生命周期管理
│   │       ├── ConnectionStore.kt   #   连接配置持久化（~/.easydb/connections.json）
│   │       ├── TaskManager.kt       #   异步任务管理（迁移/同步任务的生命周期）
│   │       ├── SqlExecutionService.kt #  SQL 执行服务
│   │       └── SqlHistoryStore.kt   #   SQL 历史持久化
│   │
│   ├── api/                         # 🔵 HTTP 协议定义
│   │   └── src/.../api/
│   │       ├── ConnectionProtocol.kt #  连接相关请求/响应
│   │       ├── MetadataProtocol.kt  #   元数据相关请求/响应
│   │       └── TaskProtocol.kt      #   任务相关请求/响应
│   │
│   ├── drivers/                     # 🔵 数据库驱动（SPI 实现）
│   │   └── mysql/                   #   MySQL 驱动（首版核心）
│   │       ├── MysqlConnectionAdapter.kt  # 连接管理（JDBC）
│   │       ├── MysqlDatabaseAdapter.kt    # 驱动入口，聚合所有适配器
│   │       ├── MysqlDatabaseSession.kt    # 会话封装
│   │       ├── MysqlMetadataAdapter.kt    # 元数据查询（SHOW DATABASES/TABLES/COLUMNS）
│   │       ├── MysqlDialectAdapter.kt     # SQL 方言（标识符引用、DDL 生成）
│   │       ├── MysqlMigrationAdapter.kt   # 数据迁移（DDL + 批量 INSERT）
│   │       └── MysqlSyncAdapter.kt        # 数据同步（INSERT/UPSERT + bulk load 优化）
│   │
│   ├── launcher/                    # 🔵 启动器（HTTP 服务入口）
│   │   └── src/.../launcher/
│   │       ├── Main.kt              #   Ktor 服务启动
│   │       ├── Routes.kt            #   路由注册
│   │       ├── Handlers.kt          #   请求处理器
│   │       └── ServiceRegistry.kt   #   服务注册中心（驱动发现）
│   │
│   ├── tunnel/                      # 🔵 SSH 隧道
│   │   └── SshTunnelManager.kt      #   SSH 端口转发管理
│   │
│   ├── compare-engine/              # ⚪ 结构比对引擎（预留）
│   ├── metadata/                    # ⚪ 元数据引擎（预留）
│   ├── dialect/                     # ⚪ 方言引擎（预留）
│   ├── sync-engine/                 # ⚪ 同步引擎（预留）
│   ├── migration-engine/            # ⚪ 迁移引擎（预留）
│   ├── task-center/                 # ⚪ 任务中心（预留）
│   │
│   ├── build.gradle.kts             #   根构建脚本
│   ├── settings.gradle.kts          #   模块注册
│   └── gradle.properties            #   版本号统一管理
│
├── scripts/                         # 构建与启动脚本
│   └── build/
│       ├── build-kernel.sh          #   内核构建
│       └── start-kernel.sh          #   内核启动
│
└── docs/                            # 文档与临时数据
```

> 🔵 已实现  ⚪ 预留模块（空 build.gradle.kts，待后续版本填充）

## 核心能力

### SQL 编辑器
- **智能补全**：表名、字段名、SQL 关键字、MySQL 函数
- 输入 `FROM ` 后提示当前库所有表，输入 `表名.` 提示字段
- 上下文感知：自动识别 FROM/JOIN 中的表并提示其字段
- 支持选中部分执行、⌘+Enter 快捷执行

### 数据同步性能
- **写入策略分层**：首次导入用 INSERT，增量用 UPSERT（`ON DUPLICATE KEY UPDATE`）
- **bulk load 优化**：同步期间 `unique_checks=0`、`foreign_key_checks=0`
- **JDBC 优化**：`rewriteBatchedStatements=true`（多值 INSERT 合并）
- **动态 batch**：普通表 5000，大表（>10 万行）10000
- 实测：190 万行同步从 48 分→5 分 25 秒（9 倍提速）

### 任务中心
- 实时耗时显示（运行中任务自动计时）
- 任务日志自动刷新
- 取消状态正确显示（不再误标为已完成）

## 快速开始

### 环境要求

- **JDK 21+**（推荐 OpenJDK 21）
- **Node.js 18+**
- **npm**

### 启动开发环境

```bash
./dev.sh start      # 一键启动内核 + 前端
```

启动后访问 http://localhost:5173

### 常用命令

| 命令 | 说明 |
|------|------|
| `./dev.sh start` | 启动内核 + 前端 |
| `./dev.sh stop` | 停止全部 |
| `./dev.sh restart` | 重启全部 |
| `./dev.sh build` | 仅构建内核 |
| `./dev.sh rebuild` | 构建 + 重启全部（**改完 Kotlin 代码后用这个**） |
| `./dev.sh status` | 查看运行状态 |
| `./dev.sh logs` | 查看内核日志 |
| `./dev.sh logs ui` | 查看前端日志 |

#### 单独管理

```bash
./dev.sh kernel start|stop|restart   # 内核
./dev.sh ui start|stop|restart       # 前端
```

## 服务信息

| 服务 | 端口 | 地址 |
|------|------|------|
| 内核 (Ktor) | 18080 | http://127.0.0.1:18080 |
| 前端 (Vite) | 5173 | http://localhost:5173 |

### 本地数据

```
~/.easydb/
├── connections.json    # 连接配置
└── sql-history.json    # SQL 执行历史（最多 500 条）
```

## 产品规划

| 版本 | 目标 |
|------|------|
| **v1.0** (当前) | MySQL 连接管理 → 工作台 → SQL 编辑器（智能补全） → 数据迁移 → 同步（性能优化） → 任务中心 |
| v1.1 | 连接分组/收藏、结果导出、任务重试 |
| v2.0 | PostgreSQL 支持、结构比对增强、跨库迁移 |

## 技术文档

| 文档 | 说明 |
|------|------|
| [mysql-sync-performance-prd.md](docs/mysql-sync-performance-prd.md) | MySQL 同步性能优化 PRD |
| [mysql-sync-performance-td.md](docs/mysql-sync-performance-td.md) | MySQL 同步性能优化技术设计 |

## License

Private
