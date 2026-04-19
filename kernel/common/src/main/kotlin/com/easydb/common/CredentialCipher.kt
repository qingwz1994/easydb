package com.easydb.common

import java.io.File
import java.security.MessageDigest
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * 连接凭据加解密工具（AES-256-GCM）。
 *
 * 密钥派生：SHA-256(machineId + APP_SALT)
 * 密文格式：Base64( IV[12 bytes] | CipherText | AuthTag[16 bytes] )
 * 存储标识：明文字段值以 "ENCv1:" 前缀标识为密文。
 *
 * 设计目标：
 *   - 防止 connections.json 文件被复制到其他机器直接使用（机器绑定）
 *   - API 返回前脱敏，防止前端日志/网络抓包泄露
 *   - 向下兼容：不带 "ENCv1:" 前缀的旧明文字段自动识别且在首次 save 时迁移
 *
 * 局限性（可接受）：
 *   - 同一台机器上的其他进程可以解密（OS Keychain 方案留作未来 P1 升级）
 *   - APP_SALT 在 JAR 内，可被反编译获取（防御对象是"文件转移"而非"本机提权"）
 */
object CredentialCipher {

    /** 版本前缀，用于区分明文与密文 */
    private const val CIPHER_PREFIX = "ENCv1:"

    /** 硬编码盐（与 machineId 组合派生密钥，单独任一项被获取均不足以还原密钥） */
    private const val APP_SALT = "EASYDB_CREDENTIAL_SALT_V1_2024"

    /** GCM Authentication Tag 长度（bit） */
    private const val GCM_TAG_LENGTH = 128

    /** IV 长度（byte） */
    private const val IV_LENGTH = 12

    // ─── 主密钥（懒初始化，进程内缓存） ──────────────────────

    private val masterKey: ByteArray by lazy {
        val machineId = getMachineId()
        val raw = "$machineId:$APP_SALT"
        MessageDigest.getInstance("SHA-256").digest(raw.toByteArray(Charsets.UTF_8))
    }

    // ─── 公开 API ─────────────────────────────────────────────

    /**
     * 加密明文字符串。
     * 如果输入为空字符串，直接返回空字符串（空密码不加密）。
     * 如果输入已经是密文（"ENCv1:" 前缀），直接返回原值（幂等）。
     */
    fun encrypt(plaintext: String): String {
        if (plaintext.isBlank()) return plaintext
        if (plaintext.startsWith(CIPHER_PREFIX)) return plaintext  // 已加密，幂等

        val iv = ByteArray(IV_LENGTH).also { java.security.SecureRandom().nextBytes(it) }
        val cipher = buildCipher(Cipher.ENCRYPT_MODE, iv)
        val cipherBytes = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))

        // 格式：IV(12) | CipherText+AuthTag
        val combined = iv + cipherBytes
        return CIPHER_PREFIX + Base64.getEncoder().encodeToString(combined)
    }

    /**
     * 解密密文字符串。
     * 如果输入不带 "ENCv1:" 前缀，视为旧版明文，直接返回原值（兼容旧格式）。
     * 如果输入为空，直接返回空字符串。
     */
    fun decrypt(ciphertext: String): String {
        if (ciphertext.isBlank()) return ciphertext
        if (!ciphertext.startsWith(CIPHER_PREFIX)) return ciphertext  // 旧明文，直接返回

        return try {
            val combined = Base64.getDecoder().decode(ciphertext.removePrefix(CIPHER_PREFIX))
            val iv = combined.copyOfRange(0, IV_LENGTH)
            val cipherBytes = combined.copyOfRange(IV_LENGTH, combined.size)
            val cipher = buildCipher(Cipher.DECRYPT_MODE, iv)
            String(cipher.doFinal(cipherBytes), Charsets.UTF_8)
        } catch (e: Exception) {
            System.err.println("[CredentialCipher] Decrypt failed: ${e.message}")
            ""  // 解密失败返回空，连接时会报认证错误，用户可重新输入
        }
    }

    /**
     * 判断字符串是否为密文（带 ENCv1: 前缀）。
     */
    fun isEncrypted(value: String): Boolean = value.startsWith(CIPHER_PREFIX)

    // ─── 私有辅助 ──────────────────────────────────────────────

    private fun buildCipher(mode: Int, iv: ByteArray): Cipher {
        val keySpec = SecretKeySpec(masterKey, "AES")
        val paramSpec = GCMParameterSpec(GCM_TAG_LENGTH, iv)
        return Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(mode, keySpec, paramSpec)
        }
    }

    /**
     * 获取机器唯一 ID。
     *
     * 优先级：
     *   1. macOS: IOPlatformUUID（通过 ioreg 命令）
     *   2. Linux: /etc/machine-id
     *   3. Windows: 注册表 MachineGuid（wmic）
     *   4. 回退：hostname（不唯一但稳定）
     */
    private fun getMachineId(): String {
        return tryMacOsUuid()
            ?: tryLinuxMachineId()
            ?: tryWindowsMachineGuid()
            ?: fallbackHostname()
    }

    private fun tryMacOsUuid(): String? = runCatching {
        val proc = ProcessBuilder("ioreg", "-rd1", "-c", "IOPlatformExpertDevice")
            .redirectErrorStream(true)
            .start()
        val output = proc.inputStream.bufferedReader().readText()
        proc.waitFor()
        val regex = Regex("""IOPlatformUUID\s*=\s*"([^"]+)"""")
        regex.find(output)?.groupValues?.get(1)?.trim()
    }.getOrNull()

    private fun tryLinuxMachineId(): String? = runCatching {
        val f = File("/etc/machine-id")
        if (f.exists()) f.readText().trim().takeIf { it.isNotBlank() } else null
    }.getOrNull()

    private fun tryWindowsMachineGuid(): String? = runCatching {
        val proc = ProcessBuilder(
            "reg", "query",
            "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
            "/v", "MachineGuid"
        ).redirectErrorStream(true).start()
        val output = proc.inputStream.bufferedReader().readText()
        proc.waitFor()
        val regex = Regex("""MachineGuid\s+REG_SZ\s+(\S+)""")
        regex.find(output)?.groupValues?.get(1)?.trim()
    }.getOrNull()

    private fun fallbackHostname(): String =
        runCatching { java.net.InetAddress.getLocalHost().hostName }.getOrElse { "easydb-unknown-host" }
}
