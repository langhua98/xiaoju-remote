package com.langhua98.xiaoju.remote

import android.annotation.TargetApi
import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageFormat
import android.graphics.Matrix
import android.graphics.Rect
import android.graphics.YuvImage
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * 相机总管：实时画面和移动侦测共用一个相机、一个硬件 H.264 编码器。
 *
 *   相机（NV21）─┬─ 移动侦测（每 200 ms 看一帧）→ 有动静：截图、Telegram 提醒、开始录
 *               ├─ H.264 编码器 ─┬─ 实时画面（有人在看、要 H.264 时）：云盘直播通道 / 同一个 Wi-Fi 直连
 *               │                └─ 事件录像（内存里一直留着最近几秒，有动静才写文件）
 *               └─ JPEG（实时画面的兼容模式、硬件编码用不了时）
 *
 * 实时画面卡顿的处理：网络跟不上丢了帧，马上要一个关键帧（4.2 不支持「要关键帧」，就重开编码器，
 * 重开后第一帧就是关键帧，卡大约 0.1 秒，不用等满 1 秒）；老是丢就把码率降下来，好了再慢慢升回去。
 *
 * 侦测开着时相机一直开着（间歇守望时没动静就关一会儿，见 rest）；只看实时画面时，看的人走了相机就关。
 * 直播中看的一端可以换镜头、调参数，直播完恢复侦测自己的设置。
 */
class CameraHub(
    private val ctx: Context, private val prefs: Prefs, cloud: Cloud, private val device: String,
    private val serviceRunning: () -> Boolean, private val status: (String) -> Unit,
) {
    val settings = LiveSettings(false, 640, 50, 10, LiveSettings.H264)
    @Volatile var monitor: MonitorConfig = prefs.monitor
        private set

    val store = EventStore(eventsDir())
    private val detector = MotionDetector()          // Kotlin 基准版（engine = kotlin，以及 ab 对比里的一半）
    /** 现在用的侦测引擎（MotionEngine.kt）：monitor 指令的 engine 字段选，换了就重新计数 */
    @Volatile private var engine: MotionEngine = KotlinMotion(detector)
    private val engineLock = Object()
    @Volatile private var mstats = MotionStats(MonitorConfig.KOTLIN) { battery() }
    @Volatile private var engineNote = ""
    private var aiBuf = ByteArray(0)                 // 录像中再认一次时复用的画面缓冲区（AI 线程用，detBusy 保证一次一个）
    private val recorder = EventRecorder(store)
    private val notifier = Notifier(cloud, prefs, device)
    val uploader = Uploader(cloud, store, device, enabled = { monitor.upload }, busy = { watching() })
    private val work = Executors.newSingleThreadExecutor()   // 截图、存小图、发提醒（不卡相机）

    @Volatile private var thread: Thread? = null

    // 实时画面：一次直播 = 云盘直播通道的推流 + 同一个 Wi-Fi 里直连进来的观看端
    private class Live(val room: String, val av: Boolean, val audio: Boolean, val until: Long) {
        val started = System.currentTimeMillis()
        @Volatile var cloud: StreamClient? = null
        val lan = java.util.concurrent.CopyOnWriteArrayList<LanViewer>()
        @Volatile var lastWatched = 0L
        fun sinks(): List<LiveSink> = listOfNotNull<LiveSink>(cloud) + lan
        fun watched(): List<LiveSink> = sinks().filter { !it.isClosed && it.watchers > 0 }
    }
    @Volatile private var live: Live? = null
    private val lanServer = LanServer(roomOk = { r -> live?.room == r }, onViewer = { v -> lanViewer(v) })

    // 码率自适应：网络跟不上（丢帧）就降，稳了再升
    @Volatile private var rateScale = 1.0
    @Volatile private var restartEnc = false
    @Volatile private var keyAt = 0L
    private val drops = java.util.concurrent.ConcurrentLinkedQueue<Long>()
    @Volatile private var lastDrop = 0L
    @Volatile private var rateChangedAt = 0L

    // 编码（相机线程上用；编出来的帧在编码器线程上分发）
    @Volatile private var enc: H264Encoder? = null
    private var encConf = ""
    private var encSince = 0L
    private var encLogged = ""
    private var fed = 0
    @Volatile private var h264Broken = false
    private var brokenBySize = false   // 退回 JPEG 只是因为这个镜头的尺寸不合适（换镜头后再试）
    private var brokenVersion = -1
    @Volatile private var rot = 0
    @Volatile private var encW = 0
    @Volatile private var encH = 0
    private val jpg = ByteArrayOutputStream(64 * 1024)

    private val stamper = TimeStamp()

    // 侦测
    private val preroll = PreRoll()               // 省电侦测守望时留的最近几帧
    private var prerollPending = false            // 编码器一开就先喂 preroll（相机线程上用）
    private var lastLook = 0L
    private var detVersion = -1
    private var detTweak = -1
    private var detRot = -1
    @Volatile private var regionsDirty = true
    @Volatile private var lastEvent = ""

    // 声音
    private var mic: AudioCapture? = null
    private var micFailedAt = 0L

    // 侦测 / 直播时拍照：从画面截一张
    @Volatile private var grabLatch: CountDownLatch? = null
    @Volatile private var grabbed: ByteArray? = null
    @Volatile private var grabW = 0
    @Volatile private var grabH = 0
    @Volatile private var grabRot = 0

    private var housekeepAt = 0L

    init {
        settings.flip = prefs.flip
        settings.stamp = prefs.stamp
        applyMonitor()
        recorder.onClosed = { e ->
            Bus.push(if (e.video) "录好一段：${e.name}，${e.durMs / 1000} 秒" else "记下一次动静：${e.name}（只有截图）")
            work.execute { store.cleanup() }
        }
        recorder.onError = { Bus.push(it) }
    }

    val cameraOn get() = thread?.isAlive == true
    /** 侦测正在用麦克风（录音指令要让一让） */
    val micOn get() = mic != null
    fun liveActive() = live != null
    fun watching() = live?.watched()?.isNotEmpty() == true
    private fun wanted() = serviceRunning() && (monitor.on || liveActive())

    /** 服务启动时：上次开着侦测就接着侦测。 */
    fun resume() {
        if (!monitor.on) return
        settings.apply(monitor.cameraJson())
        Bus.push("接着移动侦测")
        ensure()
        status(stateText())
    }

    /** monitor 指令：改侦测设置（只改指令里出现的字段），返回现在的状态（给回执）。 */
    fun setMonitor(cmd: JSONObject): String {
        val old = monitor
        val m = old.merge(cmd)
        monitor = m
        prefs.monitor = m
        applyMonitor()
        if (m.on && !old.on) mstats = MotionStats(engine.name) { battery() }   // 重新打开侦测：耗电统计从头算
        // 直播中先不动相机（看的人在调），直播完再换成侦测的设置
        if (m.on && !liveActive()) settings.apply(m.cameraJson())
        kick()
        if (m.on) {
            ensure()
            if (!old.on && m.notify) notifier.text("移动侦测已打开，有动静会发到这里。")
        }
        status(stateText())
        return describe()
    }

    /**
     * 开始给一个观看端推实时画面（连好了的云盘直播通道）。原来的直播会被替换。
     * 同时在局域网里开着直连：同一个 Wi-Fi 的 iPhone 可以拿着同一个房间名直接连过来（地址见 lanAddresses）。
     */
    fun startLive(c: StreamClient, cmd: JSONObject, av: Boolean, audio: Boolean) {
        live?.let { old -> old.sinks().forEach { it.close() } }
        val s = JSONObject(cmd.toString())
        if (!s.has("codec")) s.put("codec", LiveSettings.JPEG)   // 老查看器只认 JPEG
        settings.codecNote = ""
        settings.apply(s)
        saveView()
        val l = Live(cmd.optString("room"), av, audio, System.currentTimeMillis() + RemoteService.LIVE_MAX_MS)
        l.cloud = c
        live = l
        kick()   // 间歇守望正歇着：马上开相机
        rateScale = 1.0
        if (!lanServer.start()) Bus.push("局域网直连开不了（端口被占用），只能经云盘看")
        forceKey()
        ensure()
        status(stateText())
    }

    /** 局域网直连的地址（ip:端口），放进开始直播的回执里给 iPhone。 */
    fun lanAddresses(): List<String> = lanServer.addresses()

    private fun lanViewer(v: LanViewer) {
        val l = live
        if (l == null) { v.close(); return }
        l.lan.add(v)
        Bus.push("同一个 Wi-Fi 的 ${v.remote} 直连来看了")
        forceKey()
    }

    /** 直播中 / 侦测中调相机（video_set、手电）。 */
    fun adjust(cmd: JSONObject): List<String> = settings.apply(cmd).also { saveView(); kick() }

    /** 翻转、时间戳记在手机上（侦测、下次直播都照这个来） */
    private fun saveView() { prefs.flip = settings.flip; prefs.stamp = settings.stamp }

    /** 从画面截一张照片（相机开着时拍照用），转正、JPEG。拿不到返回 null。 */
    fun grab(timeoutMs: Long = 3_000): ByteArray? {
        if (!cameraOn) return null
        grabbed = null
        val l = CountDownLatch(1)
        grabLatch = l
        // 间歇守望正歇着：叫醒，相机重开要一两秒
        val wait = if (resting) timeoutMs + 3_000 else timeoutMs
        kick()
        if (!l.await(wait, TimeUnit.MILLISECONDS)) { grabLatch = null; return null }
        grabLatch = null
        val d = grabbed ?: return null
        return Snapshot.jpeg(d, grabW, grabH, grabRot, 92, 0)
    }

    /** 状态（monitor_status 指令）。 */
    fun statusJson(): JSONObject {
        val today = SimpleDateFormat("yyyyMMdd", Locale.US).format(Date())
        val list = store.list()
        return JSONObject().put("monitor", monitor.toJson()).put("camera", cameraOn).put("live", liveActive())
.put("recording", recorder.recording).put("score", engine.score.toDouble()).put("noise", engine.noise.toDouble())
            .put("today", list.count { it.name.startsWith(today) }).put("events", list.size)
            .put("last", list.firstOrNull()?.name ?: "").put("pending", store.pendingUpload().size)
            .put("storage_mb", store.usedBytes() / (1 shl 20)).put("free_mb", store.dir.usableSpace / (1 shl 20))
            .put("telegram", notifier.status).put("backup", uploader.status).put("codec_note", settings.codecNote)
            .put("objects", if (objectsOn()) "FastestDet" else "")
            .put("eco", monitor.eco).put("stage", stage()).put("resting", resting)
            .put("current_ma", PowerMeter.currentMa(3, 100) ?: -1)
            .put("power", powerJson())
            .put("engine", mstats.json(engine).put("note", engineNote))
    }

    /** 侦测引擎的实测（「设备信息」里看）。没开侦测返回空。 */
    fun engineText(): String = if (!monitor.on) "" else mstats.text(engine) + if (engineNote.isEmpty()) "" else "\n$engineNote"

    /** 电量（%）和插没插电 */
    private fun battery(): Pair<Int, Boolean>? = runCatching {
        val b = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) ?: return@runCatching null
        val level = b.getIntExtra(android.os.BatteryManager.EXTRA_LEVEL, -1)
        val scale = b.getIntExtra(android.os.BatteryManager.EXTRA_SCALE, 100).coerceAtLeast(1)
        if (level < 0) null else (level * 100 / scale) to (b.getIntExtra(android.os.BatteryManager.EXTRA_PLUGGED, 0) != 0)
    }.getOrNull()

    /**
     * 耗电诊断：CPU 醒着、相机开着各占多少时间，相机实际的帧率档 / 尺寸 / 对焦，间歇守望歇了多少，电池电压和温度。
     * S4 读不到实时电流，换手机、改设置以后比这几个数。
     */
    fun powerJson(): JSONObject {
        val up = Power.upMs.coerceAtLeast(1)
        val o = JSONObject()
            .put("up_min", up / 60_000)
            .put("cpu_awake_pct", Power.heldMs * 100 / up)
            .put("camera_on_pct", CamStats.onMs * 100 / up)
            .put("camera_opens", CamStats.opens).put("camera_open_ms", CamStats.lastOpenMs)
            .put("fps_ranges", CamStats.fpsRanges).put("fps_now", CamStats.fpsNow)
            .put("preview", CamStats.size).put("focus", CamStats.focus)
            .put("callbacks", CamStats.callbacks).put("looks", looks)
            .put("rests", rests).put("rest_pct", restTotal * 100 / up)
            .put("motion_to_rec_ms", lastMotionToRecMs)
        runCatching {
            val b = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            if (b != null) {
                val level = b.getIntExtra(android.os.BatteryManager.EXTRA_LEVEL, -1)
                val scale = b.getIntExtra(android.os.BatteryManager.EXTRA_SCALE, 100).coerceAtLeast(1)
                o.put("battery_pct", level * 100 / scale)
                    .put("battery_mv", b.getIntExtra(android.os.BatteryManager.EXTRA_VOLTAGE, -1))
                    .put("battery_c", b.getIntExtra(android.os.BatteryManager.EXTRA_TEMPERATURE, -10) / 10.0)
                    .put("plugged", b.getIntExtra(android.os.BatteryManager.EXTRA_PLUGGED, 0) != 0)
            }
        }
        return o
    }

    /** 事件列表（events 指令）：新的在前，带小图（base64）。 */
    fun eventsJson(limit: Int, before: String): JSONArray {
        val a = JSONArray()
        for (e in store.list().filter { before.isEmpty() || it.name < before }.take(limit.coerceIn(1, 100))) {
            val o = e.toJson()
            val t = store.thumb(e.name)
            if (t.exists() && t.length() < 64 * 1024) o.put("thumb", Base64.encodeToString(t.readBytes(), Base64.NO_WRAP))
            val mov = store.mov(e.name)
            o.put("size", mov.length()).put("local", mov.exists())   // local=false：手机上的视频删了（备份好了，去云盘看）
            a.put(o)
        }
        return a
    }

    fun shutdown() {
        kick()
        if (receiverOn) runCatching { ctx.unregisterReceiver(dutyWake) }
        live?.sinks()?.forEach { it.close() }
        lanServer.close()
        thread?.let { runCatching { it.join(5_000) } }
        uploader.close()
        work.shutdown()
        detect.shutdown()
        synchronized(engineLock) { engine.close() }
    }

    // ---- 相机线程 ----

    @Synchronized private fun ensure() {
        if (thread?.isAlive == true || !wanted()) return
        thread = Thread({ cameraLoop() }, "camera-hub").apply { start() }
    }

    private fun cameraLoop() = Power.hold { cameraLoopInner() }   // 相机开着时 CPU 一直醒着

    @Volatile private var lastOpenErr = ""
    /** 直播中连着几次开不了相机 */
    private var liveOpenFails = 0

    private fun cameraLoopInner() {
        try {
            while (wanted()) {
                try {
                    sessionAt = 0L
                    restWanted = false
                    Camera.live(settings, running = {
                        if (Thread.currentThread() === thread) housekeep()
                        val rest = restDue()
                        if (rest) restWanted = true
                        wanted() && !rest
                    }) { nv21, w, h, r, ts -> frame(nv21, w, h, r, ts) }
                    // 间歇守望：看完这一轮没动静，相机已经关了，歇一会儿
                    if (restWanted && wanted()) { restWanted = false; rest(monitor.dutyOff * 1000L) }
                } catch (e: Exception) {
                    // 同样的错只记一次（相机服务卡住时每 5 秒一条，以前会刷满日志）
                    val msg = "相机打不开：${e.message}"
                    // 直播中：先不断直播，1 秒后再开（换清晰度时偶尔开一次失败，以前直播马上就断了）；连着 3 次都不行才结束
                    val inLive = live != null && ++liveOpenFails < 3
                    if (msg != lastOpenErr) { lastOpenErr = msg; Bus.push("$msg，${if (inLive) 1 else 5} 秒后再试") }
                    if (!inLive) { live?.let { endLive() }; liveOpenFails = 0 }
                    val pause = if (inLive) 1_000 else 5_000
                    var waited = 0
                    while (wanted() && waited < pause) { try { Thread.sleep(200) } catch (ie: InterruptedException) { return }; waited += 200 }
                }
            }
        } finally {
            closeEncoder()
            setMic(false)
            recorder.close()
            engine.reset()
            if (live != null) endLive()
            status(stateText())
        }
    }

    /** 相机线程上定时（大约 0.3 秒一次）：直播该不该结束、麦克风开关、录像按时结束。 */
    private fun housekeep() {
        val now = System.currentTimeMillis()
        if (now - housekeepAt < 300) return
        housekeepAt = now
        live?.let { l ->
            l.lan.removeAll { it.isClosed }
            if (l.watched().isNotEmpty()) l.lastWatched = now
            val cloudGone = l.cloud?.isClosed != false
            when {
                now > l.until -> endLive()
                cloudGone && l.lan.isEmpty() -> endLive()
                l.lastWatched == 0L && now - l.started > 20_000 -> endLive()   // 一直没人来看
                l.lastWatched > 0 && now - l.lastWatched > 8_000 -> endLive()  // 看的人都走了
            }
        }
        // 15 秒没丢过帧：码率慢慢升回去
        if (rateScale < 1.0 && now - lastDrop > 15_000 && now - rateChangedAt > 15_000) {
            rateScale = minOf(1.0, rateScale * 1.25); rateChangedAt = now
            Bus.push("网络好了，码率升到 ${(rateScale * 100).toInt()}%")
        }
        // 侦测录声音：省电侦测时只在录像时开麦克风（守望时关着）
        liveStats(now)
        setMic((watching() && live?.audio == true) || (monitor.on && monitor.audio && (!monitor.eco || recorder.recording)))
        if (!monitor.on && recorder.recording) recorder.close()
        recorder.tick()
    }

    private fun endLive() {
        val l = live ?: return
        live = null
        val sinks = l.sinks()
        sinks.forEach { it.close() }
        Bus.push("直播结束：发出 ${sinks.sumOf { it.sentFrames }} 帧，网络跟不上丢了 ${sinks.sumOf { it.droppedFrames }} 帧")
        // 恢复侦测自己的相机设置（看的人可能换了镜头、开了手电）
        if (monitor.on) settings.apply(monitor.cameraJson().put("torch", false).put("exposure", 0).put("zoom", 0))
        status(stateText())
    }

    /**
     * 相机来的每一帧。省电侦测（monitor.eco）分两档：
     * - 守望（没动静、没人看直播）：相机降到最低帧率档、每秒只给 4 帧（LiveSettings.watch），编码器、麦克风关着，
     *   只做移动侦测，顺便留最近几帧（preroll）；
     * - 录像（有动静到最后一次动静后 post 秒）：编码器打开，先把留的几帧喂进去（录像从动静前一两秒开始），再接着录。
     * 不省电时编码器一直开着（录像能从动静前 pre 秒开始）。
     */
    private fun frame(nv21: ByteArray, w: Int, h: Int, r: Int, ts: Long) {
        val t0 = System.nanoTime()
        try { frameInner(nv21, w, h, r, ts) } finally {
            val ms = (System.nanoTime() - t0) / 1_000_000
            statWork.addAndGet(ms); statFrames.incrementAndGet()
            if (ms > statWorkMax) statWorkMax = ms
        }
    }

    // ---- 直播实测（每秒一次，发给直连的看的一端，也记到日志）：哪一步慢一眼看得出来 ----
    private val statFrames = java.util.concurrent.atomic.AtomicInteger()   // 相机线程处理了几帧
    private val statWork = java.util.concurrent.atomic.AtomicLong()        // 一共花了多少毫秒
    @Volatile private var statWorkMax = 0L
    private val statTry = java.util.concurrent.atomic.AtomicInteger()      // 想喂编码器几帧
    private val statFed = java.util.concurrent.atomic.AtomicInteger()      // 喂进去几帧
    private val statOut = java.util.concurrent.atomic.AtomicInteger()      // 编出来 / 发出去几帧
    private val statLat = java.util.concurrent.atomic.AtomicLong()         // 从相机交帧到编好，一共多少毫秒
    private val statBytes = java.util.concurrent.atomic.AtomicLong()
    private var statAt = 0L
    private var statCb = 0L
    private var statDrops = 0
    private var statLogAt = 0L
    private var slowSecs = 0
    @Volatile private var slowEncoder = ""
    @Volatile var lastStats = ""; private set

    /** 相机线程管家里每秒算一次。 */
    private fun liveStats(now: Long) {
        val l = live
        if (l == null || l.watched().isEmpty()) { statAt = 0L; return }
        val drops = l.sinks().sumOf { it.droppedFrames }
        if (statAt == 0L) {
            statAt = now; statCb = CamStats.callbacks; statDrops = drops; statLogAt = now; slowSecs = 0
            for (a in listOf(statFrames, statTry, statFed, statOut)) a.set(0)
            statWork.set(0); statLat.set(0); statBytes.set(0); statWorkMax = 0
            return
        }
        val dt = now - statAt
        if (dt < 1000) return
        fun per(n: Int) = Math.round(n * 1000.0 / dt).toInt()
        val cam = Math.round((CamStats.callbacks - statCb) * 1000.0 / dt).toInt()
        val frames = statFrames.getAndSet(0)
        val work = statWork.getAndSet(0)
        val workMax = statWorkMax; statWorkMax = 0
        val tries = statTry.getAndSet(0); val fed = statFed.getAndSet(0)
        val out = statOut.getAndSet(0); val lat = statLat.getAndSet(0)
        val kbps = statBytes.getAndSet(0) * 8 / dt
        val h = settings.codec == LiveSettings.H264 && !h264Broken
        val dropN = drops - statDrops
        val j = JSONObject().put("v", Updater.versionName(ctx)).put("codec", if (h) "h264" else "jpeg")
            .put("cam", cam).put("used", per(frames)).put("fed", per(fed)).put("out", per(out)).put("want", settings.fps)
            .put("lat", if (out > 0) lat / out else -1).put("work", if (frames > 0) work / frames else 0).put("work_max", workMax)
            .put("drop", dropN).put("kbps", kbps).put("target", encRate / 1000)
            .put("boost", Math.round(encBoost * 10) / 10.0).put("scale", Math.round(rateScale * 100))
            .put("enc", if (h) enc?.name ?: "" else "").put("size", "${encW}x$encH").put("range", CamStats.fpsNow)
        statAt = now; statCb = CamStats.callbacks; statDrops = drops
        val text = j.toString()
        lastStats = text
        val b = text.toByteArray(Charsets.UTF_8)
        val msg = ByteArray(b.size + 1); msg[0] = 5; System.arraycopy(b, 0, msg, 1, b.size)
        for (s in l.lan) s.sendStats(msg)
        if (now - statLogAt >= 10_000) {
            statLogAt = now
            Bus.push("直播实测：相机 $cam 帧/秒，用 ${per(frames)}，喂 ${per(fed)}，出 ${per(out)}；编码延迟 ${if (out > 0) lat / out else -1} ms；" +
                "每帧处理 ${if (frames > 0) work / frames else 0}（最长 $workMax）ms；$kbps kbps；丢 $dropN")
        }
        // 硬件编码器跟不上（喂 10 帧只出五六帧）连着 6 秒：这台手机的编码器太慢，改用 JPEG（同一个 Wi-Fi 里 JPEG 反而又快又清楚）
        if (h && tries >= 5 && out * 10 < tries * 6) {
            if (++slowSecs >= 6) { slowSecs = 0; slowEncoder = "硬件编码器太慢（每秒要 ${per(tries)} 帧只出 ${per(out)} 帧）" }
        } else slowSecs = 0
    }

    private fun frameInner(nv21: ByteArray, w: Int, h: Int, r: Int, ts: Long) {
        rot = r
        val l = live
        val sinks = l?.watched().orEmpty()
        val m = monitor
        val now = System.currentTimeMillis()
        // 上次是因为尺寸不合适才退回 JPEG：换了镜头 / 清晰度，新的尺寸可能可以，再试硬件编码
        if (h264Broken && brokenBySize && settings.version != brokenVersion) { h264Broken = false; brokenBySize = false; settings.codecNote = "" }
        // 刚开相机的第一帧：这一轮从这里算；头几帧曝光还在变，不看（间歇守望每轮都重开相机）
        if (sessionAt == 0L) {
            sessionAt = now; settleUntil = now + SETTLE_MS
            lastOpenErr = ""   // 相机又好了：下次再打不开要再记
            liveOpenFails = 0
            engine.pause()
            preroll.clear()   // 上一轮留的帧隔着一段空白，不要了
        }
        // 先看有没有动静（在印时间之前看：跳动的秒数不能算动静）；省电侦测时，发现动静的这一帧就开始录
        val wasRec = recorder.recording
        if (m.on && now >= settleUntil) look(nv21, w, h, r, ts)
        if (!wasRec && recorder.recording) motionAt = now
        val eco = m.on && m.eco
        val rec = m.on && (!eco || recorder.recording)
        // 印日期时间：之后的直播、录像、截图都带上。守望时（不录、没直播、不截图）不印，
        // 留下的几帧开始录时按拍下的钟点补印（见 h264 里喂 preroll）
        if (settings.stamp && (rec || l != null || grabLatch != null)) stamper.draw(nv21, w, h, r, now)
        grabLatch?.let { gl ->
            if (grabbed == null) { grabbed = nv21.copyOf(); grabW = w; grabH = h; grabRot = r; gl.countDown() }
        }
        val liveH264 = sinks.isNotEmpty() && settings.codec == LiveSettings.H264
        settings.watchFps = engine.watchFps
        settings.setWatch(eco && !rec && l == null)
        val wantH264 = !h264Broken && (rec || liveH264)
        if (wantH264) {
            if (enc == null && eco && rec) prerollPending = true
            h264(nv21, w, h, ts, liveH264)
        } else if (enc != null) {
            closeEncoder()
            if (eco) recorder.dropBuffered()   // 回到守望：内存里的旧录像不要了（下次从新留的几帧开始）
        }
        if (eco && !rec && enc == null) preroll.add(nv21, w, h, ts, now)
        else if (preroll.size > 0) preroll.clear()
        if (l != null && sinks.isNotEmpty() && (settings.codec == LiveSettings.JPEG || h264Broken)) jpegLive(l, sinks, nv21, w, h, r, ts)
    }

    private fun h264(nv21: ByteArray, w: Int, h: Int, ts: Long, liveNow: Boolean) {
        if (!H264.sizeOk(w, h)) {
            giveUp("这个镜头没有硬件编码合适的尺寸（${w}×$h）"); brokenBySize = true; brokenVersion = settings.version; return
        }
        val want = maxOf(H264.MIN_BITRATE / 2, (H264.bitrate(settings.width, settings.fps, settings.quality) * rateScale).toInt())
        // 有人看时：编码器实际出得太少就多要一些（见 H264.boost）
        val rate = if (liveNow) (want * encBoost).toLong().coerceAtMost(8_000_000L).toInt() else want
        val conf = "${w}x$h/${settings.fps}/$rate"
        try {
            if (liveNow && slowEncoder.isNotEmpty()) { val why = slowEncoder; slowEncoder = ""; giveUp(why); return }
            if (restartEnc) { restartEnc = false; closeEncoder() }   // 重开：第一帧就是关键帧
            if (enc == null || conf != encConf) {
                closeEncoder()
                encW = w; encH = h
                val e = H264Encoder(w, h, settings.fps, rate) { data, key, t -> onEncoded(data, key, t) }
                enc = e; encConf = conf; encSince = System.currentTimeMillis(); fed = 0; encRate = rate
                measAt = 0L
                if (conf != encLogged) { encLogged = conf; Bus.push("H.264 硬件编码：${e.name}，${w}×$h，${rate / 1000} kbps") }
                // 省电侦测刚开始录：先喂守望时留的几帧（动静前一两秒），录像从那里开始
                if (prerollPending) {
                    prerollPending = false
                    val stamp = settings.stamp
                    preroll.drain(w, h) { f ->
                        if (f.ts < ts) {
                            if (stamp) stamper.draw(f.data, f.w, f.h, rot, f.wall)
                            if (e.feed(f.data, f.ts, 30_000)) fed++
                        }
                    }
                }
            }
            val e = enc ?: return
            // 有人看时等编码器一小会儿（以前它一忙这一帧就丢了，帧率上不去）
            if (liveNow) statTry.incrementAndGet()
            if (e.feed(nv21, ts, if (liveNow) 15_000 else 0)) { fed++; if (liveNow) statFed.incrementAndGet() }
            if (liveNow) measure(want)
            if (motionAt > 0) { lastMotionToRecMs = System.currentTimeMillis() - motionAt; motionAt = 0L }
            if (e.produced == 0 && fed > 5 && System.currentTimeMillis() - encSince > 3000) giveUp("硬件编码器不出画面")
        } catch (t: Throwable) {
            giveUp("硬件编码出错：${t.message ?: t.javaClass.simpleName}")
        }
    }

    // 量编码器实际出的码率（相机线程上用；outBytes 在编码器线程上加）
    private val outBytes = java.util.concurrent.atomic.AtomicLong()
    private var measAt = 0L
    private var measFed = 0
    @Volatile private var encBoost = 1.0

    /** 每 4 秒看一次编码器实际出了多少：比要的少很多就把倍数调高（下一帧按新码率重开编码器）。 */
    private fun measure(want: Int) {
        val now = System.currentTimeMillis()
        if (measAt == 0L) { measAt = now; measFed = fed; outBytes.set(0); return }
        if (now - measAt < 4_000) return
        val actual = outBytes.getAndSet(0) * 8000 / (now - measAt)
        val fedN = fed - measFed
        measAt = now; measFed = fed
        if (fedN < 12) return   // 帧太少，量不准
        val b = H264.boost(encBoost, want, actual)
        if (b != encBoost) {
            Bus.push("编码器要 ${want / 1000} kbps 只出 ${actual / 1000} kbps，给它的码率调到 ${String.format(java.util.Locale.US, "%.1f", b)} 倍")
            encBoost = b
        }
    }

    /** 编码器线程上：编好的一帧发给每个在看的（云盘 / 直连），交给录像。 */
    private fun onEncoded(data: ByteArray, key: Boolean, ts: Long) {
        outBytes.addAndGet(data.size.toLong())
        val l = live
        if (l != null && settings.codec == LiveSettings.H264) {
            val sinks = l.watched()
            if (sinks.isNotEmpty()) {
                val msg = StreamClient.h264(data, rot, ts, key)
                // 积压超过大约 0.4 秒的数据就丢（延迟不越拖越长），丢了等关键帧。
                // 最少 64 KB：以前是 24 KB，一个关键帧就有二三十 KB，刚发完关键帧后面的帧就被当成积压丢掉，帧率上不去、码率还被降
                val limit = maxOf(64L * 1024, encRate / 8L * 4 / 10)
                var dropped = false
                for (s in sinks) if (!s.sendH264(msg, key, limit) && s.watchers > 0) dropped = true
                if (!dropped) framesOut.incrementAndGet()
                statOut.incrementAndGet(); statLat.addAndGet(StreamClient.now() - ts); statBytes.addAndGet(data.size.toLong())
                if (dropped) onDrop()
            }
        }
        if (monitor.on) recorder.video(data, key, ts, encW, encH, rot)
    }

    @Volatile private var encRate = 500_000

    /** 实时画面发出去的帧数（测速时看跑模型会不会拖慢直播） */
    private val framesOut = java.util.concurrent.atomic.AtomicInteger()

    /** 量 windowMs 毫秒里实时画面每秒发出几帧（阻塞）。 */
    fun framesPerSecond(windowMs: Long): Double {
        val a = framesOut.get()
        Thread.sleep(windowMs)
        return (framesOut.get() - a) * 1000.0 / windowMs
    }

    /** 丢了帧：要一个关键帧；5 秒里丢了 3 次以上就把码率降到 70%（最低 30%）。 */
    private fun onDrop() {
        val now = System.currentTimeMillis()
        lastDrop = now
        drops.add(now)
        while ((drops.peek() ?: now) < now - 5_000) drops.poll()
        if (drops.size >= 3 && now - rateChangedAt > 3_000 && rateScale > 0.3) {
            rateScale = maxOf(0.3, rateScale * 0.7); rateChangedAt = now; drops.clear()
            Bus.push("网络跟不上，码率降到 ${(rateScale * 100).toInt()}%")
        }
        forceKey(restartOld = false)
    }

    /**
     * 马上出一个关键帧：4.4+ 直接要。更老的（S4 是 4.2）只能重开编码器，restartOld = true 才重开（一秒最多一次）。
     * 网络跟不上丢帧时不重开：重开编码器要在相机线程上卡几百毫秒，丢帧越多重开越多，画面一顿一顿的；
     * 编码器每秒本来就出一个关键帧，等它就行（最多 1 秒）。
     */
    private fun forceKey(restartOld: Boolean = true) {
        val now = System.currentTimeMillis()
        if (now - keyAt < 1_000) return
        if (android.os.Build.VERSION.SDK_INT >= 19) { keyAt = now; enc?.requestKeyframe() }
        else if (restartOld && enc != null) { keyAt = now; restartEnc = true }
    }

    private fun giveUp(why: String) {
        closeEncoder()
        h264Broken = true
        settings.codecNote = "$why，实时画面改用 JPEG" + if (monitor.on) "，侦测只能存截图" else ""
        Bus.push(settings.codecNote)
    }

    private fun closeEncoder() { enc?.close(); enc = null; encConf = "" }

    private fun jpegLive(l: Live, sinks: List<LiveSink>, nv21: ByteArray, w: Int, h: Int, r: Int, ts: Long) {
        try {
            jpg.reset()
            YuvImage(nv21, ImageFormat.NV21, w, h, null).compressToJpeg(Rect(0, 0, w, h), settings.quality, jpg)
            val b = jpg.toByteArray()
            val msg = if (l.av) StreamClient.frameTs(b, r, ts) else StreamClient.frame(b, r)
            for (s in sinks) s.send(msg)
            framesOut.incrementAndGet()
            statOut.incrementAndGet(); statLat.addAndGet(StreamClient.now() - ts); statBytes.addAndGet(b.size.toLong())
        } catch (e: Throwable) { /* 丢这一帧 */ }
    }

    /**
     * 移动侦测：Kotlin 基准版每 200 ms 看一帧；C++ 版自己定（待命 500 ms、疑似 250 ms、录像 200 ms）。
     * 新的事件截一张图、发提醒；AI（FastestDet）只在有动静时、在另一个线程上跑。
     */
    private fun look(nv21: ByteArray, w: Int, h: Int, r: Int, ts: Long) {
        val now = System.currentTimeMillis()
        val eng = engine
        if (now - lastLook < eng.minGapMs) return
        lastLook = now
        looks++
        val moving: Boolean
        synchronized(engineLock) {
            if (eng !== engine) return   // 刚换了引擎：下一帧用新的
            if (settings.version != detVersion || settings.tweak != detTweak) {
                detVersion = settings.version; detTweak = settings.tweak
                eng.reset()   // 换了镜头、调了亮度：重新学背景
            }
            if (regionsDirty || r != detRot) { eng.setRegions(monitor.regions, r); detRot = r; regionsDirty = false }
            val st = mstats
            st.look(now, eng.stage, CamStats.callbacks)
            val t0 = System.nanoTime()
            moving = eng.analyze(nv21, w, h, now, recorder.recording)
            if (eng !is DualMotion) st.timed(eng.name, System.nanoTime() - t0)
        }
        if (moving && recorder.motion(ts)) {
            val e = recorder.current ?: return
            lastEvent = e.name
            mstats.event()
            Bus.push("有动静：${e.name}")
            newEvent(e, nv21.copyOf(), w, h, r)
            return
        }
        // 事件进行中：每 1.5 秒再认一次（新进来的人、刚才没认出来的）。画面拷到复用的缓冲区，不每次分配
        // 有人在看实时画面时不认（跑模型很吃 CPU，这台老手机上会把直播拖卡）
        if (recorder.recording && !detBusy && now - lastDetect > 1_500 && objectsOn() && !watching()) {
            lastDetect = now
            detBusy = true
            if (aiBuf.size != nv21.size) aiBuf = ByteArray(nv21.size)
            System.arraycopy(nv21, 0, aiBuf, 0, nv21.size)
            val copy = aiBuf
            detect.execute { Power.hold { try { later(copy, w, h, r) } finally { detBusy = false } } }
        }
    }

    /** 按设置换侦测引擎（换了才换：新的要重新学背景，统计也从头算）。 */
    private fun pickEngine(m: MonitorConfig) {
        var want = m.engine
        engineNote = ""
        if (want != MonitorConfig.KOTLIN && !MotionNative.available) {
            engineNote = "这个安装包没带 C++ 侦测库，用的是 Kotlin 版"
            want = MonitorConfig.KOTLIN
        }
        synchronized(engineLock) {
            if (engine.name != want) {
                val old = engine
                engine = when (want) {
                    MonitorConfig.NATIVE -> NativeMotion()
                    MonitorConfig.AB -> DualMotion(KotlinMotion(detector), NativeMotion()) { mstats }
                    else -> KotlinMotion(detector)
                }
                if (old !is KotlinMotion) old.close()
                detector.reset()
                mstats = MotionStats(want) { battery() }
                detRot = -1
                if (m.on) Bus.push("移动侦测引擎：" + when (want) { MonitorConfig.NATIVE -> "C++ 超低功耗版"; MonitorConfig.AB -> "C++ 和 Kotlin 对比"; else -> "Kotlin 基准版" })
            }
            engine.configure(m)
        }
    }

    // ---- 认出动的是什么（FastestDet，见 ObjectDetector）：在单独一个后台线程上，一个核，只在有动静时跑 ----
    private val detect = Executors.newSingleThreadExecutor()
    @Volatile private var detBusy = false
    @Volatile private var lastDetect = 0L
    private val evCounts = HashMap<Int, Int>()      // 这次事件里认出过的：类别 → 最多同时几个
    @Volatile private var evNotified = false

    private fun objectsOn() = ObjectDetector.usable

    /** 认一帧，只留「会动的、而且就在画面变了的地方」的（不然床、椅子、停着的车每次都算进来）。 */
    private fun recognize(nv21: ByteArray, w: Int, h: Int): List<ObjectDetector.Detection> {
        if (!ObjectDetector.ready(ctx)) return emptyList()
        Process.setThreadPriority(Process.THREAD_PRIORITY_BACKGROUND)
        return ObjectDetector.detect(nv21, w, h).filter { it.canMove && engine.moved(it.x1, it.y1, it.x2, it.y2) }
    }

    /** 记下这次认出来的，更新正在录的那段的标签。返回现在的汇总。 */
    private fun merge(ds: List<ObjectDetector.Detection>): String = synchronized(evCounts) {
        for ((cls, n) in ds.groupingBy { it.cls }.eachCount()) evCounts[cls] = maxOf(evCounts[cls] ?: 0, n)
        val text = ObjectDetector.summaryOf(evCounts)
        recorder.current?.labels = text
        text
    }

    /** 新的事件：认一下是什么、截图（框出来）、存小图、发提醒。 */
    private fun newEvent(e: EventInfo, nv21: ByteArray, w: Int, h: Int, r: Int) {
        synchronized(evCounts) { evCounts.clear() }
        evNotified = false
        lastDetect = System.currentTimeMillis()
        detBusy = true
        val m = monitor
        detect.execute { Power.hold {
            try {
                val skipAi = watching()   // 有人在看实时画面：不跑模型，直播要紧
                val ds = if (objectsOn() && !skipAi) recognize(nv21, w, h) else emptyList()
                val labels = merge(ds)
                e.labels = labels
                if (labels.isNotEmpty()) Bus.push("认出来：$labels")
                val big = Snapshot.jpeg(nv21, w, h, r, 80, 0, ds)
                store.jpg(e.name).writeBytes(big)
                store.thumb(e.name).writeBytes(Snapshot.jpeg(nv21, w, h, r, 60, 200, ds))
                // 「只在有人时提醒」：认出人才发；认不了（没带模型）就照常发
                if (m.notify && (!m.personOnly || skipAi || !ObjectDetector.ready(ctx) || ds.any { it.isPerson })) {
                    notifier.event(e.at, big, m.cooldownMin, labels)
                    evNotified = true
                }
            } catch (ex: Exception) {
                Bus.push("存截图出错：${ex.message}")
            } finally { detBusy = false }
        } }
    }

    /** 事件进行中又认了一次：补上标签；「只在有人时提醒」又还没发过时，认出人就发。 */
    private fun later(nv21: ByteArray, w: Int, h: Int, r: Int) {
        val ds = recognize(nv21, w, h)
        if (ds.isEmpty()) return
        val labels = merge(ds)
        val m = monitor
        if (m.notify && m.personOnly && !evNotified && ds.any { it.isPerson }) {
            evNotified = true
            val e = recorder.current ?: return
            notifier.event(e.at, Snapshot.jpeg(nv21, w, h, r, 80, 0, ds), m.cooldownMin, labels)
        }
    }

    private fun setMic(on: Boolean) {
        val m = mic
        if (on && m == null) {
            if (System.currentTimeMillis() - micFailedAt < 60_000) return
            if (ctx.checkPermission(android.Manifest.permission.RECORD_AUDIO, Process.myPid(), Process.myUid()) != PackageManager.PERMISSION_GRANTED) {
                micFailedAt = System.currentTimeMillis(); return
            }
            val a = AudioCapture { data, codec, ts -> onAudio(data, codec, ts) }
            if (a.start()) mic = a else { micFailedAt = System.currentTimeMillis(); Bus.push("声音没开成：${a.error}") }
        } else if (!on && m != null) {
            m.stop(); mic = null
        }
    }

    private fun onAudio(data: ByteArray, codec: Int, ts: Long) {
        val l = live
        if (l != null && l.audio) {
            val sinks = l.watched()
            if (sinks.isNotEmpty()) { val msg = StreamClient.audio(data, codec, ts); for (s in sinks) s.sendAudio(msg) }
        }
        if (monitor.on && monitor.audio) recorder.audio(data, if (codec == StreamClient.AUDIO_ULAW_8K) 8000 else 16000, ts)
    }

    private fun applyMonitor() {
        val m = monitor
        recorder.preMs = m.preSec * 1000L
        preroll.windowMs = if (m.eco) m.ecoPreMs else 0
        recorder.postMs = m.postSec * 1000L
        detector.sensitivity = m.sensitivity
        pickEngine(m)
        regionsDirty = true
    }

    /** 侦测现在在哪一档：off / watch（省电守望）/ record（在录，或不省电时一直开着编码器） */
    /** 守望时相机每秒交几帧（Kotlin 版 4 帧；C++ 版待命 2 帧、疑似 4 帧） */
    fun watchFps(): Int = engine.watchFps

    fun stage(): String = when {
        !monitor.on -> "off"
        monitor.eco && !recorder.recording && live == null -> "watch"
        else -> "record"
    }

    private fun stateText(): String = when {
        monitor.on && liveActive() -> "正在被远程使用：移动侦测 + 实时画面"
        monitor.on && monitor.dutyActive -> "正在被远程使用：移动侦测中（间歇守望）"
        monitor.on && monitor.eco -> "正在被远程使用：移动侦测中（省电）"
        monitor.on -> "正在被远程使用：移动侦测中"
        liveActive() -> "正在被远程使用：实时画面"
        else -> "待命中，等指令"
    }

    /** 回执里的一句话。 */
    fun describe(): String {
        val m = monitor
        if (!m.on) return "移动侦测已关闭（录好的 ${store.list().size} 段还在手机上）"
        val area = if (m.regions.isEmpty()) "整个画面" else "${m.regions.size} 个区域"
        val pre = if (m.eco) "省电（动静前留 ${m.ecoPreMs / 1000} 秒画面）" else "动静前 ${m.preSec} 秒"
        val eng = when (engine.name) {
            MonitorConfig.NATIVE -> "，C++ 超低功耗引擎（待命 ${m.standbyFps} 帧/秒，疑似时连续 ${m.confirm} 帧确认）"
            MonitorConfig.AB -> "，C++ 和 Kotlin 两个引擎对比"
            else -> ""
        } + if (engineNote.isEmpty()) "" else "（$engineNote）"
        val duty = if (m.dutyActive) "，间歇守望（看 ${m.dutyOn} 秒、歇 ${m.dutyOff} 秒，歇着时的动静会漏）" else ""
        return "移动侦测已打开：$area，灵敏度 ${m.sensitivity}，$pre、后 ${m.postSec} 秒$duty$eng" +
            (if (m.notify) "，Telegram 提醒（隔 ${m.cooldownMin} 分钟）" else "，不提醒") +
            (if (m.upload) "，慢慢备份到云盘" else "，只存手机") +
            (if (h264Broken) "（${settings.codecNote}）" else "")
    }

    // ---- 间歇守望：没动静时相机看 dutyOn 秒、关掉歇 dutyOff 秒（相机关、CPU 锁放掉，闹钟叫醒）----

    @Volatile var resting = false
        private set
    @Volatile private var restWanted = false
    @Volatile private var kicked = false
    private val restLock = Object()
    @Volatile private var sessionAt = 0L      // 这次开相机后第一帧的时间（0 = 还没来）
    private var settleUntil = 0L              // 这之前的帧不看（刚开相机曝光还在变）
    @Volatile private var looks = 0L
    @Volatile private var rests = 0
    @Volatile private var restTotal = 0L
    private var motionAt = 0L                 // 发现动静的时间（算到开始录用了多久）
    @Volatile private var lastMotionToRecMs = -1L

    /** 这一轮看够了、可以歇了吗：开着间歇守望、在守望（不录、没直播、不截图、没开手电）、背景学好了、没有看到一半的动静。 */
    private fun restDue(): Boolean {
        val m = monitor
        if (!m.dutyActive || live != null || recorder.recording || grabLatch != null || settings.torch) return false
        val at = sessionAt
        if (at == 0L || System.currentTimeMillis() - at < m.dutyOn * 1000L) return false
        val e = engine
        return e.ready && !e.pending
    }

    /** 有事（直播、拍照、改设置、停止）：不歇了，马上开相机。 */
    private fun kick() {
        kicked = true
        synchronized(restLock) { restLock.notifyAll() }
    }

    /** 相机线程上：歇 ms 毫秒。老系统（没有 Doze）上放掉 CPU 锁、定一个闹钟叫醒；有事被 kick 就马上回去。 */
    private fun rest(ms: Long) {
        val start = SystemClock.elapsedRealtime()
        // 闹钟没定上就别放锁（不然 CPU 睡着了没人叫醒，要等到别的事把它叫醒）
        val sleepCpu = Power.canSleep && setAlarm(start + ms)
        resting = true
        if (sleepCpu) Power.release()
        try {
            synchronized(restLock) {
                while (!kicked && wanted() && restStillOk()) {
                    val left = start + ms - SystemClock.elapsedRealtime()
                    if (left <= 0) break
                    restLock.wait(left)
                }
            }
        } catch (e: InterruptedException) {
        } finally {
            if (sleepCpu) { Power.acquire(); cancelAlarm() }
            kicked = false
            resting = false
            rests++
            restTotal += SystemClock.elapsedRealtime() - start
        }
    }

    private fun restStillOk(): Boolean = monitor.dutyActive && live == null && grabLatch == null && !settings.torch

    /** 闹钟叫醒：先拿一下 CPU 锁（相机线程醒来自己再拿），叫醒歇着的相机线程。 */
    private val dutyWake = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            Power.acquire()
            Handler(Looper.getMainLooper()).postDelayed({ Power.release() }, 2_000)
            kick()
        }
    }

    private fun dutyIntent(): PendingIntent = PendingIntent.getBroadcast(ctx, 3,
        Intent(ACTION_DUTY_WAKE).setPackage(ctx.packageName),
        PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0))

    @Volatile private var receiverOn = false

    private fun setAlarm(atElapsed: Long): Boolean =
        runCatching {
            if (!receiverOn) { ctx.registerReceiver(dutyWake, IntentFilter(ACTION_DUTY_WAKE)); receiverOn = true }
            val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            // 4.4 起 set() 不准时（会被系统攒到一起），要用 setExact；4.2、4.3 的 set() 本来就准
            if (Build.VERSION.SDK_INT >= 19) ExactAlarm.set(am, atElapsed, dutyIntent())
            else am.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, atElapsed, dutyIntent())
            true
        }.getOrElse { Bus.push("间歇守望的闹钟没定上：${it.message}"); false }

    private fun cancelAlarm() {
        runCatching { (ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager).cancel(dutyIntent()) }
    }

    companion object {
        const val ACTION_DUTY_WAKE = "com.langhua98.xiaoju.remote.DUTY_WAKE"
        /** 开相机以后这么多毫秒内的帧不看（自动曝光还在调） */
        const val SETTLE_MS = 500L
    }

    private fun eventsDir(): File {
        val ext = try { ctx.getExternalFilesDir("events") } catch (e: Exception) { null }
        if (ext != null && (ext.isDirectory || ext.mkdirs()) && ext.canWrite()) return ext
        return File(ctx.filesDir, "events")
    }
}

@TargetApi(19)
private object ExactAlarm {
    fun set(am: AlarmManager, atElapsed: Long, pi: PendingIntent) =
        am.setExact(AlarmManager.ELAPSED_REALTIME_WAKEUP, atElapsed, pi)
}

/** NV21 → 转正的 JPEG（maxW > 0 时缩小到这么宽，做小图）。 */
object Snapshot {
    /** boxes：认出来的东西，在图上框出来、写上名字 */
    fun jpeg(nv21: ByteArray, w: Int, h: Int, rot: Int, quality: Int, maxW: Int,
             boxes: List<ObjectDetector.Detection> = emptyList()): ByteArray {
        val raw = ByteArrayOutputStream()
        YuvImage(nv21, ImageFormat.NV21, w, h, null).compressToJpeg(Rect(0, 0, w, h), 95, raw)
        val r = (rot % 360 + 360) % 360
        if (r == 0 && maxW <= 0 && quality >= 95 && boxes.isEmpty()) return raw.toByteArray()
        val src = BitmapFactory.decodeByteArray(raw.toByteArray(), 0, raw.size()) ?: return raw.toByteArray()
        val outW = if (r == 90 || r == 270) h else w
        val scale = if (maxW in 1 until outW) maxW.toFloat() / outW else 1f
        val m = Matrix().apply { postRotate(r.toFloat()); postScale(scale, scale) }
        var bmp = Bitmap.createBitmap(src, 0, 0, w, h, m, true)
        if (boxes.isNotEmpty()) {
            if (!bmp.isMutable) { val c = bmp.copy(Bitmap.Config.ARGB_8888, true); if (bmp !== src) bmp.recycle(); bmp = c }
            draw(bmp, boxes, r)
        }
        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.JPEG, quality, out)
        if (bmp !== src) bmp.recycle()
        src.recycle()
        return out.toByteArray()
    }

    private fun draw(bmp: Bitmap, boxes: List<ObjectDetector.Detection>, rot: Int) {
        val c = android.graphics.Canvas(bmp)
        val bw = bmp.width.toFloat(); val bh = bmp.height.toFloat()
        val line = android.graphics.Paint().apply {
            style = android.graphics.Paint.Style.STROKE; color = 0xFFFF8C1A.toInt(); strokeWidth = maxOf(2f, bw / 160)
        }
        val text = android.graphics.Paint().apply {
            color = 0xFFFFFFFF.toInt(); textSize = maxOf(10f, bw / 22); isAntiAlias = true
        }
        val back = android.graphics.Paint().apply { color = 0xCCFF8C1A.toInt() }
        for (d in boxes) {
            val u = ObjectDetector.upright(d, rot)
            val x1 = u[0] * bw; val y1 = u[1] * bh; val x2 = u[2] * bw; val y2 = u[3] * bh
            c.drawRect(x1, y1, x2, y2, line)
            val label = d.name
            val tw = text.measureText(label) + text.textSize / 2
            val ty = if (y1 > text.textSize * 1.3f) y1 else y2 + text.textSize * 1.3f
            c.drawRect(x1, ty - text.textSize * 1.25f, x1 + tw, ty, back)
            c.drawText(label, x1 + text.textSize / 4, ty - text.textSize * 0.3f, text)
        }
    }
}
