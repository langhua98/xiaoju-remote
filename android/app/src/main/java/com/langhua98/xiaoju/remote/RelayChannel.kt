package com.langhua98.xiaoju.remote

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * 智能心跳：自己摸出这个网络能让一条安静的连接撑多久。
 *
 * 连接放久了会被路由器或运营商 NAT 悄悄掐掉，所以要定时发心跳；但间隔不写死：
 * - 每撑过一个完整的间隔（心跳有回应），就把间隔往上调一点（更省电，被控端醒得更少）；
 * - 哪一次心跳没回应（连接已经被掐了），就记住这个「撑不住」的长度，退回到它下面一档，以后不再越过。
 * 换了网络（重新从头连）就把上限忘掉，重新摸。
 *
 * 不碰安卓的类，可以在电脑上跑测试。
 */
class HeartbeatTuner(
    val minMs: Long = 20_000,
    val maxMs: Long = 9 * 60_000,
    val startMs: Long = 60_000,
) {
    @Volatile var intervalMs = startMs.coerceIn(minMs, maxMs)
        private set
    /** 已知「撑不住」的长度：间隔不会涨到这个值（减一点余量）以上。0 = 还不知道。 */
    private var ceilingMs = 0L

    /** 撑过了一个完整间隔：往上调。 */
    fun survived() {
        val cap = if (ceilingMs > 0) (ceilingMs * 8 / 10).coerceAtLeast(minMs) else maxMs
        intervalMs = (intervalMs + intervalMs / 2).coerceAtMost(minOf(maxMs, cap))
    }

    /** 这个间隔撑不住（心跳没回应）：记住它，退回下面一档。 */
    fun died() {
        ceilingMs = intervalMs
        intervalMs = (intervalMs * 6 / 10).coerceAtLeast(minMs)
    }

    /** 换了网络：忘掉学到的上限，从头摸（但别退得比现在还高）。 */
    fun reset() {
        ceilingMs = 0L
        intervalMs = startMs.coerceIn(minMs, maxMs)
    }
}

/**
 * 即时信箱的常驻推送（被控端用）：挂一条 WebSocket 一直不断，指令一到服务端马上推下来，
 * 没指令时一个字节都不发，CPU 可以一直睡（数据包到了 Wi-Fi 会把它叫醒），比每 25 秒醒一次的长轮询省电得多。
 *
 * - 收到 {"messages":[…]}：每条指令交给 onCommand（按 id 去重），再回 {"ack":<最大 id>} 让服务端删掉。
 *   没确认的留在服务端（10 分钟），断线重连会再来一次，所以连接被悄悄掐断也不丢指令。
 * - 心跳：空闲时 CPU 睡，到点发 {"ping":n}，等 {"pong":n}；回应了就把间隔调长（HeartbeatTuner），
 *   没回应就当连接死了，断开重连、间隔退一档。
 * - 第一次就连不上（服务端还没有这个口 404/405/501，或者网络不通）：返回 FALLBACK，让调用方退回长轮询。
 */
class RelayChannel(
    private val client: OkHttpClient,
    private val wsUrl: String,
    private val token: String,
    private val running: () -> Boolean,
    private val onCommand: (JSONObject) -> Unit,
    private val log: (String) -> Unit = {},
    /** 每次心跳醒来叫一下（连着常驻推送时收件循环停在 run() 里，定时的活儿靠它，比如查更新）。不能卡住。 */
    private val onTick: () -> Unit = {},
    /** 连上了（true）/ 连不上、断了（false）。备用通道靠它知道云盘好不好（BackupChannel） */
    private val onState: (Boolean) -> Unit = {},
) {
    enum class Outcome { FALLBACK, STOPPED }

    private val tuner = HeartbeatTuner()
    private val lock = Object()
    @Volatile private var ws: WebSocket? = null
    @Volatile private var closedCode = 0
    @Volatile private var closedReason = ""
    @Volatile private var failCode = -1          // onFailure 里的 HTTP 状态码（404 = 服务端没这个口）
    @Volatile private var alive = false
    @Volatile private var pingSeq = 0L
    @Volatile private var pongSeq = -1L
    private val inbox = RelayDedup()

    /**
     * 一直维持这条连接，直到 running 变 false。第一次就连不上则返回 FALLBACK。
     * 空闲等待和心跳间隔都在 Power.sleepWhile 里，让 CPU 睡。
     */
    fun run(): Outcome {
        var everConnected = false
        var backoffMs = 2_000L
        while (running()) {
            if (!connectOnce()) {
                onState(false)
                if (!everConnected) return Outcome.FALLBACK   // 服务端没这个口 / 一开始就连不上：用长轮询
                // 连过一次又断了：等一下重连（间隔退一档），别放弃。
                // 云盘可能停很久（家里电脑关机）：真的等够再连（0.29 以前这里没等，断着时一直连、费电），
                // 等的时候也叫一下 onTick（查更新会改从 GitHub 查）
                tuner.died()
                if (!sleepReleasing(backoffMs, untilDead = false)) break
                try { onTick() } catch (e: Exception) { log("定时任务出错：${e.message}") }
                backoffMs = (backoffMs * 2).coerceAtMost(30_000)
                continue
            }
            everConnected = true
            onState(true)
            backoffMs = 2_000L
            log("常驻连接：已连上（心跳约 ${tuner.intervalMs / 1000} 秒）")
            keepAlive()
            if (running()) onState(false)   // 连接断了（心跳没回应 / 被掐了）
            closeWs()
            if (!running()) break
        }
        closeWs()
        return Outcome.STOPPED
    }

    /** 连一次。成功 true；失败时 failCode 是 HTTP 状态码（能拿到的话）。 */
    private fun connectOnce(): Boolean {
        closedCode = 0; closedReason = ""; failCode = -1; alive = false; pongSeq = -1L
        inbox.newConnection()
        val opened = java.util.concurrent.CountDownLatch(1)
        val req = Request.Builder().url(wsUrl).header("Authorization", "Bearer $token").build()
        ws = client.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) { alive = true; opened.countDown() }
            override fun onMessage(webSocket: WebSocket, text: String) = onText(text)
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                closedCode = code; closedReason = reason; alive = false; wake()
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { alive = false; wake() }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                failCode = response?.code() ?: -1
                alive = false; opened.countDown(); wake()
            }
        })
        opened.await(20, TimeUnit.SECONDS)
        if (!alive) { closeWs(); return false }
        return true
    }

    /** 连上以后：空闲睡、到点心跳，直到连接断了或 running 变 false。 */
    private fun keepAlive() {
        while (running() && alive) {
            if (!sleepReleasing(tuner.intervalMs)) return      // 睡一个间隔（CPU 可以睡）
            if (!running() || !alive) return
            try { onTick() } catch (e: Exception) { log("定时任务出错：${e.message}") }
            // 到点：发心跳，等回应
            val n = ++pingSeq
            if (!trySend(JSONObject().put("ping", n).toString())) return
            val got = awaitPong(n, PONG_TIMEOUT_MS)
            if (!got) { log("心跳没回应，重连"); return }        // 连接已经被掐了
            tuner.survived()
        }
    }

    private fun onText(text: String) {
        val o = try { JSONObject(text) } catch (e: Exception) { return }
        if (o.has("pong")) { pongSeq = o.optLong("pong", -1L); wake(); return }
        val arr = o.optJSONArray("messages") ?: return
        Power.hold {   // 有指令来了：CPU 醒着处理
            var maxId = 0L
            for (i in 0 until arr.length()) {
                val m = arr.optJSONObject(i) ?: continue
                val id = m.optLong("id", 0L)
                if (id > maxId) maxId = id
                val body = m.optJSONObject("body") ?: continue
                if (!inbox.fresh(id, body.optString("id"))) continue   // 重发的，去重
                try { onCommand(body) } catch (e: Exception) { log("处理指令出错：${e.message}") }
            }
            // 只确认这一批收到的编号：服务端重启后编号从 1 重新数，确认旧的大编号会把新指令全删掉
            if (maxId > 0) trySend(JSONObject().put("ack", maxId).toString())
        }
    }

    private fun awaitPong(n: Long, timeoutMs: Long): Boolean {
        val end = System.currentTimeMillis() + timeoutMs
        synchronized(lock) {
            while (alive && pongSeq < n) {
                val left = end - System.currentTimeMillis()
                if (left <= 0) break
                try { lock.wait(left) } catch (e: InterruptedException) { return false }
            }
        }
        return pongSeq >= n && alive
    }

    /**
     * 睡 ms 毫秒，期间放掉 CPU 锁（有消息/断线会被 wake 提前叫醒）。running 变 false 或被打断返回 false 表示别再睡了。
     * untilDead：连接断了就不睡了（连着时用）；断着等重连时传 false，不管连接，睡够为止。
     */
    private fun sleepReleasing(ms: Long, untilDead: Boolean = true): Boolean {
        if (ms <= 0) return running()
        var ok = true
        Power.sleepWhile(0) {
            val end = System.currentTimeMillis() + ms
            synchronized(lock) {
                while (running() && (alive || !untilDead)) {
                    val left = end - System.currentTimeMillis()
                    if (left <= 0) break
                    try { lock.wait(left) } catch (e: InterruptedException) { ok = false; break }
                }
            }
        }
        return ok && running()
    }

    private fun wake() { synchronized(lock) { lock.notifyAll() } }

    private fun trySend(s: String): Boolean = try { ws?.send(s) == true } catch (e: Exception) { false }

    private fun closeWs() {
        runCatching { ws?.close(1000, null) }
        runCatching { ws?.cancel() }
        ws = null
    }

    companion object {
        const val PONG_TIMEOUT_MS = 10_000L
    }
}

/**
 * 常驻推送收到的指令去重。不碰安卓的类，可以在电脑上跑测试。
 *
 * 服务端的消息编号只在它这次运行里递增，云盘一重启（家里电脑重启、更新）就从 1 重新数。
 * 以前按服务端编号去重：重启后新指令的编号和以前的撞上，全被当成「重发的」扔掉，
 * 再确认一个旧的大编号，服务端把新指令也删了，直播和别的指令全都收不到，只能重开 App。
 * 现在按控制端给每条指令起的 id（时间 + 随机串，全局唯一）去重；没有 id 的指令只在同一条连接里按服务端编号去重。
 */
class RelayDedup(private val keep: Int = 500) {
    private val cmdIds = object : LinkedHashMap<String, Boolean>(64, 0.75f, false) {
        override fun removeEldestEntry(e: Map.Entry<String, Boolean>) = size > keep
    }
    private val seqs = HashSet<Long>()

    /** 连上了新的一条（服务端可能重启过，编号不再可信）。 */
    @Synchronized fun newConnection() { seqs.clear() }

    /** 这条要不要执行：第一次见到返回 true，重发的返回 false。 */
    @Synchronized fun fresh(seq: Long, cmdId: String?): Boolean {
        if (!cmdId.isNullOrBlank()) return cmdIds.put(cmdId, true) == null
        return seq <= 0 || seqs.add(seq)
    }
}
