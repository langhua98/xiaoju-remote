package com.langhua98.xiaoju.remote

import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile

/**
 * 运行记录存到文件（0.37）：以前只在内存里留 200 行，App 一重启、或者直播半小时就冲掉了，远程也看不到。
 * 现在每行追加到 log.txt，满 maxBytes 就改名成 log.1.txt 接着写新的（最多两份，大约 2 × 256 KB）。
 * `log` 指令用 tail() 取最近几行。不碰安卓的类，电脑上能直接测（见 src/test）。
 */
class LogFile(private val dir: File, private val maxBytes: Long = 256 * 1024) {
    private val cur get() = File(dir, "log.txt")
    private val old get() = File(dir, "log.1.txt")

    @Synchronized fun append(line: String) {
        runCatching {
            val f = cur
            if (f.length() >= maxBytes) { old.delete(); f.renameTo(old) }
            FileOutputStream(cur, true).use { it.write((line.replace('\n', ' ') + "\n").toByteArray(Charsets.UTF_8)) }
        }
    }

    /** 最近 n 行（旧的在前）。 */
    @Synchronized fun tail(n: Int): List<String> {
        if (n <= 0) return emptyList()
        val out = ArrayList<String>()
        for (f in listOf(cur, old)) {
            if (out.size >= n) break
            val lines = tailOf(f, n - out.size)
            out.addAll(0, lines)
        }
        return out
    }

    /** 从文件末尾往前读，最多读够 n 行（不把整个文件读进内存）。 */
    private fun tailOf(f: File, n: Int): List<String> {
        if (!f.exists() || f.length() == 0L) return emptyList()
        return runCatching {
            RandomAccessFile(f, "r").use { r ->
                val len = r.length()
                var pos = len
                var chunk = ByteArray(0)
                var count = 0
                while (pos > 0 && count <= n) {
                    val step = minOf(8 * 1024L, pos).toInt()
                    pos -= step
                    val b = ByteArray(step)
                    r.seek(pos); r.readFully(b)
                    chunk = b + chunk
                    count = chunk.count { it == '\n'.code.toByte() }
                }
                String(chunk, Charsets.UTF_8).split('\n').filter { it.isNotEmpty() }.takeLast(n)
            }
        }.getOrDefault(emptyList())
    }
}
