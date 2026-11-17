package com.langhua98.xiaoju.remote

import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile

/**
 * μ-law 声音写成 WAV（.wav，单声道，每个样本 1 字节）。iPhone、电脑都能直接放。
 * 边录边写，close() 时回头把长度补进文件头；没 close 的文件头里长度是 0，多数播放器放不了。
 * 中间断了（麦克风丢过数据）补静音，时间对得上。不碰安卓的类，可以在电脑上跑测试。
 *
 * @param t0 第一个样本的时间（毫秒，和 audio 的时间戳同一个时钟）
 */
class WavWriter(private val file: File, val rate: Int, private val t0: Long) {
    private val out = BufferedOutputStream(FileOutputStream(file), 16 * 1024)
    private var samples = 0L
    private var closed = false

    init { out.write(header(rate, 0)) }

    fun audio(ulaw: ByteArray, ts: Long) {
        check(!closed)
        if (ulaw.isEmpty()) return
        val expected = t0 + samples * 1000 / rate
        val gap = (ts - expected) * rate / 1000
        if (gap > rate / 10) {   // 晚了 0.1 秒以上：补静音（μ-law 的 0xFF），最多补 10 秒
            val silence = ByteArray(minOf(gap, rate * 10L).toInt()) { 0xFF.toByte() }
            out.write(silence); samples += silence.size
        }
        out.write(ulaw); samples += ulaw.size
    }

    /** 补文件头、关文件。返回时长（毫秒）。 */
    fun close(): Long {
        if (closed) return 0
        closed = true
        if (samples % 2 == 1L) out.write(0)   // RIFF 的数据块要凑成偶数个字节
        out.close()
        RandomAccessFile(file, "rw").use { it.seek(0); it.write(header(rate, samples)) }
        return samples * 1000 / rate
    }

    companion object {
        const val HEADER_SIZE = 58

        /** WAV 文件头（58 字节）：格式 7 = μ-law，带 fact 块（不是 PCM 的 WAV 要有）。n = 样本数。 */
        fun header(rate: Int, n: Long): ByteArray {
            val b = ByteArrayOutputStream(HEADER_SIZE)
            fun ascii(s: String) = b.write(s.toByteArray(Charsets.US_ASCII))
            fun le32(v: Long) { for (i in 0 until 4) b.write(((v shr (8 * i)) and 0xFF).toInt()) }
            fun le16(v: Int) { b.write(v and 0xFF); b.write((v shr 8) and 0xFF) }
            ascii("RIFF"); le32(HEADER_SIZE - 8 + n + n % 2); ascii("WAVE")
            ascii("fmt "); le32(18); le16(7); le16(1); le32(rate.toLong()); le32(rate.toLong()); le16(1); le16(8); le16(0)
            ascii("fact"); le32(4); le32(n)
            ascii("data"); le32(n)
            return b.toByteArray()
        }
    }
}

/**
 * 声音监听的录音（0.41）：麦克风一直开着，这里在内存里留着最近 preMs 的声音（16 kHz 时 3 秒大约 48 KB）。
 * 有声音（SoundDetector 说的）就从「有声音前 preMs」开始写一个 .wav，每次有声音都把结束时间往后推到 postMs 之后；
 * 安静够久就收尾，记成一条事件（EventInfo.sound = true），和移动侦测的录像放在同一个列表里，一样备份到云盘。
 * 一段最长 maxMs，声音一直不停就接着写下一段。换了采样率也另起一段。
 *
 * 时间戳是 StreamClient.now()（单调时钟，毫秒）。feed / tick / close 可以在不同线程调；写文件就在调用的线程上做
 * （CameraHub 给它单独一条线程，不占录音线程）。不碰安卓的类，可以在电脑上跑测试。
 */
class SoundRecorder(
    private val store: EventStore,
    private val clock: () -> Long = { StreamClient.now() },
    private val wall: () -> Long = { System.currentTimeMillis() },
) {
    @Volatile var preMs = 3_000L
    @Volatile var postMs = 10_000L
    @Volatile var maxMs = 300_000L
    /** 一段写完了 */
    var onClosed: ((EventInfo) -> Unit)? = null
    /** 写文件出错（磁盘满了之类） */
    var onError: ((String) -> Unit)? = null

    private class Chunk(val data: ByteArray, val rate: Int, val ts: Long)

    private val ring = java.util.ArrayDeque<Chunk>()
    private var active = false         // 一次事件正在进行（有声音 → 最后一次有声音后 postMs）
    private var seg: EventInfo? = null // 正在写的这一段
    private var writer: WavWriter? = null
    private var failed = false
    private var segStart = 0L
    private var endAt = 0L

    val recording: Boolean @Synchronized get() = active
    /** 正在写的这一段 */
    val current: EventInfo? @Synchronized get() = seg

    /** 麦克风来的一包（μ-law）。loud = 这一包算「有声音」。返回 true = 这是一次新的事件。 */
    @Synchronized fun feed(ulaw: ByteArray, rate: Int, ts: Long, loud: Boolean): Boolean {
        val c = Chunk(ulaw, rate, ts)
        var started = false
        if (loud) {
            endAt = maxOf(endAt, ts + postMs)
            if (!active) {
                active = true; started = true
                // 有声音前 preMs 里留着的（同一个采样率的）先写进去
                val pre = ring.filter { it.rate == rate && it.ts >= ts - preMs && it.ts < ts }
                ring.clear()
                startSeg(pre.firstOrNull()?.ts ?: ts, rate)
                for (p in pre) write(p)
            }
        }
        if (!active) { keep(c); return false }
        if (ts > endAt) { endEvent(); keep(c); return false }
        val w = writer
        // 换了采样率、或者太长了：另起一段
        if ((w != null && w.rate != rate) || ts - segStart >= maxMs) { finishSeg(); startSeg(ts, rate) }
        write(c)
        return started
    }

    /** 定时调：麦克风停了（被别的占了、坏了）也要按时结束。 */
    @Synchronized fun tick() {
        if (active && clock() > endAt + 3_000) endEvent()
    }

    /** 不听了：写完正在录的，留着的声音不要了。 */
    @Synchronized fun close() {
        if (active) endEvent()
        ring.clear()
    }

    private fun startSeg(t0: Long, rate: Int) {
        val at = toWall(t0)
        val e = EventInfo(store.newName(at), at, sound = true)
        seg = e; segStart = t0; failed = false
        writer = try { WavWriter(store.wav(e.name), rate, t0) } catch (ex: Exception) {
            failed = true
            onError?.invoke("写录音出错：${ex.message}")
            null
        }
    }

    private fun write(c: Chunk) {
        val w = writer ?: return
        if (failed) return
        try { w.audio(c.data, c.ts) } catch (ex: Exception) {
            failed = true
            onError?.invoke("写录音出错：${ex.message}")
        }
    }

    /** 写完这一段：关文件、存信息。没写成（建不了文件、一点声音都没有）就不留。 */
    private fun finishSeg() {
        val e = seg ?: return
        seg = null
        val w = writer
        writer = null
        val dur = try { w?.close() } catch (ex: Exception) {
            if (!failed) onError?.invoke("写录音出错：${ex.message}")
            null
        }
        if (dur == null || dur <= 0) { store.wav(e.name).delete(); return }
        e.durMs = dur
        store.save(e)
        onClosed?.invoke(e)
    }

    private fun endEvent() {
        finishSeg()
        active = false; endAt = 0
    }

    /** 内存里只留最近 preMs 多一点。 */
    private fun keep(c: Chunk) {
        ring.addLast(c)
        val limit = c.ts - preMs - 500
        while (ring.size > 1 && (ring.peekFirst().ts < limit || ring.size > MAX_RING)) ring.pollFirst()
    }

    private fun toWall(ts: Long) = wall() - (clock() - ts)

    companion object {
        /** 内存里最多留多少包（80 ms 一包，10 秒是 125 包） */
        const val MAX_RING = 200
    }
}
