package com.easydb.common

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/**
 * 连接配置持久化存储（v2：凭据字段 AES-256-GCM 加密）
 *
 * 存储路径：~/.easydb/connections.json
 *
 * 安全策略：
 *   - ConnectionConfig.password / ssh.password 在落盘时加密，内存中保持明文
 *   - 旧版明文 JSON（无加密前缀）在首次读取时自动迁移并重写为密文格式
 *   - 旧版文件在迁移前备份为 connections.json.bak，防止迁移异常导致数据丢失
 *
 * 调用方透明：
 *   - getById() / getAll() 返回的 ConnectionConfig 中密码为**明文**（供业务逻辑直接使用）
 *   - 磁盘文件中密码为**密文**（ENCv1: 前缀）
 */
class ConnectionStore(
    private val storageDir: File = File(System.getProperty("user.home"), ".easydb")
) {
    private val storageFile = File(storageDir, "connections.json")
    private val backupFile  = File(storageDir, "connections.json.bak")
    private val cache = ConcurrentHashMap<String, ConnectionConfig>()

    private val json = Json {
        prettyPrint = true
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    init {
        loadFromDisk()
    }

    /** 获取所有连接（内存明文） */
    fun getAll(): List<ConnectionConfig> = cache.values.toList()

    /** 根据 ID 获取（内存明文） */
    fun getById(id: String): ConnectionConfig? = cache[id]

    /** 保存连接（新建或更新）；密码字段落盘时自动加密 */
    fun save(config: ConnectionConfig): ConnectionConfig {
        cache[config.id] = config  // 内存保持明文
        saveToDisk()
        return config
    }

    /** 删除连接 */
    fun delete(id: String): Boolean {
        val removed = cache.remove(id) != null
        if (removed) saveToDisk()
        return removed
    }

    /** 更新连接状态（不影响密码加密状态） */
    fun updateStatus(id: String, status: String) {
        cache[id]?.let {
            cache[id] = it.copy(status = status)
            saveToDisk()
        }
    }

    /** 是否包含该连接 */
    fun contains(id: String): Boolean = cache.containsKey(id)

    /** 连接数量 */
    fun count(): Int = cache.size

    // ─── 磁盘 I/O ──────────────────────────────────────────────

    private fun loadFromDisk() {
        if (!storageFile.exists()) return
        try {
            val text = storageFile.readText()
            if (text.isBlank()) return

            val list = json.decodeFromString<List<ConnectionConfig>>(text)
            val needsMigration = list.any { needsEncryption(it) }

            list.forEach { config ->
                // 解密密文字段 → 内存明文
                cache[config.id] = decryptConfig(config).copy(status = "disconnected")
            }

            // 旧版明文配置 → 自动迁移（备份原文件后重写为密文）
            if (needsMigration) {
                migrateToEncrypted()
            }
        } catch (e: Exception) {
            System.err.println("[ConnectionStore] Failed to load connections: ${e.message}")
        }
    }

    @Synchronized
    private fun saveToDisk() {
        try {
            storageDir.mkdirs()
            val list = cache.values.toList().map { config ->
                // 清除运行时状态 + 加密密码字段
                encryptConfig(config).copy(status = "disconnected")
            }
            storageFile.writeText(json.encodeToString(list))
        } catch (e: Exception) {
            System.err.println("[ConnectionStore] Failed to save connections: ${e.message}")
        }
    }

    /**
     * 迁移：旧明文文件备份后重写为加密格式
     */
    private fun migrateToEncrypted() {
        try {
            // 备份原文件（覆盖旧备份）
            if (storageFile.exists()) {
                storageFile.copyTo(backupFile, overwrite = true)
                System.out.println("[ConnectionStore] Backed up plaintext config to ${backupFile.absolutePath}")
            }
            saveToDisk()
            System.out.println("[ConnectionStore] Migrated credentials to encrypted format (v2)")
        } catch (e: Exception) {
            System.err.println("[ConnectionStore] Migration failed: ${e.message}")
        }
    }

    // ─── 加解密辅助 ────────────────────────────────────────────

    /** 判断配置中是否存在未加密的敏感字段 */
    private fun needsEncryption(config: ConnectionConfig): Boolean {
        val pwdNeedsEnc = config.password.isNotBlank() && !CredentialCipher.isEncrypted(config.password)
        val sshPwdNeedsEnc = config.ssh?.password?.let {
            it.isNotBlank() && !CredentialCipher.isEncrypted(it)
        } ?: false
        return pwdNeedsEnc || sshPwdNeedsEnc
    }

    /** 将 config 中的敏感字段加密（用于落盘） */
    private fun encryptConfig(config: ConnectionConfig): ConnectionConfig {
        return config.copy(
            password = CredentialCipher.encrypt(config.password),
            ssh = config.ssh?.let { ssh ->
                ssh.copy(password = ssh.password?.let { CredentialCipher.encrypt(it) })
            }
        )
    }

    /** 将 config 中的密文字段解密（用于内存） */
    private fun decryptConfig(config: ConnectionConfig): ConnectionConfig {
        return config.copy(
            password = CredentialCipher.decrypt(config.password),
            ssh = config.ssh?.let { ssh ->
                ssh.copy(password = ssh.password?.let { CredentialCipher.decrypt(it) })
            }
        )
    }
}
