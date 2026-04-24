package com.easydb.backup

import java.sql.Connection

object MysqlConsistentSnapshot {

    data class SnapshotInfo(
        val level: String,          // "snapshot" | "best_effort"
        val binlogFile: String?,
        val binlogPos: Long?,
        val connection: Connection
    )

    fun begin(conn: Connection): SnapshotInfo {
        var level = "best_effort"
        var binlogFile: String? = null
        var binlogPos: Long? = null

        try {
            conn.createStatement().use {
                it.execute("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            }
            conn.createStatement().use {
                it.execute("START TRANSACTION WITH CONSISTENT SNAPSHOT")
            }
            level = "snapshot"
            
            try {
                conn.createStatement().use { stmt ->
                    stmt.executeQuery("SHOW MASTER STATUS").use { rs ->
                        if (rs.next()) {
                            binlogFile = rs.getString("File")
                            binlogPos = rs.getLong("Position")
                        }
                    }
                }
            } catch (e: Exception) {
                // Cannot fetch master status, probably due to lack of privileges like REPLICATION CLIENT
            }
        } catch (e: Exception) {
            // Cannot start consistent snapshot, possible MyISAM or privilege issues.
            level = "best_effort"
        }

        return SnapshotInfo(level, binlogFile, binlogPos, conn)
    }

    fun release(snapshot: SnapshotInfo) {
        try {
            snapshot.connection.createStatement().use { it.execute("ROLLBACK") }
        } catch (e: Exception) {
            // Ignore rollback failure
        }
    }
}
