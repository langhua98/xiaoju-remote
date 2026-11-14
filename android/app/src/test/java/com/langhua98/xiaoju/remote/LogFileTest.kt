package com.langhua98.xiaoju.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

class LogFileTest {
    private fun dir(): File = Files.createTempDirectory("log").toFile()

    @Test fun tailReturnsLastLinesInOrder() {
        val f = LogFile(dir())
        for (i in 1..50) f.append("第 $i 行")
        assertEquals(listOf("第 48 行", "第 49 行", "第 50 行"), f.tail(3))
        assertEquals(50, f.tail(500).size)
    }

    @Test fun rotatesAndReadsAcrossFiles() {
        val d = dir()
        val f = LogFile(d, maxBytes = 1000)
        for (i in 1..200) f.append("line-$i-" + "x".repeat(20))
        assertTrue(File(d, "log.1.txt").exists())
        assertTrue(File(d, "log.txt").length() < 1100)
        val t = f.tail(40)
        assertEquals(40, t.size)
        assertTrue(t.last().startsWith("line-200-"))
        assertTrue(t.first().startsWith("line-161-"))
        // 两份文件一共也就两千多字节，再多就没有了
        assertTrue(f.tail(1000).size < 200)
    }

    @Test fun newlinesInsideALineStayOneLine() {
        val f = LogFile(dir())
        f.append("闪退：\n第二行")
        assertEquals(listOf("闪退： 第二行"), f.tail(5))
    }

    @Test fun emptyDirGivesNothing() {
        assertEquals(emptyList<String>(), LogFile(dir()).tail(10))
    }
}
