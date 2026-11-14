package com.langhua98.xiaoju.remote

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Process

/**
 * 直播的声音：AudioRecord 录单声道 16 位，每 40 ms 一包压成 μ-law 交给 onChunk(数据, 格式, 采集时间)。
 * 先试 16 kHz，不行退到 8 kHz（4.2 的手机都支持其中之一）。在自己的线程里跑，stop() 后结束。
 *
 * 声音一卡一卡的（0.36 修）：
 * - 录音线程用系统给声音的高优先级（URGENT_AUDIO），相机、编码、侦测忙的时候也能按时读麦克风；
 * - 系统录音缓冲区放大到 1 秒（以前 0.2 秒），线程偶尔被耽误也不会把声音丢掉；
 * - 时间戳按样本数算（AudioClock），一包接一包，看的一端不会排出空当、重叠。
 * onChunk 要快：在录音线程上调，不能等锁、不能写文件（CameraHub 把写录像放到别的线程）。
 */
class AudioCapture(private val onChunk: (ByteArray, Int, Long) -> Unit) {
    @Volatile private var running = false
    private var thread: Thread? = null
    var error: String? = null
        private set
    /** 重新对钟的次数（多半是丢过声音），日志用 */
    @Volatile var resyncs = 0
        private set

    fun start(): Boolean {
        for ((rate, codec) in listOf(16000 to StreamClient.AUDIO_ULAW_16K, 8000 to StreamClient.AUDIO_ULAW_8K)) {
            val min = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
            if (min <= 0) continue
            val rec = try {
                AudioRecord(MediaRecorder.AudioSource.MIC, rate, AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT, maxOf(min, rate * 2 * BUFFER_MS / 1000))
            } catch (e: Exception) { continue }
            if (rec.state != AudioRecord.STATE_INITIALIZED) { rec.release(); continue }
            running = true
            thread = Thread({ loop(rec, rate, codec) }, "live-audio").apply { start() }
            return true
        }
        error = "麦克风打不开"
        return false
    }

    private fun loop(rec: AudioRecord, rate: Int, codec: Int) {
        runCatching { Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO) }
        val n = rate / 25  // 40 ms 一包：包越小，声音（和跟着它对齐的画面）越早到
        val buf = ShortArray(n)
        val clock = AudioClock(rate)
        try {
            rec.startRecording()
            while (running) {
                var got = 0
                while (running && got < n) {
                    val r = rec.read(buf, got, n - got)
                    if (r <= 0) break
                    got += r
                }
                if (got <= 0) break
                val ts = clock.stamp(got, StreamClient.now())
                resyncs = clock.resyncs
                onChunk(Ulaw.encode(buf, got), codec, ts)
            }
        } catch (e: Exception) {
            error = e.message
        } finally {
            runCatching { rec.stop() }
            rec.release()
        }
    }

    fun stop() {
        running = false
        runCatching { thread?.join(1000) }
    }

    companion object {
        /** 系统录音缓冲区多长（毫秒）：录音线程被耽误这么久也不丢声音 */
        const val BUFFER_MS = 1000
    }
}
