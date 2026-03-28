package com.easydb.drivers.mysql

import com.easydb.common.*
import io.mockk.*
import kotlinx.coroutines.test.runTest
import java.sql.Connection
import java.sql.ResultSet
import java.sql.ResultSetMetaData
import java.sql.Statement
import java.sql.PreparedStatement
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class MysqlMigrationAdapterTest {

    @Test
    fun `test migrateData using coroutine channels properly processes rows and utilizes batches`() = runTest {
        // We must mock the constructor BEFORE the adapter is instantiated, 
        // since metadata adapter is an inline property of the class!
        mockkConstructor(MysqlMetadataAdapter::class)
        every { anyConstructed<MysqlMetadataAdapter>().listTables(any(), any()) } returns listOf(
            TableInfo(name = "users", type = "table", rowCount = 5L)
        )

        // Prepare Adapter
        val adapter = MysqlMigrationAdapter()

        // Mock Connections and Statements
        val sourceConn = mockk<Connection>(relaxed = true)
        val targetConn = mockk<Connection>(relaxed = true)
        val sourceStmt = mockk<Statement>(relaxed = true)
        val targetStmt = mockk<PreparedStatement>(relaxed = true)
        val resultSet = mockk<ResultSet>(relaxed = true)
        val metaData = mockk<ResultSetMetaData>(relaxed = true)
        val reporter = mockk<TaskReporter>(relaxed = true)

        // Wire Mocks
        every { sourceConn.createStatement() } returns sourceStmt
        every { sourceConn.createStatement(ResultSet.TYPE_FORWARD_ONLY, ResultSet.CONCUR_READ_ONLY) } returns sourceStmt
        every { targetConn.prepareStatement(any()) } returns targetStmt
        every { sourceStmt.executeQuery(any()) } returns resultSet
        every { resultSet.metaData } returns metaData
        
        // Mock Columns
        every { metaData.columnCount } returns 2
        every { metaData.getColumnName(1) } returns "id"
        every { metaData.getColumnName(2) } returns "name"
        every { metaData.getColumnType(1) } returns java.sql.Types.INTEGER
        every { metaData.getColumnType(2) } returns java.sql.Types.VARCHAR

        // Mock Rows: total 5 rows
        var rowCounter = 0
        every { resultSet.next() } answers {
            rowCounter++
            rowCounter <= 5
        }
        every { resultSet.getObject(1) } answers { rowCounter }
        every { resultSet.getObject(2) } answers { "user_$rowCounter" }

        // Mocks for structural and configuration
        val sourceSession = mockk<MysqlDatabaseSession>(relaxed = true)
        val targetSession = mockk<MysqlDatabaseSession>(relaxed = true)
        every { sourceSession.connection } returns sourceConn
        every { targetSession.connection } returns targetConn

        // Mocks for execution checks (bypassing full system via reflection or isolated execution)
        // Since migrateData is private, we execute via the public execute() method utilizing the mocks.
        val config = MigrationConfig(
            sourceConnectionId = "conn-src",
            targetConnectionId = "conn-tgt",
            sourceDatabase = "db1",
            targetDatabase = "db2",
            tables = listOf("users"),
            mode = "data_only"
        )
        
        // We need to inject the mock metadata somehow, or just mock the MysqlMetadataAdapter internally.
        // Because MysqlMetadataAdapter is instantiated inline inside MysqlMigrationAdapter, testing `execute` 
        // directly without a DI container is tricky.
        // For the sake of this test verifying Coroutine Channels, we will use reflection or mock the constructor.
        // (Mocks for metadata moved to top)

        val sessions = SessionPair(sourceSession, targetSession)
        
        // Target Row Count Verification Mock
        val verifyStmt = mockk<Statement>(relaxed = true)
        val verifyResultSet = mockk<ResultSet>(relaxed = true)
        every { targetConn.createStatement() } returns verifyStmt
        every { verifyStmt.executeQuery(any()) } returns verifyResultSet
        every { verifyResultSet.next() } returns true
        every { verifyResultSet.getLong(1) } returns 5L

        // Execute task
        val result = adapter.execute(config, sessions, reporter)

        // Verification asserts
        assertTrue(result.success, "Failed: ${result.errorMessage}. Details: ${result.verification}")
        assertEquals(1, result.successCount)
        assertEquals(0, result.failureCount)
        assertEquals(5L, result.verification?.first()?.targetRows)

        // Verify that the target statement was added to batch and executed exactly 5 times (for the 5 rows)
        verify(exactly = 5) { targetStmt.addBatch() }
        verify(atLeast = 1) { targetStmt.executeBatch() }

        // Ensure the backend OOM guard is enabled
        verify(exactly = 1) { sourceStmt.fetchSize = Integer.MIN_VALUE }

        unmockkConstructor(MysqlMetadataAdapter::class)
    }
}
