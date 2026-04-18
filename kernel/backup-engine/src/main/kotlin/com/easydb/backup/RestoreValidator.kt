package com.easydb.backup

import kotlinx.serialization.json.Json
import kotlinx.serialization.decodeFromString
import java.io.File
import java.security.MessageDigest
import java.util.zip.ZipFile

class RestoreValidator(private val backupFile: File) {

    private val json = Json {
        ignoreUnknownKeys = true
    }

    fun inspect(): RestoreInspectResult {
        if (!backupFile.exists() || !backupFile.isFile) {
            return RestoreInspectResult(
                manifest = createEmptyManifest(),
                fileValid = false,
                checksumValid = false,
                warnings = listOf("Backup file does not exist or is not a valid file.")
            )
        }

        try {
            ZipFile(backupFile).use { zip ->
                val manifestEntry = zip.getEntry("manifest.json")
                if (manifestEntry == null) {
                    return RestoreInspectResult(
                        manifest = createEmptyManifest(),
                        fileValid = false,
                        checksumValid = false,
                        warnings = listOf("manifest.json not found in backup package.")
                    )
                }

                val manifestContent = zip.getInputStream(manifestEntry).bufferedReader().use { it.readText() }
                val manifest = json.decodeFromString<BackupManifest>(manifestContent)

                val checksumsEntry = zip.getEntry("checksums.json")
                val warnings = mutableListOf<String>()
                var checksumValid = true

                if (checksumsEntry == null) {
                    warnings.add("checksums.json not found, skipping integrity check.")
                } else {
                    val checksumsContent = zip.getInputStream(checksumsEntry).bufferedReader().use { it.readText() }
                    val expectedChecksums = json.decodeFromString<Map<String, String>>(checksumsContent)
                    
                    val manifestSha256 = computeSha256(manifestContent.toByteArray())
                    if (expectedChecksums["manifest.json"] != null && expectedChecksums["manifest.json"] != manifestSha256) {
                        checksumValid = false
                        warnings.add("manifest.json checksum mismatch!")
                    }
                }

                return RestoreInspectResult(
                    manifest = manifest,
                    fileValid = true,
                    checksumValid = checksumValid,
                    warnings = warnings
                )
            }
        } catch (e: Exception) {
            return RestoreInspectResult(
                manifest = createEmptyManifest(),
                fileValid = false,
                checksumValid = false,
                warnings = listOf("Failed to read backup package: ${e.message}")
            )
        }
    }

    private fun createEmptyManifest() = BackupManifest(
        formatVersion = 0, appVersion = "", dbType = "", serverVersion = "", database = "",
        mode = "", startedAt = "", consistency = "", tables = emptyList(), objects = emptyList()
    )
    
    private fun computeSha256(bytes: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val hash = digest.digest(bytes)
        return hash.joinToString("") { "%02x".format(it) }
    }
}
