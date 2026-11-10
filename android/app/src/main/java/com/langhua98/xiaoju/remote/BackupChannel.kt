package com.langhua98.xiaoju.remote

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URLEncoder

/**
 * 备用通道（0.31）：云盘（家里电脑）停了，指令和回执改走公共信箱 ntfy.sh，内容加密（BackupCrypto）。
 *
 * 密钥：手机第一次用时随机生成，记在手机上；云盘正常时存到云盘
 *   `/小橘推送/遥控/<设备名>/备用通道.json`（{"v","server","device","key","cmd","reply"}），
 *   控制端（小橘推送、遥控.py）云盘正常时取一份记下来，云盘停了就用它。密钥不进仓库、不进日志。
 *
 * 什么时候收：云盘连不上超过 15 秒就开始收（一条一直连着的 ntfy 消息流，CPU 可以睡），
 * 云盘回来以后再多收 10 分钟（路上的指令别丢），然后停。云盘正常时不连 ntfy，不多费电。
 * ntfy 会把消息留几个小时，开始收时从上次收到的地方（或者 15 分钟前）接着收，所以切换的那几分钟里发的指令也不丢。
 *
 * 指令要带 at（发出时的 Unix 秒），和手机时间差 15 分钟以上的不做（防止有人录下来重放）；同一个 id 只做一次。
 * 回执：小的直接放消息里（ntfy 单条最多 4096 字节）；大的（带照片、录音）加密后作为附件传。
 *
 * 做不到的：实时画面要云盘的直播通道，备用通道只能同一个 Wi-Fi 直连；侦测录像等云盘回来再备份；
 * 移动侦测的提醒还是走云盘（云盘停着时发不出去）。
 */
class BackupChannel(
    private val prefs: Prefs,
    private val device: String,
    private val running: () -> Boolean,
    private val onCommand: (JSONObject) -> Unit,
    private val log: (String) -> Unit,
) {
    val key: ByteArray = loadKey()
    val cmdTopic = BackupCrypto.topic(key, device, "cmd")
    val replyTopic = BackupCrypto.topic(key, device, "reply")

    @Volatile private var downSince = 0L      // 云盘从什么时候开始连不上（0 = 现在是好的）
    @Volatile private var upSince = System.currentTimeMillis()
    @Volatile private var listening = false
    @Volatile private var conn: HttpURLConnection? = null
    private var thread: Thread? = null

    val active: Boolean get() = listening

    private fun loadKey(): ByteArray {
        BackupCrypto.unb64(prefs.backupKey)?.takeIf { it.size == 32 }?.let { return it }
        val k = BackupCrypto.newKey()
        prefs.backupKey = BackupCrypto.b64(k)
        return k
    }

    /** 存到云盘给控制端取的那份 */
    fun keyFile(): JSONObject = JSONObject().put("v", 1).put("server", SERVER).put("device", device)
        .put("key", BackupCrypto.b64(key)).put("cmd", cmdTopic).put("reply", replyTopic)

    /** 云盘正常时调用：密钥还没存到云盘（或换了设备名）就存一份。失败下次再试。 */
    fun publishIfNeeded(cloud: Cloud) {
        val mark = BackupCrypto.hex(BackupCrypto.hmac(key, device.toByteArray(Charsets.UTF_8))).substring(0, 16)
        if (prefs.backupPublished == mark) return
        try {
            cloud.upload(keyPath(device), keyFile().toString().toByteArray(Charsets.UTF_8), "application/json; charset=utf-8")
            prefs.backupPublished = mark
            log("备用通道：密钥已存到云盘，控制端下次连上云盘时会取")
        } catch (e: Exception) {
            // 云盘停着、令牌没写权限：下次再试
        }
    }

    /** 收件循环报告云盘好不好 */
    fun cloudUp() {
        if (downSince != 0L) { downSince = 0L; upSince = System.currentTimeMillis() }
    }

    fun cloudDown() {
        if (downSince == 0L) downSince = System.currentTimeMillis()
    }

    private fun shouldListen(now: Long): Boolean {
        val d = downSince
        if (d != 0L) return now - d >= START_AFTER_MS || listening
        return listening && now - upSince < KEEP_AFTER_MS
    }

    fun start() {
        if (thread != null) return
        thread = Thread({ loop() }, "backup").apply { isDaemon = true; start() }
    }

    fun stop() {
        runCatching { conn?.disconnect() }
        thread?.interrupt(); thread = null
    }

    private fun loop() {
        var backoff = 2_000L
        while (running()) {
            if (!shouldListen(System.currentTimeMillis())) {
                if (listening) { listening = false; log("云盘恢复了，备用通道停了") }
                if (!sleep(5_000)) return
                continue
            }
            if (!listening) { listening = true; log("云盘连不上，改用备用通道收指令（ntfy.sh，加密）") }
            try {
                listenOnce()
                backoff = 2_000L
            } catch (e: Exception) {
                if (!running()) return
                log("备用通道连不上：${e.message ?: e.javaClass.simpleName}")
                if (!sleep(backoff)) return
                backoff = (backoff * 2).coerceAtMost(60_000L)
            }
        }
    }

    /** 连一次 ntfy 的消息流，一直读到断开（或者云盘恢复够久了）。 */
    private fun listenOnce() {
        val since = prefs.backupSince.ifBlank { "15m" }
        val c = Net.openStream("$SERVER/$cmdTopic/json?since=${q(since)}", STREAM_READ_TIMEOUT_MS)
        conn = c
        try {
            c.inputStream.bufferedReader(Charsets.UTF_8).use { r ->
                while (running()) {
                    val line = r.readLine() ?: return
                    if (!shouldListen(System.currentTimeMillis())) return
                    if (line.isBlank()) continue
                    val m = runCatching { JSONObject(line) }.getOrNull() ?: continue
                    if (m.optString("event") != "message") continue
                    m.optString("id").takeIf { it.isNotBlank() }?.let { prefs.backupSince = it }
                    Power.hold { handle(m.optString("message")) }
                }
            }
        } finally {
            conn = null
            c.disconnect()
        }
    }

    private fun handle(text: String) {
        val plain = BackupCrypto.openText(key, text) ?: return    // 别人的、坏的：不理
        val cmd = runCatching { JSONObject(plain) }.getOrNull() ?: return
        val id = cmd.optString("id")
        if (id.isBlank() || prefs.isSeen("bk:$id")) return
        prefs.markSeen("bk:$id")
        val at = cmd.optLong("at", 0L)
        val skew = Math.abs(System.currentTimeMillis() / 1000 - at)
        if (at <= 0L || skew > MAX_SKEW_S) {
            log("备用通道：一条指令太旧（或手机时间不对），不做")
            reply(JSONObject().put("id", id).put("ok", false).put("text", "指令发出的时间和手机时间差太多（${skew / 60} 分钟），没做"))
            return
        }
        cmd.put("via", "backup")
        onCommand(cmd)
    }

    /** 回执走备用通道。太大的作为加密附件传；附件传不了就去掉文件只回文字。 */
    fun reply(r: JSONObject) {
        val text = BackupCrypto.sealText(key, r.toString())
        try {
            if (text.length <= MESSAGE_LIMIT) {
                Net.request("POST", "$SERVER/$replyTopic", null, text.toByteArray(Charsets.UTF_8), "text/plain; charset=utf-8")
                return
            }
            val sealed = BackupCrypto.seal(key, r.toString().toByteArray(Charsets.UTF_8))
            try {
                Net.request("PUT", "$SERVER/$replyTopic", null, sealed, "application/octet-stream",
                    readTimeoutMs = 120_000, headers = mapOf("Filename" to "r.bin"))
            } catch (e: HttpError) {
                // 附件太大（ntfy.sh 不收）：只回文字
                val small = JSONObject(r.toString())
                small.remove("files")
                small.put("text", small.optString("text") + "\n（文件太大，备用通道传不了，等云盘恢复后再要）")
                Net.request("POST", "$SERVER/$replyTopic", null,
                    BackupCrypto.sealText(key, small.toString()).toByteArray(Charsets.UTF_8), "text/plain; charset=utf-8")
            }
        } catch (e: Exception) {
            log("备用通道传回执失败：${e.message ?: e.javaClass.simpleName}")
        }
    }

    private fun sleep(ms: Long): Boolean = try { Thread.sleep(ms); running() } catch (e: InterruptedException) { false }

    private fun q(s: String) = URLEncoder.encode(s, "UTF-8").replace("+", "%20")

    companion object {
        const val SERVER = "https://ntfy.sh"
        const val START_AFTER_MS = 15_000L
        const val KEEP_AFTER_MS = 10 * 60_000L
        const val MAX_SKEW_S = 15 * 60L
        /** ntfy 单条消息最多 4096 字节，超过就当附件 */
        const val MESSAGE_LIMIT = 4000
        /** ntfy.sh 大约每 45 秒发一次 keepalive，读超过这么久没东西就当断了，重连 */
        const val STREAM_READ_TIMEOUT_MS = 120_000

        fun keyPath(device: String) = "/小橘推送/遥控/$device/备用通道.json"
    }
}
