package com.easydb.backup

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.*
import java.security.MessageDigest
import java.util.zip.GZIPOutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

class BackupPackageWriter(private val workDir: File) {

    private val json = Json {
        prettyPrint = true
        encodeDefaults = true
    }

    private val checksums = mutableMapOf<String, String>()

    init {
        workDir.mkdirs()
        File(workDir, "metadata").mkdirs()
        File(workDir, "schema/010_tables").mkdirs()
        File(workDir, "schema/020_routines").mkdirs()
        File(workDir, "schema/030_views").mkdirs()
        File(workDir, "schema/040_triggers").mkdirs()
        File(workDir, "data").mkdirs()
    }

    fun writeString(relativePath: String, content: String) {
        val file = File(workDir, relativePath)
        file.parentFile.mkdirs()
        file.writeText(content)
        checksums[relativePath] = computeSha256(file)
    }

    fun writeManifest(manifest: BackupManifest) {
        writeString("manifest.json", json.encodeToString(manifest))
    }

    fun writeChecksums() {
        writeString("checksums.json", json.encodeToString(checksums))
    }

    fun createGzipDataWriter(relativePath: String): DataWriter {
        val file = File(workDir, relativePath)
        file.parentFile.mkdirs()
        val fos = FileOutputStream(file)
        val gzipOut = GZIPOutputStream(fos)
        val writer = OutputStreamWriter(gzipOut, Charsets.UTF_8)
        return DataWriter(writer, file, relativePath)
    }

    inner class DataWriter(
        private val writer: OutputStreamWriter,
        private val file: File,
        private val relativePath: String
    ) {
        fun write(str: String) {
            writer.write(str)
        }
        fun close(): String {
            writer.flush()
            writer.close()
            val sha256 = computeSha256(file)
            checksums[relativePath] = sha256
            return sha256
        }
    }

    private fun computeSha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).use { fis ->
            val buffer = ByteArray(8192)
            var bytesRead: Int
            while (fis.read(buffer).also { bytesRead = it } != -1) {
                digest.update(buffer, 0, bytesRead)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    fun packToZip(outputZipFile: File) {
        outputZipFile.parentFile.mkdirs()
        ZipOutputStream(FileOutputStream(outputZipFile)).use { zos ->
            workDir.walkTopDown().forEach { file ->
                if (file.isFile) {
                    val relativePath = file.relativeTo(workDir).path.replace('\\', '/')
                    zos.putNextEntry(ZipEntry(relativePath))
                    FileInputStream(file).use { fis ->
                        fis.copyTo(zos)
                    }
                    zos.closeEntry()
                }
            }
        }
    }

    fun cleanup() {
        workDir.deleteRecursively()
    }
}
