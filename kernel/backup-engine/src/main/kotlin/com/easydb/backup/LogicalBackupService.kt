package com.easydb.backup

import com.easydb.common.*
import com.easydb.drivers.mysql.MysqlConnectionAdapter
import com.easydb.drivers.mysql.MysqlMetadataAdapter
import java.io.File
import java.sql.Connection
import java.sql.ResultSet
import java.text.SimpleDateFormat
import java.util.Date
import java.util.UUID

class LogicalBackupService(
    private val storageDir: File = File(System.getProperty("user.home"), ".easydb")
) {
    private val metadataAdapter = MysqlMetadataAdapter()

    // 简洁专业的文件名格式：database_YYYYMMDD_HHMM.edbkp
    private val timestampFormat = SimpleDateFormat("yyyyMMdd_HHmm")
    
    fun execute(config: BackupConfig, connectionConfig: ConnectionConfig, reporter: TaskReporter): TaskResult {
        // Create dedicated connection for backup
        val adapter = MysqlConnectionAdapter()
        val backupSession = adapter.open(connectionConfig.copy(database = config.database))
        val backupConn = backupSession.getJdbcConnection()
        backupConn.isReadOnly = true

        // Consistent snapshot locking
        val snapshot = MysqlConsistentSnapshot.begin(backupConn)
        
        val backupsDir = if (config.outputPath?.isNotBlank() == true) {
            File(config.outputPath!!).apply { mkdirs() }
        } else {
            File(storageDir, "backups").apply { mkdirs() }
        }
        val timestamp = timestampFormat.format(Date())
        val workDir = File(backupsDir, "tmp_${UUID.randomUUID()}")
        
        val writer = BackupPackageWriter(workDir)
        
        try {
            val dbCharset = queryScalar(backupConn, "SELECT @@character_set_database") ?: "utf8mb4"
            val dbCollation = queryScalar(backupConn, "SELECT @@collation_database") ?: "utf8mb4_general_ci"
            val serverVersion = queryScalar(backupConn, "SELECT VERSION()") ?: "unknown"
            
            val dbDdl = "CREATE DATABASE IF NOT EXISTS `${config.database}` CHARACTER SET $dbCharset COLLATE $dbCollation;"
            writer.writeString("schema/000_database.sql", dbDdl)
            
            // Generate list of tables to backup
            val tablesToBackup = metadataAdapter.listTables(backupSession, config.database)
                .filter { it.type == "table" }
                .filter { config.tables.isEmpty() || config.tables.contains(it.name) }
                
            val tableEntries = mutableListOf<BackupTableEntry>()
            
            for ((idx, table) in tablesToBackup.withIndex()) {
                if (reporter.isCancelled()) throw Exception("Task cancelled by user")

                // Give table progress
                val baseProgress = (idx * 80) / tablesToBackup.size.coerceAtLeast(1)
                val tableProgressRange = 80 / tablesToBackup.size.coerceAtLeast(1)
                reporter.onProgress(baseProgress, "Exporting table: ${table.name}")

                // Save Schema
                val ddl = metadataAdapter.getDdl(backupSession, config.database, table.name)
                val ddlPath = "schema/010_tables/${table.name}.sql"
                writer.writeString(ddlPath, ddl)

                // Save Data (Streaming + chunking)
                val dataPaths = mutableListOf<String>()
                if (config.mode != "structure_only") {
                    dataPaths.addAll(
                        exportTableData(
                            backupConn, config.database, table.name, writer, reporter,
                            baseProgress, tableProgressRange, idx, tablesToBackup.size, table.rowCount ?: 0L
                        )
                    )
                }
                
                tableEntries.add(BackupTableEntry(
                    tableName = table.name,
                    ddlFile = ddlPath,
                    rowEstimate = table.rowCount ?: 0L,
                    dataFiles = dataPaths
                ))
            }
            
            // Save Routines, Views, Triggers
            val objectEntries = mutableListOf<BackupObjectEntry>()
            
            if (config.includeRoutines) {
                reporter.onProgress(85, "Exporting routines")
                val routines = metadataAdapter.listRoutines(backupSession, config.database)
                for (rt in routines) {
                    val ddl = metadataAdapter.getObjectDdl(backupSession, config.database, rt.name, rt.type.lowercase())
                    if (ddl.isNotEmpty()) {
                        val path = "schema/020_routines/${rt.name}.sql"
                        writer.writeString(path, ddl)
                        objectEntries.add(BackupObjectEntry(rt.name, rt.type.lowercase(), path))
                    }
                }
            }
            
            if (config.includeViews) {
                reporter.onProgress(90, "Exporting views")
                val views = metadataAdapter.listTables(backupSession, config.database).filter { it.type == "view" }
                for (v in views) {
                    val ddl = metadataAdapter.getDdl(backupSession, config.database, v.name)
                    if (ddl.isNotEmpty()) {
                        val path = "schema/030_views/${v.name}.sql"
                        writer.writeString(path, ddl)
                        objectEntries.add(BackupObjectEntry(v.name, "view", path))
                    }
                }
            }
            
            if (config.includeTriggers) {
                reporter.onProgress(95, "Exporting triggers")
                val triggers = metadataAdapter.listTriggers(backupSession, config.database)
                for (tg in triggers) {
                    val ddl = metadataAdapter.getObjectDdl(backupSession, config.database, tg.name, "trigger")
                    if (ddl.isNotEmpty()) {
                        val path = "schema/040_triggers/${tg.name}.sql"
                        writer.writeString(path, ddl)
                        objectEntries.add(BackupObjectEntry(tg.name, "trigger", path))
                    }
                }
            }
            
            // Build manifest and checksums
            val manifest = BackupManifest(
                formatVersion = 1,
                appVersion = "1.0",
                dbType = "mysql",
                serverVersion = serverVersion,
                database = config.database,
                mode = config.mode,
                charset = dbCharset,
                collation = dbCollation,
                startedAt = timestamp,
                completedAt = timestampFormat.format(Date()),
                consistency = snapshot.level,
                binlogFile = snapshot.binlogFile,
                binlogPosition = snapshot.binlogPos,
                tables = tableEntries,
                objects = objectEntries
            )
            
            writer.writeManifest(manifest)
            writer.writeChecksums()
            
            // Output package: 简洁专业命名 database_YYYYMMDD_HHMM.edbkp
            val zipFile = File(backupsDir, "${config.database}_$timestamp.edbkp")
            reporter.onProgress(98, "Packing ZIP archive")
            writer.packToZip(zipFile)
            
            reporter.onProgress(100, "Backup completed")
            
            return TaskResult(
                success = true,
                successCount = tableEntries.size + objectEntries.size,
                payload = mapOf(
                    "filePath" to zipFile.absolutePath,
                    "fileName" to zipFile.name,
                    "database" to config.database,
                    "manifestVersion" to "1",
                    "backupMode" to config.mode
                )
            )
            
        } finally {
            MysqlConsistentSnapshot.release(snapshot)
            try { backupSession.close() } catch (_: Exception) {}
            writer.cleanup()
        }
    }
    
    // --- Helper execution logic ---
    
    private fun queryScalar(conn: Connection, sql: String): String? {
        return try {
            conn.createStatement().use { stmt ->
                stmt.executeQuery(sql).use { rs ->
                    if (rs.next()) rs.getString(1) else null
                }
            }
        } catch (_: Exception) { null }
    }
    
    private fun exportTableData(
        conn: Connection,
        database: String,
        tableName: String,
        writer: BackupPackageWriter,
        reporter: TaskReporter,
        baseProgress: Int,
        progressRange: Int,
        tableIdx: Int,
        totalTables: Int,
        rowEstimate: Long
    ): List<String> {
        val dataPaths = mutableListOf<String>()
        var partIndex = 1
        var currentRows = 0L
        var totalRows = 0L
        
        val maxRowsPerChunk = 100_000L
        
        // STREAMING Mode for MySQL: we use Integer.MIN_VALUE for fetchSize
        // but since it's a generic JDBC approach we can use 1000 and ensure TYPE_FORWARD_ONLY
        conn.createStatement(ResultSet.TYPE_FORWARD_ONLY, ResultSet.CONCUR_READ_ONLY).use { stmt ->
            // Use Integer.MIN_VALUE to trigger MySQL's streaming result set and completely bypass JVM memory
            stmt.fetchSize = Integer.MIN_VALUE 
            stmt.queryTimeout = 14400 
            
            stmt.executeQuery("SELECT * FROM `$database`.`$tableName`").use { rs ->
                val meta = rs.metaData
                val colCount = meta.columnCount
                val cols = (1..colCount).joinToString(", ") { "`${meta.getColumnName(it)}`" }
                
                var dataWriter: BackupPackageWriter.DataWriter? = null
                var currentPath = ""
                var batchCount = 0
                
                fun openWriter() {
                    dataWriter?.close()
                    val formatStr = String.format("%03d", partIndex)
                    currentPath = "data/$tableName.part$formatStr.sql.gz"
                    dataWriter = writer.createGzipDataWriter(currentPath)
                    dataPaths.add(currentPath)
                    partIndex++
                    currentRows = 0
                    batchCount = 0
                }
                
                openWriter()
                
                while (rs.next()) {
                    if (reporter.isCancelled()) throw Exception("Task cancelled by user")
                    if (currentRows >= maxRowsPerChunk) {
                        dataWriter!!.write(";\n")
                        openWriter()
                    }

                    if (batchCount == 0) {
                        dataWriter!!.write("INSERT INTO `$tableName` ($cols) VALUES\n(")
                    } else {
                        dataWriter!!.write(",\n(")
                    }

                    for (i in 1..colCount) {
                        if (i > 1) dataWriter!!.write(", ")
                        val obj = rs.getObject(i)

                        val strVal = formatSqlValue(meta.getColumnType(i), obj, rs, i)
                        dataWriter!!.write(strVal)
                    }
                    dataWriter!!.write(")")

                    batchCount++
                    currentRows++
                    totalRows++

                    if (batchCount >= 500) {
                        dataWriter!!.write(";\n")
                        batchCount = 0
                    }

                    // Update progress every 10,000 rows
                    if (totalRows % 10_000 == 0L) {
                        val tableProgress = if (rowEstimate > 0) {
                            ((totalRows.toFloat() / rowEstimate) * progressRange).toInt().coerceAtMost(progressRange)
                        } else {
                            (progressRange * 0.5).toInt() // assume halfway if no estimate
                        }
                        reporter.onProgress(baseProgress + tableProgress, "Exporting table $tableName: $totalRows rows...")
                    }

                    if (totalRows % 50_000 == 0L) {
                        reporter.onLog("INFO", "Table $tableName: exported $totalRows rows...")
                    }
                }
                
                if (batchCount > 0) {
                    dataWriter!!.write(";\n")
                }
                
                dataWriter?.close()
            }
        }
        return dataPaths
    }
    
    private fun formatSqlValue(type: Int, obj: Any?, rs: ResultSet, colIdx: Int): String {
        if (obj == null) return "NULL"
        return when (type) {
            java.sql.Types.TINYINT, java.sql.Types.SMALLINT,
            java.sql.Types.INTEGER, java.sql.Types.BIGINT,
            java.sql.Types.FLOAT, java.sql.Types.REAL,
            java.sql.Types.DOUBLE, java.sql.Types.NUMERIC,
            java.sql.Types.DECIMAL, java.sql.Types.BIT, java.sql.Types.BOOLEAN -> obj.toString()
            java.sql.Types.BINARY, java.sql.Types.VARBINARY,
            java.sql.Types.LONGVARBINARY, java.sql.Types.BLOB -> {
                val bytes = rs.getBytes(colIdx)
                if (bytes == null) "NULL" else "X'" + bytes.joinToString("") { "%02X".format(it) } + "'"
            }
            else -> "'" + escapeSqlString(obj.toString()) + "'"
        }
    }
    
    private fun escapeSqlString(str: String): String {
        return str.replace("\\", "\\\\")
                  .replace("'", "''")
                  .replace("\r", "\\r")
                  .replace("\n", "\\n")
    }
}
