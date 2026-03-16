# EasyDB 开发环境

## 快速开始

```bash
cd easydb
./dev.sh start      # 一键启动内核 + 前端
```

启动后访问 http://localhost:5173

## 命令一览

| 命令 | 说明 |
|------|------|
| `./dev.sh start` | 启动内核 + 前端 |
| `./dev.sh stop` | 停止全部 |
| `./dev.sh restart` | 重启全部 |
| `./dev.sh build` | 仅构建内核 (`clean shadowJar`) |
| `./dev.sh rebuild` | 构建 + 重启全部（**改完代码后用这个**） |
| `./dev.sh status` | 查看运行状态 |
| `./dev.sh logs` | 查看内核日志 (tail -f) |
| `./dev.sh logs ui` | 查看前端日志 |

### 单独管理

```bash
./dev.sh kernel start     # 只启动内核
./dev.sh kernel stop      # 只停内核
./dev.sh kernel restart   # 只重启内核

./dev.sh ui start         # 只启动前端
./dev.sh ui stop          # 只停前端
./dev.sh ui restart       # 只重启前端
```

## 服务端口

| 服务 | 端口 | 地址 |
|------|------|------|
| 内核 (Ktor) | 18080 | http://127.0.0.1:18080 |
| 前端 (Vite) | 5173 | http://localhost:5173 |

## 日志文件

| 文件 | 说明 |
|------|------|
| `.kernel.log` | 内核运行日志 |
| `.ui.log` | 前端开发服务器日志 |
| `.kernel.pid` | 内核进程 PID（自动管理） |
| `.ui.pid` | 前端进程 PID（自动管理） |

## 数据存储

连接配置和 SQL 历史持久化到本地：

```
~/.easydb/
├── connections.json    # 连接配置
└── sql-history.json    # SQL 执行历史（最多 500 条）
```

## 常见场景

```bash
# 首次使用
./dev.sh start

# 改了内核 Kotlin 代码
./dev.sh rebuild

# 改了前端 React 代码（热更新，无需重启）
# 直接保存文件即可

# 启动失败？查看日志
./dev.sh logs

# 端口被占用？
./dev.sh stop && ./dev.sh start
```

## 项目结构

```
easydb/
├── dev.sh                  # ← 开发环境管理脚本
├── kernel/                 # Kotlin 内核 (Gradle)
│   └── launcher/build/libs/launcher-1.0.0-SNAPSHOT-all.jar
└── apps/desktop-ui/        # React 前端 (Vite)
```
