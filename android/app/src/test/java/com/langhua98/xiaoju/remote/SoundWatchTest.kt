package com.langhua98.xiaoju.remote

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/** 声音监听（0.41）：判断有没有声音、写 WAV、录一段、和录像放在一起存。 */
class SoundWatchTest {
    /** 一包 80 ms、16 kHz 的 500 Hz 正弦（一包正好 40 个整周期，没有直流），幅度 amp */
    private fun tone(amp: Int): ByteArray {
        val pcm = ShortArray(1280) { (amp * Math.sin(2 * Math.PI * it / 32.0)).toInt().toShort() }
        return Ulaw.encode(pcm, pcm.size)
    }
    private val quiet = tone(30)      // 大约 27 分贝
    private val mid = tone(500)       // 大约 51 分贝（比 quiet 高 24）
    private val loud = tone(3000)     // 大约 66 分贝（比 quiet 高 39）

    /** 喂 n 包，返回其中几包算有声音 */
    private fun feed(d: SoundDetector, chunk: ByteArray, n: Int): Int {
        var hits = 0
        repeat(n) { if (d.feed(chunk, 16000)) hits++ }
        return hits
    }

    @Test fun levelOfSilenceAndTones() {
        assertEquals(0f, SoundDetector.levelDb(ByteArray(1280) { 0xFF.toByte() }), 0.01f)
        assertEquals(27f, SoundDetector.levelDb(quiet), 3f)
        assertEquals(51f, SoundDetector.levelDb(mid), 2f)
        assertEquals(66.5f, SoundDetector.levelDb(loud), 2f)
    }

    @Test fun quietRoomNeverTriggers() {
        val d = SoundDetector()
        assertEquals(0, feed(d, quiet, 500))   // 40 秒
        assertEquals(27f, d.floor, 3f)
    }

    @Test fun loudSoundTriggersAtOnce() {
        val d = SoundDetector()
        feed(d, quiet, 50)
        assertTrue(d.feed(loud, 16000))        // 比门槛高得多：一包就算
    }

    @Test fun oneModerateChunkIsNotEnoughTwoAre() {
        val d = SoundDetector()
        feed(d, quiet, 50)
        assertFalse(d.feed(mid, 16000))        // 高 24 分贝：过了门槛（18），但只有一包
        assertTrue(d.feed(mid, 16000))         // 连着第二包：算
    }

    @Test fun nothingIsReportedWhileSettling() {
        val d = SoundDetector()
        assertEquals(0, feed(d, loud, 18))     // 刚开麦克风的 1.5 秒（18 包 = 1.44 秒）只学底噪
        assertEquals(0, feed(d, loud, 50))     // 一开始就这么响：它就是底噪
    }

    @Test fun steadyNoiseBecomesTheFloorAndQuietBringsItBack() {
        val d = SoundDetector()
        feed(d, quiet, 50)
        assertTrue(feed(d, loud, 100) > 50)    // 前 8 秒：一直算有声音
        feed(d, loud, 650)                     // 再响 52 秒：底噪跟上去了
        assertEquals(0, feed(d, loud, 50))
        feed(d, quiet, 100)                    // 安静 8 秒：底噪很快回来
        assertEquals(27f, d.floor, 4f)
        assertTrue(d.feed(loud, 16000))
    }

    @Test fun sensitivityMovesTheThreshold() {
        val low = SoundDetector().apply { sensitivity = 1 }      // 门槛约 30 分贝
        feed(low, quiet, 50)
        assertEquals(0, feed(low, mid, 10))
        val high = SoundDetector().apply { sensitivity = 100 }   // 门槛 6 分贝
        feed(high, quiet, 50)
        assertTrue(feed(high, mid, 2) > 0)
        assertTrue(low.marginDb > high.marginDb)
    }

    private fun le32(b: ByteArray, at: Int) =
        (b[at].toInt() and 0xFF) or ((b[at + 1].toInt() and 0xFF) shl 8) or ((b[at + 2].toInt() and 0xFF) shl 16) or ((b[at + 3].toInt() and 0xFF) shl 24)

    @Test fun wavHeaderAndLength() {
        val f = File(Files.createTempDirectory("wav").toFile(), "a.wav")
        val w = WavWriter(f, 8000, 1000)
        w.audio(ByteArray(800) { 0x7f }, 1000)
        w.audio(ByteArray(800) { 0x7f }, 1100)
        assertEquals(200L, w.close())
        val b = f.readBytes()
        assertEquals(58 + 1600, b.size)
        assertEquals("RIFF", String(b, 0, 4, Charsets.US_ASCII))
        assertEquals(50 + 1600, le32(b, 4))
        assertEquals("WAVE", String(b, 8, 4, Charsets.US_ASCII))
        assertEquals(7, b[20].toInt())             // μ-law
        assertEquals(8000, le32(b, 24))
        assertEquals("fact", String(b, 38, 4, Charsets.US_ASCII))
        assertEquals(1600, le32(b, 46))
        assertEquals("data", String(b, 50, 4, Charsets.US_ASCII))
        assertEquals(1600, le32(b, 54))
    }

    @Test fun wavFillsGapsWithSilenceAndPadsOddLength() {
        val dir = Files.createTempDirectory("wav").toFile()
        val g = File(dir, "gap.wav")
        val w = WavWriter(g, 8000, 1000)
        w.audio(ByteArray(800) { 0x7f }, 1000)
        w.audio(ByteArray(800) { 0x7f }, 1600)     // 该在 1100 来，晚了 0.5 秒：补 4000 个静音
        assertEquals(700L, w.close())
        assertEquals(58 + 5600, g.length().toInt())
        val o = File(dir, "odd.wav")
        val w2 = WavWriter(o, 8000, 0)
        w2.audio(ByteArray(801) { 0x7f }, 0)
        w2.close()
        val b = o.readBytes()
        assertEquals(58 + 802, b.size)             // 凑成偶数
        assertEquals(801, le32(b, 54))
        assertEquals(50 + 802, le32(b, 4))
    }

    private class Clock { var t = 0L }
    private val wallBase = 1_700_000_000_000L

    private fun recorder(store: EventStore, c: Clock, closed: MutableList<EventInfo>) =
        SoundRecorder(store, clock = { c.t }, wall = { wallBase + c.t }).apply { onClosed = { closed += it } }

    /** 从 from 到 to（不含），每 80 ms 一包；loudAt 里的时间点算有声音。返回开始了几次新事件。 */
    private fun run(r: SoundRecorder, c: Clock, from: Long, to: Long, loudAt: (Long) -> Boolean): Int {
        var started = 0
        var t = from
        while (t < to) {
            c.t = t
            if (r.feed(quiet, 16000, t, loudAt(t))) started++
            r.tick()
            t += 80
        }
        return started
    }

    @Test fun recordsPreRollAndStopsAfterQuiet() {
        val store = EventStore(Files.createTempDirectory("ev").toFile())
        val c = Clock()
        val closed = ArrayList<EventInfo>()
        val r = recorder(store, c, closed)
        r.preMs = 3_000; r.postMs = 2_000
        // 10.00 秒和 11.04 秒各有一次声音：从 7.04 秒录到 13.04 秒，一共 76 包
        val started = run(r, c, 0, 20_000) { it == 10_000L || it == 11_040L }
        assertEquals(1, started)
        assertFalse(r.recording)
        assertEquals(1, closed.size)
        val e = store.list().single()
        assertTrue(e.sound); assertFalse(e.video); assertTrue(e.hasMedia)
        assertEquals(6_080L, e.durMs)
        assertEquals(wallBase + 7_040, e.at)
        assertEquals(58L + 76 * 1280, store.wav(e.name).length())
        assertEquals(listOf(e.name), store.pendingUpload().map { it.name })
    }

    @Test fun longSoundIsSplitIntoSegments() {
        val store = EventStore(Files.createTempDirectory("ev").toFile())
        val c = Clock()
        val closed = ArrayList<EventInfo>()
        val r = recorder(store, c, closed)
        r.postMs = 2_000; r.maxMs = 4_000
        val started = run(r, c, 0, 20_000) { it < 10_000 }   // 响 10 秒：4 + 4 + 剩下的
        assertEquals(1, started)                              // 是同一次事件
        assertEquals(3, closed.size)
        assertEquals(3, store.list().size)
        assertEquals(3, store.list().map { it.name }.toSet().size)
        assertTrue(store.list().all { it.sound && store.wav(it.name).exists() })
    }

    @Test fun tickEndsTheEventWhenTheMicStops() {
        val store = EventStore(Files.createTempDirectory("ev").toFile())
        val c = Clock()
        val closed = ArrayList<EventInfo>()
        val r = recorder(store, c, closed)
        r.postMs = 2_000
        run(r, c, 0, 1_040) { true }
        assertTrue(r.recording)
        c.t = 1_000 + 2_000 + 2_900; r.tick()   // 麦克风不来数据了：还没到
        assertTrue(r.recording)
        c.t += 200; r.tick()
        assertFalse(r.recording)
        assertEquals(1, closed.size)
    }

    @Test fun closeFinishesTheSegment() {
        val store = EventStore(Files.createTempDirectory("ev").toFile())
        val c = Clock()
        val closed = ArrayList<EventInfo>()
        val r = recorder(store, c, closed)
        run(r, c, 0, 800) { true }
        r.close()
        assertFalse(r.recording)
        assertEquals(800L, closed.single().durMs)
    }

    @Test fun storeTreatsSoundLikeVideo() {
        val s = EventStore(Files.createTempDirectory("ev").toFile())
        s.wav("20261116-100000").writeBytes(ByteArray(100))
        s.save(EventInfo("20261116-100000", 1000, sound = true))
        s.mov("20261116-110000").writeBytes(ByteArray(100))
        s.save(EventInfo("20261116-110000", 2000, video = true))
        val back = s.get("20261116-100000")!!
        assertTrue(back.sound)
        assertEquals("20261116-100000.wav", s.media(back).name)
        assertEquals("20261116-110000.mov", s.media(s.get("20261116-110000")!!).name)
        assertEquals(2, s.pendingUpload().size)
        s.markUploaded("20261116-100000", "/x/20261116-100000.wav")
        assertEquals(1, s.dropBackedUp())                      // 备份好的录音手机上不留
        assertFalse(s.wav("20261116-100000").exists())
        assertTrue(s.mov("20261116-110000").exists())
        assertTrue(s.delete("20261116-110000"))
        assertFalse(s.mov("20261116-110000").exists())
        // 老版本存的信息里没有 sound：当成不是
        assertFalse(EventInfo.fromJson(JSONObject("""{"name":"20261116-120000","at":1,"video":true}""")).sound)
    }

    @Test fun sameSecondGetsDifferentNames() {
        val s = EventStore(Files.createTempDirectory("ev").toFile())
        val a = s.newName(wallBase)
        val b = s.newName(wallBase)                            // 文件还没建，也不能重名
        assertNotEquals(a, b)
    }

    @Test fun monitorConfigSoundFields() {
        val a = MonitorConfig()
        assertFalse(a.sound)
        val b = a.merge(JSONObject().put("sound", true).put("sound_sens", 500).put("sound_post", 1).put("sound_pre", 99))
        assertTrue(b.sound)
        assertEquals(100, b.soundSens)
        assertEquals(3, b.soundPostSec)
        assertEquals(10, b.soundPreSec)
        assertEquals(a.on, b.on)                               // 不碰移动侦测的开关
        assertFalse(b.merge(JSONObject().put("on", true)).soundNotify)
        assertTrue(b.merge(JSONObject().put("on", true)).sound) // 只改移动侦测：声音监听不变
        assertEquals(b.toJson().toString(), MonitorConfig.fromJson(b.toJson().toString()).toJson().toString())
    }
}
