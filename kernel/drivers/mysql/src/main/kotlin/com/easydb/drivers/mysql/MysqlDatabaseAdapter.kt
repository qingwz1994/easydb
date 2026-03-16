package com.easydb.drivers.mysql

import com.easydb.common.*

/**
 * MySQL 数据库适配器
 * 统一入口，聚合所有 MySQL 子适配器
 */
class MysqlDatabaseAdapter : DatabaseAdapter {

    private val connectionAdapter = MysqlConnectionAdapter()
    private val metadataAdapter = MysqlMetadataAdapter()
    private val dialectAdapter = MysqlDialectAdapter()
    private val syncAdapter = MysqlSyncAdapter()
    private val migrationAdapter = MysqlMigrationAdapter()

    override fun dbType(): DbType = DbType.MYSQL

    override fun capabilities(): DatabaseCapabilities = DatabaseCapabilities(
        supportsTransactions = true,
        supportsSsh = true,
        supportsSsl = true,
        supportsViews = true,
        supportsStoredProcedures = false,  // V1.0 不支持
        supportsTriggers = false            // V1.0 不支持
    )

    override fun connectionAdapter(): ConnectionAdapter = connectionAdapter
    override fun metadataAdapter(): MetadataAdapter = metadataAdapter
    override fun dialectAdapter(): DialectAdapter = dialectAdapter
    override fun syncAdapter(): SyncAdapter = syncAdapter
    override fun migrationAdapter(): MigrationAdapter = migrationAdapter
}
