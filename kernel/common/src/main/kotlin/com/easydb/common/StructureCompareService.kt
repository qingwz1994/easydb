package com.easydb.common

/**
 * 数据结构对比服务
 * 分析两端数据库的表结构差异，生成让目标向源靠齐的 SQL
 */
class StructureCompareService {

    fun compare(
        sourceMetadata: MetadataAdapter,
        targetMetadata: MetadataAdapter,
        sourceDialect: DialectAdapter,
        sourceSession: DatabaseSession,
        targetSession: DatabaseSession,
        config: CompareConfig
    ): CompareResult {
        val options = config.options

        // 1. 获取两端表列表
        val sourceTables = sourceMetadata.listTables(sourceSession, config.sourceDatabase)
            .filter { it.type == "table" }
            .let { tables ->
                if (config.tables.isNotEmpty()) tables.filter { it.name in config.tables }
                else tables
            }
        val targetTables = targetMetadata.listTables(targetSession, config.targetDatabase)
            .filter { it.type == "table" }

        val sourceTableNames = sourceTables.map { it.name }.toSet()
        val targetTableNames = targetTables.map { it.name }.toSet()
        val allTableNames = (sourceTableNames + targetTableNames).sorted()

        // 2. 逐表对比
        val results = allTableNames.map { tableName ->
            when {
                tableName in sourceTableNames && tableName !in targetTableNames -> {
                    // 仅源存在 → CREATE TABLE
                    val ddl = sourceMetadata.getDdl(sourceSession, config.sourceDatabase, tableName)
                    TableCompareResult(
                        tableName = tableName,
                        status = "only_in_source",
                        risk = "low",
                        sql = ddl,
                        summary = "目标连接不存在该表，需创建"
                    )
                }

                tableName !in sourceTableNames && tableName in targetTableNames -> {
                    // 仅目标存在
                    val q = sourceDialect.quoteIdentifier(tableName)
                    TableCompareResult(
                        tableName = tableName,
                        status = "only_in_target",
                        risk = if (options.includeDropStatements) "high" else "low",
                        sql = if (options.includeDropStatements) "DROP TABLE $q;" else "",
                        summary = if (options.includeDropStatements)
                            "源连接不存在该表，已生成 DROP TABLE（高风险）"
                        else
                            "源连接不存在该表，未生成删除语句（可在对比选项中开启）"
                    )
                }

                else -> {
                    // 两端都存在 → 逐字段/索引对比
                    compareTables(
                        sourceMetadata, targetMetadata, sourceDialect,
                        sourceSession, targetSession,
                        config.sourceDatabase, config.targetDatabase,
                        tableName, options
                    )
                }
            }
        }

        val diffCount = results.count { it.status != "identical" }

        // 3. 对比非表对象（视图 / 存储过程 / 函数 / 触发器）
        val viewResults      = if (options.compareViews)      compareObjects(sourceMetadata, targetMetadata, sourceSession, targetSession, config.sourceDatabase, config.targetDatabase, "view")      else emptyList()
        val procedureResults = if (options.compareProcedures) compareObjects(sourceMetadata, targetMetadata, sourceSession, targetSession, config.sourceDatabase, config.targetDatabase, "procedure") else emptyList()
        val functionResults  = if (options.compareFunctions)  compareObjects(sourceMetadata, targetMetadata, sourceSession, targetSession, config.sourceDatabase, config.targetDatabase, "function")  else emptyList()
        val triggerResults   = if (options.compareTriggers)   compareObjects(sourceMetadata, targetMetadata, sourceSession, targetSession, config.sourceDatabase, config.targetDatabase, "trigger")   else emptyList()

        return CompareResult(
            sourceDatabase = config.sourceDatabase,
            targetDatabase = config.targetDatabase,
            totalTables = results.size,
            diffCount = diffCount,
            tables = results,
            views      = viewResults,
            procedures = procedureResults,
            functions  = functionResults,
            triggers   = triggerResults
        )
    }

    /**
     * 对比一类非表对象（视图/过程/函数/触发器）
     * objectType: "view" | "procedure" | "function" | "trigger"
     */
    private fun compareObjects(
        sourceMetadata: MetadataAdapter,
        targetMetadata: MetadataAdapter,
        sourceSession: DatabaseSession,
        targetSession: DatabaseSession,
        sourceDatabase: String,
        targetDatabase: String,
        objectType: String
    ): List<ObjectCompareResult> {
        val sourceNames: Set<String> = try {
            when (objectType) {
                "view"      -> sourceMetadata.listTables(sourceSession, sourceDatabase).filter { it.type == "view" }.map { it.name }
                "procedure" -> sourceMetadata.listRoutines(sourceSession, sourceDatabase).filter { it.type.equals("PROCEDURE", true) }.map { it.name }
                "function"  -> sourceMetadata.listRoutines(sourceSession, sourceDatabase).filter { it.type.equals("FUNCTION", true) }.map { it.name }
                "trigger"   -> sourceMetadata.listTriggers(sourceSession, sourceDatabase).map { it.name }
                else        -> emptyList()
            }.toSet()
        } catch (_: Exception) { emptySet() }

        val targetNames: Set<String> = try {
            when (objectType) {
                "view"      -> targetMetadata.listTables(targetSession, targetDatabase).filter { it.type == "view" }.map { it.name }
                "procedure" -> targetMetadata.listRoutines(targetSession, targetDatabase).filter { it.type.equals("PROCEDURE", true) }.map { it.name }
                "function"  -> targetMetadata.listRoutines(targetSession, targetDatabase).filter { it.type.equals("FUNCTION", true) }.map { it.name }
                "trigger"   -> targetMetadata.listTriggers(targetSession, targetDatabase).map { it.name }
                else        -> emptyList()
            }.toSet()
        } catch (_: Exception) { emptySet() }

        val allNames = (sourceNames + targetNames).sorted()

        return allNames.map { name ->
            val srcDdl = if (name in sourceNames) try { normalizeDdl(sourceMetadata.getObjectDdl(sourceSession, sourceDatabase, name, objectType)) } catch (_: Exception) { "" } else ""
            val tgtDdl = if (name in targetNames) try { normalizeDdl(targetMetadata.getObjectDdl(targetSession, targetDatabase, name, objectType)) } catch (_: Exception) { "" } else ""

            val status = when {
                name in sourceNames && name !in targetNames -> "only_in_source"
                name !in sourceNames && name in targetNames -> "only_in_target"
                srcDdl == tgtDdl                           -> "identical"
                else                                        -> "different"
            }

            val summary = when (status) {
                "only_in_source" -> "目标端不存在此${objectType}，可在目标端创建"
                "only_in_target" -> "源端不存在此${objectType}"
                "different"      -> "两端 DDL 定义不一致"
                else             -> "定义一致"
            }

            ObjectCompareResult(
                name       = name,
                objectType = objectType,
                status     = status,
                sourceDdl  = if (name in sourceNames) try { sourceMetadata.getObjectDdl(sourceSession, sourceDatabase, name, objectType) } catch (_: Exception) { "" } else "",
                targetDdl  = if (name in targetNames) try { targetMetadata.getObjectDdl(targetSession, targetDatabase, name, objectType) } catch (_: Exception) { "" } else "",
                summary    = summary
            )
        }
    }

    /**
     * DDL 归一化：消除因环境不同而产生的无意义差异
     * - 去掉 DEFINER（不同实例用户名必然不同）
     * - 去掉块注释和行注释
     * - 合并多余空白
     * - AUTO_INCREMENT 值归零（仅用于表，非表对象无影响）
     */
    private fun normalizeDdl(ddl: String): String {
        return ddl
            .replace(Regex("/\\*.*?\\*/", RegexOption.DOT_MATCHES_ALL), "")
            .replace(Regex("--[^\\n]*"), "")
            .replace(Regex("DEFINER\\s*=\\s*`[^`]*`@`[^`]*`"), "DEFINER=CURRENT_USER")
            .replace(Regex("AUTO_INCREMENT\\s*=\\s*\\d+"), "AUTO_INCREMENT=0")
            .replace(Regex("\\s+"), " ")
            .trim()
    }


    private fun compareTables(
        sourceMetadata: MetadataAdapter,
        targetMetadata: MetadataAdapter,
        dialect: DialectAdapter,
        sourceSession: DatabaseSession,
        targetSession: DatabaseSession,
        sourceDatabase: String,
        targetDatabase: String,
        tableName: String,
        options: CompareOptions
    ): TableCompareResult {
        val sourceDef = sourceMetadata.getTableDefinition(sourceSession, sourceDatabase, tableName)
        val targetDef = targetMetadata.getTableDefinition(targetSession, targetDatabase, tableName)

        val columnDiffs = compareColumns(sourceDef.columns, targetDef.columns, options)
        val indexDiffs = compareIndexes(
            sourceMetadata.getIndexes(sourceSession, sourceDatabase, tableName),
            targetMetadata.getIndexes(targetSession, targetDatabase, tableName)
        )

        val hasColumnDiff = columnDiffs.any { it.status != "identical" }
        val hasIndexDiff = indexDiffs.any { it.status != "identical" }
        val isIdentical = !hasColumnDiff && !hasIndexDiff

        val sql = if (!isIdentical) {
            generateAlterSql(dialect, tableName, sourceDef.columns, columnDiffs, indexDiffs, options)
        } else ""

        val summaryParts = mutableListOf<String>()
        val addedCols = columnDiffs.count { it.status == "added" }
        val removedCols = columnDiffs.count { it.status == "removed" }
        val modifiedCols = columnDiffs.count { it.status == "modified" }
        val addedIdx = indexDiffs.count { it.status == "added" }
        val removedIdx = indexDiffs.count { it.status == "removed" }
        if (addedCols > 0) summaryParts.add("新增 $addedCols 列")
        if (removedCols > 0) summaryParts.add("缺少 $removedCols 列")
        if (modifiedCols > 0) summaryParts.add("$modifiedCols 列定义不一致")
        if (addedIdx > 0) summaryParts.add("新增 $addedIdx 索引")
        if (removedIdx > 0) summaryParts.add("缺少 $removedIdx 索引")

        val hasDrops = removedCols > 0 || removedIdx > 0
        val risk = when {
            hasDrops && options.includeDropStatements -> "high"
            hasColumnDiff || hasIndexDiff -> "medium"
            else -> "low"
        }

        return TableCompareResult(
            tableName = tableName,
            status = if (isIdentical) "identical" else "different",
            risk = risk,
            columnDiffs = columnDiffs,
            indexDiffs = indexDiffs,
            sql = sql,
            summary = if (isIdentical) "结构一致" else summaryParts.joinToString("，")
        )
    }

    private fun compareColumns(
        sourceColumns: List<ColumnInfo>,
        targetColumns: List<ColumnInfo>,
        options: CompareOptions
    ): List<ColumnDiff> {
        val sourceMap = sourceColumns.associateBy { it.name }
        val targetMap = targetColumns.associateBy { it.name }
        val allNames = (sourceMap.keys + targetMap.keys).toList()
        // 按源端顺序优先
        val ordered = sourceColumns.map { it.name } + (targetMap.keys - sourceMap.keys)

        return ordered.distinct().map { name ->
            val src = sourceMap[name]
            val tgt = targetMap[name]
            when {
                src != null && tgt == null -> ColumnDiff(
                    columnName = name, status = "added",
                    sourceType = src.type,
                    sourceNullable = src.nullable,
                    sourceDefault = src.defaultValue,
                    sourceComment = src.comment,
                    details = "仅源连接存在"
                )

                src == null && tgt != null -> ColumnDiff(
                    columnName = name, status = "removed",
                    targetType = tgt.type,
                    targetNullable = tgt.nullable,
                    targetDefault = tgt.defaultValue,
                    targetComment = tgt.comment,
                    details = "仅目标连接存在"
                )

                src != null && tgt != null -> {
                    val diffs = mutableListOf<String>()
                    if (src.type != tgt.type) diffs.add("类型: ${src.type} → ${tgt.type}")
                    if (src.nullable != tgt.nullable) diffs.add("可空: ${src.nullable} → ${tgt.nullable}")
                    if (src.defaultValue != tgt.defaultValue) diffs.add("默认值: ${src.defaultValue} → ${tgt.defaultValue}")
                    if (!options.ignoreComment && src.comment != tgt.comment) diffs.add("注释不同")

                    if (diffs.isEmpty()) {
                        ColumnDiff(columnName = name, status = "identical",
                            sourceType = src.type, targetType = tgt.type)
                    } else {
                        ColumnDiff(
                            columnName = name, status = "modified",
                            sourceType = src.type, targetType = tgt.type,
                            sourceNullable = src.nullable, targetNullable = tgt.nullable,
                            sourceDefault = src.defaultValue, targetDefault = tgt.defaultValue,
                            sourceComment = src.comment, targetComment = tgt.comment,
                            details = diffs.joinToString("；")
                        )
                    }
                }

                else -> ColumnDiff(columnName = name, status = "identical")
            }
        }
    }

    private fun compareIndexes(
        sourceIndexes: List<IndexInfo>,
        targetIndexes: List<IndexInfo>
    ): List<IndexDiff> {
        val sourceMap = sourceIndexes.associateBy { it.name }
        val targetMap = targetIndexes.associateBy { it.name }
        val allNames = (sourceMap.keys + targetMap.keys).sorted()

        return allNames.map { name ->
            val src = sourceMap[name]
            val tgt = targetMap[name]
            when {
                src != null && tgt == null -> IndexDiff(
                    indexName = name, status = "added",
                    sourceColumns = src.columns,
                    sourceUnique = src.isUnique,
                    details = "仅源连接存在"
                )

                src == null && tgt != null -> IndexDiff(
                    indexName = name, status = "removed",
                    targetColumns = tgt.columns,
                    targetUnique = tgt.isUnique,
                    details = "仅目标连接存在"
                )

                src != null && tgt != null -> {
                    val diffs = mutableListOf<String>()
                    if (src.columns != tgt.columns) diffs.add("列: ${src.columns} → ${tgt.columns}")
                    if (src.isUnique != tgt.isUnique) diffs.add("唯一: ${src.isUnique} → ${tgt.isUnique}")

                    if (diffs.isEmpty()) {
                        IndexDiff(indexName = name, status = "identical",
                            sourceColumns = src.columns, targetColumns = tgt.columns)
                    } else {
                        IndexDiff(
                            indexName = name, status = "modified",
                            sourceColumns = src.columns, targetColumns = tgt.columns,
                            sourceUnique = src.isUnique, targetUnique = tgt.isUnique,
                            details = diffs.joinToString("；")
                        )
                    }
                }

                else -> IndexDiff(indexName = name, status = "identical")
            }
        }
    }

    private fun generateAlterSql(
        dialect: DialectAdapter,
        tableName: String,
        sourceColumns: List<ColumnInfo>,
        columnDiffs: List<ColumnDiff>,
        indexDiffs: List<IndexDiff>,
        options: CompareOptions
    ): String {
        val qt = dialect.quoteIdentifier(tableName)
        val statements = mutableListOf<String>()

        // 字段变更
        for (diff in columnDiffs) {
            val qc = dialect.quoteIdentifier(diff.columnName)
            when (diff.status) {
                "added" -> {
                    val colDef = buildColumnDefinition(dialect, diff.columnName, diff.sourceType!!, diff.sourceNullable, diff.sourceDefault, diff.sourceComment)
                    // 找到前一列用于 AFTER
                    val prevCol = findPreviousColumn(sourceColumns, diff.columnName)
                    val afterClause = if (prevCol != null) " AFTER ${dialect.quoteIdentifier(prevCol)}" else " FIRST"
                    statements.add("ALTER TABLE $qt ADD COLUMN $colDef$afterClause;")
                }

                "removed" -> {
                    if (options.includeDropStatements) {
                        statements.add("ALTER TABLE $qt DROP COLUMN $qc;")
                    }
                }

                "modified" -> {
                    val colDef = buildColumnDefinition(dialect, diff.columnName, diff.sourceType!!, diff.sourceNullable, diff.sourceDefault, diff.sourceComment)
                    statements.add("ALTER TABLE $qt MODIFY COLUMN $colDef;")
                }
            }
        }

        // 索引变更
        for (diff in indexDiffs) {
            val qi = dialect.quoteIdentifier(diff.indexName)
            when (diff.status) {
                "added" -> {
                    val cols = diff.sourceColumns!!.joinToString(", ") { dialect.quoteIdentifier(it) }
                    val unique = if (diff.sourceUnique == true && diff.indexName != "PRIMARY") "UNIQUE " else ""
                    if (diff.indexName == "PRIMARY") {
                        statements.add("ALTER TABLE $qt ADD PRIMARY KEY ($cols);")
                    } else {
                        statements.add("ALTER TABLE $qt ADD ${unique}INDEX $qi ($cols);")
                    }
                }

                "removed" -> {
                    if (options.includeDropStatements) {
                        if (diff.indexName == "PRIMARY") {
                            statements.add("ALTER TABLE $qt DROP PRIMARY KEY;")
                        } else {
                            statements.add("ALTER TABLE $qt DROP INDEX $qi;")
                        }
                    }
                }

                "modified" -> {
                    // 先删后建
                    val cols = diff.sourceColumns!!.joinToString(", ") { dialect.quoteIdentifier(it) }
                    val unique = if (diff.sourceUnique == true && diff.indexName != "PRIMARY") "UNIQUE " else ""
                    if (diff.indexName == "PRIMARY") {
                        statements.add("ALTER TABLE $qt DROP PRIMARY KEY;")
                        statements.add("ALTER TABLE $qt ADD PRIMARY KEY ($cols);")
                    } else {
                        statements.add("ALTER TABLE $qt DROP INDEX $qi;")
                        statements.add("ALTER TABLE $qt ADD ${unique}INDEX $qi ($cols);")
                    }
                }
            }
        }

        return statements.joinToString("\n")
    }

    private fun buildColumnDefinition(
        dialect: DialectAdapter,
        name: String,
        type: String,
        nullable: Boolean?,
        defaultValue: String?,
        comment: String?
    ): String {
        val qn = dialect.quoteIdentifier(name)
        val parts = mutableListOf("$qn $type")
        if (nullable == false) parts.add("NOT NULL")
        if (defaultValue != null) parts.add("DEFAULT $defaultValue")
        if (!comment.isNullOrBlank()) parts.add("COMMENT '${comment.replace("'", "\\'")}'")
        return parts.joinToString(" ")
    }

    private fun findPreviousColumn(columns: List<ColumnInfo>, columnName: String): String? {
        val index = columns.indexOfFirst { it.name == columnName }
        return if (index > 0) columns[index - 1].name else null
    }
}
