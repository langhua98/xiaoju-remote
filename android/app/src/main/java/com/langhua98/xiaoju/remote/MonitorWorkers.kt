package com.langhua98.xiaoju.remote

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * Telegram 提醒：有新的事件就发一条（带截图），两次之间至少隔 cooldown 分钟；
 * 冷却期间的事件不单独发，下一条提醒里说「这之前还有 N 次」。在自己的线程上发，不卡相机。
 */
class Notifier(private val cloud: Cloud, private val prefs: Prefs, private val device: String) {
    private val q = LinkedBlockingQueue<Pair<String, ByteArray?>>(20)
    @Volatile private var lastAt = 0L
    @Volatile private var skipped = 0
    /** 最近一次发的结果（给 monitor_status 看） */
    @Volatile var status = "还没发过"
        private set
    private val thread = Thread({ loop() }, "notify").apply { isDaemon = true; start() }

    /** 有新的事件。cooldownMin 分钟内发过就先攒着。 */
    fun event(at: Long, jpg: ByteArray?, cooldownMin: Int, labels: String = "") {
        val now = System.currentTimeMillis()
        if (now - lastAt < cooldownMin * 60_000L) { skipped++; return }
        lastAt = now
        val t = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date(at))
        val more = if (skipped > 0) "（这之前 $cooldownMin 分钟里还有 $skipped 次）" else ""
        skipped = 0
        val what = if (labels.isEmpty()) "有动静" else "有动静：$labels"
        q.offer("🍊 小橘遥控 · $device\n$t $what$more" to jpg)
    }

    /** 随便发一句（打开侦测时确认 Telegram 通不通）。 */
    fun text(s: String) { q.offer("🍊 小橘遥控 · $device\n$s" to null) }

    private fun loop() {
        while (true) {
            val (text, jpg) = try { q.take() } catch (e: InterruptedException) { return }
            try {
                val chat = Power.hold { cloud.notify(text, jpg, prefs.tgChat) }
                if (chat != 0L && chat != prefs.tgChat) prefs.tgChat = chat
                status = "已发到 Telegram（${SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())}）"
            } catch (e: HttpError) {
                status = when (e.code) {
                    404 -> "云盘服务端还不能发 Telegram 提醒（要先更新服务端）"
                    501 -> "云盘服务端没有配置 Telegram 机器人"
                    else -> "Telegram 提醒没发出去：${e.message}"
                }
                Bus.push(status)
            } catch (e: Exception) {
                status = "Telegram 提醒没发出去：${e.message ?: e.javaClass.simpleName}"
                Bus.push(status)
            }
        }
    }
}

/**
 * 录像慢慢备份到云盘：一次传一个，传完歇 1 分钟再传下一个，限速 bps；有人在看实时画面时不传（不抢网速）。
 * 云盘存储后面是 Telegram，传太快会被限流，所以宁可慢。路径 /小橘推送/遥控/<设备>/录像/<日期>/<时间>.mov。
 *
 * 0.32：老系统（Android 4.2，CPU 能睡）上，Object.wait 的计时只在 CPU 醒着时走，CPU 睡着就停了。
 * 以前「等 20 秒看一眼」「出错 5 分钟后再试」在 S4 上要等几十分钟到几个小时，录像几乎传不上去。
 * 现在什么时候该传按 elapsedRealtime（睡着的时间也算）记在 BackupSchedule 里，
 * 由 RemoteService 2 分钟一次的闹钟看门狗 kick() 叫醒来看；云盘断过又回来了（cloudBack）马上接着传。
 */
class Uploader(
    private val cloud: Cloud, private val store: EventStore, private val device: String,
    private val enabled: () -> Boolean, private val busy: () -> Boolean,
) {
    @Volatile var status = ""
        private set
    @Volatile private var stop = false
    /** 这次启动后核对过「已备份」的录像云盘上还在不在（见 EventStore.forgetMissing） */
    @Volatile private var verified = false
    private val wake = Object()
    private val plan = BackupSchedule { android.os.SystemClock.elapsedRealtime() }
    private val thread = Thread({ loop() }, "backup").apply { isDaemon = true; start() }

    fun close() { stop = true; kick() }

    /** 叫醒备份线程看一眼（闹钟看门狗、录完一段时叫）。 */
    fun kick() { synchronized(wake) { wake.notifyAll() } }

    /** 云盘连上了：之前出错在等着重试的，马上再试。 */
    fun cloudBack() { if (plan.cloudBack()) kick() }

    /** 云盘上的路径。 */
    fun pathFor(e: EventInfo): String =
        "/小橘推送/遥控/$device/录像/${SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date(e.at))}/${e.name}.mov"

    /** 现在就传这一段（iPhone 要看一段还没备份的大视频时），返回云盘路径。 */
    fun uploadNow(e: EventInfo): String {
        val p = pathFor(e)
        cloud.uploadSlow(p, store.mov(e.name).readBytes(), FAST_BPS)
        store.markUploaded(e.name, p)
        return p
    }

    private fun loop() {
        var today = ""
        var count = 0
        while (!stop) {
            // CPU 醒着时最多等 20 秒；睡着时这里不走，靠看门狗 kick
            synchronized(wake) { try { wake.wait(20_000L) } catch (e: InterruptedException) { return } }
            if (stop) return
            if (!plan.due()) continue
            if (!enabled() || busy()) continue
            try {
                Power.hold { step(today, count) }?.let { (d, c) -> today = d; count = c }
            } catch (e: OutOfMemoryError) {
                // 一段特别大、读不进内存：别让备份线程死掉，记下来跳过去不太好（会一直卡在这段），先等一会儿再试
                status = "备份出错（内存不够），5 分钟后再试"
                Bus.push(status)
                plan.failed()
            }
        }
    }

    /** 传一段。返回新的（日期，今天传了几段）；没事做返回 null。 */
    private fun step(today0: String, count0: Int): Pair<String, Int>? {
        if (!verified) {
            try {
                val lost = store.forgetMissing { cloud.names(it) }
                verified = true
                if (lost > 0) { status = "云盘上少了 $lost 段（云盘搬家时丢的），重新备份"; Bus.push(status) }
            } catch (ex: Exception) {
                status = "核对云盘备份出错，5 分钟后再试：${ex.message}"
                Bus.push(status)
                plan.failed()
                return null
            }
        }
        val day = SimpleDateFormat("yyyyMMdd", Locale.US).format(Date())
        val count = if (day != today0) 0 else count0
        if (count >= DAILY_MAX) { status = "今天已经备份了 $count 段，明天接着传"; return day to count }
        val e = store.pendingUpload().firstOrNull() ?: return day to count
        val f = store.mov(e.name)
        if (!f.exists()) return day to count
        return try {
            val p = pathFor(e)
            cloud.uploadSlow(p, f.readBytes(), SLOW_BPS)
            store.markUploaded(e.name, p)
            plan.done()
            val left = store.pendingUpload().size
            status = "已备份 ${e.name}" + if (left > 0) "，还有 $left 段等着" else ""
            Bus.push(status)
            day to count + 1
        } catch (ex: Exception) {
            status = "备份出错，5 分钟后再试（云盘回来了马上试）：${ex.message}"
            Bus.push(status)
            plan.failed()
            day to count
        }
    }

    companion object {
        const val SLOW_BPS = 128 * 1024        // 平时备份：128 KB/s
        const val FAST_BPS = 512 * 1024        // iPhone 等着看：快一点
        const val DAILY_MAX = 500
    }
}

/**
 * 备份什么时候该再看一眼。时间用 now()（安卓上是 elapsedRealtime，CPU 睡着的时间也算），不碰安卓的类，可以在电脑上测。
 * - 传完一段：歇 GAP_MS 再传下一段；
 * - 出错：RETRY_MS 后再试，云盘回来了（cloudBack）马上再试。
 */
class BackupSchedule(private val now: () -> Long) {
    @Volatile private var nextAt = 0L
    @Volatile var failing = false
        private set

    fun due(): Boolean = now() >= nextAt
    fun done() { failing = false; nextAt = now() + GAP_MS }
    fun failed() { failing = true; nextAt = now() + RETRY_MS }

    /** 云盘连上了。之前出错在等：清掉等待，返回 true（要叫醒备份线程）。 */
    fun cloudBack(): Boolean {
        if (!failing) return false
        failing = false
        nextAt = 0L
        return true
    }

    companion object {
        const val GAP_MS = 60_000L             // 两个文件之间歇 1 分钟
        const val RETRY_MS = 5 * 60_000L       // 出错 5 分钟后再试
    }
}
