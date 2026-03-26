# 贡献指南

感谢你对 EasyDB 的关注！欢迎提交 Issue 和 Pull Request。

## 开发环境要求

| 工具 | 版本 |
|------|------|
| Node.js | 18+ |
| JDK | 21+ |
| Rust | latest stable |
| Gradle | 8+ (已内置 wrapper) |

## 项目结构

```
easydb/
├── apps/desktop-ui/     # 前端（React + TypeScript + Tauri）
├── kernel/              # 后端内核（Kotlin + Ktor）
│   ├── common/          # 公共接口
│   ├── launcher/        # HTTP 服务入口
│   └── drivers/mysql/   # MySQL 驱动适配
├── scripts/             # 构建脚本
└── docs/                # 项目文档
```

## 本地开发

```bash
# 1. 安装前端依赖
npm install

# 2. 启动开发环境（内核 + 前端）
./dev.sh start

# 3. 或分别启动
cd kernel && ./gradlew :launcher:run        # 后端
cd apps/desktop-ui && npm run dev           # 前端
```

## 提交规范

提交信息格式：`类型(范围): 描述`

| 类型 | 说明 |
|------|------|
| `feat` | 新功能 |
| `fix` | 修复 bug |
| `docs` | 文档变更 |
| `refactor` | 重构 |
| `style` | 代码风格调整 |
| `test` | 测试相关 |
| `chore` | 构建/CI 相关 |

示例：
```
feat(工作台): 添加数据预览筛选功能
fix(连接管理): 修复连接断开后状态未更新
```

## Pull Request 流程

1. Fork 仓库
2. 创建功能分支：`git checkout -b feat/your-feature`
3. 提交代码，确保通过编译检查：
   - 前端：`cd apps/desktop-ui && npx tsc --noEmit`
   - 后端：`cd kernel && ./gradlew build -x test`
4. 提交 PR 到 `dev/v1.2` 分支
5. 等待代码审核

## 许可证

本项目采用 [AGPL-3.0](LICENSE) 许可证。提交代码即表示你同意以相同许可证发布你的贡献。
