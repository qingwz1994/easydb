package com.easydb.backup

import com.easydb.common.*
import com.easydb.drivers.mysql.MysqlConnectionAdapter
import java.io.File
import java.util.zip.GZIPInputStream
import java.util.zip.ZipFile

class RestoreService(
    private val storageDir: File = File(System.getProperty("user.home"), ".easydb")
) {

    fun execute(config: RestoreConfig, connectionConfig: ConnectionConfig, reporter: TaskReporter): TaskResult {
        val adapter = MysqlConnectionAdapter()
        val restoreSession = adapter.open(connectionConfig)
        val restoreConn = restoreSession.getJdbcConnection()
        restoreConn.autoCommit = true

        val backupFile = File(config.backupFilePath)
        val validator = RestoreValidator(backupFile)
        val inspectResult = validator.inspect()
        
        if (!inspectResult.fileValid) {
            throw Exception("Backup file is invalid: \${inspectResult.warnings.joinToString()}")
        }
        
        val manifest = inspectResult.manifest

        try {
            // Setup target database
            if (config.strategy == "overwrite_existing") {
                restoreConn.createStatement().use { it.execute("DROP DATABASE IF EXISTS `${config.targetDatabase}`") }
            }
            
            ZipFile(backupFile).use { zip ->
                fun extractString(entryName: String): String? {
                    val entry = zip.getEntry(entryName) ?: return null
                    return zip.getInputStream(entry).bufferedReader().use { it.readText() }
                }

                reporter.onProgress(5, "Preparing target database")
                val dbDdl = extractString("schema/000_database.sql")
                if (dbDdl != null) {
                    val replacedDdl = dbDdl.replace("`${manifest.database}`", "`${config.targetDatabase}`")
                    restoreConn.createStatement().use { it.execute(replacedDdl) }
                } else {
                    restoreConn.createStatement().use { 
                        it.execute("CREATE DATABASE IF NOT EXISTS `${config.targetDatabase}`")
                    }
                }
                
                restoreConn.createStatement().use { it.execute("USE `${config.targetDatabase}`") }
                
                // Disable constraints
                restoreConn.createStatement().use { it.execute("SET FOREIGN_KEY_CHECKS=0") }
                restoreConn.createStatement().use { it.execute("SET UNIQUE_CHECKS=0") }

                // Determine tables to restore (apply selectedTables filter for both structure and data)
                val tablesToRestore = if (config.selectedTables.isEmpty()) manifest.tables
                    else manifest.tables.filter { config.selectedTables.contains(it.tableName) }

                val mode = config.mode ?: "restore_all"
                val restoreStructure = mode == "restore_all" || mode == "structure_only"
                val restoreData = mode == "restore_all" || mode == "data_only"

                // 1. Tables structure (restore_all: 5-15%, structure_only: 5-40%, data_only: skip)
                if (restoreStructure) {
                    val structureProgressEnd = if (mode == "structure_only") 40 else 15
                    val structureProgressRange = structureProgressEnd - 5
                    val totalTables = tablesToRestore.size
                    for ((idx, table) in tablesToRestore.withIndex()) {
                        if (reporter.isCancelled()) throw Exception("Task cancelled")
                        val p = 5 + (structureProgressRange * (idx + 1)) / totalTables.coerceAtLeast(1)
                        reporter.onProgress(p, "Restoring table structure: ${table.tableName}")
                        reporter.onLog("INFO", "Creating table ${table.tableName}...")

                        // Drop existing table first to handle partial restore leftovers
                        restoreConn.createStatement().use { it.execute("DROP TABLE IF EXISTS `${table.tableName}`") }

                        val tableDdl = extractString(table.ddlFile)
                        if (tableDdl != null) {
                            restoreConn.createStatement().use { it.execute(tableDdl) }
                        }
                    }
                } else {
                    reporter.onLog("INFO", "Skipping structure restore (data_only mode)")
                }

                // 2. Table Data (restore_all: 15-85%, data_only: 5-95%, structure_only: skip)
                if (restoreData) {
                    val dataProgressStart = if (mode == "data_only") 5 else 15
                    val dataProgressEnd = if (mode == "data_only") 95 else 85
                    val dataProgressRange = dataProgressEnd - dataProgressStart
                    val totalTablesForData = tablesToRestore.size
                var sqlCount = 0
                var globalSqlCount = 0L
                for ((tableIdx, table) in tablesToRestore.withIndex()) {
                    if (reporter.isCancelled()) throw Exception("Task cancelled")
                    val tableProgressBase = dataProgressStart + (dataProgressRange * tableIdx) / totalTablesForData.coerceAtLeast(1)
                    val tableProgressRangePerTable = dataProgressRange / totalTablesForData.coerceAtLeast(1)
                    reporter.onProgress(tableProgressBase, "Restoring table data: ${table.tableName}")
                    reporter.onLog("INFO", "Restoring table ${table.tableName}...")
                    sqlCount = 0
                    var tableSqlCount = 0L
                    for ((fileIdx, dataFile) in table.dataFiles.withIndex()) {
                        if (reporter.isCancelled()) throw Exception("Task cancelled")
                        val entry = zip.getEntry(dataFile) ?: continue
                        val inputStream = if (dataFile.endsWith(".gz")) GZIPInputStream(zip.getInputStream(entry)) else zip.getInputStream(entry)
                        inputStream.bufferedReader(Charsets.UTF_8).use { reader ->
                            var currentSql = StringBuilder()
                            var line = reader.readLine()
                            while (line != null) {
                                if (reporter.isCancelled()) throw Exception("Task cancelled")
                                val trimmed = line.trim()
                                if (trimmed == ";" || trimmed.endsWith(";")) {
                                    // SQL statement ended
                                    if (trimmed.endsWith(";") && trimmed != ";") {
                                        // Line like "(xxx);", append without the trailing ;
                                        currentSql.append(trimmed.dropLast(1)).append("\n")
                                    }
                                    if (currentSql.isNotBlank()) {
                                        restoreConn.createStatement().use { it.execute(currentSql.toString()) }
                                        sqlCount++
                                        tableSqlCount++
                                        globalSqlCount++
                                        if (sqlCount % 100 == 0) {
                                            // Update progress within table based on file index + batch count
                                            val fileProgress = (fileIdx * 100 + sqlCount.coerceAtMost(500)) / (table.dataFiles.size * 500 + 1)
                                            val p = tableProgressBase + (tableProgressRangePerTable * fileProgress) / 100
                                            reporter.onProgress(p.coerceAtMost(84), "Restoring table ${table.tableName}: $sqlCount batches...")
                                            reporter.onLog("INFO", "Table ${table.tableName}: inserted $sqlCount batches...")
                                        }
                                    }
                                    currentSql = StringBuilder()
                                } else {
                                    currentSql.append(line).append("\n")
                                }
                                line = reader.readLine()
                            }
                            // Handle any remaining SQL without trailing ;
                            if (currentSql.isNotBlank()) {
                                try {
                                    restoreConn.createStatement().use { it.execute(currentSql.toString()) }
                                } catch (e: Exception) {
                                    // ignore partial error for trailing spaces
                                }
                            }
                        }
                    }
                    // Mark this table complete
                    val tableCompleteProgress = dataProgressStart + (dataProgressRange * (tableIdx + 1)) / totalTablesForData.coerceAtLeast(1)
                    reporter.onProgress(tableCompleteProgress.coerceAtMost(dataProgressEnd - 1), "Table ${table.tableName} restored")
                    reporter.onLog("INFO", "Table ${table.tableName} restored ($tableSqlCount batches)")
                }
                } else {
                    reporter.onLog("INFO", "Skipping data restore (structure_only mode)")
                }

                // 3. Routines (restore_all: 85-90%, structure_only: 40-50%, data_only: skip)
                val routines = manifest.objects.filter { it.type == "procedure" || it.type == "function" }
                if (restoreStructure && routines.isNotEmpty()) {
                    val routinesProgressStart = if (mode == "structure_only") 40 else 85
                    val routinesProgressEnd = if (mode == "structure_only") 50 else 90
                    reporter.onProgress(routinesProgressStart, "Restoring routines")
                    reporter.onLog("INFO", "Restoring ${routines.size} routines...")
                    for ((idx, obj) in routines.withIndex()) {
                        if (reporter.isCancelled()) throw Exception("Task cancelled")
                        val p = routinesProgressStart + ((routinesProgressEnd - routinesProgressStart) * (idx + 1)) / routines.size.coerceAtLeast(1)
                        reporter.onProgress(p, "Restoring routine: ${obj.name}")

                        // Drop existing routine first
                        val dropSql = if (obj.type == "procedure") {
                            "DROP PROCEDURE IF EXISTS `${obj.name}`"
                        } else {
                            "DROP FUNCTION IF EXISTS `${obj.name}`"
                        }
                        restoreConn.createStatement().use { it.execute(dropSql) }

                        val ddl = extractString(obj.ddlFile)
                        if (ddl != null) {
                            val replaced = ddl.replace("`${manifest.database}`", "`${config.targetDatabase}`")
                            restoreConn.createStatement().use { it.execute(replaced) }
                        }
                    }
                }

                // 4. Views (restore_all: 90-95%, structure_only: 50-60%, data_only: skip)
                val views = manifest.objects.filter { it.type == "view" }
                if (restoreStructure && views.isNotEmpty()) {
                    val viewsProgressStart = if (mode == "structure_only") 50 else 90
                    val viewsProgressEnd = if (mode == "structure_only") 60 else 95
                    reporter.onProgress(viewsProgressStart, "Restoring views")
                    reporter.onLog("INFO", "Restoring ${views.size} views...")
                    for ((idx, obj) in views.withIndex()) {
                        if (reporter.isCancelled()) throw Exception("Task cancelled")
                        val p = viewsProgressStart + ((viewsProgressEnd - viewsProgressStart) * (idx + 1)) / views.size.coerceAtLeast(1)
                        reporter.onProgress(p, "Restoring view: ${obj.name}")

                        // Drop existing view first
                        restoreConn.createStatement().use { it.execute("DROP VIEW IF EXISTS `${obj.name}`") }

                        val ddl = extractString(obj.ddlFile)
                        if (ddl != null) {
                            val replaced = ddl.replace("`${manifest.database}`", "`${config.targetDatabase}`")
                            restoreConn.createStatement().use { it.execute(replaced) }
                        }
                    }
                }

                // 5. Triggers (restore_all: 95-100%, structure_only: 60-100%, data_only: skip)
                val triggers = manifest.objects.filter { it.type == "trigger" }
                if (restoreStructure && triggers.isNotEmpty()) {
                    val triggersProgressStart = if (mode == "structure_only") 60 else 95
                    reporter.onProgress(triggersProgressStart, "Restoring triggers")
                    reporter.onLog("INFO", "Restoring ${triggers.size} triggers...")
                    for ((idx, obj) in triggers.withIndex()) {
                        if (reporter.isCancelled()) throw Exception("Task cancelled")
                        val p = triggersProgressStart + ((100 - triggersProgressStart) * (idx + 1)) / triggers.size.coerceAtLeast(1)
                        reporter.onProgress(p, "Restoring trigger: ${obj.name}")

                        // Drop existing trigger first
                        restoreConn.createStatement().use { it.execute("DROP TRIGGER IF EXISTS `${obj.name}`") }

                        val ddl = extractString(obj.ddlFile)
                        if (ddl != null) {
                            val replaced = ddl.replace("`${manifest.database}`", "`${config.targetDatabase}`")
                            restoreConn.createStatement().use { it.execute(replaced) }
                        }
                    }
                }

                // Restore constraints
                restoreConn.createStatement().use { it.execute("SET FOREIGN_KEY_CHECKS=1") }
                restoreConn.createStatement().use { it.execute("SET UNIQUE_CHECKS=1") }

                reporter.onProgress(100, "Restore completed")

                return TaskResult(
                    success = true,
                    successCount = manifest.tables.size + manifest.objects.size,
                    payload = mapOf(
                        "database" to config.targetDatabase
                    )
                )
            }
        } finally {
            try { restoreSession.close() } catch (e: Exception) {}
        }
    }
}
