package com.langhua98.xiaoju.remote

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class BackupCryptoTest {
    private val key = ByteArray(32) { it.toByte() }
    private val nonce = ByteArray(16) { (100 + it).toByte() }
    private val plain = "hello 小橘 ".repeat(7)

    /** 这两个值是 Python（遥控.py 里一样的算法）算出来的：三端要对得上 */
    @Test fun matchesPythonVector() {
        val sealed = BackupCrypto.seal(key, plain.toByteArray(Charsets.UTF_8), nonce)
        assertEquals("xj1.ZGVmZ2hpamtsbW5vcHFycz+rbKGjAYIadBdOdGXRG8Tt0YDGTKAp2V04AvkTWVriU/svC3uOKSeQ5fmhFCjgGT9dTaQx7UhmYQ9Z33ywCEnbe6mA0zcxgURmeObUsBtpjBJoO6QGRXdA4WDLcAgrniV2Q6blqZ95CwfeNwz3+A2aXP82VyTST8DJig==",
            BackupCrypto.PREFIX + BackupCrypto.b64(sealed))
        assertEquals("xjb4bfb47306f3a84fd792c0e6bcc5b1", BackupCrypto.topic(key, "A", "cmd"))
    }

    @Test fun roundTripAndTamper() {
        val text = BackupCrypto.sealText(key, plain)
        assertEquals(plain, BackupCrypto.openText(key, text))
        // 换个密钥、改一个字节、不是 xj1. 开头的，都打不开
        assertNull(BackupCrypto.openText(ByteArray(32), text))
        val raw = BackupCrypto.unb64(text.removePrefix(BackupCrypto.PREFIX))!!
        raw[20] = (raw[20].toInt() xor 1).toByte()
        assertNull(BackupCrypto.open(key, raw))
        assertNull(BackupCrypto.openText(key, "hello"))
        // 空的也能封
        assertEquals("", BackupCrypto.openText(key, BackupCrypto.sealText(key, "")))
    }

    @Test fun base64RoundTrip() {
        for (n in 0..70) {
            val b = ByteArray(n) { (it * 37 + 5).toByte() }
            assertArrayEquals(b, BackupCrypto.unb64(BackupCrypto.b64(b)))
        }
        assertNull(BackupCrypto.unb64("!!"))
    }
}
