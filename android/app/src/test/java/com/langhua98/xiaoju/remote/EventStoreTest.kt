package com.langhua98.xiaoju.remote

import org.junit.Assert.assertEquals
import org.junit.Test
import java.nio.file.Files

class EventStoreTest {
    private fun event(s: EventStore, name: String, at: Long, uploaded: String) {
        s.mov(name).writeBytes(ByteArray(10))
        s.save(EventInfo(name, at, video = true, uploaded = uploaded))
    }

    /** 云盘上没有了的录像重新排队备份；还在的、出错的不动。 */
    @Test fun forgetMissingRequeuesLostVideos() {
        val s = EventStore(Files.createTempDirectory("ev").toFile())
        val d1 = "/小橘推送/遥控/A/录像/2026-11-09"
        val d2 = "/小橘推送/遥控/A/录像/2026-11-10"
        event(s, "20261109-100000", 1000, "$d1/20261109-100000.mov")   // 还在
        event(s, "20261109-110000", 2000, "$d1/20261109-110000.mov")   // 丢了
        event(s, "20261110-090000", 3000, "$d2/20261110-090000.mov")   // 整个文件夹都没了
        event(s, "20261110-100000", 4000, "")                          // 本来就没备份
        val asked = ArrayList<String>()
        val n = s.forgetMissing { folder ->
            asked.add(folder)
            if (folder == d1) setOf("20261109-100000.mov") else emptySet()
        }
        assertEquals(2, n)
        assertEquals(2, asked.size)   // 每个文件夹只问一次
        assertEquals(listOf("20261109-110000", "20261110-090000", "20261110-100000"), s.pendingUpload().map { it.name })
        assertEquals("$d1/20261109-100000.mov", s.get("20261109-100000")!!.uploaded)
    }

    /** 问云盘出错：什么也不改。 */
    @Test fun forgetMissingKeepsMarksOnError() {
        val s = EventStore(Files.createTempDirectory("ev").toFile())
        event(s, "20261109-100000", 1000, "/x/20261109-100000.mov")
        try { s.forgetMissing { throw java.io.IOException("断网") } } catch (e: java.io.IOException) {}
        assertEquals(0, s.pendingUpload().size)
    }

    /** 备份好的删掉手机上的视频，信息留着；没备份的不动。 */
    @Test fun dropBackedUpKeepsPendingVideos() {
        val s = EventStore(Files.createTempDirectory("ev").toFile())
        event(s, "20261109-100000", 1000, "/x/20261109-100000.mov")
        event(s, "20261109-110000", 2000, "")
        assertEquals(1, s.dropBackedUp())
        assertEquals(false, s.mov("20261109-100000").exists())
        assertEquals(true, s.mov("20261109-110000").exists())
        assertEquals(2, s.list().size)
        assertEquals(listOf("20261109-110000"), s.pendingUpload().map { it.name })
        assertEquals(0, s.dropBackedUp())
    }
}
