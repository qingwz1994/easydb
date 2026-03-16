# EasyDB MySQL 数据同步性能优化技术设计（TD）

## 1. 目标

基于现有 `MysqlSyncAdapter` 的实现，完成以下改造：

1. 区分首次导入与增量同步
2. 降低大表同步耗时
3. 引入会话级 bulk load 优化
4. 修复任务状态不一致问题
5. 为后续并发/分段同步预留结构

---

## 2. 现有代码位置

### 2.1 核心同步逻辑
- `kernel/drivers/mysql/src/main/kotlin/com/easydb/drivers/mysql/MysqlSyncAdapter.kt`

### 2.2 MySQL 连接参数
- `kernel/drivers/mysql/src/main/kotlin/com/easydb/drivers/mysql/MysqlConnectionAdapter.kt`

### 2.3 任务状态管理
- `kernel/common/src/main/kotlin/com/easydb/common/TaskManager.kt`

### 2.4 任务启动逻辑
- `kernel/launcher/src/main/kotlin/com/easydb/launcher/Handlers.kt`

---

## 3. 现状实现摘要

当前 `MysqlSyncAdapter`：

1. 列出源库表
2. 逐表串行执行
3. 若目标表不存在则复制 DDL
4. 同步数据时：
   - `SELECT * FROM sourceTable`
   - `REPLACE INTO targetTable`
   - `batchSize = 1000`
   - 每批 `executeBatch()` + `commit()`

当前问题：

- 首次导入与增量更新没有策略区分
- 目标会话未做 bulk load 参数优化
- 无大表识别
- 取消状态最终可能被覆盖为 completed

---

## 4. 设计原则

1. **兼容优先**：不破坏现有 API 入参的可用性
2. **默认更快**：首次导入走轻量策略
3. **可渐进升级**：后续可演进到并发/分段同步
4. **安全恢复**：会话级参数必须恢复
5. **状态可信**：日志与状态一致

---

## 5. 总体设计

### 5.1 策略分层

为同步过程增加“写入策略”判定：

- `INSERT`
- `UPSERT`
- `REPLACE`

默认规则：

1. 目标表不存在 → `INSERT`
2. 目标表存在但为空 → `INSERT`
3. 目标表存在且有数据 → `UPSERT`
4. `REPLACE` 仅在显式指定或兜底时使用

### 5.2 大表识别

根据 `information_schema.tables` 统计字段识别大表：

- `table_rows > 500000`
- 或 `(data_length + index_length) > 200MB`

大表使用更大 batch，并输出更明确日志。

### 5.3 bulk load 会话优化

在目标连接写入期间：

```sql
SET SESSION unique_checks = 0;
SET SESSION foreign_key_checks = 0;
SET SESSION autocommit = 0;
```

结束后恢复：

```sql
SET SESSION unique_checks = 1;
SET SESSION foreign_key_checks = 1;
SET SESSION autocommit = 1;
```

---

## 6. 详细设计

## 6.1 `MysqlSyncAdapter` 改造

### 6.1.1 新增判定方法

建议新增：

- `targetTableExists(...)`
- `targetTableRowEstimate(...)`
- `chooseSyncMode(...)`
- `isLargeTable(...)`
- `applyBulkLoadSessionSettings(...)`
- `restoreSessionSettings(...)`

### 6.1.2 同步流程调整

伪代码：

```kotlin
for each table:
    ensure target table exists
    mode = chooseSyncMode(table)
    large = isLargeTable(table)
    apply bulk session settings
    try:
        syncTableData(mode, batchSize)
    finally:
        restore session settings
```

### 6.1.3 `syncTableData` 重构

当前：

```kotlin
REPLACE INTO ...
```

调整为：

```kotlin
when (mode) {
  INSERT -> INSERT INTO ...
  UPSERT -> INSERT INTO ... ON DUPLICATE KEY UPDATE ...
  REPLACE -> REPLACE INTO ...
}
```

### 6.1.4 UPSERT SQL 生成

列集合：

```sql
INSERT INTO t (c1, c2, c3)
VALUES (?, ?, ?)
ON DUPLICATE KEY UPDATE
  c1 = VALUES(c1),
  c2 = VALUES(c2),
  c3 = VALUES(c3)
```

注意：

- 可排除主键列不更新
- 或首版全部字段更新

### 6.1.5 batch 策略

- 默认表：`5000`
- 大表：`10000`

可先定义：

```kotlin
val defaultBatchSize = 5000
val largeTableBatchSize = 10000
```

---

## 6.2 `MysqlConnectionAdapter` 改造

当前连接参数：

- `connectTimeout`
- `socketTimeout`
- `useSSL=false`
- `allowPublicKeyRetrieval=true`
- `serverTimezone=UTC`
- `characterEncoding=UTF-8`

建议新增：

```kotlin
setProperty("rewriteBatchedStatements", "true")
setProperty("useServerPrepStmts", "true")
setProperty("cachePrepStmts", "true")
```

说明：

- 提升 batch 写入效率
- 由 JDBC 驱动帮助优化批量 SQL 执行

---

## 6.3 `TaskManager` / `Handlers` 状态修复

### 问题

当前 `markCompleted(taskId, duration)` 不校验任务是否已取消。

### 修改建议

#### `TaskManager.markCompleted`

增加保护：

```kotlin
if (current.status == "cancelled") return
```

#### `Handlers.kt`

在异步执行完成后：

- 若 `reporter.isCancelled()` 为 `true`
- 则不调用 `markCompleted`

必要时补充：

- `markCancelled(taskId, duration?)`

---

## 7. 推荐代码修改清单

## 7.1 文件一：`MysqlSyncAdapter.kt`

### 修改项

1. 增加表存在/空表判定
2. 增加同步模式枚举
3. 增加大表识别
4. 增加 bulk load session 参数设置
5. 重构 `syncTableData`
6. 将固定 `REPLACE INTO` 改为可切换
7. 调整 batch size

### 建议新增枚举

```kotlin
enum class SyncWriteMode {
    INSERT,
    UPSERT,
    REPLACE
}
```

---

## 7.2 文件二：`MysqlConnectionAdapter.kt`

### 修改项

新增 JDBC 参数：

```kotlin
rewriteBatchedStatements=true
useServerPrepStmts=true
cachePrepStmts=true
```

---

## 7.3 文件三：`TaskManager.kt`

### 修改项

1. `markCompleted()` 增加 cancelled 保护
2. 视情况新增 `markCancelledWithDuration()`
3. 让状态流转更严格

---

## 7.4 文件四：`Handlers.kt`

### 修改项

1. 任务执行结束前判断是否取消
2. 已取消时不再 `markCompleted`
3. 保证 UI 查询到的状态与日志一致

---

## 8. 数据与兼容性影响

### 8.1 数据语义差异

`REPLACE INTO` 与 `ON DUPLICATE KEY UPDATE` 并不完全等价：

- `REPLACE`：可能删后重建
- `UPSERT`：更新已有行

因此需要明确产品语义：

- 首次导入：优先 `INSERT`
- 增量同步：优先 `UPSERT`
- 删除再插入语义：仅显式启用 `REPLACE`

### 8.2 风险

1. 关闭 `unique_checks` 可能延后暴露唯一冲突
2. 关闭 `foreign_key_checks` 后恢复时不会自动回查历史写入
3. batch 过大可能带来内存上升

---

## 9. 测试方案

## 9.1 功能测试

1. 目标表不存在时可自动建表并导入
2. 目标表为空时走 `INSERT`
3. 目标表有数据时走 `UPSERT`
4. 可正常取消任务
5. 取消后状态应为 `cancelled`

## 9.2 性能测试

使用 `721db` 对应数据集验证：

1. 总耗时
2. `data_quota_hours` 单表耗时
3. batch 提交次数
4. 日志输出是否完整

## 9.3 回归测试

1. 小表同步正确性
2. 空表同步
3. 无主键表行为
4. 索引/DDL 保持不变

---

## 10. 建议实施顺序

### 第一步 ✅ 已完成（2026-03-16）

1. ✅ 调整 JDBC 参数（`rewriteBatchedStatements=true`，`cachePrepStmts=true`，`socketTimeout=0`）
2. ✅ batch 从 1000 提到 5000（大表 10000）
3. ✅ 修复取消状态（`markCompleted` 增加 cancelled 保护，新增 `markCancelled`）

### 第二步 ✅ 已完成（2026-03-16）

1. ✅ 增加 INSERT / UPSERT / REPLACE 三种模式
2. ✅ 首次导入默认走 INSERT
3. ✅ 增量场景默认走 UPSERT（`ON DUPLICATE KEY UPDATE`）

### 第三步 ✅ 已完成（2026-03-16）

1. ✅ 增加 bulk load session 设置（`unique_checks=0`，`foreign_key_checks=0`）
2. ✅ 增加大表识别（>10万行）
3. ✅ 大表专项 batch（10000）

### 第四步

1. 并发小表
2. 大表分段
3. 性能统计面板

---

## 11. 交付物

本期建议交付：

1. ✅ PRD 文档
2. ✅ 技术设计文档
3. ✅ 第一~三阶段代码改造：
   - ✅ JDBC 参数优化
   - ✅ batch 调整
   - ✅ 状态修复
   - ✅ INSERT/UPSERT/REPLACE 策略切换
   - ✅ bulk load session 设置
   - ✅ 大表识别与专项 batch

---

## 12. 结论

本次优化的核心不是“继续微调 REPLACE”，而是**把同步策略从单一路径改成分层路径**：

- 首次导入走 `INSERT`
- 增量同步走 `UPSERT`
- `REPLACE` 不再作为默认

同时配合：

- `unique_checks=0`
- `foreign_key_checks=0`
- 更大的 batch
- 更合理的状态流转

才能真正解决当前 MySQL 大表同步慢的问题。
