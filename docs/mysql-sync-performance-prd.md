# EasyDB MySQL 数据同步性能优化 PRD

## 1. 基本信息
- 文档名称：MySQL→MySQL 数据同步性能优化 PRD
- 版本：V1.0
- 日期：2026-03-16
- 适用模块：`kernel/drivers/mysql` / `sync`

---

## 2. 背景

当前 EasyDB 已支持 MySQL→MySQL 的库级数据同步。  
在一次实际任务中：

- 任务名称：`同步 energy → 721db`
- 开始时间：**2026-03-16 17:56:46**
- 任务耗时：**48分58秒**
- 日志显示原计划同步 **147 张表**
- 实际落到目标库的表数为 **92 张**
- 日志末尾出现 **“同步已被取消”**
- 但任务状态显示为 **completed**

对目标库 `721db` 的本地统计结果：

- 表数：**92**
- 估算总行数：**1,902,765**
- 总大小：**632.89 MB**
- 空表数：**52**

核心大表：

| 表名 | 估算行数 | 大小 |
|---|---:|---:|
| `data_quota_hours` | 1,779,167 | 583.89 MB |
| `data_quota_day` | 54,483 | 21.09 MB |
| `data_quota_day_copy1` | 52,099 | 21.09 MB |

结论：**绝大部分耗时集中在 `data_quota_hours`。**

---

## 3. 现状

当前同步逻辑：

1. 源端执行 `SELECT * FROM table`
2. 目标端执行批量 `REPLACE INTO`
3. 单线程串行同步全部表
4. `batchSize = 1000`
5. 每批 `executeBatch()` 后 `commit()`

---

## 4. 问题定义

当前方案在中大数据量场景下存在以下问题：

1. 大表同步耗时过长
2. 首次全量导入仍使用 `REPLACE INTO`
3. 索引/约束检查未做 bulk load 优化
4. 批次过小，事务提交频繁
5. 无大表专项策略
6. 任务取消与完成状态不一致

---

## 5. 核心瓶颈分析

### 5.1 `REPLACE INTO` 是主瓶颈

当前所有表统一使用 `REPLACE INTO`。  
其代价高于普通 `INSERT`，冲突时接近 `DELETE + INSERT`，会放大：

- 行级写入成本
- 主键/唯一索引维护成本
- 二级索引更新成本

对 `data_quota_hours` 这类百万级大表，这是当前**第一瓶颈**。

### 5.2 未关闭 `UNIQUE_CHECKS`

当前批量写入时未显式执行：

```sql
SET SESSION unique_checks = 0;
```

对大表，尤其索引体量较大的表，会持续发生唯一索引检查。  
这会进一步放大 `REPLACE INTO` 的写入成本，是当前**第二瓶颈**。

### 5.3 未关闭 `FOREIGN_KEY_CHECKS`

当前批量写入时未显式执行：

```sql
SET SESSION foreign_key_checks = 0;
```

若目标表存在外键约束，则每行写入都存在引用完整性校验开销。  
该项是否构成核心瓶颈，取决于目标表是否定义了外键，属于**条件成立时的重要瓶颈**。

### 5.4 批次过小

当前 `batchSize = 1000`。  
对于 `177万+` 行的大表，意味着需要大量 `executeBatch()` 和 `commit()`，事务与网络往返成本较高。

### 5.5 单线程串行

当前全部表串行处理，小表无法快速并发完成，总时长被大表完全拖住。

### 5.6 缺少首次导入与增量同步的策略区分

当前不区分：

- 目标表不存在/为空
- 目标表已有数据

统一走 `REPLACE INTO`，导致首次导入场景策略明显偏重。

### 5.7 任务状态不一致

日志显示任务被取消，但状态被标记为 `completed`。  
会误导用户判断同步是否真正成功。

---

## 6. 优化目标

### 6.1 业务目标

提升 EasyDB 在 MySQL→MySQL 中大数据量同步场景下的性能和可解释性。

### 6.2 性能目标

以 `721db` 对应数据集为参考：

1. 总耗时较当前版本下降 **50%+**
2. `data_quota_hours` 同步耗时下降 **60%+**
3. 首次全量导入显著快于当前方案

### 6.3 稳定性目标

1. 任务状态与日志保持一致
2. 取消/失败/完成可明确区分
3. 会话级优化参数可恢复，不污染后续连接

---

## 7. 非目标

本期不处理：

1. CDC / 实时增量同步
2. 跨数据库类型同步
3. 分布式调度
4. 全量一致性校验平台

---

## 8. 产品方案

### 8.1 同步模式拆分

#### 模式 A：首次全量导入

适用条件：

- 目标表不存在
- 或目标表为空

策略：

- 使用 `INSERT INTO`
- 会话级关闭：
  - `unique_checks`
  - `foreign_key_checks`
- 提升 batch 大小
- 启用 JDBC batch 优化参数

#### 模式 B：增量/覆盖同步

适用条件：

- 目标表已存在数据
- 需要按唯一键更新

策略：

- 优先使用 `INSERT ... ON DUPLICATE KEY UPDATE`
- `REPLACE INTO` 降级为显式可选策略，不再作为默认

### 8.2 大表专项处理

对满足以下条件的表识别为大表：

- 行数 > 50 万
- 或大小 > 200MB

策略：

1. 提升 batch 到 10000
2. 单独记录详细进度
3. 后续为分段同步和专项导入预留能力

### 8.3 任务状态修复

优化任务结束逻辑：

- 已取消任务不得再标记为 `completed`
- UI 正确显示 `cancelled`
- 日志与状态保持一致

---

## 9. 详细修改方案

### 9.1 SQL 策略调整

#### 当前

```sql
REPLACE INTO table (...) VALUES (...)
```

#### 调整后

- 首次导入：`INSERT INTO`
- 增量同步：`INSERT ... ON DUPLICATE KEY UPDATE`
- 仅在用户明确指定时才允许 `REPLACE INTO`

### 9.2 会话级 bulk load 优化

同步前：

```sql
SET SESSION unique_checks = 0;
SET SESSION foreign_key_checks = 0;
SET SESSION autocommit = 0;
```

同步后恢复：

```sql
SET SESSION unique_checks = 1;
SET SESSION foreign_key_checks = 1;
SET SESSION autocommit = 1;
```

要求：

- 必须使用 `SESSION` 级别
- 必须在 `finally` 中恢复

### 9.3 批次优化

- 默认 batch：`5000`
- 大表 batch：`10000`

### 9.4 大表识别

新增预扫描逻辑：

- 从 `information_schema.tables` 获取行数/大小
- 标记大表并切换专项策略

### 9.5 状态修复

需要修复：

1. 取消后不得再 `markCompleted`
2. 中途取消时状态保持 `cancelled`
3. 若仅完成部分表，应明确呈现部分完成/已取消

---

## 10. 涉及模块

1. `kernel/drivers/mysql/src/main/kotlin/com/easydb/drivers/mysql/MysqlSyncAdapter.kt`
2. `kernel/drivers/mysql/src/main/kotlin/com/easydb/drivers/mysql/MysqlConnectionAdapter.kt`
3. `kernel/common/src/main/kotlin/com/easydb/common/TaskManager.kt`
4. `kernel/launcher/src/main/kotlin/com/easydb/launcher/Handlers.kt`

---

## 11. 验收标准

### 功能

- 可区分首次导入与增量同步
- 可配置同步策略
- 取消状态正确显示

### 性能

- `721db` 对应数据集整体耗时下降 50%+
- 大表耗时下降 60%+
- 批处理提交次数显著下降

### 稳定性

- 会话参数恢复正常
- 取消/异常后连接可继续使用
- 无明显状态错乱

---

## 12. 实施优先级

### P0

1. ✅ 首次全量导入改 `INSERT INTO`
2. ✅ 增加 `unique_checks=0`
3. ✅ 增加 `foreign_key_checks=0`
4. ✅ batch 从 1000 提升到 5000（大表 10000）
5. ✅ 修复取消状态误标记完成

### P1

1. ✅ 增加 `rewriteBatchedStatements=true`
2. ✅ 大表识别与专项 batch（>10万行自动切换 batch=10000）
3. ✅ 增量模式支持 `ON DUPLICATE KEY UPDATE`

### P2

1. 小表并发
2. 大表分段同步
3. 同步后校验
4. 性能面板

---

## 13. 结论

当前 MySQL 同步性能问题的根因不是单纯“数据量大”，而是：

1. 大表仍默认使用 `REPLACE INTO`
2. 未关闭 `UNIQUE_CHECKS`
3. 未关闭 `FOREIGN_KEY_CHECKS`（有外键时）
4. batch 过小
5. 缺少首次导入/增量导入分层策略
6. 任务状态管理存在一致性缺陷

本期应优先围绕：

- SQL 策略切换
- bulk load 会话优化
- 大表专项优化
- 状态修复

进行改造。
