package com.easydb.backup

import kotlinx.serialization.Serializable

@Serializable
data class BackupConfig(
    val connectionId: String,
    val database: String,
    val mode: String = "full",              // full | structure_only | data_only
    val tables: List<String> = emptyList(), // 为空表示整库
    val includeRoutines: Boolean = true,
    val includeViews: Boolean = true,
    val includeTriggers: Boolean = true,
    val compression: String = "gzip",       // none | gzip
    val chunkSizeBytes: Long = 64L * 1024 * 1024,
    val outputPath: String? = null          // 自定义输出路径，为空使用默认 ~/.easydb/backups/
)

@Serializable
data class BackupEstimateResult(
    val database: String,
    val selectedTables: Int,
    val estimatedRows: Long,
    val estimatedBytes: Long,
    val largeTableCount: Int,
    val warnings: List<String> = emptyList()
)

@Serializable
data class BackupManifest(
    val formatVersion: Int,
    val appVersion: String,
    val dbType: String,
    val serverVersion: String,
    val database: String,
    val mode: String,
    val charset: String? = null,
    val collation: String? = null,
    val startedAt: String,
    val completedAt: String? = null,
    val consistency: String,                // snapshot | best_effort
    val binlogFile: String? = null,
    val binlogPosition: Long? = null,
    val tables: List<BackupTableEntry>,
    val objects: List<BackupObjectEntry>,
    val warnings: List<String> = emptyList()
)

@Serializable
data class BackupTableEntry(
    val tableName: String,
    val ddlFile: String,
    val rowEstimate: Long,
    val dataFiles: List<String>,
    val checksum: String? = null
)

@Serializable
data class BackupObjectEntry(
    val name: String,
    val type: String,                   // "view" | "procedure" | "function" | "trigger"
    val ddlFile: String,
    val sha256: String? = null
)

@Serializable
data class RestoreInspectResult(
    val manifest: BackupManifest,
    val fileValid: Boolean,
    val checksumValid: Boolean,
    val targetDatabaseExists: Boolean? = null,
    val warnings: List<String> = emptyList()
)

@Serializable
data class RestoreConfig(
    val targetConnectionId: String,
    val backupFilePath: String,
    val targetDatabase: String,
    val mode: String = "restore_all",           // restore_all | structure_only | data_only
    val strategy: String = "restore_to_new",    // restore_to_new | overwrite_existing
    val selectedTables: List<String> = emptyList()
)
