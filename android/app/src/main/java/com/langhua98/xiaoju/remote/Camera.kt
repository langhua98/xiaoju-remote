package com.langhua98.xiaoju.remote

import android.annotation.TargetApi
import android.content.Context
import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.SurfaceTexture
import android.graphics.YuvImage
import android.hardware.Camera as LegacyCamera
import java.io.ByteArrayOutputStream
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit


/**
 * 相机。用老的 android.hardware.Camera（Android 4.2 没有 Camera2），新系统上也能用。
 * 无预览拍照：给相机一个看不见的 SurfaceTexture 当预览目标。
 */
@Suppress("DEPRECATION")
object Camera {
    /** 预览缓冲区几块（一直都放在相机手里，用完马上还） */
    private const val BUFFERS = 3
    /** 正在开相机（LegacyCamera.open 还没回来）从什么时候开始，0 = 没在开 */
    @Volatile var openingSince = 0L
        private set

    /**
     * 开相机，所有开相机的地方都走这里。S4 的系统相机服务卡住时，open 会一直不回来（不报错）：
     * 这时再开新的只会多卡一个线程（0.20 每 5 秒开一次，越堆越多，手机很卡），所以上一次还没回来就直接报错。
     */
    fun open(id: Int): LegacyCamera {
        val since = openingSince
        if (since > 0) throw IllegalStateException(
            "系统相机服务卡住了（上次开相机 ${(System.currentTimeMillis() - since) / 1000} 秒还没回来），重启手机就好")
        openingSince = System.currentTimeMillis()
        try { return LegacyCamera.open(id) } finally { openingSince = 0L }
    }

    /** 相机这么久没交一帧：补缓冲区 */
    private const val STALL_REFILL_MS = 4_000L

    /** 后置镜头的编号（手电用） */
    fun backId(): Int = findCamera(false)

    private fun findCamera(front: Boolean): Int {
        val want = if (front) LegacyCamera.CameraInfo.CAMERA_FACING_FRONT else LegacyCamera.CameraInfo.CAMERA_FACING_BACK
        val info = LegacyCamera.CameraInfo()
        for (i in 0 until LegacyCamera.getNumberOfCameras()) {
            LegacyCamera.getCameraInfo(i, info)
            if (info.facing == want) return i
        }
        return 0
    }

    /** 旧接口（即时信箱的旧直播用）：参数固定、有时长，一帧一张 JPEG。 */
    fun stream(front: Boolean, targetW: Int, quality: Int, fps: Int, durationMs: Long,
               running: () -> Boolean, onFrame: (jpg: ByteArray, rot: Int, ts: Long) -> Unit) {
        val end = System.currentTimeMillis() + durationMs
        val out = ByteArrayOutputStream(64 * 1024)
        live(LiveSettings(front, targetW, quality, fps), { running() && System.currentTimeMillis() < end }) { data, w, h, rot, ts ->
            out.reset()
            YuvImage(data, ImageFormat.NV21, w, h, null).compressToJpeg(Rect(0, 0, w, h), quality, out)
            onFrame(out.toByteArray(), rot, ts)
        }
    }

    /**
     * 实时画面：连续从预览里取帧（NV21），按 settings 的帧率交给 onFrame。阻塞调用，直到 running 变 false。
     * 用老相机的预览回调，4.2 也能跑。预览缓冲区是固定的两块轮着用（不每帧新分配内存，老手机上不会因为回收内存一顿一顿）；
     * onFrame 返回后这块缓冲区会还给相机，要留数据得自己拷。
     * 省电（见 FramePacer）：相机手里最多一块缓冲区，只在下一帧快该用时才给，用不上的帧在驱动里就丢了，不拷贝；
     * 传感器帧率只选够用的最低一档（LiveSettings.pickFpsRange），守望时（settings.watch）换到更低的一档。
     * rot 是画面要顺时针旋转多少度才是正的，交给看的一端去转（省这台老手机的 CPU）。
     * 直播中改 settings：镜头/清晰度/编码会关掉相机重开，其他的当场生效。
     */
    fun live(s: LiveSettings, running: () -> Boolean,
             onFrame: (nv21: ByteArray, w: Int, h: Int, rot: Int, ts: Long) -> Unit) {
        if (LegacyCamera.getNumberOfCameras() == 0) throw IllegalStateException("这台手机没有摄像头")
        Torch.releaseLegacy()
        val ht = HandlerThread("vid").apply { start() }
        val h = Handler(ht.looper)
        try {
            while (running()) {
                val ver = s.version
                val front = s.front
                var pf = s.profile   // 开相机时用的帧率档（之后变了就换）
                val ready = CountDownLatch(1)
                var startErr: Throwable? = null
                var cam: LegacyCamera? = null
                var tex: SurfaceTexture? = null
                var feed: Feed? = null
                h.post {
                    try {
                        val t0 = System.currentTimeMillis()
                        val id = findCamera(front)
                        val c = open(id)
                        cam = c
                        val rot = LegacyCamera.CameraInfo().also { LegacyCamera.getCameraInfo(id, it) }.orientation
                        val p = c.parameters
                        val sz = LiveSettings.pickSize(p.supportedPreviewSizes.map { it.width to it.height },
                            s.width, s.codec == LiveSettings.H264)
                        sz?.let { p.setPreviewSize(it.first, it.second) }
                        p.previewFormat = ImageFormat.NV21
                        // 传感器帧率：够用的最低一档（跑得越快越费电）
                        p.supportedPreviewFpsRange?.let { LiveSettings.pickFpsRange(it, s.fps, s.watch) }
                            ?.let { p.setPreviewFpsRange(it[0], it[1]) }
                        // 对焦：一直连续对焦（0.18 守望时定焦、直播时再换回来，S4 一换对焦预览就不出画面了，0.21 去掉）
                        LiveSettings.pickFocus(p.supportedFocusModes ?: emptyList(), false)?.let { p.focusMode = it }
                        try { c.parameters = p } catch (e: RuntimeException) {
                            // 有的手机不接受这个帧率范围：去掉再试
                            val q = c.parameters
                            sz?.let { q.setPreviewSize(it.first, it.second) }
                            q.previewFormat = ImageFormat.NV21
                            c.parameters = q
                        }
                        tweak(c, s, front)
                        val fw = c.parameters.previewSize.width
                        val fh = c.parameters.previewSize.height
                        val t = SurfaceTexture(20); tex = t
                        c.setPreviewTexture(t)
                        val size = fw * fh * ImageFormat.getBitsPerPixel(ImageFormat.NV21) / 8
                        // 缓冲区：3 块一直放在相机手里，每帧用完马上还（见 Feed）
                        val st = Feed(c, size)
                        feed = st
                        val pacer = FramePacer()
                        var frameErrLogged = false
                        c.setPreviewCallbackWithBuffer { data, _ ->
                            if (data == null) return@setPreviewCallbackWithBuffer
                            st.lastFrameAt = System.currentTimeMillis()
                            CamStats.callbacks++
                            val now = System.currentTimeMillis()
                            // 按节拍抽帧：平均下来正好是要的帧率（守望时每秒 4 帧）
                            if (running() && pacer.due(now, s.frameFps)) {
                                val ts = StreamClient.now()   // 采集时间（和声音同一个时钟）
                                val r = if (s.flip) (rot + 180) % 360 else rot   // 上下翻转 = 多转 180°
                                try { onFrame(data, fw, fh, r, ts) } catch (e: Throwable) {
                                    // 丢这一帧；每次开相机只记第一次（以前一声不吭，出了错根本看不出来）
                                    if (!frameErrLogged) { frameErrLogged = true; Bus.push("处理画面出错：${e.message ?: e.javaClass.simpleName}") }
                                }
                            }
                            // 用完马上还给相机（不能让相机手里没有缓冲区，见 Feed）
                            if (data.size >= st.size) st.give(data)
                        }
                        st.fill()
                        c.startPreview()
                        st.lastFrameAt = System.currentTimeMillis()
                        CamStats.opened(c.parameters, System.currentTimeMillis() - t0)
                    } catch (e: Throwable) { startErr = e } finally { ready.countDown() }
                }
                // 8 秒还没开好：当打不开处理（以前会当成开好了，相机线程空转、一帧画面都没有）
                if (!ready.await(8, TimeUnit.SECONDS) && startErr == null) startErr = IllegalStateException("8 秒还没打开")
                startErr?.let { e ->
                    val done = CountDownLatch(1)
                    h.post { feed?.open = false; cleanup(cam, tex); done.countDown() }
                    done.await(3, TimeUnit.SECONDS)
                    throw e
                }
                var tw = s.tweak
                var refilled = false
                while (running() && s.version == ver) {
                    if (s.tweak != tw) { tw = s.tweak; h.post { cam?.let { runCatching { tweak(it, s, front) } } } }
                    if (s.profile != pf) { pf = s.profile; h.post { cam?.let { runCatching { switchFps(it, s, feed) } } } }
                    // 保险：相机好几秒没交一帧（缓冲区丢了、驱动卡住），先补缓冲区，还不行就关掉重开
                    val f = feed
                    val quiet = if (f == null) 0L else System.currentTimeMillis() - f.lastFrameAt
                    if (quiet > STALL_REFILL_MS && !refilled) {
                        refilled = true
                        Bus.push("相机 ${quiet / 1000} 秒没出画面，重新给缓冲区")
                        h.post { f?.refill() }
                    } else if (quiet < STALL_REFILL_MS) refilled = false
                    // 0.20 在这里 10 秒没画面就关掉相机重开，S4 上一直循环，手机很卡、手电录音都用不了，0.21 去掉
                    try { Thread.sleep(100) } catch (e: InterruptedException) { break }
                }
                // 关掉这台相机（换镜头/清晰度时接着开新的）
                val closed = CountDownLatch(1)
                h.post {
                    feed?.open = false
                    runCatching { cam?.setPreviewCallbackWithBuffer(null) }; cleanup(cam, tex); closed.countDown()
                }
                closed.await(3, TimeUnit.SECONDS)
                CamStats.closed()
            }
        } finally {
            ht.quit()
        }
    }

    /**
     * 预览缓冲区：BUFFERS 块一直放在相机手里，每帧用完马上还，用不上的帧在 Java 这边丢掉（FramePacer.due）。
     *
     * 0.13～0.21 为了省电，相机手里最多放一块、快用到时才给。三星 S4（Android 4.2）受不了：
     * 相机手里一没有缓冲区，系统就把预览回调关掉（日志「Callback buffer was too small! … got 0 bytes」），
     * 预览也卡住（「BufferQueue: min undequeued buffer count exceeded」），之后再也不交画面：
     * 直播没画面、侦测看不到东西、拍照「没截到画面」。0.22 改回最稳的做法。
     */
    private class Feed(val cam: LegacyCamera, val size: Int) {
        var open = true
        /** 上一帧回调的时间（开预览时也算一次） */
        @Volatile var lastFrameAt = System.currentTimeMillis()
        /** 一块缓冲区交给相机 */
        fun give(b: ByteArray) {
            if (!open) return
            try { cam.addCallbackBuffer(b) } catch (e: RuntimeException) { }
        }
        /** 给相机 BUFFERS 块新的缓冲区（开预览前、停过预览以后） */
        fun fill() { repeat(BUFFERS) { give(ByteArray(size)) } }
        fun refill() = fill()
    }


    /**
     * 相机开着时换传感器帧率档（进出守望）：大多数手机能直接设；不行就停一下预览再设（不用重开相机，大约 0.2 秒）。
     * 停预览时相机手里的缓冲区可能被收走，重开后再给一块。
     */
    private fun switchFps(c: LegacyCamera, s: LiveSettings, feed: Feed?) {
        val p = c.parameters
        var changed = false
        val r = p.supportedPreviewFpsRange?.let { LiveSettings.pickFpsRange(it, s.fps, s.watch) }
        val cur = IntArray(2).also { p.getPreviewFpsRange(it) }
        if (r != null && (cur[0] != r[0] || cur[1] != r[1])) { p.setPreviewFpsRange(r[0], r[1]); changed = true }
        // 对焦方式不在开着的相机上换（0.18 这么做，S4 一换预览就停了：直播没画面）
        if (!changed) return
        try {
            c.parameters = p
        } catch (e: RuntimeException) {
            runCatching { c.stopPreview() }
            runCatching { c.parameters = p }
            c.startPreview()
            feed?.refill()   // 停预览时相机手里的缓冲区收不回来了，补上
        }
        CamStats.update(c.parameters)
    }

    /** 在开着的相机上设亮度、变焦、手电；不支持的记到 s.unsupported。 */
    private fun tweak(c: LegacyCamera, s: LiveSettings, front: Boolean) {
        val p = c.parameters
        val no = ArrayList<String>()
        val min = p.minExposureCompensation
        val max = p.maxExposureCompensation
        if (min != 0 || max != 0) p.exposureCompensation = LiveSettings.exposureIndex(s.exposure, min, max)
        else if (s.exposure != 0f) no += "调亮度"
        if (p.isZoomSupported) p.zoom = Math.round(s.zoom * p.maxZoom)
        else if (s.zoom > 0f) no += "变焦"
        val flash = p.supportedFlashModes ?: emptyList()
        if (s.torch && !front && "torch" in flash) p.flashMode = "torch"
        else {
            if (s.torch) no += if (front) "前置镜头开手电" else "手电"
            if ("off" in flash) p.flashMode = "off"
        }
        c.parameters = p
        s.unsupported = if (no.isEmpty()) "" else "这台手机不支持" + no.joinToString("、")
    }

    private fun cleanup(cam: LegacyCamera?, tex: SurfaceTexture?) {
        runCatching { cam?.stopPreview() }
        runCatching { cam?.release() }
        runCatching { tex?.release() }
    }

    /** 拍一张 JPEG。阻塞调用，不要在主线程上调。 */
    fun capture(front: Boolean, flip: Boolean = false, timeoutMs: Long = 15_000): ByteArray {
        if (LegacyCamera.getNumberOfCameras() == 0) throw IllegalStateException("这台手机没有摄像头")
        Torch.releaseLegacy()   // 老接口开着手电时相机被占用，先关掉
        val ht = HandlerThread("cam").apply { start() }
        val h = Handler(ht.looper)
        val latch = CountDownLatch(1)
        var result: ByteArray? = null
        var error: Throwable? = null
        var cam: LegacyCamera? = null
        var tex: SurfaceTexture? = null

        h.post {
            try {
                val id = findCamera(front)
                val c = open(id)
                cam = c
                val info = LegacyCamera.CameraInfo().also { LegacyCamera.getCameraInfo(id, it) }
                val p = c.parameters
                // 选不超过 1920 的最大尺寸，传得快一点
                val size = p.supportedPictureSizes
                    .filter { maxOf(it.width, it.height) <= 1920 }
                    .maxByOrNull { it.width * it.height }
                    ?: p.supportedPictureSizes.minByOrNull { it.width * it.height }
                size?.let { p.setPictureSize(it.width, it.height) }
                p.pictureFormat = ImageFormat.JPEG
                p.jpegQuality = 85
                p.setRotation((info.orientation + if (flip) 180 else 0) % 360)   // 竖着拿手机时照片方向正确；倒装时再转 180°
                val modes = p.supportedFocusModes ?: emptyList()
                when {
                    "continuous-picture" in modes -> p.focusMode = "continuous-picture"
                    "auto" in modes -> p.focusMode = "auto"
                }
                c.parameters = p
                val t = SurfaceTexture(10)
                tex = t
                c.setPreviewTexture(t)
                c.startPreview()
                // 给自动曝光一点时间
                h.postDelayed({
                    try {
                        c.takePicture(null, null) { data, _ -> result = data; latch.countDown() }
                    } catch (e: Throwable) { error = e; latch.countDown() }
                }, 900)
            } catch (e: Throwable) { error = e; latch.countDown() }
        }

        val done = latch.await(timeoutMs, TimeUnit.MILLISECONDS)
        h.post {
            runCatching { cam?.stopPreview() }
            runCatching { cam?.release() }
            runCatching { tex?.release() }
            ht.quit()
        }
        if (!done) throw IllegalStateException("拍照超时")
        error?.let { throw it }
        return result ?: throw IllegalStateException("没拿到照片数据")
    }
}

/**
 * 相机的耗电诊断（monitor_status 的 power 里给出来）：这台手机实际用的帧率档、尺寸、对焦，
 * 开了几次相机、每次开要多久、一共开了多久、预览回调来了几次。
 */
@Suppress("DEPRECATION")
object CamStats {
    @Volatile var opens = 0; private set
    @Volatile var lastOpenMs = 0L; private set
    @Volatile var fpsRanges = ""; private set
    @Volatile var fpsNow = ""; private set
    @Volatile var size = ""; private set
    @Volatile var focus = ""; private set
    /** 预览回调次数（只在相机线程上加） */
    @Volatile var callbacks = 0L
    private var onSince = 0L
    private var onTotal = 0L

    @Synchronized fun opened(p: LegacyCamera.Parameters, ms: Long) {
        opens++; lastOpenMs = ms; onSince = System.currentTimeMillis()
        update(p)
    }

    @Synchronized fun closed() {
        if (onSince > 0) { onTotal += System.currentTimeMillis() - onSince; onSince = 0L }
    }

    fun update(p: LegacyCamera.Parameters) {
        runCatching {
            fpsRanges = p.supportedPreviewFpsRange?.joinToString(" ") { "${fps(it[0])}-${fps(it[1])}" } ?: ""
            val cur = IntArray(2).also { p.getPreviewFpsRange(it) }
            fpsNow = "${fps(cur[0])}-${fps(cur[1])}"
            size = "${p.previewSize.width}x${p.previewSize.height}"
            focus = p.focusMode ?: ""
        }
    }

    private fun fps(v: Int): String = if (v % 1000 == 0) "${v / 1000}" else String.format(java.util.Locale.US, "%.1f", v / 1000.0)

    /** 相机一共开了多少毫秒 */
    val onMs: Long @Synchronized get() = onTotal + (if (onSince > 0) System.currentTimeMillis() - onSince else 0L)
}

/** 手电筒：Android 6.0+ 用 CameraManager.setTorchMode，更老的用老相机接口的常亮闪光灯。 */
@Suppress("DEPRECATION")
object Torch {
    private var legacy: LegacyCamera? = null
    private var legacyTex: SurfaceTexture? = null

    fun set(ctx: Context, on: Boolean): String {
        if (Build.VERSION.SDK_INT >= 23) return Torch23.set(ctx, on)
        if (!on) { releaseLegacy(); return "手电筒已关闭" }
        if (legacy != null) return "手电筒已打开"
        if (LegacyCamera.getNumberOfCameras() == 0) return "这台手机没有摄像头"
        val c = Camera.open(Camera.backId())
        val p = c.parameters
        val modes = p.supportedFlashModes ?: emptyList()
        if ("torch" !in modes) { c.release(); return "这台手机不支持手电筒常亮" }
        p.flashMode = "torch"
        c.parameters = p
        val t = SurfaceTexture(11)
        c.setPreviewTexture(t)
        c.startPreview()
        legacy = c; legacyTex = t
        return "手电筒已打开"
    }

    fun releaseLegacy() {
        legacy?.let { c ->
            runCatching { val p = c.parameters; p.flashMode = "off"; c.parameters = p }
            runCatching { c.stopPreview() }
            runCatching { c.release() }
        }
        runCatching { legacyTex?.release() }
        legacy = null; legacyTex = null
    }
}

@TargetApi(23)
private object Torch23 {
    fun set(ctx: Context, on: Boolean): String {
        val mgr = ctx.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val id = mgr.cameraIdList.firstOrNull {
            mgr.getCameraCharacteristics(it).get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
        } ?: return "这台手机没有闪光灯"
        mgr.setTorchMode(id, on)
        return "手电筒已${if (on) "打开" else "关闭"}"
    }
}
