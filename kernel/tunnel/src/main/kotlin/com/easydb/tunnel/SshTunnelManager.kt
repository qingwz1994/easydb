package com.easydb.tunnel

import com.easydb.common.SshConfig
import com.jcraft.jsch.JSch
import com.jcraft.jsch.Session

/**
 * SSH 隧道管理器
 * 建立本地端口转发到远程 MySQL 服务器
 */
class SshTunnelManager {

    private val activeTunnels = mutableMapOf<String, TunnelInfo>()

    /**
     * 建立 SSH 隧道
     * @param tunnelId 隧道唯一标识（通常用连接 ID）
     * @param sshConfig SSH 配置
     * @param remoteHost 远程 MySQL 主机
     * @param remotePort 远程 MySQL 端口
     * @return 本地转发端口
     */
    fun openTunnel(
        tunnelId: String,
        sshConfig: SshConfig,
        remoteHost: String,
        remotePort: Int
    ): Int {
        // 关闭已有同 ID 隧道
        closeTunnel(tunnelId)

        val jsch = JSch()

        // 私钥认证
        if (sshConfig.authType == "privateKey" && !sshConfig.privateKeyPath.isNullOrBlank()) {
            jsch.addIdentity(sshConfig.privateKeyPath)
        }

        val session = jsch.getSession(sshConfig.username, sshConfig.host, sshConfig.port)

        // 密码认证
        if (sshConfig.authType == "password" && !sshConfig.password.isNullOrBlank()) {
            session.setPassword(sshConfig.password)
        }

        session.setConfig("StrictHostKeyChecking", "no")
        session.setConfig("PreferredAuthentications", "publickey,keyboard-interactive,password")
        session.connect(10000) // 10 秒超时

        // 本地端口转发：0 表示自动分配
        val localPort = session.setPortForwardingL(0, remoteHost, remotePort)

        activeTunnels[tunnelId] = TunnelInfo(session = session, localPort = localPort)
        return localPort
    }

    /**
     * 关闭指定隧道
     */
    fun closeTunnel(tunnelId: String) {
        activeTunnels.remove(tunnelId)?.let { info ->
            try {
                if (info.session.isConnected) {
                    info.session.disconnect()
                }
            } catch (_: Exception) {
                // 忽略关闭异常
            }
        }
    }

    /**
     * 关闭所有隧道
     */
    fun closeAll() {
        activeTunnels.keys.toList().forEach { closeTunnel(it) }
    }

    /**
     * 获取隧道本地端口
     */
    fun getLocalPort(tunnelId: String): Int? {
        return activeTunnels[tunnelId]?.localPort
    }

    private data class TunnelInfo(
        val session: Session,
        val localPort: Int
    )
}
